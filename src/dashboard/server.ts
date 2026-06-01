import http from 'node:http'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../types.js'
import { EventBus } from './eventBus.js'
import { Pipeline } from '../detection/pipeline.js'
import { UrlClassifier } from '../detection/urlHeuristic.js'

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Firewall Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; color: #1a1a1a; }
  .container { max-width: 1300px; margin: 0 auto; padding: 24px 16px; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  .header h1 { font-size: 1.25rem; font-weight: 700; }
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4caf50; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  /* Stats bar */
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 18px; min-width: 120px; }
  .stat-label { font-size: 0.72rem; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
  .stat-value { font-size: 1.5rem; font-weight: 700; }
  .stat-value.blocked { color: #d32f2f; }
  .stat-value.warned  { color: #e65100; }
  .stat-value.total   { color: #1565c0; }

  /* Tabs (Premium Segmented Control) */
  .tabs { display: inline-flex; background: #e4e6eb; padding: 4px; border-radius: 8px; margin-bottom: 16px; gap: 2px; }
  .tab-btn { padding: 6px 16px; border: none; background: transparent; cursor: pointer;
    border-radius: 6px; font-size: 0.82rem; font-weight: 500; color: #555; transition: all 0.2s; }
  .tab-btn:hover { color: #1a1a1a; background: rgba(0,0,0,0.04); }
  .tab-btn.active { background: #ffffff; color: #1565c0; font-weight: 600; box-shadow: 0 2px 5px rgba(0,0,0,0.08); }
  .tab-panel { display: none; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
  .tab-panel.active { display: block; }

  /* Events table */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th { text-align: left; padding: 10px 12px; background: #f7f8fa; border-bottom: 2px solid #e0e0e0;
    white-space: nowrap; font-size: 0.75rem; text-transform: uppercase; letter-spacing: .05em; color: #555; }
  td { padding: 9px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  tr.event-row:hover { background: #f7f9ff; cursor: pointer; }
  tr.event-row.selected { background: #e8f0fe; }

  /* Action badges */
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-weight: 700;
    font-size: 0.75rem; color: #fff; white-space: nowrap; }
  .badge-blocked { background: #d32f2f; }
  .badge-warned  { background: #e65100; }

  /* Stage chips */
  .chip { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .chip-heuristic   { background: #fff3cd; color: #856404; }
  .chip-embedding   { background: #ffe0b2; color: #7c3800; }
  .chip-judge       { background: #ffcdd2; color: #7f0000; }
  .chip-none        { background: #e8f5e9; color: #1b5e20; }
  .chip-url-filter  { background: #e8d5f5; color: #6a1b9a; }
  .chip-dlp         { background: #b2dfdb; color: #004d40; }
  .chip-dos         { background: #ffccbc; color: #bf360c; }
  .chip-rag         { background: #d1c4e9; color: #311b92; }

  /* Score bar */
  .score-bar { display: flex; align-items: center; gap: 6px; }
  .bar-track { width: 60px; height: 6px; background: #eee; border-radius: 3px; overflow: hidden; }
  .bar-fill  { height: 100%; border-radius: 3px; }
  .bar-fill.high   { background: #d32f2f; }
  .bar-fill.medium { background: #e65100; }
  .bar-fill.low    { background: #f9a825; }

  /* Payload preview */
  .payload-preview { font-family: monospace; font-size: 0.78rem; color: #555;
    max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Detection detail */
  .detail-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .detail-tag { background: #e8eaed; color: #333; border-radius: 4px;
    padding: 1px 6px; font-size: 0.72rem; font-family: monospace; }

  /* Expandable drawer */
  tr.drawer-row td { padding: 0; border-bottom: 2px solid #c5d0e8; }
  .drawer { background: #f7f9ff; padding: 16px 20px; display: grid;
    grid-template-columns: 1fr 1fr; gap: 16px; }
  .drawer-section h4 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: .06em;
    color: #666; margin-bottom: 8px; }
  .drawer-full { grid-column: 1 / -1; }
  .payload-full { font-family: monospace; font-size: 0.82rem; background: #1e1e1e; color: #d4d4d4;
    padding: 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-all;
    max-height: 200px; overflow-y: auto; line-height: 1.5; }
  .meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 0.82rem; }
  .meta-grid dt { color: #888; white-space: nowrap; }
  .meta-grid dd { font-family: monospace; word-break: break-all; }
  .match-list { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
  .match-pill { background: #fff3cd; color: #856404; border: 1px solid #f0c040;
    border-radius: 4px; padding: 2px 8px; font-size: 0.78rem; font-weight: 600; }
  .nearest-text { font-family: monospace; font-size: 0.78rem; background: #fff; border: 1px solid #e0e0e0;
    border-radius: 4px; padding: 6px 10px; color: #333; word-break: break-all; }
  .sim-value { font-size: 1.1rem; font-weight: 700; color: #d32f2f; }

  #no-events { color: #999; font-size: 0.9rem; padding: 20px; text-align: center; }

  /* Playground */
  .playground-wrap { padding: 20px; }
  .pg-mode { display: inline-flex; background: #e4e6eb; padding: 3px; border-radius: 6px; margin-bottom: 14px; gap: 2px; }
  .pg-mode-btn { padding: 5px 14px; border: none; background: transparent; cursor: pointer; border-radius: 4px; font-size: 0.82rem; font-weight: 500; color: #555; transition: all 0.2s; }
  .pg-mode-btn.active { background: #fff; color: #1565c0; font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  textarea { width: 100%; padding: 10px; font-family: monospace; font-size: 0.9rem;
    border: 1px solid #ccc; border-radius: 6px; resize: vertical; background: #fafafa; min-height: 80px; }
  .pg-url-input { width: 100%; padding: 10px; font-family: monospace; font-size: 0.9rem;
    border: 1px solid #ccc; border-radius: 6px; background: #fafafa; }
  .btn { margin-top: 10px; padding: 7px 18px; background: #1565c0; color: #fff;
    border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 2px 4px rgba(21,101,192,0.15); }
  .btn:hover { background: #1976d2; transform: translateY(-1px); box-shadow: 0 4px 8px rgba(21,101,192,0.25); }
  .btn:active { transform: translateY(0); box-shadow: 0 1px 2px rgba(21,101,192,0.15); }
  .pg-results { margin-top: 20px; border-top: 1px solid #eee; padding-top: 16px; }
  .pg-verdict { font-size: 1.1rem; font-weight: 700; margin-bottom: 16px; }
  .pg-stages { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .pg-stage { border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; background: #fafafa; }
  .pg-stage h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: .05em; color: #666; margin-bottom: 8px; }
  .pg-stage .val { font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; }
  .pg-stage .sub { font-size: 0.78rem; font-family: monospace; color: #555; word-break: break-all; }
  .pg-badge { display: inline-block; padding: 4px 16px; border-radius: 12px; font-weight: 700;
    font-size: 1rem; color: #fff; }
  .pg-badge-BLOCK { background: #d32f2f; }
  .pg-badge-WARN  { background: #e65100; }
  .pg-badge-PASS  { background: #388e3c; }
  .pg-url-result { margin-top: 20px; border-top: 1px solid #eee; padding-top: 16px; }
  .pg-url-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; background: #fafafa; max-width: 400px; }
  .pg-url-card h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: .05em; color: #666; margin-bottom: 8px; }
  .pg-url-reason { font-family: monospace; font-size: 0.84rem; margin-top: 6px; color: #555; }
  .pg-url-checks { margin-top: 14px; display: flex; flex-direction: column; gap: 4px; }
  .pg-check { display: flex; gap: 8px; font-size: 0.81rem; align-items: baseline; }
  .pg-check-icon { font-weight: 700; width: 14px; flex-shrink: 0; }
  .pg-check-pass .pg-check-icon { color: #388e3c; }
  .pg-check-block .pg-check-icon { color: #d32f2f; }
  .pg-check-name { font-weight: 600; color: #333; min-width: 170px; }
  .pg-check-reason { font-family: monospace; font-size: 0.76rem; color: #666; }

  /* Live Traffic */
  .traffic-panel-wrap { padding: 16px; }
  .traffic-stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .chart-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .chart-card-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; color: #555; margin-bottom: 10px; font-weight: 600; }
  #traffic-canvas { display: block; width: 100%; height: 100px; }
  .svc-rows { display: flex; flex-direction: column; gap: 8px; }
  .svc-row { display: flex; align-items: center; gap: 10px; font-size: 0.84rem; }
  .svc-label { min-width: 110px; font-weight: 600; color: #333; }
  .svc-track { flex: 1; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; }
  .svc-fill { height: 100%; border-radius: 4px; background: #1565c0; transition: width 0.4s; }
  .svc-bytes { min-width: 80px; text-align: right; font-family: monospace; font-size: 0.78rem; color: #555; }
  .tlog-wrap { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
  .tlog-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; color: #555; padding: 12px 16px; border-bottom: 1px solid #e0e0e0; font-weight: 600; }
  .tlog { width: 100%; border-collapse: collapse; font-size: 0.81rem; }
  .tlog th { text-align: left; padding: 8px 12px; background: #f7f8fa; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; color: #777; }
  .tlog td { padding: 7px 12px; border-top: 1px solid #f0f0f0; font-family: monospace; }
  .tlog tr:hover { background: #f7f9ff; }
  .svc-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 700; }
  .svc-openai      { background: #d1fae5; color: #065f46; }
  .svc-anthropic   { background: #fde8d8; color: #9a3412; }
  .svc-google      { background: #dbeafe; color: #1e40af; }
  .svc-mistral     { background: #fef3c7; color: #92400e; }
  .svc-huggingface { background: #fce7f3; color: #9d174d; }
  .svc-cohere      { background: #ecfdf5; color: #064e3b; }
  .svc-microsoft   { background: #e0f2fe; color: #0369a1; }
  .svc-npm         { background: #fee2e2; color: #b91c1c; }
  .svc-antigravity { background: #f3e8ff; color: #6b21a8; }
  .svc-local       { background: #f3f4f6; color: #374151; }
  .svc-custom      { background: #ede9fe; color: #5b21b6; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><span class="live-dot"></span>LLM Firewall Dashboard</h1>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-label">Total Events</div><div class="stat-value total" id="s-total">0</div></div>
    <div class="stat"><div class="stat-label">Blocked</div><div class="stat-value blocked" id="s-blocked">0</div></div>
    <div class="stat"><div class="stat-label">Warned</div><div class="stat-value warned" id="s-warned">0</div></div>
    <div class="stat"><div class="stat-label">Heuristic</div><div class="stat-value" id="s-heuristic">0</div></div>
    <div class="stat"><div class="stat-label">Embedding</div><div class="stat-value" id="s-embedding">0</div></div>
    <div class="stat"><div class="stat-label">Judge</div><div class="stat-value" id="s-judge">0</div></div>
    <div class="stat"><div class="stat-label">URL Filter</div><div class="stat-value blocked" id="s-url">0</div></div>
    <div class="stat"><div class="stat-label">Data Loss</div><div class="stat-value warned" id="s-dlp">0</div></div>
    <div class="stat"><div class="stat-label">Rate Limit / DoS</div><div class="stat-value blocked" id="s-dos">0</div></div>
    <div class="stat"><div class="stat-label">RAG Poisoning</div><div class="stat-value blocked" id="s-rag">0</div></div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" onclick="showTab('events', this)">Events</button>
    <button class="tab-btn" onclick="showTab('playground', this)">Prompt Testing</button>
    <button class="tab-btn" onclick="showTab('traffic', this)">Live Traffic</button>
  </div>

  <div id="tab-events" class="tab-panel active">
    <div class="table-wrap">
      <table id="events-table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Time</th>
            <th>Stage</th>
            <th>Endpoint</th>
            <th>Target</th>
            <th>Score</th>
            <th>Similarity</th>
            <th>Detection Detail</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody id="events-body">
          <tr id="no-events"><td colspan="9" id="no-events-cell">No events yet.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div id="tab-playground" class="tab-panel">
    <div class="playground-wrap">
      <div class="pg-mode">
        <button class="pg-mode-btn active" onclick="setPgMode('prompt', this)">Prompt</button>
        <button class="pg-mode-btn" onclick="setPgMode('url', this)">URL</button>
      </div>
      <div id="pg-prompt-wrap">
        <textarea id="prompt-input" rows="3" placeholder="Enter a prompt to analyze..."></textarea>
      </div>
      <div id="pg-url-wrap" style="display:none">
        <input class="pg-url-input" id="url-input" type="text" placeholder="e.g. webhook.site or https://evil.ngrok.io/exfil?data=..." />
      </div>
      <button class="btn" onclick="analyzePrompt()">Analyze</button>
      <div class="pg-results" id="pg-results" style="display:none">
        <div class="pg-verdict">Verdict: <span class="pg-badge" id="pg-badge"></span></div>
        <div class="pg-stages">
          <div class="pg-stage">
            <h3>Stage 1 — Heuristic</h3>
            <div class="val" id="pg-score"></div>
            <div class="sub" id="pg-matches"></div>
          </div>
          <div class="pg-stage">
            <h3>Stage 2 — Embedding</h3>
            <div class="val" id="pg-sim"></div>
            <div class="sub" id="pg-nearest"></div>
          </div>
          <div class="pg-stage">
            <h3>Stage 3 — Judge</h3>
            <div class="val" id="pg-verdict"></div>
          </div>
        </div>
      </div>
      <div class="pg-url-result" id="pg-url-result" style="display:none">
        <div class="pg-verdict">Verdict: <span class="pg-badge" id="pg-url-badge"></span></div>
        <div class="pg-url-card">
          <h3>URL Filter</h3>
          <div class="val" id="pg-url-action"></div>
          <div class="pg-url-reason" id="pg-url-reason"></div>
          <div class="pg-url-checks" id="pg-url-checks"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="tab-traffic" class="tab-panel">
    <div class="traffic-panel-wrap">
      <div class="traffic-stats">
        <div class="stat"><div class="stat-label">Connections</div><div class="stat-value total" id="t-conn">0</div></div>
        <div class="stat"><div class="stat-label">Total Sent</div><div class="stat-value" id="t-sent">—</div></div>
        <div class="stat"><div class="stat-label">Total Received</div><div class="stat-value" id="t-recv">—</div></div>
        <div class="stat"><div class="stat-label">Req / sec</div><div class="stat-value" id="t-rps">0</div></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">Throughput — Bytes / sec (last 60 s)</div>
        <canvas id="traffic-canvas" height="100"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">Service Utilization</div>
        <div class="svc-rows" id="svc-rows"><div style="color:#999;font-size:0.85rem">No traffic yet.</div></div>
      </div>
      <div class="tlog-wrap">
        <div class="tlog-title">Recent Connections</div>
        <table class="tlog">
          <thead><tr><th>Time</th><th>Service</th><th>Host</th><th>Sent</th><th>Received</th></tr></thead>
          <tbody id="tlog-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const stats = { total: 0, blocked: 0, warned: 0, heuristic: 0, embedding: 0, judge: 0, url: 0, dlp: 0, dos: 0, rag: 0 };
function updateStats(ev) {
  stats.total++;
  if (ev.action === 'blocked') stats.blocked++;
  else stats.warned++;
  if (ev.stage === 'heuristic') stats.heuristic++;
  else if (ev.stage === 'embedding') stats.embedding++;
  else if (ev.stage === 'judge') stats.judge++;
  else if (ev.stage === 'url-filter') stats.url++;
  else if (ev.stage === 'dlp') stats.dlp++;
  else if (ev.stage === 'dos') stats.dos++;
  else if (ev.stage === 'rag') stats.rag++;
  document.getElementById('s-total').textContent = stats.total;
  document.getElementById('s-blocked').textContent = stats.blocked;
  document.getElementById('s-warned').textContent = stats.warned;
  document.getElementById('s-heuristic').textContent = stats.heuristic;
  document.getElementById('s-embedding').textContent = stats.embedding;
  document.getElementById('s-judge').textContent = stats.judge;
  document.getElementById('s-url').textContent = stats.url;
  document.getElementById('s-dlp').textContent = stats.dlp;
  document.getElementById('s-dos').textContent = stats.dos;
  document.getElementById('s-rag').textContent = stats.rag;
}

// ── Escape ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Score bar ─────────────────────────────────────────────────────────────────
function scoreBar(score) {
  const pct = Math.min(100, (score / 100) * 100);
  const cls = score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';
  return '<div class="score-bar">' +
    '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
    '<span>' + (score != null ? Number(score).toFixed(0) : '—') + '</span></div>';
}

// ── Detection detail cell ─────────────────────────────────────────────────────
function detailCell(ev) {
  if (ev.stage === 'heuristic' && ev.heuristicMatches && ev.heuristicMatches.length) {
    return '<div class="detail-tags">' +
      ev.heuristicMatches.map(m => '<span class="detail-tag">' + esc(m) + '</span>').join('') +
      '</div>';
  }
  if (ev.stage === 'embedding' && ev.nearestTemplate) {
    return '<span class="detail-tag" title="' + esc(ev.nearestTemplate) + '">' +
      esc(ev.nearestTemplate.slice(0, 40) + (ev.nearestTemplate.length > 40 ? '…' : '')) + '</span>';
  }
  if (ev.stage === 'judge') {
    return '<span class="detail-tag">judge: ' + esc(ev.verdict || 'MALICIOUS') + '</span>';
  }
  if (ev.stage === 'url-filter') {
    return '<span class="detail-tag">' + esc(ev.urlBlockReason || 'url-blocked') + '</span>';
  }
  if (ev.stage === 'dlp') {
    return '<span class="detail-tag">' + esc(ev.dlpType || 'sensitive-data') + '</span>';
  }
  if (ev.stage === 'dos') {
    return '<span class="detail-tag">' + esc(ev.dosReason || 'rate-limit') + '</span>';
  }
  if (ev.stage === 'rag') {
    return '<span class="detail-tag">' + esc(ev.ragTag ? 'poisoned <' + ev.ragTag + '>' : (ev.verdict || 'context-poisoning')) + '</span>';
  }
  return '—';
}

// ── Drawer ────────────────────────────────────────────────────────────────────
let openDrawerId = null;
function toggleDrawer(id, ev) {
  const existingDrawer = document.getElementById('drawer-' + id);
  if (existingDrawer) {
    existingDrawer.remove();
    document.getElementById('row-' + id)?.classList.remove('selected');
    openDrawerId = null;
    return;
  }
  // Close any open drawer
  if (openDrawerId) {
    document.getElementById('drawer-' + openDrawerId)?.remove();
    document.getElementById('row-' + openDrawerId)?.classList.remove('selected');
  }
  openDrawerId = id;
  document.getElementById('row-' + id)?.classList.add('selected');

  const matchesHtml = ev.heuristicMatches && ev.heuristicMatches.length
    ? '<ul class="match-list">' + ev.heuristicMatches.map(m => '<li class="match-pill">' + esc(m) + '</li>').join('') + '</ul>'
    : '<span style="color:#999">None</span>';

  const nearestHtml = ev.nearestTemplate
    ? '<div class="nearest-text">' + esc(ev.nearestTemplate) + '</div>'
    : '<span style="color:#999">—</span>';

  const simHtml = ev.similarity != null && ev.similarity > 0
    ? '<span class="sim-value">' + Number(ev.similarity).toFixed(4) + '</span>'
    : '<span style="color:#999">—</span>';

  const drawerHtml =
    '<tr class="drawer-row" id="drawer-' + id + '"><td colspan="9">' +
    '<div class="drawer">' +
      '<div class="drawer-section drawer-full">' +
        '<h4>Full Payload</h4>' +
        '<div class="payload-full">' + esc(ev.payload_full || ev.payload_preview || '') + '</div>' +
      '</div>' +
      '<div class="drawer-section">' +
        '<h4>Request</h4>' +
        '<dl class="meta-grid">' +
          '<dt>Target</dt><dd>' + esc(ev.target) + '</dd>' +
          '<dt>Method</dt><dd>' + esc(ev.method) + '</dd>' +
          '<dt>Path</dt><dd>' + esc(ev.path) + '</dd>' +
          '<dt>Action</dt><dd>' + esc(ev.action) + '</dd>' +
          '<dt>Time</dt><dd>' + esc(ev.timestamp) + '</dd>' +
          '<dt>ID</dt><dd>' + esc(ev.id) + '</dd>' +
        '</dl>' +
      '</div>' +
      '<div class="drawer-section">' +
        '<h4>Detection</h4>' +
        '<dl class="meta-grid">' +
          '<dt>Stage</dt><dd>' + esc(ev.stage) + '</dd>' +
          '<dt>Score</dt><dd>' + (ev.score != null ? Number(ev.score).toFixed(1) : '—') + '</dd>' +
          '<dt>Similarity</dt><dd>' + simHtml + '</dd>' +
          (ev.verdict ? '<dt>Judge</dt><dd>' + esc(ev.verdict) + '</dd>' : '') +
        '</dl>' +
      '</div>' +
      '<div class="drawer-section">' +
        '<h4>Heuristic Matches</h4>' + matchesHtml +
      '</div>' +
      '<div class="drawer-section">' +
        '<h4>Nearest Attack Template</h4>' + nearestHtml +
      '</div>' +
    '</div>' +
    '</td></tr>';

  const row = document.getElementById('row-' + id);
  if (row) row.insertAdjacentHTML('afterend', drawerHtml);
}

// ── Append event row ──────────────────────────────────────────────────────────
const tbody = document.getElementById('events-body');
const noEventsRow = document.getElementById('no-events');

function appendRow(ev) {
  if (noEventsRow && noEventsRow.parentNode) noEventsRow.parentNode.removeChild(noEventsRow);
  updateStats(ev);

  const actionBadge = '<span class="badge badge-' + esc(ev.action) + '">' + esc((ev.action || '').toUpperCase()) + '</span>';
  const stageChip  = '<span class="chip chip-' + esc(ev.stage) + '">' + esc(ev.stage) + '</span>';
  const endpoint   = esc((ev.method || '') + ' ' + (ev.path || ''));

  const tr = document.createElement('tr');
  tr.className = 'event-row';
  tr.id = 'row-' + ev.id;
  tr.innerHTML =
    '<td>' + actionBadge + '</td>' +
    '<td style="white-space:nowrap;color:#666;font-size:0.8rem">' + esc(ev.timestamp || '') + '</td>' +
    '<td>' + stageChip + '</td>' +
    '<td style="font-family:monospace;font-size:0.8rem">' + endpoint + '</td>' +
    '<td style="color:#555">' + esc(ev.target || '') + '</td>' +
    '<td>' + scoreBar(ev.score) + '</td>' +
    '<td style="font-family:monospace">' + (ev.similarity > 0 ? Number(ev.similarity).toFixed(3) : '—') + '</td>' +
    '<td>' + detailCell(ev) + '</td>' +
    '<td class="payload-preview" title="Click row to expand">' + esc((ev.payload_preview || '').slice(0, 60)) + (ev.payload_preview && ev.payload_preview.length > 60 ? '…' : '') + '</td>';

  tr.onclick = () => toggleDrawer(ev.id, ev);
  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.rows.length > 200) tbody.deleteRow(tbody.rows.length - 1);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const es = new EventSource('/events');
es.onmessage = e => { try { appendRow(JSON.parse(e.data)); } catch(_) {} };

// ── Playground ────────────────────────────────────────────────────────────────
let pgMode = 'prompt';
function setPgMode(mode, btn) {
  pgMode = mode;
  document.querySelectorAll('.pg-mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('pg-prompt-wrap').style.display = mode === 'prompt' ? '' : 'none';
  document.getElementById('pg-url-wrap').style.display = mode === 'url' ? '' : 'none';
  document.getElementById('pg-results').style.display = 'none';
  document.getElementById('pg-url-result').style.display = 'none';
}

async function analyzePrompt() {
  try {
    if (pgMode === 'url') {
      const url = document.getElementById('url-input').value.trim();
      if (!url) return;
      document.getElementById('pg-results').style.display = 'none';
      document.getElementById('pg-url-result').style.display = 'none';
      const res = await fetch('/api/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const d = await res.json();
      const action = (d.action || 'pass').toUpperCase();
      const badge = document.getElementById('pg-url-badge');
      badge.textContent = action;
      badge.className = 'pg-badge pg-badge-' + (action === 'BLOCK' ? 'BLOCK' : 'PASS');
      document.getElementById('pg-url-action').textContent = action === 'BLOCK' ? 'Blocked' : 'Allowed';
      let reason = d.reason || 'clean';
      if (!d.urlFilterEnabled) reason += ' (URL filter disabled in config)';
      document.getElementById('pg-url-reason').textContent = 'Reason: ' + reason;
      document.getElementById('pg-url-checks').innerHTML = (d.checks || []).map(c =>
        '<div class="pg-check pg-check-' + c.result + '">' +
        '<span class="pg-check-icon">' + (c.result === 'block' ? '✗' : '✓') + '</span>' +
        '<span class="pg-check-name">' + esc(c.name) + '</span>' +
        '<span class="pg-check-reason">' + esc(c.reason) + '</span>' +
        '</div>'
      ).join('');
      document.getElementById('pg-url-result').style.display = 'block';
      return;
    }

    const prompt = document.getElementById('prompt-input').value.trim();
    if (!prompt) return;
    document.getElementById('pg-url-result').style.display = 'none';
    document.getElementById('pg-results').style.display = 'none';
    const res = await fetch('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const d = await res.json();

    const action = (d.action || 'PASS').toUpperCase();
    const badge = document.getElementById('pg-badge');
    badge.textContent = action;
    badge.className = 'pg-badge pg-badge-' + (action === 'BLOCK' ? 'BLOCK' : action === 'WARN' ? 'WARN' : 'PASS');

    document.getElementById('pg-score').textContent = d.score != null ? 'Score: ' + Number(d.score).toFixed(1) : 'Score: n/a';
    document.getElementById('pg-matches').textContent = d.heuristicMatches && d.heuristicMatches.length
      ? 'Matched: ' + d.heuristicMatches.join(', ')
      : 'No rule matches';

    document.getElementById('pg-sim').textContent = d.similarity != null ? 'Similarity: ' + Number(d.similarity).toFixed(4) : 'Similarity: n/a';
    document.getElementById('pg-nearest').textContent = d.nearestTemplate
      ? 'Nearest: ' + d.nearestTemplate.slice(0, 80) + (d.nearestTemplate.length > 80 ? '…' : '')
      : 'No match';

    let judgeStatus;
    if (d.verdict) {
      judgeStatus = d.verdict;
    } else if (!d.judgeEnabled) {
      judgeStatus = 'disabled — run llm-fw setup-judge to enable';
    } else if (d.stage === 'heuristic') {
      judgeStatus = 'not reached — blocked at Stage 1';
    } else if (d.stage === 'embedding') {
      judgeStatus = 'not reached — blocked at Stage 2';
    } else {
      judgeStatus = 'not triggered — similarity below warn threshold';
    }
    document.getElementById('pg-verdict').textContent = judgeStatus;
    document.getElementById('pg-results').style.display = 'block';
  } catch(err) {
    alert('Error: ' + err.message);
  }
}

// ── Live Traffic ──────────────────────────────────────────────────────────────
const CHART_LEN = 60;
let chartHead = Math.floor(Date.now() / 1000);
const chartData = Array.from({length: CHART_LEN}, () => ({sent:0, recv:0, n:0}));
const tStats = {conn:0, sent:0, recv:0};
const svcBytes = {};

function fmtB(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
  if (b >= 1024)    return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function advChart() {
  const now = Math.floor(Date.now() / 1000);
  while (chartHead < now) {
    chartHead++;
    chartData[chartHead % CHART_LEN] = {sent:0, recv:0, n:0};
  }
}

function addTraffic(m) {
  advChart();
  const sec = Math.floor(new Date(m.timestamp.replace(' ', 'T')).getTime() / 1000);
  if (sec >= chartHead - CHART_LEN + 1 && sec <= chartHead) {
    chartData[sec % CHART_LEN].sent += m.bytesSent;
    chartData[sec % CHART_LEN].recv += m.bytesReceived;
    chartData[sec % CHART_LEN].n++;
  }
  tStats.conn++;
  tStats.sent += m.bytesSent;
  tStats.recv += m.bytesReceived;
  svcBytes[m.service] = (svcBytes[m.service] || 0) + m.bytesSent + m.bytesReceived;
  document.getElementById('t-conn').textContent = tStats.conn;
  document.getElementById('t-sent').textContent = fmtB(tStats.sent);
  document.getElementById('t-recv').textContent = fmtB(tStats.recv);
  renderSvcs();
  addTlogRow(m);
  drawChart();
}

function renderSvcs() {
  const total = Object.values(svcBytes).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(svcBytes).sort((a, b) => b[1] - a[1]);
  document.getElementById('svc-rows').innerHTML = sorted.map(([svc, bytes]) =>
    '<div class="svc-row">' +
    '<div class="svc-label">' + esc(svc) + '</div>' +
    '<div class="svc-track"><div class="svc-fill" style="width:' + Math.round(bytes / total * 100) + '%"></div></div>' +
    '<div class="svc-bytes">' + fmtB(bytes) + '</div>' +
    '</div>'
  ).join('');
}

const tlogBody = document.getElementById('tlog-body');
function addTlogRow(m) {
  const cls = 'svc-' + m.service.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td>' + esc(m.timestamp || '') + '</td>' +
    '<td><span class="svc-badge ' + cls + '">' + esc(m.service) + '</span></td>' +
    '<td>' + esc(m.host) + '</td>' +
    '<td>' + fmtB(m.bytesSent) + '</td>' +
    '<td>' + fmtB(m.bytesReceived) + '</td>';
  tlogBody.insertBefore(tr, tlogBody.firstChild);
  while (tlogBody.rows.length > 100) tlogBody.deleteRow(tlogBody.rows.length - 1);
}

const tCanvas = document.getElementById('traffic-canvas');
const tCtx = tCanvas ? tCanvas.getContext('2d') : null;
function drawChart() {
  if (!tCtx) return;
  advChart();
  const W = tCanvas.offsetWidth || 800, H = 100;
  tCanvas.width = W; tCanvas.height = H;
  tCtx.clearRect(0, 0, W, H);
  const data = [];
  for (let i = 0; i < CHART_LEN; i++) data.push(chartData[(chartHead - CHART_LEN + 1 + i) % CHART_LEN]);
  const maxV = Math.max(...data.map(d => d.sent + d.recv), 1);
  const step = W / (CHART_LEN - 1);
  // grid
  tCtx.strokeStyle = '#e8e8e8'; tCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(H * i / 4);
    tCtx.beginPath(); tCtx.moveTo(0, y); tCtx.lineTo(W, y); tCtx.stroke();
  }
  // area fill
  tCtx.fillStyle = 'rgba(21,101,192,0.08)';
  tCtx.beginPath();
  data.forEach((d, i) => {
    const x = i * step, y = H - ((d.sent + d.recv) / maxV) * (H - 4);
    i === 0 ? tCtx.moveTo(x, y) : tCtx.lineTo(x, y);
  });
  tCtx.lineTo((CHART_LEN - 1) * step, H); tCtx.lineTo(0, H);
  tCtx.closePath(); tCtx.fill();
  // line
  tCtx.strokeStyle = '#1565c0'; tCtx.lineWidth = 2;
  tCtx.beginPath();
  data.forEach((d, i) => {
    const x = i * step, y = H - ((d.sent + d.recv) / maxV) * (H - 4);
    i === 0 ? tCtx.moveTo(x, y) : tCtx.lineTo(x, y);
  });
  tCtx.stroke();
  document.getElementById('t-rps').textContent = chartData[chartHead % CHART_LEN].n;
}

const trafficEs = new EventSource('/traffic-events');
trafficEs.onmessage = e => { try { addTraffic(JSON.parse(e.data)); } catch(_) {} };

setInterval(drawChart, 1000);
drawChart();

// Historical backlog is replayed by the SSE connection on subscribe — no separate REST fetch needed.
</script>
</body>
</html>`

export function createDashboardServer(config: Config, eventBus: EventBus, pipeline: Pipeline): http.Server {
  const urlClassifier = config.proxy.urlFilter.enabled
    ? new UrlClassifier(config.proxy.urlFilter)
    : null

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
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body) as { prompt?: string; url?: string }

          if (parsed.url !== undefined) {
            const raw = parsed.url.trim()
            if (!raw) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'url is required' }))
              return
            }
            let hostname: string
            let urlPath: string
            try {
              const u = new URL(raw.includes('://') ? raw : 'https://' + raw)
              hostname = u.hostname
              urlPath = u.pathname + u.search
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'invalid url' }))
              return
            }
            const urlResult = urlClassifier
              ? urlClassifier.classifyDetailed(hostname, urlPath)
              : { action: 'pass' as const, reason: 'url-filter-disabled', checks: [] }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ...urlResult, urlFilterEnabled: config.proxy.urlFilter.enabled }))
            return
          }

          const { prompt } = parsed
          if (!prompt || typeof prompt !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'prompt is required' }))
            return
          }
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
          res.end(JSON.stringify({ ...result, judgeEnabled: config.detection.judgeEnabled }))
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

    if (req.method === 'GET' && path === '/traffic-events') {
      eventBus.subscribeTraffic(res)
      return
    }

    if (req.method === 'GET' && path === '/api/metrics/traffic') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 500)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(eventBus.getTrafficMetrics(limit)))
      return
    }

    // Serve the CRL so Windows Schannel can verify revocation status of MITM certs.
    if (req.method === 'GET' && path === '/crl') {
      const crlPath = join(homedir(), '.llm-fw', 'ca.crl')
      if (fs.existsSync(crlPath)) {
        const crlData = fs.readFileSync(crlPath)
        res.writeHead(200, { 'Content-Type': 'application/pkix-crl', 'Content-Length': String(crlData.length) })
        res.end(crlData)
      } else {
        res.writeHead(404)
        res.end()
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
}
