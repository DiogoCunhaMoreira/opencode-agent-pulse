import { Database } from "bun:sqlite"
import { createQueries } from "./db"

export function printStats(db: Database) {
  const q = createQueries(db)
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000

  const agents = q.healthByAgent.all(since) as any[]
  const tools = q.toolStats.all(since) as any[]
  const agentsWithChanges = q.agentsWithChanges.all() as any[]

  console.log("\n=== Agents (last 7 days) ===")
  if (agents.length) {
    console.table(agents.map(a => ({
      agent: a.agent || "(default)",
      health: a.avg_health,
      sessions: a.sessions,
      "avg cost": `$${a.avg_cost}`,
      "avg tokens": Math.round(a.avg_tokens),
      "error %": `${a.error_rate}%`,
    })))
  } else console.log("  No data")

  // Evolution per agent — one table per agent showing version history
  if (agentsWithChanges.length) {
    for (const { agent } of agentsWithChanges) {
      const versions = q.agentEvolution.all(agent) as any[]
      if (!versions.length) continue

      console.log(`\n=== Evolution: ${agent} ===`)
      console.table(versions.map((v, i) => {
        const prev = i > 0 ? versions[i - 1] : null
        const healthDelta = prev && v.sessions && prev.sessions
          ? ` (${v.avg_health - prev.avg_health > 0 ? "+" : ""}${(v.avg_health - prev.avg_health).toFixed(1)})`
          : ""
        const tokenDelta = prev && v.sessions && prev.sessions
          ? ` (${v.avg_tokens - prev.avg_tokens > 0 ? "+" : ""}${Math.round(v.avg_tokens - prev.avg_tokens)})`
          : ""
        const costDelta = prev && v.sessions && prev.sessions
          ? ` (${v.avg_cost - prev.avg_cost > 0 ? "+" : ""}${(v.avg_cost - prev.avg_cost).toFixed(4)})`
          : ""

        return {
          version: v.config_hash,
          changed: new Date(v.changed_at).toLocaleString(),
          sessions: v.sessions,
          health: v.sessions ? `${v.avg_health}${healthDelta}` : "-",
          "avg cost": v.sessions ? `$${v.avg_cost}${costDelta}` : "-",
          "avg tokens": v.sessions ? `${Math.round(v.avg_tokens)}${tokenDelta}` : "-",
          "error %": v.sessions ? `${v.error_rate}%` : "-",
        }
      }))
    }
  }

  console.log("\n=== Tools by Agent Version (last 7 days) ===")
  if (tools.length) {
    console.table(tools.map(t => ({
      agent: t.agent || "(default)",
      version: t.config_hash || "-",
      tool: t.tool_name,
      calls: t.calls,
      errors: t.errors,
      "error %": t.calls > 0 ? `${((t.errors / t.calls) * 100).toFixed(1)}%` : "0%",
      "avg ms": t.avg_duration_ms,
    })))
  } else console.log("  No data")

  console.log()
}
