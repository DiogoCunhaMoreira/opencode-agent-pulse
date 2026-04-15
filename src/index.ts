import type { Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { createTables, createQueries } from "./db"
import { computeHealthScore } from "./health"
import { scanAgentConfigs, detectChanges, getAgentHash, initFromDB } from "./agent-tracker"

// ── In-memory session accumulator ───────────────────────────────

interface SessionTracker {
  sessionID: string
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
}

const active = new Map<string, SessionTracker>()

function tracker(id: string): SessionTracker {
  if (!active.has(id)) {
    active.set(id, {
      sessionID: id,
      startTime: Date.now(),
      agent: "", model: "", provider: "",
      stepCount: 0, toolCalls: 0, toolErrors: 0, retries: 0,
      totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
      totalReasoningTokens: 0, totalCacheRead: 0, totalCacheWrite: 0,
      hasError: false, wasReverted: false, errorMessages: [], userPrompt: "",
    })
  }
  return active.get(id)!
}

// ── Plugin ──────────────────────────────────────────────────────

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
  function checkAgentChanges() {
    try {
      const current = scanAgentConfigs(projectDir, home)
      const changes = detectChanges(current)
      for (const c of changes) {
        q.insertAgentChange.run(c.agent, c.hash, c.path, Date.now(), c.content.slice(0, 5000))
        ctx.client.app.log({
          body: {
            service: "agent-pulse",
            level: "info",
            message: `Agent config changed: ${c.agent} → ${c.hash}`,
          },
        })
      }
    } catch { /* ignore scan errors */ }
  }
  checkAgentChanges()

  function flush(sessionID: string, endTime?: number) {
    const t = active.get(sessionID)
    if (!t) return

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
      t.sessionID, t.startTime, endTime || Date.now(),
      t.agent, t.model, t.provider, t.userPrompt.slice(0, 2000),
      t.stepCount, t.toolCalls, t.toolErrors, t.retries, t.totalCost,
      t.totalInputTokens, t.totalOutputTokens, t.totalReasoningTokens,
      t.totalCacheRead, t.totalCacheWrite,
      t.hasError ? 1 : 0, t.wasReverted ? 1 : 0,
      JSON.stringify(t.errorMessages.slice(0, 10)),
      health,
      getAgentHash(t.agent) || null,
    )

    active.delete(sessionID)
  }

  await ctx.client.app.log({
    body: {
      service: "agent-pulse",
      level: "info",
      message: `Agent Quality Analytics ready. DB: ${dbPath}`,
    },
  })

  return {
    event: async ({ event }) => {
      try {
        // ── Messages ──
        if (event.type === "message.updated") {
          const msg = event.properties.info as any

          if (msg.role === "user") {
            const t = tracker(msg.sessionID)
            if (!t.agent) {
              t.agent = msg.agent || ""
              t.model = msg.model?.modelID || ""
              t.provider = msg.model?.providerID || ""
            }
          }

          if (msg.role === "assistant") {
            const t = tracker(msg.sessionID)
            t.model = msg.modelID || t.model
            t.provider = msg.providerID || t.provider
            t.totalCost += msg.cost || 0
            t.totalInputTokens += msg.tokens?.input || 0
            t.totalOutputTokens += msg.tokens?.output || 0
            t.totalReasoningTokens += msg.tokens?.reasoning || 0
            t.totalCacheRead += msg.tokens?.cache?.read || 0
            t.totalCacheWrite += msg.tokens?.cache?.write || 0

            if (msg.error) {
              t.hasError = true
              t.errorMessages.push(msg.error.name || "unknown")
            }

            const dur = msg.time?.completed && msg.time?.created
              ? msg.time.completed - msg.time.created : null

            q.insertModelCall.run(
              msg.sessionID, msg.id, msg.modelID || "", msg.providerID || "",
              t.agent,
              msg.tokens?.input || 0, msg.tokens?.output || 0,
              msg.tokens?.reasoning || 0,
              msg.tokens?.cache?.read || 0, msg.tokens?.cache?.write || 0,
              msg.cost || 0,
              msg.time?.created || null, msg.time?.completed || null, dur,
              msg.finish || null, msg.error ? 1 : 0, msg.error?.name || null,
            )
          }
        }

        // ── Parts ──
        if (event.type === "message.part.updated") {
          const part = event.properties.part as any

          if (part.type === "text" && part.sessionID) {
            const t = active.get(part.sessionID)
            if (t && !t.userPrompt && !part.synthetic) {
              t.userPrompt = (part.text || "").slice(0, 2000)
            }
          }

          if (part.type === "tool") {
            const t = tracker(part.sessionID)
            if (part.state.status === "completed" || part.state.status === "error") {
              t.toolCalls++
              const start = part.state.time?.start || null
              const end = part.state.time?.end || null
              const dur = start && end ? end - start : null
              if (part.state.status === "error") t.toolErrors++
              q.insertToolExec.run(
                part.sessionID, part.messageID, part.tool, part.state.status,
                start, end, dur,
                part.state.status === "error" ? (part.state.error || "unknown") : null,
              )
            }
          }

          if (part.type === "step-finish") {
            const t = tracker(part.sessionID)
            t.stepCount++
            q.insertStep.run(
              part.sessionID, part.messageID, t.stepCount,
              part.tokens?.input || 0, part.tokens?.output || 0,
              part.tokens?.reasoning || 0,
              part.tokens?.cache?.read || 0, part.tokens?.cache?.write || 0,
              part.cost || 0, part.reason || null,
            )
          }

          if (part.type === "retry") {
            tracker(part.sessionID).retries++
          }
        }

        // ── Session lifecycle ──
        if (event.type === "session.idle") {
          flush(event.properties.sessionID, Date.now())
        }

        if (event.type === "session.error") {
          const sid = (event.properties as any).sessionID
          if (sid) {
            const t = tracker(sid)
            t.hasError = true
            if ((event.properties as any).error) {
              t.errorMessages.push((event.properties as any).error.name || "unknown")
            }
            flush(sid, Date.now())
          }
        }

        if (event.type === "session.updated") {
          const session = (event.properties as any).info
          if (session?.revert) {
            const t = active.get(session.id)
            if (t) t.wasReverted = true
            else q.markReverted.run(session.id)
          }
        }

        // ── File watcher: re-scan agent configs on changes ──
        if (event.type === "file.watcher.updated") {
          const file = (event.properties as any).file || ""
          if (file.includes("agent") && file.endsWith(".md")) {
            checkAgentChanges()
          }
        }

      } catch (err) {
        ctx.client.app.log({
          body: {
            service: "agent-pulse",
            level: "error",
            message: `Error: ${(err as Error).message}`,
          },
        })
      }
    },
  }
}

export const plugin = AgentPulsePlugin
export default plugin
