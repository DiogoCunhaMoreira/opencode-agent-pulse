import { Database } from "bun:sqlite"
import { createQueries } from "./db"

export function printStats(db: Database) {
  const q = createQueries(db)
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000

  const agents = q.healthByAgent.all(since) as any[]
  const models = q.healthByModel.all(since) as any[]
  const tools = q.toolStats.all(since) as any[]
  const worst = q.worstSessions.all(since, 5) as any[]
  const changes = q.recentAgentChanges.all(10) as any[]

  console.log("\n=== Health by Agent (last 7 days) ===")
  if (agents.length) console.table(agents)
  else console.log("  No data")

  console.log("\n=== Health by Model ===")
  if (models.length) console.table(models)
  else console.log("  No data")

  console.log("\n=== Tool Performance ===")
  if (tools.length) console.table(tools)
  else console.log("  No data")

  console.log("\n=== Worst Sessions ===")
  if (worst.length) {
    console.table(worst.map(s => ({
      agent: s.agent || "-",
      model: s.model || "-",
      health: s.health_score,
      cost: `$${s.total_cost.toFixed(4)}`,
      tools: `${s.tool_calls} (${s.tool_errors} err)`,
      prompt: (s.user_prompt || "").slice(0, 60),
    })))
  } else console.log("  No data")

  console.log("\n=== Recent Agent Config Changes ===")
  if (changes.length) {
    console.table(changes.map(c => ({
      agent: c.agent,
      hash: c.config_hash,
      changed: new Date(c.changed_at).toLocaleString(),
    })))
  } else console.log("  No changes tracked")

  console.log()
}
