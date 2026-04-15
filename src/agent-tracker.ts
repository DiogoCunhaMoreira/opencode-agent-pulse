/**
 * Tracks changes to agent configuration files (.md and opencode.json agents).
 *
 * On startup and on file.watcher.updated events, hashes the agent config files.
 * When a hash differs from the last known hash, records the change.
 * Sessions are tagged with the current config hash so you can compare
 * health scores before/after a prompt change.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export interface AgentConfigState {
  /** agent name → current config hash */
  hashes: Map<string, string>
}

const state: AgentConfigState = { hashes: new Map() }

export function scanAgentConfigs(projectDir: string, homeDir: string): Map<string, { hash: string; path: string; content: string }> {
  const agents = new Map<string, { hash: string; path: string; content: string }>()

  const dirs = [
    join(projectDir, ".opencode", "agents"),
    join(projectDir, ".opencode", "agent"),
    join(homeDir, ".config", "opencode", "agents"),
    join(homeDir, ".config", "opencode", "agent"),
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir).filter((f: any) => f.endsWith(".md"))
      for (const file of files) {
        const name = file.replace(/\.md$/, "")
        const filePath = join(dir, file)
        try {
          const content = readFileSync(filePath, "utf-8")
          const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
          // Project-level overrides global (scanned later = wins)
          agents.set(name, { hash, path: filePath, content })
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // directory not listable
    }
  }

  return agents
}

export function detectChanges(
  current: Map<string, { hash: string; path: string; content: string }>,
): Array<{ agent: string; hash: string; path: string; content: string }> {
  const changes: Array<{ agent: string; hash: string; path: string; content: string }> = []

  for (const [agent, info] of current) {
    const prev = state.hashes.get(agent)
    if (prev !== info.hash) {
      changes.push({ agent, ...info })
      state.hashes.set(agent, info.hash)
    }
  }

  return changes
}

export function getAgentHash(agent: string): string | undefined {
  return state.hashes.get(agent)
}

export function initFromDB(latestHashes: Array<{ agent: string; config_hash: string }>) {
  for (const row of latestHashes) {
    state.hashes.set(row.agent, row.config_hash)
  }
}
