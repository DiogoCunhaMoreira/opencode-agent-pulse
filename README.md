# opencode-agent-pulse

At a time when token maxxing is becoming increasingly important, most analytics tools stop at counting tokens and dollars. But knowing you spent $2.40 on a session tells you nothing about whether your agent actually worked — or whether that prompt tweak you just made improved anything.

**agent-pulse** is an [OpenCode](https://opencode.ai) plugin that tracks what matters: did the agent succeed, how much did it cost, and did your last change make it better or worse?

## The problem

You create agents, tweak their prompts, swap models — but you're flying blind. There's no way to know:

- Is this agent actually performing well, or just expensive?
- I changed the prompt yesterday — did it help?
- Am I spending more tokens than I need to?
- Which version of my agent was the best?

## What agent-pulse gives you

A CLI that shows you, per agent:

- **Health score** (0-100) based on errors, reverts, retries, tool success, and step count
- **Cost and token usage** averages
- **Version-by-version evolution** — every time you change an agent's config, a new version is tracked with before/after metrics
- **Tool performance** — which tools fail, how often, how slow
- **Worst sessions** — so you know where to investigate

## Prerequisites

- [Bun](https://bun.sh) — required runtime (the plugin and CLI use `bun:sqlite`)

## Install

```bash
npm install @arcevico/opencode-agent-pulse
```

Add to your `opencode.json`:

```json
{
  "plugin": ["@arcevico/opencode-agent-pulse"]
}
```

Restart OpenCode. The plugin starts tracking automatically in the background.

## Usage

```bash
# Run the CLI to see your stats
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
```

The evolution table shows you exactly what each config change did — health went up, tokens went down. That's how you know your prompt optimization is working.

## How it works

The plugin hooks into OpenCode's event system and tracks every session automatically. Data is stored locally in SQLite at `~/.local/share/opencode/agent-pulse.db`.

When you modify an agent config file (`.opencode/agents/*.md`), the plugin detects the change in real-time via OpenCode's file watcher — no restart needed. It hashes the new content, creates a new version, and all subsequent sessions are tagged with that version so you can compare performance across config changes.

## Health score

Each session gets a 0-100 score:

| Signal | Weight | Logic |
|---|---|---|
| No errors | 30 | Full if clean, partial if 1 error |
| No reverts | 25 | Did the user undo the agent's work? |
| Low retries | 15 | Degrades per retry |
| Tool success | 15 | Ratio of successful tool calls |
| Reasonable steps | 15 | Sweet spot is 2-15 steps |

## Data stored

| Table | What's in it |
|---|---|
| `sessions` | Health score, cost, tokens, tool stats, errors, reverts, config version |
| `tool_executions` | Per-tool success/failure, duration |
| `model_calls` | Per-LLM-call tokens, cost, latency, errors |
| `step_metrics` | Per-step token breakdown |
| `agent_changes` | Every config change with timestamp, hash, and content snapshot |

## License

MIT
