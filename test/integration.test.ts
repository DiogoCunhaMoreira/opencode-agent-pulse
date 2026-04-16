import { describe, it, expect, beforeEach } from "vitest"
import { Database } from "bun:sqlite"
import { createTables, createQueries } from "../src/db"
import { createEventHandler } from "../src/index"

function setup() {
  const db = new Database(":memory:")
  createTables(db)
  const q = createQueries(db)
  const handler = createEventHandler(db, q)
  return { db, q, handler }
}

function userMsg(sessionID: string, agent: string, msgId: string) {
  return {
    type: "message.updated",
    properties: {
      info: {
        role: "user",
        sessionID,
        agent,
        id: msgId,
        model: { modelID: "claude-sonnet", providerID: "anthropic" },
      },
    },
  }
}

function assistantMsg(sessionID: string, msgId: string, opts: {
  modelID?: string, providerID?: string,
  cost?: number, tokens?: any,
  finish?: string, error?: any,
  time?: any,
} = {}) {
  return {
    type: "message.updated",
    properties: {
      info: {
        role: "assistant",
        sessionID,
        id: msgId,
        modelID: opts.modelID || "claude-sonnet",
        providerID: opts.providerID || "anthropic",
        cost: opts.cost || 0,
        tokens: opts.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: opts.finish,
        error: opts.error,
        time: opts.time,
      },
    },
  }
}

function toolPart(sessionID: string, messageID: string, tool: string, status: "completed" | "error", opts: {
  time?: { start: number, end: number },
  error?: string,
} = {}) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID,
        messageID,
        tool,
        state: {
          status,
          time: opts.time || { start: 1000, end: 1500 },
          error: opts.error,
        },
      },
    },
  }
}

function stepPart(sessionID: string, messageID: string, opts: {
  tokens?: any, cost?: number, reason?: string,
} = {}) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID,
        messageID,
        tokens: opts.tokens || { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
        cost: opts.cost || 0.001,
        reason: opts.reason || "endTurn",
      },
    },
  }
}

function retryPart(sessionID: string) {
  return {
    type: "message.part.updated",
    properties: { part: { type: "retry", sessionID } },
  }
}

function textPart(sessionID: string, messageID: string, text: string) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        sessionID,
        messageID,
        text,
        synthetic: false,
      },
    },
  }
}

function sessionIdle(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } }
}

function sessionError(sessionID: string, errorName?: string) {
  return {
    type: "session.error",
    properties: { sessionID, error: errorName ? { name: errorName } : undefined },
  }
}

function sessionRevert(sessionID: string) {
  return {
    type: "session.updated",
    properties: { info: { id: sessionID, revert: true } },
  }
}

describe("integration: createEventHandler", () => {
  let db: Database
  let q: ReturnType<typeof createQueries>
  let handler: ReturnType<typeof createEventHandler>

  beforeEach(() => {
    const s = setup()
    db = s.db
    q = s.q
    handler = s.handler
  })

  it("records a clean session on idle", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(sessionIdle("s1"))

    const rows = db.prepare("SELECT * FROM sessions").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe("coder")
    expect(rows[0].step_count).toBe(2)
    expect(rows[0].health_score).toBe(100)
    expect(rows[0].has_error).toBe(0)
    expect(rows[0].was_reverted).toBe(0)
  })

  it("tracks tool calls and tool errors", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(toolPart("s1", "a1", "read_file", "completed"))
    await handler.handleEvent(toolPart("s1", "a1", "write_file", "completed"))
    await handler.handleEvent(toolPart("s1", "a1", "bash", "error", { error: "timeout" }))
    await handler.handleEvent(sessionIdle("s1"))

    const sessions = db.prepare("SELECT * FROM sessions").all() as any[]
    expect(sessions[0].tool_calls).toBe(3)
    expect(sessions[0].tool_errors).toBe(1)

    const tools = db.prepare("SELECT * FROM tool_executions ORDER BY tool_name").all() as any[]
    expect(tools).toHaveLength(3)
    expect(tools[0].tool_name).toBe("bash")
    expect(tools[0].status).toBe("error")
    expect(tools[0].error).toBe("timeout")
    expect(tools[1].tool_name).toBe("read_file")
    expect(tools[1].status).toBe("completed")
  })

  it("links tool_executions to session via trackingKey", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(toolPart("s1", "a1", "read_file", "completed"))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT session_id FROM sessions").get() as any
    const tool = db.prepare("SELECT session_id FROM tool_executions").get() as any
    expect(tool.session_id).toBe(session.session_id)
  })

  it("records assistant message errors", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(assistantMsg("s1", "a1", {
      finish: "error",
      error: { name: "rate_limit" },
      cost: 0.01,
      tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1000, completed: 2000 },
    }))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT * FROM sessions").get() as any
    expect(session.has_error).toBe(1)
    expect(JSON.parse(session.error_messages)).toContain("rate_limit")

    const calls = db.prepare("SELECT * FROM model_calls").all() as any[]
    expect(calls).toHaveLength(1)
    expect(calls[0].had_error).toBe(1)
    expect(calls[0].error_type).toBe("rate_limit")
    expect(calls[0].duration_ms).toBe(1000)
  })

  it("handles session.error events", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(sessionError("s1", "connection_failed"))

    const session = db.prepare("SELECT * FROM sessions").get() as any
    expect(session.has_error).toBe(1)
    expect(JSON.parse(session.error_messages)).toContain("connection_failed")
  })

  it("marks sessions as reverted", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(sessionRevert("s1"))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT * FROM sessions").get() as any
    expect(session.was_reverted).toBe(1)
    expect(session.health_score).toBeLessThan(100)
  })

  it("accumulates tokens and cost correctly", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(assistantMsg("s1", "a1", {
      cost: 0.005,
      tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 200, write: 50 } },
      finish: "endTurn",
      time: { created: 1000, completed: 2000 },
    }))
    await handler.handleEvent(assistantMsg("s1", "a2", {
      cost: 0.003,
      tokens: { input: 800, output: 300, reasoning: 50, cache: { read: 100, write: 30 } },
      finish: "endTurn",
      time: { created: 3000, completed: 4000 },
    }))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT * FROM sessions").get() as any
    expect(session.total_cost).toBeCloseTo(0.008, 4)
    expect(session.input_tokens).toBe(1800)
    expect(session.output_tokens).toBe(800)
    expect(session.reasoning_tokens).toBe(150)
    expect(session.cache_read).toBe(300)
    expect(session.cache_write).toBe(80)
  })

  it("does not double-count on message.updated replays", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))

    await handler.handleEvent(assistantMsg("s1", "a1", {
      cost: 0.002, tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }))
    await handler.handleEvent(assistantMsg("s1", "a1", {
      cost: 0.005, tokens: { input: 1000, output: 300, reasoning: 50, cache: { read: 0, write: 0 } },
      finish: "endTurn", time: { created: 1000, completed: 2000 },
    }))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT * FROM sessions").get() as any
    expect(session.total_cost).toBeCloseTo(0.005, 4)
    expect(session.input_tokens).toBe(1000)
    expect(session.output_tokens).toBe(300)
  })

  it("records model_calls on finish", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(assistantMsg("s1", "a1", {
      modelID: "claude-opus", providerID: "anthropic",
      cost: 0.01,
      tokens: { input: 2000, output: 1000, reasoning: 200, cache: { read: 500, write: 100 } },
      finish: "endTurn",
      time: { created: 1000, completed: 3000 },
    }))
    await handler.handleEvent(sessionIdle("s1"))

    const calls = db.prepare("SELECT * FROM model_calls").all() as any[]
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe("claude-opus")
    expect(calls[0].provider).toBe("anthropic")
    expect(calls[0].cost).toBeCloseTo(0.01, 4)
    expect(calls[0].duration_ms).toBe(2000)
    expect(calls[0].finish_reason).toBe("endTurn")
    expect(calls[0].had_error).toBe(0)
  })

  it("records step_metrics", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1", {
      tokens: { input: 500, output: 200, reasoning: 50, cache: { read: 100, write: 20 } },
      cost: 0.002, reason: "endTurn",
    }))
    await handler.handleEvent(stepPart("s1", "a1", {
      tokens: { input: 300, output: 100, reasoning: 10, cache: { read: 50, write: 10 } },
      cost: 0.001, reason: "toolUse",
    }))
    await handler.handleEvent(sessionIdle("s1"))

    const steps = db.prepare("SELECT * FROM step_metrics ORDER BY step_index").all() as any[]
    expect(steps).toHaveLength(2)
    expect(steps[0].step_index).toBe(1)
    expect(steps[0].finish_reason).toBe("endTurn")
    expect(steps[1].step_index).toBe(2)
    expect(steps[1].finish_reason).toBe("toolUse")
  })

  it("counts retries", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(retryPart("s1"))
    await handler.handleEvent(retryPart("s1"))
    await handler.handleEvent(retryPart("s1"))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT * FROM sessions").get() as any
    expect(session.retries).toBe(3)
    expect(session.health_score).toBeLessThan(100)
  })

  it("tracks multiple agents separately", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(toolPart("s1", "a1", "read_file", "completed"))

    await handler.handleEvent(userMsg("s1", "reviewer", "m2"))
    await handler.handleEvent(stepPart("s1", "a2"))
    await handler.handleEvent(toolPart("s1", "a2", "grep", "completed"))
    await handler.handleEvent(toolPart("s1", "a2", "grep", "error", { error: "not found" }))
    await handler.handleEvent(sessionIdle("s1"))

    const sessions = db.prepare("SELECT * FROM sessions ORDER BY agent").all() as any[]
    expect(sessions).toHaveLength(2)

    const coder = sessions.find((s: any) => s.agent === "coder")
    const reviewer = sessions.find((s: any) => s.agent === "reviewer")

    expect(coder.tool_calls).toBe(1)
    expect(coder.tool_errors).toBe(0)
    expect(reviewer.tool_calls).toBe(2)
    expect(reviewer.tool_errors).toBe(1)
  })

  it("creates unique session IDs per user message", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(sessionIdle("s1"))

    await handler.handleEvent(userMsg("s1", "coder", "m2"))
    await handler.handleEvent(stepPart("s1", "a2"))
    await handler.handleEvent(sessionIdle("s1"))

    const sessions = db.prepare("SELECT session_id FROM sessions ORDER BY start_time").all() as any[]
    expect(sessions).toHaveLength(2)
    expect(sessions[0].session_id).not.toBe(sessions[1].session_id)
    expect(sessions[0].session_id).toContain("m1")
    expect(sessions[1].session_id).toContain("m2")
  })

  it("captures user prompt from text parts", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(textPart("s1", "m1", "fix the login bug"))
    await handler.handleEvent(sessionIdle("s1"))

    const session = db.prepare("SELECT user_prompt FROM sessions").get() as any
    expect(session.user_prompt).toBe("fix the login bug")
  })

  it("deduplicates replayed user messages", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a2"))
    await handler.handleEvent(sessionIdle("s1"))

    const sessions = db.prepare("SELECT * FROM sessions").all() as any[]
    expect(sessions).toHaveLength(1)
    expect(sessions[0].step_count).toBe(2)
  })

  it("flushes all trackers on new user message", async () => {
    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(userMsg("s1", "coder", "m2"))
    await handler.handleEvent(sessionIdle("s1"))

    const sessions = db.prepare("SELECT * FROM sessions ORDER BY start_time").all() as any[]
    expect(sessions).toHaveLength(2)
    expect(sessions[0].step_count).toBe(1)
  })

  it("healthByAgent query works with tracking keys", async () => {
    const since = Date.now() - 1000

    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(stepPart("s1", "a1"))
    await handler.handleEvent(sessionIdle("s1"))

    const results = q.healthByAgent.all(since) as any[]
    expect(results).toHaveLength(1)
    expect(results[0].agent).toBe("coder")
    expect(results[0].sessions).toBe(1)
  })

  it("toolStats query joins correctly with tracking keys", async () => {
    const since = Date.now() - 1000

    await handler.handleEvent(userMsg("s1", "coder", "m1"))
    await handler.handleEvent(toolPart("s1", "a1", "read_file", "completed"))
    await handler.handleEvent(toolPart("s1", "a1", "read_file", "completed"))
    await handler.handleEvent(toolPart("s1", "a1", "bash", "error", { error: "fail" }))
    await handler.handleEvent(sessionIdle("s1"))

    const tools = q.toolStats.all(since) as any[]
    expect(tools.length).toBeGreaterThanOrEqual(2)

    const readFile = tools.find((t: any) => t.tool_name === "read_file")
    expect(readFile.calls).toBe(2)
    expect(readFile.errors).toBe(0)

    const bash = tools.find((t: any) => t.tool_name === "bash")
    expect(bash.calls).toBe(1)
    expect(bash.errors).toBe(1)
  })
})
