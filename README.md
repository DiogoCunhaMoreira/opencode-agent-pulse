# opencode-agent-pulse

Agent effectiveness analytics for [OpenCode](https://opencode.ai).

## What it does

Every other OpenCode analytics tool counts tokens and dollars. This one answers the questions that actually matter:

- **Is my agent working?** → Health score (0-100) per session
- **Which tools keep failing?** → Tool success rates and latency
- **Is Sonnet or Opus better for my workflow?** → Model comparison with cost-normalized quality
- **Did my prompt change help?** → Agent config change tracking with before/after metrics

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-agent-quality"]
}
```

Restart OpenCode. Done.

Data is stored locally at `~/.local/share/opencode/agent-quality.db`.

## What gets tracked

Every session writes structured data to SQLite:

| Table | What's in it |
|---|---|
| `sessions` | Health score, cost, tokens, tool stats, errors, reverts, agent config hash |
| `tool_executions` | Per-tool success/failure, duration |
| `model_calls` | Per-LLM-call tokens, cost, latency, errors |
| `step_metrics` | Per-step token breakdown |
| `agent_changes` | Timestamped log of every prompt/config change with content snapshot |

## Health score

Each session gets a 0-100 score based on:

| Signal | Weight | Logic |
|---|---|---|
| No errors | 30 | Full if clean, partial if 1 error |
| No reverts | 25 | Did the user undo the agent's work? |
| Low retries | 15 | Degrades per retry |
| Tool success | 15 | Ratio of successful tool calls |
| Reasonable steps | 15 | Sweet spot is 2-15 steps |