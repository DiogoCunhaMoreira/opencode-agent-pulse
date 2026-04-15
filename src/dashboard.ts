import { Database } from "bun:sqlite"
import { createQueries } from "./db"

export function startDashboard(db: Database, port: number) {
  const q = createQueries(db)

  function getData() {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000
    return {
      agents: q.healthByAgent.all(since),
      models: q.healthByModel.all(since),
      tools: q.toolStats.all(since),
      worst: q.worstSessions.all(since, 10),
      changes: q.recentAgentChanges.all(20),
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
</style>
</head>
<body>
<h1>Agent Pulse</h1>
<div class="grid" id="root"></div>
<script>
async function load() {
  const res = await fetch('/api/data')
  const d = await res.json()
  const root = document.getElementById('root')

  // Build all HTML first, then insert once
  let html = ''
  html += card('Health by Agent', d.agents.length ? '<canvas id="cAgent"></canvas>' : '<p class="empty">No data yet</p>')
  html += card('Health by Model', d.models.length ? '<canvas id="cModel"></canvas>' : '<p class="empty">No data yet</p>')
  html += card('Tool Performance', d.tools.length ? '<canvas id="cTools"></canvas>' : '<p class="empty">No data yet</p>', 'full')

  // Worst Sessions — table
  let rows = ''
  for (const s of d.worst) {
    const cls = s.health_score >= 70 ? 'health-good' : s.health_score >= 40 ? 'health-mid' : 'health-bad'
    rows += '<tr><td class="'+cls+'">'+s.health_score+'</td><td>'+(s.agent||'-')+'</td><td>'+(s.model||'-')+'</td><td>$'+s.total_cost.toFixed(4)+'</td><td>'+s.tool_calls+' ('+s.tool_errors+' err)</td><td>'+(s.user_prompt||'').slice(0,80)+'</td></tr>'
  }
  html += card('Worst Sessions', d.worst.length
    ? '<table><tr><th>Health</th><th>Agent</th><th>Model</th><th>Cost</th><th>Tools</th><th>Prompt</th></tr>'+rows+'</table>'
    : '<p class="empty">No data yet</p>', 'full')

  // Recent Config Changes — table
  let crows = ''
  for (const c of d.changes) {
    crows += '<tr><td>'+c.agent+'</td><td><code>'+c.config_hash+'</code></td><td>'+new Date(c.changed_at).toLocaleString()+'</td></tr>'
  }
  html += card('Agent Config Changes', d.changes.length
    ? '<table><tr><th>Agent</th><th>Hash</th><th>Changed</th></tr>'+crows+'</table>'
    : '<p class="empty">No changes tracked</p>', 'full')

  // Insert all at once, then bindings chart to canvas
  root.innerHTML = html

  const chartOpts = { responsive:true, plugins:{ legend:{ labels:{ color:'#aaa' }}}, scales:{ x:{ ticks:{ color:'#aaa' }}, y:{ ticks:{ color:'#aaa' }}}}

  if (d.agents.length) {
    new Chart(document.getElementById('cAgent'), {
      type:'bar',
      data:{
        labels: d.agents.map(a => a.agent || '(default)'),
        datasets:[
          { label:'Avg Health', data:d.agents.map(a => a.avg_health), backgroundColor:'#4ade80' },
          { label:'Sessions', data:d.agents.map(a => a.sessions), backgroundColor:'#60a5fa' },
        ]
      },
      options: chartOpts
    })
  }

  if (d.models.length) {
    new Chart(document.getElementById('cModel'), {
      type:'bar',
      data:{
        labels: d.models.map(m => m.model),
        datasets:[
          { label:'Avg Health', data:d.models.map(m => m.avg_health), backgroundColor:'#c084fc' },
          { label:'Total Cost ($)', data:d.models.map(m => m.total_cost), backgroundColor:'#fb923c' },
        ]
      },
      options: chartOpts
    })
  }

  if (d.tools.length) {
    new Chart(document.getElementById('cTools'), {
      type:'bar',
      data:{
        labels: d.tools.map(t => t.tool_name),
        datasets:[
          { label:'Calls', data:d.tools.map(t => t.calls), backgroundColor:'#60a5fa' },
          { label:'Errors', data:d.tools.map(t => t.errors), backgroundColor:'#f87171' },
        ]
      },
      options:{ ...chartOpts, indexAxis:'y' }
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
