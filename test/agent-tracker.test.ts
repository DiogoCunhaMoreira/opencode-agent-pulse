import { describe, it, expect, beforeEach } from "vitest"
import { join } from "node:path"
import { scanAgentConfigs, detectChanges, initFromDB } from "../src/agent-tracker"

const fixturesDir = join(__dirname, "fixtures")

describe("scanAgentConfigs", () => {
  it("finds agent config files in the project directory", () => {
    const configs = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    expect(configs.has("coder")).toBe(true)
    expect(configs.has("reviewer")).toBe(true)
  })

  it("returns hash, path, and content for each agent", () => {
    const configs = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    const coder = configs.get("coder")!

    expect(coder.hash).toMatch(/^[a-f0-9]{16}$/)
    expect(coder.path).toContain("coder.md")
    expect(coder.content).toContain("coding assistant")
  })

  it("produces consistent hashes for the same content", () => {
    const first = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    const second = scanAgentConfigs(fixturesDir, "/nonexistent-home")

    expect(first.get("coder")!.hash).toBe(second.get("coder")!.hash)
  })

  it("returns empty map when directories do not exist", () => {
    const configs = scanAgentConfigs("/nonexistent", "/nonexistent")
    expect(configs.size).toBe(0)
  })
})

describe("detectChanges", () => {
  beforeEach(() => {
    initFromDB([])
  })

  it("detects new agent configs as changes", () => {
    const configs = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    const changes = detectChanges(configs)

    expect(changes.length).toBe(2)
    const names = changes.map(c => c.agent).sort()
    expect(names).toEqual(["coder", "reviewer"])
  })

  it("reports no changes on second scan with same content", () => {
    const configs = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    detectChanges(configs) // first scan — registers hashes

    const configs2 = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    const changes = detectChanges(configs2)

    expect(changes.length).toBe(0)
  })

  it("detects changes when a known hash differs", () => {
    initFromDB([{ agent: "coder", config_hash: "old_hash_1234567" }])

    const configs = scanAgentConfigs(fixturesDir, "/nonexistent-home")
    const changes = detectChanges(configs)

    const coderChange = changes.find(c => c.agent === "coder")
    expect(coderChange).toBeDefined()
    expect(coderChange!.hash).not.toBe("old_hash_1234567")
  })
})
