import type { Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { createTables, createQueries } from "./db"
import { computeHealthScore } from "./health"
import { scanAgentConfigs, detectChanges, getAgentHash, initFromDB } from "./agent-tracker"

interface SessionTracker {
  sessionID: string
  trackingKey: string
  startTime: number
  agent: string
  model: string
  provider: string
  stepCount: number
  toolCalls: number
  toolErrors: number
  retries: number
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  hasError: boolean
  wasReverted: boolean
  errorMessages: string[]
  userPrompt: string
  messageTotals: Map<string, { cost: number, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number }>
}

export function createEventHandler(db: Database, q: ReturnType<typeof createQueries>, opts?: { projectDir?: string, home?: string }) {
  const active = new Map<string, SessionTracker>()
  const sessionKeys = new Map<string, string>()
  const lastUserMsg = new Map<string, string>()

  function trackingKey(sessionID: string, agent: string, msgId?: string): string {
    return msgId ? `${sessionID}:${agent}:${msgId}` : `${sessionID}:${agent}`
  }

  function startTracking(sessionID: string, agent: string, model?: string, provider?: string, msgId?: string): SessionTracker {
    const key = trackingKey(sessionID, agent, msgId)

    const prevKey = sessionKeys.get(sessionID)
    if (prevKey && prevKey !== key) {
      const prev = active.get(prevKey)
      if (prev) {
        save(prev, Date.now())
        active.delete(prevKey)
      }
    }

    sessionKeys.set(sessionID, key)

    if (!active.has(key)) {
      active.set(key, {
        sessionID, trackingKey: key,
        startTime: Date.now(),
        agent, model: model || "", provider: provider || "",
        stepCount: 0, toolCalls: 0, toolErrors: 0, retries: 0,
        totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
        totalReasoningTokens: 0, totalCacheRead: 0, totalCacheWrite: 0,
        hasError: false, wasReverted: false, errorMessages: [], userPrompt: "",
        messageTotals: new Map(),
      })
    }
    return active.get(key)!
  }

  function getTracker(sessionID: string): SessionTracker | undefined {
    const key = sessionKeys.get(sessionID)
    return key ? active.get(key) : undefined
  }

  function save(t: SessionTracker, endTime?: number) {
    if (!t.agent) return

    const health = computeHealthScore({
      hasError: t.hasError,
      errorCount: t.errorMessages.length,
      wasReverted: t.wasReverted,
      retries: t.retries,
      toolCalls: t.toolCalls,
      toolErrors: t.toolErrors,
      stepCount: t.stepCount,
    })

    q.upsertSession.run(
      t.trackingKey, t.startTime, endTime || Date.now(),
      t.agent, t.model, t.provider, t.userPrompt.slice(0, 2000),
      t.stepCount, t.toolCalls, t.toolErrors, t.retries, t.totalCost,
      t.totalInputTokens, t.totalOutputTokens, t.totalReasoningTokens,
      t.totalCacheRead, t.totalCacheWrite,
      t.hasError ? 1 : 0, t.wasReverted ? 1 : 0,
      JSON.stringify(t.errorMessages.slice(0, 10)),
      health,
      getAgentHash(t.agent) || null,
    )
  }

  function flush(sessionID: string, endTime?: number) {
    const key = sessionKeys.get(sessionID)
    if (!key) return
    const t = active.get(key)
    if (!t) return
    save(t, endTime)
    active.delete(key)
    sessionKeys.delete(sessionID)
  }

  function flushAll() {
    const now = Date.now()
    for (const [key, t] of active.entries()) {
      save(t, now)
    }
    active.clear()
    sessionKeys.clear()
  }

  function checkAgentChanges() {
    if (!opts?.projectDir) return
    try {
      const current = scanAgentConfigs(opts.projectDir, opts.home || homedir())
      const changes = detectChanges(current)
      for (const c of changes) {
        q.insertAgentChange.run(c.agent, c.hash, c.path, Date.now(), c.content.slice(0, 5000))
      }
    } catch (_) {}
  }

  async function handleEvent(event: any) {
    try {
      if (event.type === "message.updated") {
        const msg = event.properties.info as any

        if (msg.role === "user") {
          const agent = msg.agent || ""
          const msgKey = `${msg.id}:${agent}`
          const prevKey = lastUserMsg.get(msg.sessionID)
          if (prevKey === msgKey) return
          lastUserMsg.set(msg.sessionID, msgKey)
          flushAll()
          checkAgentChanges()
          startTracking(msg.sessionID, agent, msg.model?.modelID, msg.model?.providerID, msg.id)
        }

        if (msg.role === "assistant") {
          const t = getTracker(msg.sessionID)
          if (!t) return

          t.model = msg.modelID || t.model
          t.provider = msg.providerID || t.provider

          const msgId = msg.id
          const prev = t.messageTotals.get(msgId) || { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
          const curr = {
            cost: msg.cost || 0,
            input: msg.tokens?.input || 0,
            output: msg.tokens?.output || 0,
            reasoning: msg.tokens?.reasoning || 0,
            cacheRead: msg.tokens?.cache?.read || 0,
            cacheWrite: msg.tokens?.cache?.write || 0,
          }
          t.totalCost += curr.cost - prev.cost
          t.totalInputTokens += curr.input - prev.input
          t.totalOutputTokens += curr.output - prev.output
          t.totalReasoningTokens += curr.reasoning - prev.reasoning
          t.totalCacheRead += curr.cacheRead - prev.cacheRead
          t.totalCacheWrite += curr.cacheWrite - prev.cacheWrite
          t.messageTotals.set(msgId, curr)

          if (msg.error) {
            t.hasError = true
            if (!t.errorMessages.includes(msg.error.name || "unknown")) {
              t.errorMessages.push(msg.error.name || "unknown")
            }
          }

          if (msg.finish || msg.error) {
            const dur = msg.time?.completed && msg.time?.created
              ? msg.time.completed - msg.time.created : null

            q.insertModelCall.run(
              t.trackingKey, msg.id, msg.modelID || "", msg.providerID || "",
              t.agent,
              curr.input, curr.output, curr.reasoning,
              curr.cacheRead, curr.cacheWrite,
              curr.cost,
              msg.time?.created || null, msg.time?.completed || null, dur,
              msg.finish || null, msg.error ? 1 : 0, msg.error?.name || null,
            )
          }
        }
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part as any
        const t = getTracker(part.sessionID)
        if (!t) return

        if (part.type === "text" && !t.userPrompt && !part.synthetic) {
          t.userPrompt = (part.text || "").slice(0, 2000)
        }

        if (part.type === "tool") {
          if (part.state.status === "completed" || part.state.status === "error") {
            t.toolCalls++
            const start = part.state.time?.start || null
            const end = part.state.time?.end || null
            const dur = start && end ? end - start : null
            if (part.state.status === "error") t.toolErrors++
            q.insertToolExec.run(
              t.trackingKey, part.messageID, part.tool, part.state.status,
              start, end, dur,
              part.state.status === "error" ? (part.state.error || "unknown") : null,
            )
          }
        }

        if (part.type === "step-finish") {
          t.stepCount++
          q.insertStep.run(
            t.trackingKey, part.messageID, t.stepCount,
            part.tokens?.input || 0, part.tokens?.output || 0,
            part.tokens?.reasoning || 0,
            part.tokens?.cache?.read || 0, part.tokens?.cache?.write || 0,
            part.cost || 0, part.reason || null,
          )
        }

        if (part.type === "retry") {
          t.retries++
        }
      }

      if (event.type === "session.idle") {
        flush(event.properties.sessionID, Date.now())
      }

      if (event.type === "session.error") {
        const sid = (event.properties as any).sessionID
        if (sid) {
          const t = getTracker(sid)
          if (t) {
            t.hasError = true
            if ((event.properties as any).error) {
              t.errorMessages.push((event.properties as any).error.name || "unknown")
            }
          }
          flush(sid, Date.now())
        }
      }

      if (event.type === "session.updated") {
        const session = (event.properties as any).info
        if (session?.revert) {
          const t = getTracker(session.id)
          if (t) t.wasReverted = true
          else q.markReverted.run(session.id)
        }
      }

      if (event.type === "file.watcher.updated") {
        checkAgentChanges()
      }

    } catch (_) {}
  }

  return { handleEvent, checkAgentChanges }
}

const AgentPulsePlugin: Plugin = async (ctx) => {
  const home = homedir()
  const dbDir = join(home, ".local", "share", "opencode")
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, "agent-pulse.db")

  const db = new Database(dbPath)
  createTables(db)
  const q = createQueries(db)

  const allAgents = db.prepare(`
    SELECT agent, config_hash FROM agent_changes
    WHERE id IN (SELECT MAX(id) FROM agent_changes GROUP BY agent)
  `).all() as Array<{ agent: string; config_hash: string }>
  initFromDB(allAgents)

  const projectDir = ctx.directory || ctx.worktree || process.cwd()
  const handler = createEventHandler(db, q, { projectDir, home })
  handler.checkAgentChanges()

  await ctx.client.app.log({
    body: {
      service: "agent-pulse",
      level: "info",
      message: `Agent Quality Analytics ready. DB: ${dbPath}`,
    },
  })

  return {
    event: async ({ event }) => {
      await handler.handleEvent(event)
    },
  }
}

export const plugin = AgentPulsePlugin
export default plugin
