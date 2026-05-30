import http from 'node:http'
import { Config } from '../types.js'
import { EventBus } from './eventBus.js'
import { Pipeline } from '../detection/pipeline.js'

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Firewall Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: sans-serif; background: #f5f5f5; color: #222; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 1.4rem; margin-bottom: 16px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .tab-btn {
    padding: 8px 20px; border: 1px solid #ccc; background: #eee;
    cursor: pointer; border-radius: 4px 4px 0 0; font-size: 0.95rem;
  }
  .tab-btn.active { background: #fff; border-bottom-color: #fff; font-weight: 600; }
  .tab-panel { display: none; background: #fff; border: 1px solid #ccc; border-radius: 0 4px 4px 4px; padding: 16px; }
  .tab-panel.active { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th { text-align: left; padding: 8px 10px; background: #f0f0f0; border-bottom: 2px solid #ddd; white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid #eee; vertical-align: top; word-break: break-word; }
  tr.heuristic { background: #fff3cd; }
  tr.embedding  { background: #ffe0b2; }
  tr.judge      { background: #ffcdd2; }
  .preview { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 0.82rem; }
  textarea { width: 100%; padding: 10px; font-family: monospace; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 4px; resize: vertical; }
  .btn { margin-top: 10px; padding: 9px 22px; background: #1976d2; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.95rem; }
  .btn:hover { background: #1565c0; }
  .results { margin-top: 18px; }
  .result-section { margin-bottom: 14px; }
  .result-section h3 { font-size: 0.92rem; color: #555; margin-bottom: 6px; }
  .result-row { font-size: 0.9rem; margin-bottom: 4px; }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 12px; font-weight: 700; font-size: 0.88rem; color: #fff; }
  .badge-BLOCK { background: #d32f2f; }
  .badge-WARN  { background: #e65100; }
  .badge-PASS  { background: #388e3c; }
  .phrases { font-family: monospace; font-size: 0.82rem; color: #555; }
  .nearest { font-family: monospace; font-size: 0.82rem; color: #555; word-break: break-all; }
  #no-events { color: #999; font-size: 0.9rem; padding: 12px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>LLM Firewall Dashboard</h1>
  <div class="tabs">
    <button class="tab-btn active" onclick="showTab('events', this)">Events</button>
    <button class="tab-btn" onclick="showTab('playground', this)">Playground</button>
  </div>

  <div id="tab-events" class="tab-panel active">
    <table id="events-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Stage</th>
          <th>Score</th>
          <th>Similarity</th>
          <th>Target</th>
          <th>Preview</th>
        </tr>
      </thead>
      <tbody id="events-body">
        <tr id="no-events"><td colspan="6" id="no-events-cell">No events yet.</td></tr>
      </tbody>
    </table>
  </div>

  <div id="tab-playground" class="tab-panel">
    <textarea id="prompt-input" rows="8" placeholder="Enter a prompt to analyze..."></textarea>
    <button class="btn" onclick="analyzePrompt()">Analyze</button>
    <div class="results" id="results" style="display:none">
      <div class="result-section">
        <h3>Stage 1 — Heuristic</h3>
        <div class="result-row">Score: <strong id="r-score"></strong></div>
        <div class="result-row phrases" id="r-phrases"></div>
      </div>
      <div class="result-section">
        <h3>Stage 2 — Embedding</h3>
        <div class="result-row">Similarity: <strong id="r-similarity"></strong></div>
        <div class="result-row nearest" id="r-nearest"></div>
      </div>
      <div class="result-section">
        <h3>Stage 3 — Judge</h3>
        <div class="result-row" id="r-verdict"></div>
      </div>
      <div class="result-section">
        <div class="result-row">Verdict: <span class="badge" id="r-badge"></span></div>
      </div>
    </div>
  </div>
</div>

<script>
function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

// SSE event stream
const tbody = document.getElementById('events-body');
const noEventsRow = document.getElementById('no-events');

function appendRow(ev) {
  if (noEventsRow && noEventsRow.parentNode) noEventsRow.parentNode.removeChild(noEventsRow);
  const tr = document.createElement('tr');
  tr.className = ev.stage || '';
  tr.innerHTML =
    '<td>' + esc(ev.timestamp || '') + '</td>' +
    '<td>' + esc(ev.stage || '') + '</td>' +
    '<td>' + (ev.score != null ? Number(ev.score).toFixed(1) : '') + '</td>' +
    '<td>' + (ev.similarity != null ? Number(ev.similarity).toFixed(3) : '') + '</td>' +
    '<td>' + esc(ev.target || '') + '</td>' +
    '<td class="preview" title="' + esc(ev.payload_preview || '') + '">' + esc((ev.payload_preview || '').slice(0, 80)) + '</td>';
  tbody.insertBefore(tr, tbody.firstChild);
  // Cap DOM rows at 100
  while (tbody.rows.length > 100) tbody.deleteRow(tbody.rows.length - 1);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const es = new EventSource('/events');
es.onmessage = function(e) {
  try { appendRow(JSON.parse(e.data)); } catch(_) {}
};

// Playground
async function analyzePrompt() {
  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt) return;
  const resultsEl = document.getElementById('results');
  resultsEl.style.display = 'none';
  try {
    const res = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await res.json();
    document.getElementById('r-score').textContent = data.score != null ? Number(data.score).toFixed(1) : 'n/a';
    const phrases = data.heuristicMatches && data.heuristicMatches.length
      ? 'Matched: ' + data.heuristicMatches.join(', ')
      : 'No matches';
    document.getElementById('r-phrases').textContent = phrases;
    document.getElementById('r-similarity').textContent = data.similarity != null ? Number(data.similarity).toFixed(4) : 'n/a';
    const nearest = data.nearestTemplate
      ? data.nearestTemplate.slice(0, 80) + (data.nearestTemplate.length > 80 ? '...' : '')
      : 'n/a';
    document.getElementById('r-nearest').textContent = 'Nearest: ' + nearest;
    document.getElementById('r-verdict').textContent = data.verdict ? data.verdict : 'disabled';
    const action = (data.action || '').toUpperCase();
    const badge = document.getElementById('r-badge');
    badge.textContent = action || 'PASS';
    badge.className = 'badge badge-' + (action === 'BLOCK' ? 'BLOCK' : action === 'WARN' ? 'WARN' : 'PASS');
    resultsEl.style.display = 'block';
  } catch(err) {
    alert('Error: ' + err.message);
  }
}
</script>
</body>
</html>`

export function createDashboardServer(config: Config, eventBus: EventBus, pipeline: Pipeline): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.dashboard.port}`)
    const path = url.pathname

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }

    if (req.method === 'GET' && path === '/events') {
      eventBus.subscribe(res)
      return
    }

    if (req.method === 'GET' && path === '/api/events') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 500)
      const page = Math.max(parseInt(url.searchParams.get('page') ?? '0', 10), 0)
      const events = eventBus.getRecent(limit, page)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(events))
      return
    }

    if (req.method === 'POST' && path === '/api/test') {
      const MAX_BODY_BYTES = 1 * 1024 * 1024 // 1 MB limit for playground endpoint
      let body = ''
      let bodyBytes = 0
      let tooLarge = false
      req.on('data', chunk => {
        if (tooLarge) return // already rejected; drain silently
        bodyBytes += Buffer.byteLength(chunk)
        if (bodyBytes > MAX_BODY_BYTES) {
          tooLarge = true
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
          req.resume()
          return
        }
        body += chunk
      })
      req.on('end', async () => {
        if (tooLarge) return
        try {
          const { prompt } = JSON.parse(body) as { prompt: string }
          if (!prompt || typeof prompt !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'prompt is required' }))
            return
          }
          // Wrap prompt in Anthropic-shaped request body for the pipeline
          const anthropicBody = JSON.stringify({
            model: 'claude-3-haiku-20240307',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1,
          })
          const result = await pipeline.run(
            '/v1/messages',
            anthropicBody,
            { target: 'playground', method: 'POST', path: '/v1/messages' }
          )
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request read error' }))
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
}
