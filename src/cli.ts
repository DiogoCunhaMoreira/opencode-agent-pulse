#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { printStats } from "./stats"
import { startDashboard } from "./dashboard"

const dbPath = join(homedir(), ".local", "share", "opencode", "agent-quality.db")

if (!existsSync(dbPath)) {
  console.error("No data yet. Run some OpenCode sessions first.")
  console.error(`Expected DB at: ${dbPath}`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
const command = process.argv[2] || "stats"

if (command === "stats") {
  printStats(db)
} else if (command === "dashboard") {
  const port = Number(process.argv[3]) || 4321
  startDashboard(db, port)
} else {
  console.log("Usage: opencode-agent-pulse [stats|dashboard] [port]")
}
