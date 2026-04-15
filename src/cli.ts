#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { printStats } from "./stats"

const dbPath = join(homedir(), ".local", "share", "opencode", "agent-pulse.db")

if (!existsSync(dbPath)) {
  console.error("No data yet. Run some OpenCode sessions first.")
  console.error(`Expected DB at: ${dbPath}`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
printStats(db)
