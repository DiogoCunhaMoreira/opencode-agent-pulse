import { Database } from "bun:sqlite"
import { createQueries } from "./db"

export function printStats(db: Database) {
  const q = createQueries(db)
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000

  const agents = q.healthBreakdownByAgent.all(since) as any[]
  const models = q.healthByModel.all(since) as any[]
  const tools = q.toolStats.all(since) as any[]
  const worst = q.worstSessions.all(since, 5) as any[]
  const changes = q.recentAgentChanges.all(10) as any[]

  console.log("\n=== Health by Agent (last 7 days) ===")
  if (agents.length) {
    console.table(agents.map(a => ({
      agent: a.agent || "(default)",
      health: `${a.avg_health}/100`,
      sessions: a.sessions,
      "errors /30": a.avg_error_score,
      "reverts /25": a.avg_revert_score,
      "retries /15": a.avg_retry_score,
      "tools /15": a.avg_tool_score,
      "steps /15": a.avg_step_score,
    })))
  } else console.log("  No data")

  console.log("\n=== Health by Model ===")
  if (models.length) console.table(models)
  else console.log("  No data")

  console.log("\n=== Tool Performance ===")
  if (tools.length) {
    console.table(tools.map(t => ({
      tool: t.tool_name,
      calls: t.calls,
      errors: t.errors,
      "error %": t.calls > 0 ? ((t.errors / t.calls) * 100).toFixed(1) + "%" : "0%",
      "avg ms": t.avg_duration_ms,
    })))
  } else console.log("  No data")

  console.log("\n=== Worst Sessions ===")
  if (worst.length) {
    console.table(worst.map(s => {
      const flags: string[] = []
      if (s.has_error) flags.push("err")
      if (s.was_reverted) flags.push("revert")
      if (s.retries > 0) flags.push(`${s.retries}x retry`)
      return {
        agent: s.agent || "-",
        model: s.model || "-",
        health: s.health_score,
        flags: flags.join(", ") || "-",
        cost: `$${s.total_cost.toFixed(4)}`,
        tools: `${s.tool_calls} (${s.tool_errors} err)`,
        prompt: (s.user_prompt || "").slice(0, 60),
      }
    }))
  } else console.log("  No data")

  console.log("\n=== Agent Config Changes ===")
  if (changes.length) {
    console.table(changes.map(c => {
      const impact = q.healthAroundChange.all(c.id, c.agent) as any[]
      const before = impact.find((r: any) => r.period === "before")
      const after = impact.find((r: any) => r.period === "after")

      const healthBefore = before ? before.avg_health : null
      const healthAfter = after ? after.avg_health : null
      let healthImpact = "-"
      if (healthBefore != null && healthAfter != null) {
        const d = healthAfter - healthBefore
        healthImpact = `${healthBefore} -> ${healthAfter} (${d > 0 ? "+" : ""}${d.toFixed(1)})`
      }

      return {
        agent: c.agent,
        changed: new Date(c.changed_at).toLocaleString(),
        "health impact": healthImpact,
        "sessions (before/after)": `${before ? before.sessions : 0} / ${after ? after.sessions : 0}`,
      }
    }))
  } else console.log("  No changes tracked")

  console.log()
}
