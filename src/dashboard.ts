import { Database } from "bun:sqlite"
import { createQueries } from "./db"

export function startDashboard(db: Database, port: number) {
  const q = createQueries(db)

  function getData() {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000
    const changes = q.recentAgentChanges.all(20) as any[]

    const enrichedChanges = changes.map(c => {
      const impact = q.healthAroundChange.all(c.id, c.agent) as any[]
      const before = impact.find((r: any) => r.period === "before") || null
      const after = impact.find((r: any) => r.period === "after") || null
      return { ...c, before, after }
    })

    return {
      agents: q.healthBreakdownByAgent.all(since),
      models: q.healthByModel.all(since),
      tools: q.toolStats.all(since),
      worst: q.worstSessions.all(since, 10),
      changes: enrichedChanges,
    }
  }

  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/api/data") {
        return Response.json(getData())
      }

      return new Response(html(), { headers: { "content-type": "text/html" } })
    },
  })

  console.log(`Dashboard running at http://localhost:${port}`)
}

function html() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Pulse</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:system-ui,sans-serif; background:#0a0a0a; color:#e0e0e0; padding:2rem; }
  h1 { font-size:1.5rem; margin-bottom:1.5rem; color:#fff; }
  h2 { font-size:1rem; margin-bottom:.75rem; color:#aaa; text-transform:uppercase; letter-spacing:.05em; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; margin-bottom:1.5rem; }
  .card { background:#141414; border:1px solid #222; border-radius:8px; padding:1.25rem; }
  .full { grid-column:1/-1; }
  canvas { max-height:260px; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th,td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid #1a1a1a; }
  th { color:#888; font-weight:500; }
  .health-good { color:#4ade80; }
  .health-mid  { color:#facc15; }
  .health-bad  { color:#f87171; }
  .empty { color:#555; font-style:italic; }
  .legend { display:flex; flex-wrap:wrap; gap:.75rem; font-size:.75rem; margin-bottom:.75rem; color:#888; }
  .legend span { display:inline-flex; align-items:center; gap:.25rem; }
  .legend .swatch { width:10px; height:10px; border-radius:2px; display:inline-block; }
  .badge { font-size:.65rem; padding:1px 5px; border-radius:3px; margin-left:3px; font-weight:500; }
  .badge-err { background:#7f1d1d; color:#f87171; }
  .badge-rev { background:#713f12; color:#facc15; }
  .badge-retry { background:#1e3a5f; color:#60a5fa; }
  .delta-good { color:#4ade80; font-weight:600; }
  .delta-bad { color:#f87171; font-weight:600; }
  .delta-neutral { color:#888; }
  .delta-arrow { font-size:.8rem; margin:0 .25rem; color:#555; }
  details { margin-top:.35rem; }
  details summary { color:#60a5fa; font-size:.8rem; cursor:pointer; }
  details pre { max-height:300px; overflow-y:auto; background:#0a0a0a; padding:.5rem; border-radius:4px; font-size:.75rem; white-space:pre-wrap; color:#aaa; margin-top:.25rem; border:1px solid #222; }
  .no-impact { color:#555; font-size:.8rem; font-style:italic; }
</style>
</head>
<body>
<h1>Agent Pulse</h1>
<div class="grid" id="root"></div>
<script>
function hCls(score) {
  return score >= 70 ? 'health-good' : score >= 40 ? 'health-mid' : 'health-bad'
}

function delta(before, after, unit, invert) {
  if (before == null || after == null) return '<span class="no-impact">-</span>'
  const d = after - before
  const sign = d > 0 ? '+' : ''
  const good = invert ? d < 0 : d > 0
  const cls = Math.abs(d) < 0.5 ? 'delta-neutral' : good ? 'delta-good' : 'delta-bad'
  const fmt = v => unit === '$' ? '$' + v.toFixed(4) : unit === '%' ? (v * 100).toFixed(1) + '%' : v.toFixed(1)
  return '<span class="'+hCls(before)+'">'+fmt(before)+'</span>'
    + '<span class="delta-arrow">&rarr;</span>'
    + '<span class="'+hCls(after)+'">'+fmt(after)+'</span>'
    + ' <span class="'+cls+'">('+sign+fmt(d)+')</span>'
}

async function load() {
  const res = await fetch('/api/data')
  const d = await res.json()
  const root = document.getElementById('root')

  let html = ''

  // Health by Agent — stacked bar
  const agentLegend = '<div class="legend">'
    + '<span><span class="swatch" style="background:#4ade80"></span>Errors (30)</span>'
    + '<span><span class="swatch" style="background:#a78bfa"></span>Reverts (25)</span>'
    + '<span><span class="swatch" style="background:#facc15"></span>Retries (15)</span>'
    + '<span><span class="swatch" style="background:#60a5fa"></span>Tool Success (15)</span>'
    + '<span><span class="swatch" style="background:#fb923c"></span>Steps (15)</span>'
    + '</div>'
  html += card('Health by Agent', d.agents.length
    ? agentLegend + '<canvas id="cAgent"></canvas>'
    : '<p class="empty">No data yet</p>')

  // Health by Model
  html += card('Health by Model', d.models.length ? '<canvas id="cModel"></canvas>' : '<p class="empty">No data yet</p>')

  // Tool Performance
  html += card('Tool Performance', d.tools.length ? '<canvas id="cTools"></canvas>' : '<p class="empty">No data yet</p>', 'full')

  // Worst Sessions — with badges
  let rows = ''
  for (const s of d.worst) {
    const cls = hCls(s.health_score)
    let badges = ''
    if (s.has_error) badges += '<span class="badge badge-err">err</span>'
    if (s.was_reverted) badges += '<span class="badge badge-rev">revert</span>'
    if (s.retries > 0) badges += '<span class="badge badge-retry">' + s.retries + ' retry</span>'
    rows += '<tr>'
      + '<td class="'+cls+'">'+s.health_score + badges+'</td>'
      + '<td>'+(s.agent||'-')+'</td>'
      + '<td>'+(s.model||'-')+'</td>'
      + '<td>$'+s.total_cost.toFixed(4)+'</td>'
      + '<td>'+s.tool_calls+' ('+s.tool_errors+' err)</td>'
      + '<td>'+(s.user_prompt||'').slice(0,80)+'</td>'
      + '</tr>'
  }
  html += card('Worst Sessions', d.worst.length
    ? '<table><tr><th>Health</th><th>Agent</th><th>Model</th><th>Cost</th><th>Tools</th><th>Prompt</th></tr>'+rows+'</table>'
    : '<p class="empty">No data yet</p>', 'full')

  // Agent Config Changes — with before/after impact
  let crows = ''
  for (const c of d.changes) {
    const healthDelta = delta(
      c.before ? c.before.avg_health : null,
      c.after ? c.after.avg_health : null, '', false)
    const costDelta = delta(
      c.before ? c.before.avg_cost : null,
      c.after ? c.after.avg_cost : null, '$', true)
    const errDelta = delta(
      c.before ? c.before.avg_tool_error_rate : null,
      c.after ? c.after.avg_tool_error_rate : null, '%', true)
    const sessions = (c.before ? c.before.sessions : 0) + ' / ' + (c.after ? c.after.sessions : 0)
    const snapshot = c.snapshot
      ? '<details><summary>View config</summary><pre>'+c.snapshot.replace(/</g,'&lt;')+'</pre></details>'
      : ''
    crows += '<tr>'
      + '<td>'+c.agent+'</td>'
      + '<td>'+new Date(c.changed_at).toLocaleString()+'</td>'
      + '<td>'+healthDelta+'</td>'
      + '<td>'+costDelta+'</td>'
      + '<td>'+errDelta+'</td>'
      + '<td class="delta-neutral">'+sessions+'</td>'
      + '<td>'+snapshot+'</td>'
      + '</tr>'
  }
  html += card('Agent Config Changes', d.changes.length
    ? '<table><tr><th>Agent</th><th>Changed</th><th>Health Impact</th><th>Cost Impact</th><th>Error Rate</th><th>Sessions (before/after)</th><th>Config</th></tr>'+crows+'</table>'
    : '<p class="empty">No changes tracked</p>', 'full')

  root.innerHTML = html

  // Charts
  const baseOpts = {
    responsive: true,
    plugins: { legend: { labels: { color: '#aaa' } } },
    scales: { x: { ticks: { color: '#aaa' } }, y: { ticks: { color: '#aaa' } } }
  }

  if (d.agents.length) {
    new Chart(document.getElementById('cAgent'), {
      type: 'bar',
      data: {
        labels: d.agents.map(a => (a.agent || '(default)') + ' (' + a.sessions + ')'),
        datasets: [
          { label: 'Errors (30)', data: d.agents.map(a => a.avg_error_score), backgroundColor: '#4ade80' },
          { label: 'Reverts (25)', data: d.agents.map(a => a.avg_revert_score), backgroundColor: '#a78bfa' },
          { label: 'Retries (15)', data: d.agents.map(a => a.avg_retry_score), backgroundColor: '#facc15' },
          { label: 'Tool Success (15)', data: d.agents.map(a => a.avg_tool_score), backgroundColor: '#60a5fa' },
          { label: 'Steps (15)', data: d.agents.map(a => a.avg_step_score), backgroundColor: '#fb923c' },
        ]
      },
      options: {
        ...baseOpts,
        scales: {
          x: { stacked: true, ticks: { color: '#aaa' } },
          y: { stacked: true, max: 100, ticks: { color: '#aaa' } }
        },
        plugins: {
          legend: { labels: { color: '#aaa' } },
          tooltip: {
            callbacks: {
              afterBody: function(ctx) {
                const i = ctx[0].dataIndex
                const a = d.agents[i]
                return 'Total: ' + a.avg_health + '/100'
              }
            }
          }
        }
      }
    })
  }

  if (d.models.length) {
    new Chart(document.getElementById('cModel'), {
      type: 'bar',
      data: {
        labels: d.models.map(m => m.model),
        datasets: [
          { label: 'Avg Health', data: d.models.map(m => m.avg_health), backgroundColor: '#c084fc' },
          { label: 'Total Cost ($)', data: d.models.map(m => m.total_cost), backgroundColor: '#fb923c' },
        ]
      },
      options: baseOpts
    })
  }

  if (d.tools.length) {
    new Chart(document.getElementById('cTools'), {
      type: 'bar',
      data: {
        labels: d.tools.map(t => t.tool_name),
        datasets: [
          { label: 'Calls', data: d.tools.map(t => t.calls), backgroundColor: '#60a5fa' },
          { label: 'Errors', data: d.tools.map(t => t.errors), backgroundColor: '#f87171' },
        ]
      },
      options: {
        ...baseOpts,
        indexAxis: 'y',
        plugins: {
          legend: { labels: { color: '#aaa' } },
          tooltip: {
            callbacks: {
              afterLabel: function(ctx) {
                const i = ctx.dataIndex
                const t = d.tools[i]
                const rate = t.calls > 0 ? (t.errors / t.calls * 100).toFixed(1) : '0.0'
                return 'Error rate: ' + rate + '% | Avg: ' + t.avg_duration_ms + 'ms'
              }
            }
          }
        }
      }
    })
  }
}

function card(title, content, cls) {
  return '<div class="card '+(cls||'')+'"><h2>'+title+'</h2>'+content+'</div>'
}

load()
</script>
</body>
</html>`
}
