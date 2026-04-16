# opencode-agent-pulse

Agent effectiveness analytics for [OpenCode](https://opencode.ai).

## What it does

Every other OpenCode analytics tool counts tokens and dollars. This one answers the questions that actually matter:

- **Is my agent working?** → Health score (0-100) per session
- **Which tools keep failing?** → Tool success rates and latency, grouped by agent version
- **Did my prompt change help?** → Agent config change tracking with before/after metrics

## Prerequisites

- [Bun](https://bun.sh) — required runtime (the plugin and CLI use `bun:sqlite`)

## Install

```bash
bun add @arcevico/opencode-agent-pulse
```

Add to your `opencode.json`:

```json
{
  "plugin": ["@arcevico/opencode-agent-pulse"]
}
```

Restart OpenCode. Done.

Data is stored locally at `~/.local/share/opencode/agent-pulse.db`.

## Usage

```bash
bunx @arcevico/opencode-agent-pulse
```

Example output:

```
=== Agents (last 7 days) ===
┌───┬────────┬────────┬──────────┬──────────┬────────────┬─────────┐
│   │ agent  │ health │ sessions │ avg cost │ avg tokens │ error % │
├───┼────────┼────────┼──────────┼──────────┼────────────┼─────────┤
│ 0 │ coder  │ 82     │ 15       │ $0.1200  │ 3800       │ 5%      │
│ 1 │ fast   │ 71     │ 8        │ $0.0400  │ 1200       │ 12%     │
└───┴────────┴────────┴──────────┴──────────┴────────────┴─────────┘

=== Evolution: coder ===
┌───┬──────────┬───────────────────┬──────────┬────────────┬──────────────────┬────────────────┬─────────┐
│   │ version  │ changed           │ sessions │ health     │ avg cost         │ avg tokens     │ error % │
├───┼──────────┼───────────────────┼──────────┼────────────┼──────────────────┼────────────────┼─────────┤
│ 0 │ a3f2...  │ 4/10/2026, 14:00  │ 5        │ 65         │ $0.1500          │ 4500           │ 12%     │
│ 1 │ b7c1...  │ 4/12/2026, 09:30  │ 8        │ 82 (+17.0) │ $0.1000 (-0.05)  │ 3200 (-1300)   │ 5%      │
└───┴──────────┴───────────────────┴──────────┴────────────┴──────────────────┴────────────────┴─────────┘

=== Tools by Agent Version (last 7 days) ===
┌───┬────────┬──────────┬────────────┬───────┬────────┬─────────┬────────┐
│   │ agent  │ version  │ tool       │ calls │ errors │ error % │ avg ms │
├───┼────────┼──────────┼────────────┼───────┼────────┼─────────┼────────┤
│ 0 │ coder  │ b7c1...  │ file_write │ 42    │ 1      │ 2.4%    │ 120    │
│ 1 │ coder  │ b7c1...  │ bash       │ 31    │ 3      │ 9.7%    │ 850    │
│ 2 │ coder  │ a3f2...  │ file_write │ 28    │ 4      │ 14.3%   │ 145    │
└───┴────────┴──────────┴────────────┴───────┴────────┴─────────┴────────┘
```

## How it works

The plugin hooks into OpenCode's event system and tracks every session automatically.

When you modify an agent config file (`.opencode/agents/*.md`), the plugin detects the change in real-time via the file watcher — no restart needed. It hashes the new content, creates a new version, and all subsequent sessions are tagged with that version so you can compare performance across config changes.

## Health score

Each session gets a 0-100 score based on:

| Signal | Weight | Logic |
|---|---|---|
| No errors | 30 | Full if clean, partial if 1 error |
| No reverts | 25 | Did the user undo the agent's work? |
| Low retries | 15 | Degrades per retry |
| Tool success | 15 | Ratio of successful tool calls |
| Reasonable steps | 15 | Sweet spot is 2-15 steps |

## Data stored

Every session writes structured data to SQLite:

| Table | What's in it |
|---|---|
| `sessions` | Health score, cost, tokens, tool stats, errors, reverts, config version |
| `tool_executions` | Per-tool success/failure, duration |
| `model_calls` | Per-LLM-call tokens, cost, latency, errors |
| `step_metrics` | Per-step token breakdown |
| `agent_changes` | Every config change with timestamp, hash, and content snapshot |

## License

MIT
