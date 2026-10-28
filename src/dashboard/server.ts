import http from 'node:http'
import fs from 'node:fs'
import { getLlmFwDir } from '../config/paths.js'
import { join } from 'node:path'
import { Config, PipelineResult } from '../types.js'
import { deepMerge } from '../config/config.js'
import { EventBus } from './eventBus.js'
import { MetricsRegistry } from './metrics.js'
import { Pipeline } from '../detection/pipeline.js'
import { SuppressionStore } from '../detection/suppressions.js'
import { getParser } from '../detection/parsers.js'
import { parseDataUrl, summarizeOpaque } from '../detection/media.js'
import { ocrImage, isOcrCandidate } from '../detection/ocr.js'
import { UrlClassifier } from '../detection/urlHeuristic.js'
import { DlpScanner } from '../detection/dlp/scanner.js'
import { playgroundExamplesScript } from './playgroundExamples.js'
import { McpScanner } from '../detection/mcp/scanner.js'
import { CommandScanner } from '../detection/mcp/commands.js'
import { TRANSLATE_LANGUAGES, translateText } from './translate.js'
import { credentialFromAuthHeader, isLoopbackAddr as isLoopback, isLoopbackHostHeader, tokenMatches as matchesToken, generateToken } from '../auth.js'
import { ModuleManager, TOKEN_ECONOMY_ID } from '../modules/registry.js'
import { PromptMonitorModule } from '../modules/builtin/promptMonitor.js'
import { readRuntimeState } from '../cli/runtimeState.js'
import { createLogger } from '../logger.js';

const log = createLogger('dashboard');

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>llm-fw Dashboard</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230a0e14'/%3E%3Cpath d='M32 9 51 16v14c0 12-8 21-19 25-11-4-19-13-19-25V16z' fill='none' stroke='%232dd4ea' stroke-width='5' stroke-linejoin='round'/%3E%3C/svg%3E">
<script>try { var t = localStorage.getItem('llm-fw-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (_) {}</script>
<style>
  /* ── Design tokens ──────────────────────────────────────────────────────── */
  :root {
    color-scheme: light;
    --font-sans: Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --bg: #f3f5f8;
    --bg-elev: #ffffff;
    --bg-sunken: #eceff4;
    --panel: #ffffff;
    --line: #e2e6ed;
    --line-strong: #c9d1dc;
    --text: #141c27;
    --text-2: #46536a;
    --text-3: #76829a;
    --accent: #0b7a8a;
    --accent-strong: #085e6b;
    --accent-soft: #e0f3f5;
    --accent-ink: #ffffff;
    --danger: #c4283a;
    --danger-soft: #fcebee;
    --danger-ink: #8c1d2a;
    --warn: #b4530a;
    --warn-soft: #fff3e4;
    --warn-ink: #85400a;
    --ok: #1d7a3f;
    --ok-soft: #e5f5ea;
    --ok-ink: #155e30;
    --info: #1f5fd0;
    --info-soft: #e8effd;
    --info-ink: #1a49a0;
    --violet: #6b3fc2;
    --violet-soft: #f0e9fc;
    --violet-ink: #51309a;
    --code-bg: #0f172a;
    --code-fg: #d7e0ee;
    --code-accent: #7dd3fc;
    --shadow-1: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.07);
    --shadow-2: 0 8px 24px -12px rgba(16, 24, 40, 0.22);
    --radius: 10px;
    --radius-s: 6px;
    --focus: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #0a0f16;
      --bg-elev: #111822;
      --bg-sunken: #0d131b;
      --panel: #121a25;
      --line: #1f2a38;
      --line-strong: #2d3a4d;
      --text: #e7edf6;
      --text-2: #a4b0c2;
      --text-3: #6e7c91;
      --accent: #2dd4ea;
      --accent-strong: #7ee8f5;
      --accent-soft: rgba(45, 212, 234, 0.13);
      --accent-ink: #04151a;
      --danger: #f26b78;
      --danger-soft: rgba(242, 107, 120, 0.14);
      --danger-ink: #ffb8c0;
      --warn: #f5a623;
      --warn-soft: rgba(245, 166, 35, 0.14);
      --warn-ink: #ffd48c;
      --ok: #42d174;
      --ok-soft: rgba(66, 209, 116, 0.14);
      --ok-ink: #aaf1c2;
      --info: #62a1ff;
      --info-soft: rgba(98, 161, 255, 0.14);
      --info-ink: #b9d3ff;
      --violet: #a98cfb;
      --violet-soft: rgba(169, 140, 251, 0.14);
      --violet-ink: #d4c6ff;
      --code-bg: #070b11;
      --code-fg: #cfd8e6;
      --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-2: 0 10px 30px -12px rgba(0, 0, 0, 0.7);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0a0f16;
    --bg-elev: #111822;
    --bg-sunken: #0d131b;
    --panel: #121a25;
    --line: #1f2a38;
    --line-strong: #2d3a4d;
    --text: #e7edf6;
    --text-2: #a4b0c2;
    --text-3: #6e7c91;
    --accent: #2dd4ea;
    --accent-strong: #7ee8f5;
    --accent-soft: rgba(45, 212, 234, 0.13);
    --accent-ink: #04151a;
    --danger: #f26b78;
    --danger-soft: rgba(242, 107, 120, 0.14);
    --danger-ink: #ffb8c0;
    --warn: #f5a623;
    --warn-soft: rgba(245, 166, 35, 0.14);
    --warn-ink: #ffd48c;
    --ok: #42d174;
    --ok-soft: rgba(66, 209, 116, 0.14);
    --ok-ink: #aaf1c2;
    --info: #62a1ff;
    --info-soft: rgba(98, 161, 255, 0.14);
    --info-ink: #b9d3ff;
    --violet: #a98cfb;
    --violet-soft: rgba(169, 140, 251, 0.14);
    --violet-ink: #d4c6ff;
    --code-bg: #070b11;
    --code-fg: #cfd8e6;
    --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-2: 0 10px 30px -12px rgba(0, 0, 0, 0.7);
  }

  /* ── Base ───────────────────────────────────────────────────────────────── */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  code, pre, kbd, .mono { font-family: var(--font-mono); }
  code { font-size: 0.92em; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  b, strong { font-weight: 600; }
  button, input, select, textarea { font: inherit; color: inherit; }
  :focus-visible { outline: none; box-shadow: var(--focus); }
  ::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  .container { max-width: 1360px; margin: 0 auto; padding: 0 20px 48px; }
  .muted { color: var(--text-3); }
  .dim { color: var(--text-2); }
  .small { font-size: 0.8rem; }
  .text-danger { color: var(--danger); }
  .text-ok { color: var(--ok); }
  .text-warn { color: var(--warn); }
  .td-time { white-space: nowrap; color: var(--text-3); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
  .td-mono { font-family: var(--font-mono); font-size: 0.78rem; white-space: nowrap; }
  .td-dim { color: var(--text-2); }
  .note { font-size: 0.82rem; color: var(--text-2); line-height: 1.5; }
  .eyebrow { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); }
  .status-ok { margin-left: 12px; font-size: 0.82rem; color: var(--ok); }

  /* ── App header ─────────────────────────────────────────────────────────── */
  .app-header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    margin: 0 -20px 22px; padding: 12px 20px;
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand-mark { width: 34px; height: 34px; flex-shrink: 0; color: var(--accent); }
  .brand h1 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; white-space: nowrap; }
  .brand h1 .brand-sub { font-weight: 500; color: var(--text-3); margin-left: 6px; }
  .brand-tagline { font-size: 0.74rem; color: var(--text-3); margin-top: 1px; white-space: nowrap; }
  .header-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .mode-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .mode-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.72rem; font-weight: 600; padding: 4px 10px; border-radius: 999px; cursor: help;
    border: 1px solid transparent; white-space: nowrap;
  }
  .mode-chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .mode-chip.observe { background: var(--warn-soft); color: var(--warn-ink); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
  .mode-chip.sinkhole { background: var(--info-soft); color: var(--info-ink); border-color: color-mix(in srgb, var(--info) 35%, transparent); }
  .mode-chip.gateway { background: var(--violet-soft); color: var(--violet-ink); border-color: color-mix(in srgb, var(--violet) 35%, transparent); }
  .live-pill {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 0.72rem; font-weight: 600; color: var(--ok); padding: 4px 10px 4px 8px;
    border-radius: 999px; background: var(--ok-soft); border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 45%, transparent); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; border-radius: var(--radius-s);
    background: var(--bg-elev); border: 1px solid var(--line); color: var(--text-2); cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .icon-btn:hover { color: var(--text); border-color: var(--line-strong); background: var(--bg-sunken); }
  .icon-btn svg { width: 17px; height: 17px; }
  .icon-btn .icon-moon { display: none; }
  :root[data-theme="dark"] .icon-btn .icon-sun { display: none; }
  :root[data-theme="dark"] .icon-btn .icon-moon { display: block; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .icon-btn .icon-sun { display: none; }
    :root:not([data-theme="light"]) .icon-btn .icon-moon { display: block; }
  }

  /* ── Stat tiles ─────────────────────────────────────────────────────────── */
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 10px; margin-bottom: 22px; }
  .stat {
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 12px 14px 10px; min-width: 0; box-shadow: var(--shadow-1);
    position: relative; overflow: hidden;
  }
  .stat-label { font-size: 0.68rem; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; line-height: 1.3; }
  .stat-value { font-size: 1.5rem; font-weight: 700; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat-primary .stat-value { font-size: 1.75rem; }
  .stat-value.blocked { color: var(--danger); }
  .stat-value.warned  { color: var(--warn); }
  .stat-value.total   { color: var(--accent); }
  .stat-value.saved   { color: var(--ok); }
  .stat-sub { font-size: 0.7rem; color: var(--ok); font-weight: 600; margin-top: 2px; }
  @media (min-width: 900px) {
    .stats { grid-template-columns: repeat(10, minmax(0, 1fr)); }
    .stat.stat-primary { grid-column: span 2; }
    .stat.stat-primary .stat-value { font-size: 2rem; }
  }

  /* ── Tabs ───────────────────────────────────────────────────────────────── */
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 18px; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab-btn {
    position: relative; padding: 10px 14px 11px; border: none; background: transparent; cursor: pointer;
    font-size: 0.86rem; font-weight: 500; color: var(--text-2); white-space: nowrap; border-radius: var(--radius-s) var(--radius-s) 0 0;
    transition: color 0.15s, background 0.15s;
  }
  .tab-btn:hover { color: var(--text); background: var(--bg-sunken); }
  .tab-btn.active { color: var(--text); font-weight: 600; }
  .tab-btn.active::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
  .tab-btn .count {
    display: inline-block; min-width: 20px; padding: 0 6px; margin-left: 6px; border-radius: 999px;
    font-size: 0.7rem; font-weight: 600; line-height: 18px; text-align: center;
    background: var(--bg-sunken); color: var(--text-2); border: 1px solid var(--line);
  }
  .tab-btn.active .count { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .tab-panel { display: none; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-1); overflow: hidden; }
  .tab-panel.active { display: block; }
  .panel-intro { font-size: 0.84rem; color: var(--text-2); line-height: 1.55; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--bg-sunken); }
  .panel-toolbar { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
  .panel-section { padding: 18px; }

  /* ── Inputs ─────────────────────────────────────────────────────────────── */
  .events-filter, .pg-url-input, .settings-select, .settings-input, .pg-translate-select, textarea, select, input[type=text], input[type=number] {
    background: var(--bg-elev); color: var(--text); border: 1px solid var(--line-strong); border-radius: var(--radius-s);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus-visible, select:focus-visible, textarea:focus-visible { border-color: var(--accent); box-shadow: var(--focus); }
  .events-filter { width: 100%; max-width: 460px; padding: 8px 12px 8px 34px; font-size: 0.85rem;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23788398' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: 11px center; }
  textarea { width: 100%; padding: 12px 14px; font-family: var(--font-mono); font-size: 0.86rem; line-height: 1.55; resize: vertical; min-height: 96px; }
  .pg-url-input { width: 100%; padding: 10px 14px; font-family: var(--font-mono); font-size: 0.86rem; }
  select { padding: 6px 30px 6px 10px; font-size: 0.82rem; appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23788398' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; }
  input[type=number], input[type=text] { padding: 6px 10px; font-size: 0.82rem; }
  input[type=checkbox] { accent-color: var(--accent); width: 15px; height: 15px; }
  ::placeholder { color: var(--text-3); }

  /* ── Buttons ────────────────────────────────────────────────────────────── */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    margin-top: 10px; padding: 8px 18px; background: var(--accent); color: var(--accent-ink);
    border: 1px solid transparent; border-radius: var(--radius-s); cursor: pointer; font-size: 0.84rem; font-weight: 600;
    box-shadow: var(--shadow-1); transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
  }
  .btn:hover { background: var(--accent-strong); box-shadow: var(--shadow-2); }
  .btn:active { transform: translateY(1px); box-shadow: none; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-sm { padding: 5px 12px; font-size: 0.78rem; margin-top: 0; }
  .prompts-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--line); }
  .prompts-bar input[type=text] { flex: 1 1 240px; min-width: 160px; }
  .prompts-bar .prompts-spacer { flex: 1 1 auto; }
  .prompts-note { padding: 18px; color: var(--text-2); font-size: 0.84rem; }
  .prompt-text { max-width: 720px; white-space: pre-wrap; overflow-wrap: anywhere; cursor: pointer; }
  .prompt-text.is-clipped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .prompt-meta { color: var(--text-3); font-size: 0.74rem; }
  .btn-ghost { background: var(--bg-elev); color: var(--text); border-color: var(--line-strong); box-shadow: none; }
  .btn-ghost:hover { background: var(--bg-sunken); color: var(--text); box-shadow: none; }

  /* ── Tables ─────────────────────────────────────────────────────────────── */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  th { position: sticky; top: 0; z-index: 1; text-align: left; padding: 10px 14px; background: var(--bg-sunken); border-bottom: 1px solid var(--line);
    white-space: nowrap; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-3); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tr.event-row { transition: background 0.1s; }
  tr.event-row:hover { background: var(--bg-sunken); cursor: pointer; }
  tr.event-row.selected { background: var(--accent-soft); }
  tr.event-row.selected td:first-child { box-shadow: inset 3px 0 0 var(--accent); }

  /* ── Badges & chips ─────────────────────────────────────────────────────── */
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-weight: 700;
    font-size: 0.68rem; letter-spacing: 0.05em; white-space: nowrap; border: 1px solid transparent; }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .badge-blocked { background: var(--danger-soft); color: var(--danger-ink); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .badge-warned  { background: var(--warn-soft); color: var(--warn-ink); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
  .badge-passed  { background: var(--ok-soft); color: var(--ok-ink); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
  .badge-observed { background: transparent; color: var(--danger); border-color: var(--danger); border-style: dashed; }

  .chip { --c: var(--text-2); display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 0.72rem; font-weight: 600;
    font-family: var(--font-mono); background: color-mix(in srgb, var(--c) 13%, transparent); color: var(--c); white-space: nowrap; }
  .chip-heuristic   { --c: #c27a06; }
  .chip-embedding   { --c: #d2581b; }
  .chip-judge       { --c: #c62839; }
  .chip-none        { --c: #1d7a3f; }
  .chip-url-filter  { --c: #7b3fc4; }
  .chip-dlp         { --c: #0b7a8a; }
  .chip-dos         { --c: #b93c15; }
  .chip-rag         { --c: #4f46c8; }
  .chip-mcp-filter  { --c: #0e7490; }
  .chip-ascii-smuggling { --c: #b8236f; }
  .chip-response-exfil { --c: #c0611a; }
  .chip-non-text    { --c: #6d4c9f; }
  .chip-harmful-request { --c: #b4233a; }
  .chip-memory-poisoning { --c: #8a3fb0; }
  .chip-many-shot   { --c: #a35a0c; }
  .chip-crescendo   { --c: #9a4a12; }
  .chip-classifier  { --c: #2a5bd7; }
  .chip-indirect-instruction { --c: #5a48c4; }
  .chip-error       { --c: #6b7280; }
  :root[data-theme="dark"] .chip { color: color-mix(in srgb, var(--c) 65%, white); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .chip { color: color-mix(in srgb, var(--c) 65%, white); } }

  /* ── Score bar ──────────────────────────────────────────────────────────── */
  .score-bar { display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
  .bar-track { width: 64px; height: 6px; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .bar-fill  { height: 100%; border-radius: 3px; }
  .bar-fill.high   { background: var(--danger); }
  .bar-fill.medium { background: var(--warn); }
  .bar-fill.low    { background: #d9a400; }

  .payload-preview { font-family: var(--font-mono); font-size: 0.76rem; color: var(--text-2);
    max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .detail-tag { background: var(--bg-sunken); color: var(--text-2); border: 1px solid var(--line); border-radius: 4px;
    padding: 1px 6px; font-size: 0.7rem; font-family: var(--font-mono); white-space: nowrap; }

  /* ── Event drawer ───────────────────────────────────────────────────────── */
  tr.drawer-row td { padding: 0; border-bottom: 1px solid var(--line); }
  .drawer { background: var(--bg-sunken); padding: 18px 20px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
    border-top: 1px solid var(--line); }
  .drawer-section h4 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 8px; font-weight: 600; }
  .drawer-full { grid-column: 1 / -1; }
  .payload-full, .pg-redacted, .tlog-body-box {
    font-family: var(--font-mono); font-size: 0.8rem; background: var(--code-bg); color: var(--code-fg);
    padding: 12px 14px; border-radius: var(--radius-s); white-space: pre-wrap; word-break: break-all; line-height: 1.55;
    border: 1px solid color-mix(in srgb, var(--code-fg) 12%, transparent);
  }
  .payload-full { max-height: 220px; overflow-y: auto; }
  .meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 0.8rem; }
  .meta-grid dt { color: var(--text-3); white-space: nowrap; }
  .meta-grid dd { font-family: var(--font-mono); word-break: break-all; }
  .match-list { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
  .match-pill { background: var(--warn-soft); color: var(--warn-ink); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
    border-radius: 5px; padding: 2px 8px; font-size: 0.76rem; font-weight: 600; font-family: var(--font-mono); }
  .nearest-text { font-family: var(--font-mono); font-size: 0.78rem; background: var(--bg-elev); border: 1px solid var(--line);
    border-radius: var(--radius-s); padding: 8px 10px; color: var(--text); word-break: break-all; }
  .sim-value { font-size: 1.05rem; font-weight: 700; color: var(--danger); }
  .drawer-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .drawer-actions .btn { margin-top: 0; }

  #no-events { color: var(--text-3); }
  #no-events-cell { padding: 36px 20px; text-align: center; font-size: 0.88rem; }

  /* ── Playground ─────────────────────────────────────────────────────────── */
  .playground-wrap { padding: 18px; }
  .pg-mode { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .pg-mode-btn { padding: 6px 13px; border: 1px solid var(--line); background: var(--bg-elev); cursor: pointer; border-radius: 999px;
    font-size: 0.8rem; font-weight: 500; color: var(--text-2); transition: all 0.15s; }
  .pg-mode-btn:hover { color: var(--text); border-color: var(--line-strong); background: var(--bg-sunken); }
  .pg-mode-btn.active, .pg-mode-btn.active:hover { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
  .pg-translate { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .pg-translate-label { font-size: 0.8rem; color: var(--text-2); }
  .pg-translate-select { padding: 6px 30px 6px 10px; font-size: 0.82rem; max-width: 220px; }
  .pg-translate-btn { margin-top: 0; padding: 6px 14px; font-size: 0.8rem; }
  .pg-translate-status { font-size: 0.8rem; color: var(--text-2); }
  .pg-translate-status.error { color: var(--danger); }

  .pg-results { margin-top: 22px; border-top: 1px solid var(--line); padding-top: 18px; }
  .pg-verdict { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 1rem; font-weight: 600; margin-bottom: 16px; }
  .pg-verdict-note { font-size: 0.8rem; font-weight: 400; color: var(--text-2); }
  .pg-verdict-note.observe { color: var(--warn); }
  .pg-stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .pg-stage { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; background: var(--bg-sunken); }
  .pg-stage h3 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 8px; font-weight: 600; }
  .pg-stage .val { font-size: 1.02rem; font-weight: 700; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
  .pg-stage .sub { font-size: 0.76rem; font-family: var(--font-mono); color: var(--text-2); word-break: break-all; }
  .pg-stage-rag { border-color: color-mix(in srgb, var(--violet) 45%, transparent); background: var(--violet-soft); }
  .pg-stage-ascii { border-color: color-mix(in srgb, #b8236f 45%, transparent); background: color-mix(in srgb, #b8236f 10%, transparent); }
  .pg-stage-ok { border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: var(--ok-soft); color: var(--ok-ink); font-weight: 500; }
  .pg-badge { display: inline-flex; align-items: center; gap: 7px; padding: 5px 14px; border-radius: 999px; font-weight: 700;
    font-size: 0.82rem; letter-spacing: 0.04em; border: 1px solid transparent; }
  .pg-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .pg-badge-BLOCK { background: var(--danger-soft); color: var(--danger-ink); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
  .pg-badge-WARN  { background: var(--warn-soft); color: var(--warn-ink); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
  .pg-badge-PASS  { background: var(--ok-soft); color: var(--ok-ink); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
  .pg-url-result { margin-top: 20px; border-top: 1px solid var(--line); padding-top: 16px; }
  .pg-url-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; background: var(--bg-sunken); max-width: 480px; }
  .pg-url-card h3, .pg-info-card h3 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 10px; font-weight: 600; }
  .pg-url-card .val { font-size: 1.02rem; font-weight: 700; }
  .pg-url-reason { font-family: var(--font-mono); font-size: 0.8rem; margin-top: 6px; color: var(--text-2); }
  .pg-url-checks { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
  .pg-check { display: flex; gap: 10px; font-size: 0.8rem; align-items: baseline; }
  .pg-check-icon { font-weight: 700; width: 14px; flex-shrink: 0; }
  .pg-check-pass .pg-check-icon { color: var(--ok); }
  .pg-check-block .pg-check-icon { color: var(--danger); }
  .pg-check-name { font-weight: 600; color: var(--text); min-width: 170px; }
  .pg-check-reason { font-family: var(--font-mono); font-size: 0.74rem; color: var(--text-2); }

  .pg-upload { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; padding: 14px; border: 1px dashed var(--line-strong);
    border-radius: var(--radius); background: var(--bg-sunken); cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .pg-upload:hover { border-color: var(--accent); background: var(--accent-soft); }
  .pg-upload input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
  .pg-upload-btn { padding: 7px 14px; border: 1px solid var(--accent); background: var(--bg-elev); color: var(--accent);
    border-radius: var(--radius-s); font-size: 0.82rem; font-weight: 600; white-space: nowrap; transition: all 0.15s; }
  .pg-upload:hover .pg-upload-btn { background: var(--accent); color: var(--accent-ink); }
  .pg-upload-hint { font-size: 0.78rem; color: var(--text-2); flex: 1 1 280px; line-height: 1.45; }
  .pg-image-info { font-size: 0.82rem; color: var(--text-2); margin-bottom: 8px; }
  .pg-img-preview { max-height: 96px; max-width: 180px; border-radius: var(--radius-s); border: 1px solid var(--line); margin-top: 8px; display: block; }

  .pg-desc { font-size: 0.84rem; color: var(--text-2); line-height: 1.55; margin-bottom: 14px; max-width: 860px; }
  .pg-examples { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .pg-ex-label { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); width: 100%; margin-bottom: 2px; }
  .pg-ex { padding: 4px 11px; border: 1px solid var(--line); background: var(--bg-elev); border-radius: 999px;
    font-size: 0.78rem; cursor: pointer; color: var(--text-2); transition: all 0.15s; white-space: nowrap; }
  .pg-ex:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .pg-ex.danger { color: var(--danger-ink); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .pg-ex.danger:hover { background: var(--danger-soft); border-color: var(--danger); color: var(--danger-ink); }
  .pg-ex.safe { color: var(--ok-ink); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
  .pg-ex.safe:hover { background: var(--ok-soft); border-color: var(--ok); color: var(--ok-ink); }

  .pg-guardrails-bar { display: flex; gap: 18px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
  .pg-guardrails-bar label { font-size: 0.82rem; font-weight: 500; color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .pg-guardrails-cats { display: flex; gap: 14px; flex-wrap: wrap; }
  .pg-alert { background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger-ink);
    padding: 12px 14px; border-radius: var(--radius-s); margin-bottom: 14px; font-weight: 600; font-family: var(--font-mono); font-size: 0.82rem; }

  .pg-findings { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .pg-finding { display: flex; align-items: center; gap: 8px; font-size: 0.84rem; }
  .pg-finding-type { font-family: var(--font-mono); font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 4px; font-size: 0.78rem; }
  .pg-redacted { margin-top: 10px; }
  .pg-redacted .mark { color: var(--code-accent); font-weight: 700; }

  .pg-info-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; background: var(--bg-sunken); max-width: 640px; margin-top: 16px; }
  .pg-kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 0.82rem; }
  .pg-kv dt { color: var(--text-3); white-space: nowrap; }
  .pg-kv dd { font-family: var(--font-mono); word-break: break-all; }
  .pg-kv dd.strong { font-weight: 700; }
  .pg-tool-pill { display: inline-block; font-family: var(--font-mono); font-size: 0.76rem; background: var(--danger-soft); color: var(--danger-ink);
    border-radius: 4px; padding: 1px 8px; margin: 2px 2px 0 0; }

  /* ── Live Traffic ───────────────────────────────────────────────────────── */
  .traffic-panel-wrap { padding: 18px; }
  .traffic-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .insp-legend { color: var(--text-2); font-size: 0.82rem; margin: 4px 0 14px; }
  .chart-card { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 14px; }
  .chart-card-title { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 12px; font-weight: 600; }
  #traffic-canvas { display: block; width: 100%; height: 100px; }
  .svc-rows { display: flex; flex-direction: column; gap: 8px; }
  .svc-row { display: flex; align-items: center; gap: 12px; font-size: 0.82rem; }
  .svc-label { min-width: 110px; font-weight: 600; color: var(--text); }
  .svc-track { flex: 1; height: 8px; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
  .svc-fill { height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.4s; }
  .svc-bytes { min-width: 80px; text-align: right; font-family: var(--font-mono); font-size: 0.76rem; color: var(--text-2); }
  .tlog-wrap { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .tlog-title { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); padding: 12px 16px; border-bottom: 1px solid var(--line); font-weight: 600; }
  .tlog-title .hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-3); }
  .tlog { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .tlog th { position: static; }
  .tlog td { padding: 8px 14px; border-top: 1px solid var(--line); border-bottom: none; font-family: var(--font-mono); font-size: 0.78rem; }
  .tlog tbody tr:first-child td { border-top: none; }
  .tlog tr:hover { background: var(--bg-sunken); }
  .svc-badge { --c: var(--text-2); display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; font-family: var(--font-sans);
    background: color-mix(in srgb, var(--c) 13%, transparent); color: var(--c); }
  .svc-openai      { --c: #0f8a5f; }
  .svc-anthropic   { --c: #c0541b; }
  .svc-google      { --c: #1f5fd0; }
  .svc-mistral     { --c: #b8780a; }
  .svc-huggingface { --c: #c22a7a; }
  .svc-cohere      { --c: #0a6e5e; }
  .svc-microsoft   { --c: #0a7fb5; }
  .svc-npm         { --c: #c42a2a; }
  .svc-antigravity { --c: #7b3fc4; }
  .svc-local       { --c: #5b6577; }
  .svc-custom      { --c: #6a4fd8; }
  :root[data-theme="dark"] .svc-badge { color: color-mix(in srgb, var(--c) 65%, white); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .svc-badge { color: color-mix(in srgb, var(--c) 65%, white); } }
  .tlog tr.tlog-row { cursor: pointer; }
  .tlog tr.tlog-row.selected { background: var(--accent-soft); }
  .tlog .ip-cell { color: var(--text-2); }
  .tlog .req-cell { color: var(--text-2); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tlog .req-tunnel { color: var(--text-3); font-style: italic; }

  /* ── Modules ────────────────────────────────────────────────────────────── */
  .modules-wrap { padding: 18px; }
  .module-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .module-card { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; transition: opacity 0.2s; }
  .module-card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .module-card-head label { font-size: 0.78rem; color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; }
  .module-card-name { font-weight: 600; font-size: 0.92rem; }
  .module-card-desc { color: var(--text-2); font-size: 0.8rem; margin: 4px 0 14px; line-height: 1.5; }
  .economy-card { margin-bottom: 12px; border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
  .economy-card .module-card-desc { margin-bottom: 0; }
  .module-card-detail { color: var(--text-2); font-size: 0.78rem; margin-top: 12px; overflow-wrap: anywhere; line-height: 1.5; }
  .module-card-action { margin-top: 12px; display: flex; align-items: center; gap: 10px; }
  .module-cards.economy-off .module-card { opacity: 0.5; }
  .module-options { margin-top: 12px; font-size: 0.8rem; }
  .module-options summary { cursor: pointer; color: var(--text-2); font-weight: 500; }
  .module-options summary:hover { color: var(--text); }
  .module-options-form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .module-option { display: flex; align-items: center; gap: 8px; }
  .module-option input[type="number"] { width: 110px; }
  .module-option-list input { flex: 1; min-width: 200px; }
  .module-options-status { color: var(--ok); font-size: 0.78rem; }
  .module-options-status.is-error { color: var(--danger); }
  .module-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 12px; }
  .module-kpi-value { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .module-saved { color: var(--ok); font-weight: 700; }
  .module-observed { color: var(--danger); font-size: 0.7rem; margin-right: 6px; }

  /* ── Traffic drawer ─────────────────────────────────────────────────────── */
  .tlog tr.tlog-drawer-row > td { padding: 0; border-top: 1px solid var(--line); background: var(--bg-sunken); font-family: var(--font-sans); }
  .tlog-drawer { padding: 18px 20px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .tlog-drawer h4 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 8px; font-weight: 600; }
  .tlog-drawer .full { grid-column: 1 / -1; }
  .tlog-drawer dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 0.8rem; }
  .tlog-drawer dt { color: var(--text-3); white-space: nowrap; }
  .tlog-drawer dd { font-family: var(--font-mono); word-break: break-all; }
  .insp-badge { font-size: 0.68rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; font-family: var(--font-sans); border: 1px solid transparent; }
  .insp-yes { background: var(--ok-soft); color: var(--ok-ink); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
  .insp-no { background: var(--bg-sunken); color: var(--text-2); border-color: var(--line-strong); }
  .tlog-body-box { max-height: 320px; overflow-y: auto; }
  .tlog-hdrs { font-family: var(--font-mono); font-size: 0.76rem; background: var(--bg-elev); border: 1px solid var(--line);
    border-radius: var(--radius-s); padding: 8px 10px; max-height: 160px; overflow-y: auto; line-height: 1.6; }
  .tlog-hdrs .hk { color: var(--accent); }
  .tlog-trunc { font-size: 0.74rem; color: var(--danger); margin-top: 6px; }
  .tlog-empty { color: var(--text-3); font-size: 0.8rem; font-family: var(--font-sans); }

  /* ── Settings ───────────────────────────────────────────────────────────── */
  .settings-wrap { padding: 18px; }
  .settings-intro { font-size: 0.86rem; color: var(--text-2); line-height: 1.55; margin-bottom: 14px; max-width: 860px; }
  .settings-group { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 14px; background: var(--bg-elev); }
  .settings-group h3 { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 4px; font-weight: 600; }
  .settings-group .grp-desc { font-size: 0.8rem; color: var(--text-2); margin-bottom: 8px; line-height: 1.5; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-top: 1px solid var(--line); }
  .setting-row:first-of-type { border-top: none; }
  .setting-label { font-size: 0.86rem; color: var(--text); font-weight: 500; }
  .setting-sub { font-size: 0.76rem; color: var(--text-3); margin-top: 2px; line-height: 1.45; }
  .setting-control { flex-shrink: 0; }
  .settings-select { padding: 6px 30px 6px 10px; font-size: 0.82rem; }
  .settings-input { padding: 6px 10px; font-size: 0.82rem; width: 120px; text-align: right; font-family: var(--font-mono); }
  .settings-input[type=text] { width: 190px; text-align: left; }
  .settings-saved { font-size: 0.82rem; color: var(--ok); height: 18px; margin-bottom: 8px; transition: opacity 0.3s; }
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; cursor: pointer; inset: 0; background: var(--line-strong); border-radius: 22px; transition: 0.2s; }
  .slider::before { content: ""; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: 0.2s; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); }
  .switch input:checked + .slider { background: var(--accent); }
  .switch input:checked + .slider::before { transform: translateX(18px); }
  .switch input:focus-visible + .slider { box-shadow: var(--focus); }
  .switch input:disabled + .slider { opacity: 0.5; cursor: not-allowed; }

  /* ── Responsive ─────────────────────────────────────────────────────────── */
  @media (max-width: 760px) {
    .container { padding: 0 14px 32px; }
    .app-header { margin: 0 -14px 16px; padding: 10px 14px; }
    .brand-tagline { display: none; }
    .drawer, .tlog-drawer { grid-template-columns: 1fr; }
    .setting-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .pg-check-name { min-width: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<div class="container">
  <header class="app-header">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
        <rect x="2" y="2" width="60" height="60" rx="14" fill="currentColor" opacity="0.12"/>
        <path d="M32 11 50 18v13c0 11.5-7.6 20-18 23.8C21.6 51 14 42.5 14 31V18z" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/>
        <path d="M24 32.5l5.5 5.5L41 26" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div>
        <h1>llm-fw<span class="brand-sub">Dashboard</span></h1>
        <div class="brand-tagline">Local prompt-injection firewall for LLM traffic</div>
      </div>
    </div>
    <div class="header-right">
      <div id="mode-chips" class="mode-chips"></div>
      <a class="btn btn-ghost btn-sm" href="https://github.com/PIsberg/llm-fw/issues/new" target="_blank" rel="noopener noreferrer" title="Open a bug report or false-positive issue on GitHub">Report on GitHub</a>
      <a class="btn btn-ghost btn-sm" href="mailto:isberg.peter@gmail.com?subject=llm-fw%20bug%20report" title="Email a bug report directly">Report by email</a>
      <span class="live-pill" title="Connected to the event stream"><span class="live-dot"></span>Live</span>
      <button id="theme-toggle" class="icon-btn" type="button" title="Switch between light and dark" aria-label="Switch between light and dark" onclick="toggleTheme()">
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
    </div>
  </header>

  <div class="stats">
    <div class="stat stat-primary"><div class="stat-label">Total Events</div><div class="stat-value total" id="s-total">0</div></div>
    <div class="stat stat-primary"><div class="stat-label">Blocked</div><div class="stat-value blocked" id="s-blocked">0</div></div>
    <div class="stat stat-primary" title="Observe mode: recorded as a block, but the request was forwarded"><div class="stat-label">Would block</div><div class="stat-value blocked" id="s-observed">0</div></div>
    <div class="stat stat-primary"><div class="stat-label">Warned</div><div class="stat-value warned" id="s-warned">0</div></div>
    <div class="stat stat-primary" title="Tokens pruned across requests by Gateway Modules"><div class="stat-label">Tokens Saved</div><div class="stat-value saved" id="stat-tokens-saved">0</div><div id="stat-tokens-pct" class="stat-sub">0% saved</div></div>
    <div class="stat"><div class="stat-label">Heuristic</div><div class="stat-value" id="s-heuristic">0</div></div>
    <div class="stat"><div class="stat-label">Embedding</div><div class="stat-value" id="s-embedding">0</div></div>
    <div class="stat"><div class="stat-label">Judge</div><div class="stat-value" id="s-judge">0</div></div>
    <div class="stat"><div class="stat-label">URL Filter</div><div class="stat-value blocked" id="s-url">0</div></div>
    <div class="stat"><div class="stat-label">Data Loss</div><div class="stat-value warned" id="s-dlp">0</div></div>
    <div class="stat"><div class="stat-label">Rate Limit / DoS</div><div class="stat-value blocked" id="s-dos">0</div></div>
    <div class="stat"><div class="stat-label">RAG Poisoning</div><div class="stat-value blocked" id="s-rag">0</div></div>
    <div class="stat"><div class="stat-label">MCP / Tool Use</div><div class="stat-value blocked" id="s-mcp">0</div></div>
    <div class="stat"><div class="stat-label">ASCII Smuggling</div><div class="stat-value blocked" id="s-ascii">0</div></div>
    <div class="stat"><div class="stat-label">Response Exfil</div><div class="stat-value blocked" id="s-exfil">0</div></div>
  </div>

  <nav class="tabs" aria-label="Dashboard sections">
    <button class="tab-btn active" onclick="showTab('events', this)">Events</button>
    <button class="tab-btn" onclick="showTab('playground', this)">Prompt Testing</button>
    <button class="tab-btn" onclick="showTab('traffic', this)">Live Traffic</button>
    <button class="tab-btn" onclick="showTab('mcp', this)">MCP Traffic <span id="mcp-count" class="count">0</span></button>
    <button class="tab-btn" onclick="showTab('prompts', this)">Prompts</button>
    <button class="tab-btn" onclick="showTab('modules', this)">Modules</button>
    <button class="tab-btn" onclick="showTab('settings', this)">Settings</button>
  </nav>

  <div id="tab-events" class="tab-panel active">
    <div class="panel-toolbar">
      <input id="events-filter" class="events-filter" type="search" placeholder="Filter by event ID, endpoint, target or payload" oninput="filterEvents(this.value)">
    </div>
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
          <tr id="no-events"><td colspan="9" id="no-events-cell">No events yet. Blocked and warned requests appear here as they happen.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div id="tab-mcp" class="tab-panel">
    <p class="panel-intro">MCP and tool-use traffic that passed every check: the tools each request exposed to the model. Blocks and warnings stay in Events.</p>
    <div class="table-wrap">
      <table id="mcp-table">
        <thead>
          <tr>
            <th>Action</th><th>Time</th><th>Stage</th><th>Endpoint</th><th>Target</th><th>Score</th><th>Similarity</th><th>Detection Detail</th><th>Payload</th>
          </tr>
        </thead>
        <tbody id="mcp-body"></tbody>
      </table>
    </div>
  </div>

  <div id="tab-prompts" class="tab-panel">
    <p class="panel-intro">What users typed, newest first. The Prompt Monitor keeps the newest user message of each request in memory only, with secrets redacted, and forgets everything when you switch it off or the process stops. Tool results, system text and assistant turns are never kept.</p>
    <div class="prompts-bar">
      <label><input type="checkbox" id="prompts-toggle"> Monitoring</label>
      <span class="prompts-spacer"></span>
      <span id="prompts-count" class="prompt-meta"></span>
      <button type="button" class="btn btn-sm" id="prompts-refresh">Refresh</button>
      <button type="button" class="btn btn-sm" id="prompts-clear">Clear</button>
    </div>
    <div class="prompts-bar" id="prompts-filters">
      <input type="text" id="prompts-search" placeholder="Search prompts (every word must match)" aria-label="Search prompts">
      <select id="prompts-target" aria-label="Filter by target"><option value="">All targets</option></select>
      <select id="prompts-model" aria-label="Filter by model"><option value="">All models</option></select>
      <select id="prompts-session" aria-label="Filter by client"><option value="">All clients</option></select>
      <select id="prompts-range" aria-label="Filter by time">
        <option value="">Any time</option>
        <option value="3600000">Last hour</option>
        <option value="86400000">Last 24 hours</option>
        <option value="604800000">Last 7 days</option>
      </select>
    </div>
    <div id="prompts-off" class="prompts-note" hidden>Prompt monitoring is off. Switch it on to start keeping the prompts users type.</div>
    <div class="table-wrap">
      <table class="tlog" id="prompts-table">
        <thead><tr><th>Time</th><th>Client</th><th>Target</th><th>Model</th><th>Prompt</th></tr></thead>
        <tbody id="prompts-body"></tbody>
      </table>
    </div>
    <div class="prompts-bar"><button type="button" class="btn btn-sm" id="prompts-more" hidden>Load more</button></div>
  </div>

  <div id="tab-modules" class="tab-panel">
    <p class="panel-intro">Gateway modules rewrite a request before DLP and detection scan it, so both see the body that is forwarded, on the proxy and the gateway alike. A module that fails is skipped and the request continues. Under observe mode the request goes upstream unmodified, and the figures are what would have been saved.</p>
    <div class="modules-wrap">
      <div class="module-card economy-card" id="token-economy-card">
        <div class="module-card-head"><span class="module-card-name">Token Economy</span>
        <label><input type="checkbox" id="token-economy-toggle"> Enabled</label></div>
        <div class="module-card-desc" id="token-economy-desc">The parent of every module below. Off, no module runs on the proxy or the gateway, and each keeps its own switch for when it comes back on.</div>
      </div>
      <div class="module-cards" id="module-cards"></div>
      <div class="tlog-wrap">
        <div class="tlog-title">Recent Activity</div>
        <table class="tlog">
          <thead><tr><th>Time</th><th>Module</th><th>Target</th><th>Path</th><th>Original tokens</th><th>After</th><th>Saved</th></tr></thead>
          <tbody id="modules-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="tab-playground" class="tab-panel">
    <div class="playground-wrap">
      <div class="pg-mode" id="pg-cats">
        <button class="pg-mode-btn active" data-cat="injection" onclick="setPgCat('injection', this)">Prompt Injection</button>
        <button class="pg-mode-btn" data-cat="ascii" onclick="setPgCat('ascii', this)">ASCII Smuggling</button>
        <button class="pg-mode-btn" data-cat="image" onclick="setPgCat('image', this)">Image / Document</button>
        <button class="pg-mode-btn" data-cat="rag" onclick="setPgCat('rag', this)">RAG Poisoning</button>
        <button class="pg-mode-btn" data-cat="dlp" onclick="setPgCat('dlp', this)">Data Loss</button>
        <button class="pg-mode-btn" data-cat="mcp" onclick="setPgCat('mcp', this)">MCP Tools</button>
        <button class="pg-mode-btn" data-cat="guardrails" onclick="setPgCat('guardrails', this)">Security Guardrails</button>
        <button class="pg-mode-btn" data-cat="url" onclick="setPgCat('url', this)">URL / Exfil</button>
        <button class="pg-mode-btn" data-cat="dos" onclick="setPgCat('dos', this)">Rate Limit / DoS</button>
      </div>

      <div class="pg-desc" id="pg-desc"></div>
      <div class="pg-examples" id="pg-examples"></div>

      <div id="pg-text-wrap">
        <textarea id="prompt-input" rows="4" placeholder="Enter text to analyze, or click an example above..." oninput="onPromptInput()"></textarea>
        <div class="pg-translate" id="pg-translate">
          <span class="pg-translate-label">Translate to</span>
          <select id="translate-lang" class="pg-translate-select"></select>
          <button class="btn pg-translate-btn" type="button" onclick="translateInjection(this)">Translate</button>
          <span id="translate-status" class="pg-translate-status"></span>
        </div>
      </div>
      <div id="pg-image-wrap" style="display:none">
        <label class="pg-upload">
          <input type="file" id="image-file" accept="image/*,application/pdf,text/plain,text/markdown,text/csv,application/json,.txt,.md,.csv,.json" onchange="onImageFile(this)" />
          <span class="pg-upload-btn">Choose a file…</span>
          <span class="pg-upload-hint">Upload any image, PDF, or text/JSON file (max 8 MB) — it's wrapped as a content block and run through the firewall, exactly as a model would receive it.</span>
        </label>
        <div id="pg-image-info" class="pg-image-info"></div>
      </div>
      <div id="pg-url-wrap" style="display:none">
        <input class="pg-url-input" id="url-input" type="text" placeholder="e.g. webhook.site or https://evil.ngrok.io/exfil?data=..." />
      </div>
      <div id="pg-mcp-wrap" style="display:none">
        <input class="pg-url-input" id="mcp-input" type="text" placeholder="Tool name(s), comma-separated — e.g. execute_command, read_file" />
      </div>
      <div id="pg-guardrails-wrap" style="display:none">
        <div class="pg-guardrails-bar">
          <label for="guardrails-tool">Simulated tool
            <select id="guardrails-tool">
              <option value="bash">bash</option>
              <option value="execute_command">execute_command</option>
              <option value="ctx_shell">ctx_shell</option>
              <option value="powershell">powershell</option>
            </select>
          </label>
          <div class="pg-guardrails-cats">
            <label><input type="checkbox" id="guardrails-cat-a" checked /> Cat A (FS)</label>
            <label><input type="checkbox" id="guardrails-cat-b" checked /> Cat B (Network)</label>
            <label><input type="checkbox" id="guardrails-cat-c" checked /> Cat C (Process)</label>
            <label><input type="checkbox" id="guardrails-cat-d" checked /> Cat D (Dev/Infra)</label>
          </div>
        </div>
        <textarea id="guardrails-input" rows="3" placeholder="Enter shell command or query to analyze, e.g. rm -rf /"></textarea>
      </div>

      <button class="btn" id="pg-analyze-btn" onclick="analyzePrompt()">Analyze</button>

      <div class="pg-results" id="pg-result" style="display:none"></div>
    </div>
  </div>

  <div id="tab-traffic" class="tab-panel">
    <div class="traffic-panel-wrap">
      <div class="traffic-stats">
        <div class="stat"><div class="stat-label">Connections</div><div class="stat-value total" id="t-conn">0</div></div>
        <div class="stat"><div class="stat-label">Total Sent</div><div class="stat-value" id="t-sent">—</div></div>
        <div class="stat"><div class="stat-label">Total Received</div><div class="stat-value" id="t-recv">—</div></div>
        <div class="stat"><div class="stat-label">Req / sec</div><div class="stat-value" id="t-rps">0</div></div>
        <div class="stat" title="Connections to a target AI host: TLS-intercepted and scanned"><div class="stat-label">Inspected</div><div class="stat-value saved" id="t-inspected">0</div></div>
        <div class="stat" title="Connections to any other host: tunneled end-to-end, never decrypted or scanned"><div class="stat-label">Not inspected</div><div class="stat-value" id="t-tunneled">0</div></div>
      </div>
      <p class="insp-legend">Only hosts in <code>targets</code> / <code>interceptDomains</code> are decrypted and scanned. Every other connection is a <b>Not inspected</b> tunnel: llm-fw sees its host and byte counts, never its contents.</p>
      <div class="chart-card">
        <div class="chart-card-title">Throughput — Bytes / sec (last 60 s)</div>
        <canvas id="traffic-canvas" height="100"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">Service Utilization</div>
        <div class="svc-rows" id="svc-rows"><div class="muted small">No traffic yet.</div></div>
      </div>
      <div class="tlog-wrap">
        <div class="tlog-title">Recent Connections <span class="hint">— click a row for full request details</span></div>
        <table class="tlog">
          <thead><tr><th>Time</th><th>From IP</th><th>Inspection</th><th>Service</th><th>Host</th><th>Request</th><th>Sent</th><th>Received</th></tr></thead>
          <tbody id="tlog-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="tab-settings" class="tab-panel">
    <div class="settings-wrap">
      <div class="settings-intro">
        Enable or disable each defense (attack type) the firewall enforces. Changes apply
        immediately to live proxy traffic and are saved to <code>~/.llm-fw/config.json</code> —
        no restart required.
      </div>
      <div class="settings-saved" id="settings-saved"></div>
      <div id="settings-body"></div>
    </div>
  </div>
</div>
<script>
// ── Tabs ──────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('llm-fw-theme', root.dataset.theme); } catch (_) {}
  if (typeof drawChart === 'function') drawChart();
}

function showTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'prompts') loadPrompts(true);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const stats = { total: 0, blocked: 0, observed: 0, warned: 0, heuristic: 0, embedding: 0, judge: 0, url: 0, dlp: 0, dos: 0, rag: 0, mcp: 0, ascii: 0, exfil: 0 };
// A block recorded under observe mode (enforced: false) refused nothing.
function isObservedBlock(ev) { return ev.action === 'blocked' && ev.enforced === false; }
function resetStats() {
  for (const k of Object.keys(stats)) stats[k] = 0;
  renderStats();
}
function updateStats(ev) {
  stats.total++;
  if (isObservedBlock(ev)) stats.observed++;
  else if (ev.action === 'blocked') stats.blocked++;
  else if (ev.action === 'warned') stats.warned++;
  // We do not increment warned/blocked for 'passed'
  if (ev.stage === 'heuristic') stats.heuristic++;
  else if (ev.stage === 'embedding') stats.embedding++;
  else if (ev.stage === 'judge') stats.judge++;
  else if (ev.stage === 'url-filter') stats.url++;
  else if (ev.stage === 'dlp') stats.dlp++;
  else if (ev.stage === 'dos') stats.dos++;
  else if (ev.stage === 'rag') stats.rag++;
  else if (ev.stage === 'mcp-filter') stats.mcp++;
  else if (ev.stage === 'ascii-smuggling') stats.ascii++;
  else if (ev.stage === 'response-exfil') stats.exfil++;
  renderStats();
}
function renderStats() {
  document.getElementById('s-total').textContent = stats.total;
  document.getElementById('s-blocked').textContent = stats.blocked;
  document.getElementById('s-observed').textContent = stats.observed;
  document.getElementById('s-warned').textContent = stats.warned;
  document.getElementById('s-heuristic').textContent = stats.heuristic;
  document.getElementById('s-embedding').textContent = stats.embedding;
  document.getElementById('s-judge').textContent = stats.judge;
  document.getElementById('s-url').textContent = stats.url;
  document.getElementById('s-dlp').textContent = stats.dlp;
  document.getElementById('s-dos').textContent = stats.dos;
  document.getElementById('s-rag').textContent = stats.rag;
  if (document.getElementById('s-mcp')) document.getElementById('s-mcp').textContent = stats.mcp;
  if (document.getElementById('s-ascii')) document.getElementById('s-ascii').textContent = stats.ascii;
  if (document.getElementById('s-exfil')) document.getElementById('s-exfil').textContent = stats.exfil;
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
  if (ev.stage === 'mcp-filter') {
    return '<span class="detail-tag">' + esc(ev.mcpTool ? 'tool: ' + ev.mcpTool : 'mcp-policy') + '</span>';
  }
  if (ev.stage === 'ascii-smuggling') {
    return '<span class="detail-tag">' + esc(ev.smuggleRanges && ev.smuggleRanges.length ? ev.smuggleRanges.join(', ') : 'hidden-chars') + '</span>';
  }
  if (ev.stage === 'response-exfil') {
    return '<span class="detail-tag" title="' + esc(ev.exfilUrl || '') + '">' + esc(ev.exfilUrl ? ev.exfilUrl.slice(0, 40) + (ev.exfilUrl.length > 40 ? '…' : '') : 'exfil-url') + '</span>';
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
    : '<span class="muted">None</span>';

  const nearestHtml = ev.nearestTemplate
    ? '<div class="nearest-text">' + esc(ev.nearestTemplate) + '</div>'
    : '<span class="muted">—</span>';

  const simHtml = ev.similarity != null && ev.similarity > 0
    ? '<span class="sim-value">' + Number(ev.similarity).toFixed(4) + '</span>'
    : '<span class="muted">—</span>';
  const bugLinks = buildEventBugLinks(ev);

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
          '<dt>Event ID</dt><dd>' + esc(id) + '</dd>' +
          '<dt>Target</dt><dd>' + esc(ev.target) + '</dd>' +
          '<dt>Method</dt><dd>' + esc(ev.method) + '</dd>' +
          '<dt>Path</dt><dd>' + esc(ev.path) + '</dd>' +
          '<dt>Action</dt><dd>' + esc(ev.action) + (isObservedBlock(ev) ? ' (observe mode: not enforced, request forwarded)' : ev.withheld === true ? ' (tool output withheld from the model, rest of the request forwarded)' : '') + '</dd>' +
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
      '<div class="drawer-section drawer-full drawer-actions">' +
        '<button class="btn btn-ghost btn-sm" id="wl-btn-' + esc(id) + '" title="Records the event in whitelist.json for review. It does not change what future requests get">Record as false positive (audit only)</button>' +
        '<span id="wl-status-' + esc(id) + '" class="status-ok"></span>' +
        // Only a block about one scanned text carries a suppressionKey; on a
        // DLP, URL or rate block the button would store an entry nothing reads.
        (ev.action === 'blocked' && ev.suppressionKey
          ? '<button class="btn btn-sm" id="fp-btn-' + esc(id) + '" title="Remember this exact prompt so an identical future request warns instead of blocking">Mark false positive (suppress future matches)</button>' +
            '<span id="fp-status-' + esc(id) + '" class="status-ok"></span>'
          : '') +
        '<a class="btn btn-ghost btn-sm" id="gh-bug-' + esc(id) + '" href="' + esc(bugLinks.github) + '" target="_blank" rel="noopener noreferrer" title="Open a pre-filled GitHub issue for this event">Report on GitHub</a>' +
        '<a class="btn btn-ghost btn-sm" id="mail-bug-' + esc(id) + '" href="' + esc(bugLinks.mailto) + '" title="Email a pre-filled report for this event">Report by email</a>' +
      '</div>' +
    '</div>' +
    '</td></tr>';

  const row = document.getElementById('row-' + id);
  if (row) {
    row.insertAdjacentHTML('afterend', drawerHtml);
    // Wire the handler in JS (rather than an inline onclick) so the event id
    // never has to be quote-escaped inside this HTML template literal.
    const wlBtn = document.getElementById('wl-btn-' + id);
    if (wlBtn) wlBtn.onclick = () => whitelistEvent(id, wlBtn);
    const fpBtn = document.getElementById('fp-btn-' + id);
    if (fpBtn) fpBtn.onclick = () => suppressEvent(id, fpBtn);
  }
}

function buildEventBugLinks(ev) {
  const title = '[Detection report] ' + (ev.action || 'event') + ' at stage ' + (ev.stage || 'none') + ' (' + (ev.method || '') + ' ' + (ev.path || '') + ')';
  const matches = ev.heuristicMatches && ev.heuristicMatches.length ? ev.heuristicMatches.join(', ') : 'none';
  const preview = String(ev.payload_preview || '').slice(0, 400);
  const body = [
    '### Event details',
    '- **Action**: ' + (ev.action || '') + (ev.withheld ? ' (withheld)' : ''),
    '- **Stage**: ' + (ev.stage || 'none'),
    '- **Score**: ' + (ev.score != null ? Number(ev.score).toFixed(1) : 'n/a'),
    '- **Similarity**: ' + (ev.similarity != null ? Number(ev.similarity).toFixed(4) : 'n/a'),
    '- **Heuristic matches**: ' + matches,
    '- **Target / Path**: ' + (ev.target || '') + ' ' + (ev.method || '') + ' ' + (ev.path || ''),
    '',
    '### Expected vs actual verdict',
    '- **Expected**: ',
    '',
    '### Redacted preview (check before sending)',
    '~~~',
    preview,
    '~~~',
  ].join('\\n');
  return {
    github: 'https://github.com/PIsberg/llm-fw/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body),
    mailto: 'mailto:isberg.peter@gmail.com?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body),
  };
}

// ── Suppress (false-positive feedback loop, distinct from Whitelist above:
// this one actually changes future pipeline behavior — see /api/feedback) ─────
async function suppressEvent(id, btn) {
  const status = document.getElementById('fp-status-' + id);
  btn.disabled = true;
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: id })
    });
    const d = await res.json();
    if (res.ok) {
      if (status) status.textContent = '✓ Suppressed — an identical prompt will warn, not block';
      btn.textContent = 'Suppressed';
    } else {
      btn.disabled = false;
      if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Error: ' + (d.error || res.status); }
    }
  } catch (err) {
    btn.disabled = false;
    if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Error: ' + err.message; }
  }
}

// ── Whitelist (false positive) ────────────────────────────────────────────────
async function whitelistEvent(id, btn) {
  const status = document.getElementById('wl-status-' + id);
  btn.disabled = true;
  try {
    const res = await fetch('/api/whitelist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const d = await res.json();
    if (res.ok) {
      if (status) status.textContent = '✓ Saved to whitelist';
      btn.textContent = 'Whitelisted';
    } else {
      btn.disabled = false;
      if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Error: ' + (d.error || res.status); }
    }
  } catch (err) {
    btn.disabled = false;
    if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Error: ' + err.message; }
  }
}

// ── Append event row ──────────────────────────────────────────────────────────
const tbody = document.getElementById('events-body');
const noEventsRow = document.getElementById('no-events');

// Events lists findings only (#337). A passed event is inventory, not a
// finding: MCP tool listings arrive on every agent request and buried the
// blocks and warns, and they counted in the Total and MCP tiles. They go to
// the MCP Traffic tab and count only there.
const mcpBody = document.getElementById('mcp-body');
let mcpCount = 0;
function appendRow(ev) {
  const isPassed = ev.action === 'passed';
  const body = isPassed ? mcpBody : tbody;
  if (isPassed) {
    document.getElementById('mcp-count').textContent = String(++mcpCount);
  } else {
    if (noEventsRow && noEventsRow.parentNode) noEventsRow.parentNode.removeChild(noEventsRow);
    updateStats(ev);
  }

  const actionBadge = isObservedBlock(ev)
    ? '<span class="badge badge-observed" title="Observe mode: recorded, not refused">WOULD BLOCK</span>'
    : ev.action === 'blocked' && ev.withheld === true
    ? '<span class="badge badge-observed" title="The tool output was withheld from the model; the rest of the request was forwarded">WITHHELD</span>'
    : '<span class="badge badge-' + esc(ev.action) + '">' + esc((ev.action || '').toUpperCase()) + '</span>';
  const stageChip  = '<span class="chip chip-' + esc(ev.stage) + '">' + esc(ev.stage) + '</span>';
  const endpoint   = esc((ev.method || '') + ' ' + (ev.path || ''));

  const tr = document.createElement('tr');
  tr.className = 'event-row';
  tr.id = 'row-' + ev.id;
  tr.innerHTML =
    '<td>' + actionBadge + '</td>' +
    '<td class="td-time">' + esc(ev.timestamp || '') + '</td>' +
    '<td>' + stageChip + '</td>' +
    '<td class="td-mono">' + endpoint + '</td>' +
    '<td class="td-dim">' + esc(ev.target || '') + '</td>' +
    '<td>' + scoreBar(ev.score) + '</td>' +
    '<td class="td-mono">' + (ev.similarity > 0 ? Number(ev.similarity).toFixed(3) : '—') + '</td>' +
    '<td>' + detailCell(ev) + '</td>' +
    '<td class="payload-preview" title="Click row to expand">' + esc((ev.payload_preview || '').slice(0, 60)) + (ev.payload_preview && ev.payload_preview.length > 60 ? '…' : '') + '</td>';

  tr.onclick = () => toggleDrawer(ev.id, ev);
  tr.dataset.search = [ev.id, ev.method, ev.path, ev.target, ev.stage, ev.payload_preview].join(' ').toLowerCase();
  body.insertBefore(tr, body.firstChild);
  while (body.rows.length > 200) body.deleteRow(body.rows.length - 1);
  applyFilter(tr);
  if (ev.id && ev.id === deepLinkEventId()) openDeepLinkedEvent(tr, ev);
}

// #319: a blocked client is told to open /#event=<id>. The event arrives
// with the SSE replay, so the drawer opens when its row does, once per load.
let deepLinkOpened = null;
function deepLinkEventId() {
  const m = /^#event=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}
function openDeepLinkedEvent(tr, ev) {
  if (deepLinkOpened === ev.id) return;
  deepLinkOpened = ev.id;
  showTab('events', document.querySelector('.tab-btn'));
  if (!document.getElementById('drawer-' + ev.id)) toggleDrawer(ev.id, ev);
  tr.scrollIntoView({ block: 'center' });
}
window.addEventListener('hashchange', () => {
  const id = deepLinkEventId();
  const tr = id && document.getElementById('row-' + id);
  if (tr) tr.click();
});

// Filter the Events table by id, endpoint, target, stage or payload.
let eventsFilter = '';
function applyFilter(tr) {
  tr.style.display = !eventsFilter || (tr.dataset.search || '').includes(eventsFilter) ? '' : 'none';
}
function filterEvents(value) {
  eventsFilter = String(value || '').trim().toLowerCase();
  document.querySelectorAll('#events-body tr.event-row').forEach(applyFilter);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const es = new EventSource('/events');
// Every (re)connect replays the server's whole buffer, so start from an empty
// table: no duplicated rows after a dropped connection, and no rows left over
// from before a restart whose "Mark false positive" the server cannot honour.
// The tiles count the same replay, so they start from zero too.
es.onopen = () => {
  tbody.replaceChildren(); mcpBody.replaceChildren(); mcpCount = 0;
  modulesBody.replaceChildren();
  document.getElementById('mcp-count').textContent = '0';
  resetStats(); loadModuleStats(); loadModeChips();
};

// How this process was started (#338): --observe, the sinkhole and the gateway
// change what the firewall does to every client on the machine, so they are
// shown above everything else rather than discovered in Settings.
async function loadModeChips() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const s = await res.json();
    const chips = [];
    if (s.enforcement === 'observe') chips.push(['observe', 'Observe mode: nothing is blocked', 'Every detector runs and would-be blocks are recorded, but no request is refused. Restart without --observe to enforce.']);
    if (s.sinkhole) chips.push(['sinkhole', 'Sinkhole active', 'Provider hostnames resolve to this machine (hosts file plus a :443 redirect), so Node.js and native clients are inspected without HTTPS_PROXY. llm-fw stop or uninstall restores them.']);
    if (s.gatewayUrl) chips.push(['gateway', 'Gateway ' + s.gatewayUrl, 'Reverse-proxy endpoint: point an SDK base_url here.']);
    const box = document.getElementById('mode-chips');
    box.replaceChildren(...chips.map(([cls, text, tip]) => {
      const el = document.createElement('span');
      el.className = 'mode-chip ' + cls;
      el.textContent = text;
      el.title = tip;
      return el;
    }));
  } catch (_) {}
}
loadModeChips();
es.onmessage = e => { try { appendRow(JSON.parse(e.data)); } catch(_) {} };
es.addEventListener('module', e => {
  try {
    const data = JSON.parse(e.data);
    updateModuleStats(data);
    appendModuleRow(data);
    scheduleModuleRefresh();
  } catch(_) {}
});

// ── Modules tab (#341) ───────────────────────────────────────────────────────
const modulesBody = document.getElementById('modules-body');
function appendModuleRow(ev) {
  const tr = document.createElement('tr');
  tr.className = 'module-row';
  const observed = ev.applied === false ? '<span class="module-observed">would save</span>' : '';
  tr.innerHTML =
    '<td class="td-time">' + esc(ev.timestamp || '') + '</td>' +
    '<td>' + esc(ev.moduleName || ev.moduleId || '') + '</td>' +
    '<td>' + esc(ev.target || '') + '</td>' +
    '<td>' + esc(ev.path || '') + '</td>' +
    '<td>' + esc(Number(ev.tokensOriginal || 0).toLocaleString()) + '</td>' +
    '<td>' + esc(Number(ev.tokensPruned || 0).toLocaleString()) + '</td>' +
    '<td>' + observed + '<span class="module-saved">-' + esc(ev.percentSaved || 0) + '%</span></td>';
  modulesBody.insertBefore(tr, modulesBody.firstChild);
  while (modulesBody.rows.length > 200) modulesBody.deleteRow(modulesBody.rows.length - 1);
}

function renderModuleCards(mods) {
  const box = document.getElementById('module-cards');
  // An option editor left open survives the refresh a module event triggers.
  const open = new Set([...box.querySelectorAll('.module-card details[open]')].map(d => d.closest('.module-card').dataset.module));
  box.replaceChildren(...mods.map(m => {
    const card = document.createElement('div');
    card.className = 'module-card';
    card.dataset.module = m.id;
    const kpi = (key, label, value) =>
      '<div><div class="stat-label">' + esc(label) + '</div><div class="module-kpi-value" data-kpi="' + esc(key) + '">' + esc(value) + '</div></div>';
    // A module that measures something other than savings (the usage meter)
    // sends its own KPIs.
    const kpis = Array.isArray(m.kpis)
      ? m.kpis.map(k => kpi(k.key, k.label, typeof k.value === 'number' ? k.value.toLocaleString() : k.value)).join('')
      : kpi('saved', 'Tokens saved', Number(m.tokensSaved || 0).toLocaleString()) +
        kpi('original', 'Original tokens', Number(m.tokensOriginal || 0).toLocaleString()) +
        kpi('ratio', 'Savings ratio', (m.percentSaved || 0) + '%') +
        kpi('requests', 'Requests examined', Number(m.totalInvocations || 0).toLocaleString());
    // The module's options (#354): one field per option, saved together.
    const options = Array.isArray(m.options) ? m.options : [];
    const field = (o) => {
      const name = 'data-option="' + esc(o.key) + '"';
      if (o.type === 'boolean') return '<label class="module-option"><input type="checkbox" ' + name + (o.value ? ' checked' : '') + '> ' + esc(o.key) + '</label>';
      if (o.type === 'enum') return '<label class="module-option">' + esc(o.key) + ' <select ' + name + '>' + o.values.map(v => '<option' + (v === o.value ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select></label>';
      if (o.type === 'number') return '<label class="module-option">' + esc(o.key) + ' <input type="number" ' + name + ' value="' + esc(o.value) + '"' + (o.min !== undefined ? ' min="' + esc(o.min) + '"' : '') + (o.max !== undefined ? ' max="' + esc(o.max) + '"' : '') + '></label>';
      if (o.type === 'list') return '<label class="module-option module-option-list">' + esc(o.key) + ' <input type="text" ' + name + ' value="' + esc((o.value || []).join(', ')) + '" placeholder="comma-separated"></label>';
      return '<label class="module-option">' + esc(o.key) + ' <input type="text" ' + name + ' value="' + esc(o.value) + '"></label>';
    };
    const optionsHtml = options.length
      ? '<details class="module-options"><summary>Options</summary><form class="module-options-form" novalidate>' + options.map(field).join('') +
        '<div><button type="submit" class="btn btn-sm">Save</button> <span class="module-options-status"></span></div></form></details>'
      : '';
    card.innerHTML =
      '<div class="module-card-head"><span class="module-card-name">' + esc(m.name) + '</span>' +
      '<label><input type="checkbox" class="module-switch"' + (m.enabled ? ' checked' : '') + '> Enabled</label></div>' +
      '<div class="module-card-desc">' + esc(m.description || '') + '</div>' +
      '<div class="module-kpis">' + kpis + '</div>' +
      (m.detail ? '<div class="module-card-detail">' + esc(m.detail) + '</div>' : '') +
      (m.action ? '<div class="module-card-action"><button type="button" class="btn btn-sm module-action">' + esc(m.action.label) + '</button> <span class="module-options-status"></span></div>' : '') +
      optionsHtml;
    const toggle = card.querySelector('input.module-switch');
    toggle.onchange = () => setModuleEnabled(m.id, toggle);
    // A one-click action (#407) changes another module, so it is armed by a
    // first click and sent by a second.
    const action = card.querySelector('button.module-action');
    if (action) {
      let armed = false;
      action.onclick = async () => {
        if (!armed) { armed = true; action.textContent = 'Click again to confirm'; return; }
        const status = card.querySelector('.module-card-action .module-options-status');
        try {
          const res = await fetch('/api/modules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: m.action.module, ...(typeof m.action.enabled === 'boolean' ? { enabled: m.action.enabled } : {}), options: m.action.options }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          loadModuleStats();
        } catch (err) {
          armed = false;
          action.textContent = m.action.label;
          status.textContent = err.message;
          status.classList.add('is-error');
        }
      };
    }
    const form = card.querySelector('.module-options-form');
    if (form) {
      form.onsubmit = (ev) => { ev.preventDefault(); saveModuleOptions(m.id, options, form); };
      if (open.has(m.id)) card.querySelector('details').open = true;
    }
    return card;
  }));
}

// Reads the option fields back in the types the API validates: a number
// input as a number, a list field split on commas with blanks dropped.
function readModuleOptions(options, form) {
  const out = {};
  for (const o of options) {
    const el = form.querySelector('[data-option="' + o.key + '"]');
    if (!el) continue;
    if (o.type === 'boolean') out[o.key] = el.checked;
    else if (o.type === 'number') out[o.key] = Number(el.value);
    else if (o.type === 'list') out[o.key] = el.value.split(',').map(s => s.trim()).filter(Boolean);
    else out[o.key] = el.value;
  }
  return out;
}

async function saveModuleOptions(id, options, form) {
  const status = form.querySelector('.module-options-status');
  status.textContent = '';
  status.classList.remove('is-error');
  try {
    const res = await fetch('/api/modules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, options: readModuleOptions(options, form) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    // The cards are rendered again with the live values; the editor stays
    // open (see renderModuleCards) and the message goes on the new card.
    await loadModuleStats();
    const fresh = document.querySelector('.module-card[data-module="' + id + '"] .module-options-status');
    if (fresh) fresh.textContent = 'Saved';
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('is-error');
  }
}

async function setModuleEnabled(id, toggle) {
  try {
    const res = await fetch('/api/modules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled: toggle.checked }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (_) {
    toggle.checked = !toggle.checked;
  }
  loadModuleStats();
}

// Cards carry totals the event does not (original tokens, requests examined),
// so a burst of module events refreshes them once.
let moduleRefresh = null;
function scheduleModuleRefresh() {
  if (moduleRefresh) return;
  moduleRefresh = setTimeout(() => { moduleRefresh = null; loadModuleStats(); }, 500);
}

function updateModuleStats(data) {
  if (!data) return;
  const el = document.getElementById('stat-tokens-saved');
  if (el && typeof data.totalTokensSaved === 'number') {
    el.textContent = data.totalTokensSaved.toLocaleString();
  }
  const pctEl = document.getElementById('stat-tokens-pct');
  if (pctEl && typeof data.overallPercentSaved === 'number') {
    // applied === false: observe mode forwarded the original body.
    pctEl.textContent = data.overallPercentSaved + (data.applied === false ? '% would be saved (observe)' : '% saved');
  }
}

// Token Economy: the parent switch (modules.enabled). Off, the sub-module
// cards are dimmed; their own switches keep their state.
function renderTokenEconomy(te) {
  const toggle = document.getElementById('token-economy-toggle');
  if (!toggle || !te) return;
  toggle.checked = !!te.enabled;
  document.getElementById('module-cards').classList.toggle('economy-off', !te.enabled);
}
document.getElementById('token-economy-toggle').onchange = function () { setModuleEnabled('token-economy', this); };

async function loadModuleStats() {
  try {
    const res = await fetch('/api/modules');
    if (res.ok) {
      const data = await res.json();
      updateModuleStats(data);
      renderTokenEconomy(data.tokenEconomy);
      if (Array.isArray(data.modules)) renderModuleCards(data.modules);
    }
  } catch(_) {}
}
loadModuleStats();

// ── Prompts tab ──────────────────────────────────────────────────────────────
// Text goes in through textContent only: a prompt is whatever a user typed.
const PROMPT_PAGE = 100;
let promptShown = 0;
let promptTimer = null;
const promptEl = id => document.getElementById(id);

function promptQuery(offset) {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v) p.set(k, v); };
  set('q', promptEl('prompts-search').value.trim());
  set('target', promptEl('prompts-target').value);
  set('model', promptEl('prompts-model').value);
  set('session', promptEl('prompts-session').value);
  const range = Number(promptEl('prompts-range').value);
  if (range) p.set('since', new Date(Date.now() - range).toISOString());
  p.set('limit', String(PROMPT_PAGE));
  p.set('offset', String(offset));
  return p.toString();
}

function fillPromptFilter(id, values) {
  const sel = promptEl(id);
  const keep = sel.value;
  const all = sel.options[0];
  sel.replaceChildren(all, ...values.sort().map(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; return o; }));
  sel.value = values.includes(keep) ? keep : '';
}

function promptRow(e) {
  const tr = document.createElement('tr');
  const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; };
  cell(e.timestamp.slice(0, 19).replace('T', ' ') + 'Z', 'td-time');
  cell(e.session);
  cell(e.target);
  cell(e.model);
  const td = cell(e.text, 'prompt-text is-clipped');
  td.title = 'Click to expand';
  td.onclick = () => td.classList.toggle('is-clipped');
  if (e.truncated) {
    const m = document.createElement('div');
    m.className = 'prompt-meta';
    m.textContent = 'Cut: ' + e.chars.toLocaleString() + ' characters in all';
    td.appendChild(m);
  }
  return tr;
}

async function loadPrompts(reset) {
  const body = promptEl('prompts-body');
  const offset = reset ? 0 : promptShown;
  try {
    const res = await fetch('/api/prompts?' + promptQuery(offset));
    if (!res.ok) return;
    const data = await res.json();
    promptEl('prompts-toggle').checked = data.enabled;
    promptEl('prompts-off').hidden = data.enabled;
    promptEl('prompts-filters').hidden = !data.enabled;
    if (reset) { body.replaceChildren(); promptShown = 0; }
    for (const e of data.entries) body.appendChild(promptRow(e));
    promptShown += data.entries.length;
    promptEl('prompts-count').textContent = data.enabled ? promptShown.toLocaleString() + ' of ' + data.total.toLocaleString() + ' shown' : '';
    promptEl('prompts-more').hidden = promptShown >= data.total;
    fillPromptFilter('prompts-target', data.facets.targets);
    fillPromptFilter('prompts-model', data.facets.models);
    fillPromptFilter('prompts-session', data.facets.sessions);
  } catch (_) {}
}

promptEl('prompts-search').oninput = () => { clearTimeout(promptTimer); promptTimer = setTimeout(() => loadPrompts(true), 200); };
for (const id of ['prompts-target', 'prompts-model', 'prompts-session', 'prompts-range']) promptEl(id).onchange = () => loadPrompts(true);
promptEl('prompts-refresh').onclick = () => loadPrompts(true);
promptEl('prompts-more').onclick = () => loadPrompts(false);
promptEl('prompts-toggle').onchange = async function () {
  const box = this;
  try {
    const res = await fetch('/api/modules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'prompt-monitor', enabled: box.checked }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (_) { box.checked = !box.checked; }
  loadPrompts(true);
  loadModuleStats();
};
promptEl('prompts-clear').onclick = async () => {
  try { await fetch('/api/prompts/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) {}
  loadPrompts(true);
};
// New prompts arrive while the tab is open; keep the first page fresh unless the reader is searching or paged in.
setInterval(() => {
  if (promptEl('tab-prompts').classList.contains('active') && !document.hidden && promptShown <= PROMPT_PAGE && document.activeElement !== promptEl('prompts-search')) loadPrompts(true);
}, 5000);

// ── Playground ────────────────────────────────────────────────────────────────
// Per-category descriptions + curated examples that llm-fw actually catches.
const PG_DESC = {
  injection: 'Detects jailbreaks and prompt-injection attempts: heuristics (Stage 1, <1ms), embedding similarity to known attacks (Stage 2), and an optional local LLM judge for intent (Stage 3). Click an example or paste your own.',
  ascii: 'Detects ASCII smuggling — instructions hidden in INVISIBLE characters (Unicode Tags block, bidi overrides, plane-14 variation selectors) that you cannot see but the LLM still reads and obeys. The examples below encode a hidden instruction into invisible tag characters; the firewall decodes and blocks it. Try typing visible text — it passes; the invisible payload is what trips the block.',
  image: 'Detects prompt injection carried by NON-TEXT content (issue #60): images, PDFs, and document blocks. Upload any image, PDF, or text/JSON file — it is wrapped as a content block and run through the full pipeline, exactly as a model would receive it. Text-bearing files (text/*, PDFs with uncompressed text) are decoded and scanned, so an injection hidden in an uploaded file is blocked just like a typed one. Genuinely opaque media (raster images, audio) can\\'t be inspected locally — it is surfaced as a warn event (audit mode) or refused outright (block mode). You can also type text to simulate a document, or click an example.',
  rag: 'Detects context poisoning — active instructions smuggled inside retrieved data blocks (<document>, <context>, <search_results>, code fences). Passive data should never issue system overrides, so any imperative confined to a data block is blocked.',
  dlp: 'Scans outbound text for secrets and PII (cloud keys, tokens, private keys, credit cards) before it leaves your machine. Default mode redacts in place; configurable to block or audit. The raw secret is never logged.',
  mcp: 'Enforces a tool allow/deny policy. Tools on the blocklist are refused before the agent can expose them to the model or invoke them. Enter one or more tool names (comma-separated).',
  guardrails: 'Evaluates tool arguments on execution context tools (bash, execute_command, ctx_shell, powershell, shell, run_shell_command, in any capitalisation) to intercept and block catastrophic shell commands, database drops, and infrastructure tear-downs before execution.',
  url: 'Screens outbound destinations for exfiltration: known sinks (webhook.site, ngrok, requestbin), high-entropy/DGA domains, and suspicious data-carrying query strings.',
  dos: 'Behavioral circuit breaker against denial-of-wallet: per-minute rate limits, a rolling token budget, and identical-request loop detection. These are stateful — they trip across real traffic, not a single test prompt.',
};

// The examples live in src/dashboard/playgroundExamples.ts, where
// test/dashboard/playground-examples.test.ts checks that each is still caught.
const PG_EXAMPLES = ${playgroundExamplesScript()};

let pgCat = 'injection';
// Stashed data URL for the Image/Document category. Set by an example that
// carries binary content (PDF/PNG); cleared when the user edits the textarea
// (onPromptInput) so free-typed text reverts to a text-document upload.
let pgImageDataUrl = '';
// 1×1 transparent PNG — a genuinely opaque raster image for the demo.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function badgeHtml(action) {
  const a = (action || 'PASS').toUpperCase();
  const cls = (a === 'BLOCK' || a === 'BLOCKED' || a === 'WOULD BLOCK') ? 'BLOCK'
    : (a === 'WARN' || a === 'WARNED' || a === 'REDACT') ? 'WARN' : 'PASS';
  return '<span class="pg-badge pg-badge-' + cls + '">' + esc(a) + '</span>';
}

function renderExamples(cat) {
  const wrap = document.getElementById('pg-examples');
  const exs = PG_EXAMPLES[cat] || [];
  if (!exs.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<span class="pg-ex-label">Examples llm-fw catches — click to test</span>' +
    exs.map((e, i) => '<span class="pg-ex ' + (e.safe ? 'safe' : 'danger') + '" onclick="fillExample(' + i + ')">' + esc(e.label) + '</span>').join('');
}

function setPgCat(cat, btn) {
  pgCat = cat;
  document.querySelectorAll('#pg-cats .pg-mode-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('pg-text-wrap').style.display = (cat === 'injection' || cat === 'ascii' || cat === 'rag' || cat === 'dlp' || cat === 'image') ? '' : 'none';
  // Translation only makes sense for natural-language injection text, not for a
  // simulated file upload — hide it in the Image/Document category.
  const tr = document.getElementById('pg-translate');
  if (tr) tr.style.display = cat === 'image' ? 'none' : '';
  pgImageDataUrl = '';
  // Image/Document file upload — reset the picker each time the category opens.
  document.getElementById('pg-image-wrap').style.display = cat === 'image' ? '' : 'none';
  const imgFile = document.getElementById('image-file');
  if (imgFile) imgFile.value = '';
  const imgInfo = document.getElementById('pg-image-info');
  if (imgInfo) imgInfo.innerHTML = '';
  document.getElementById('pg-url-wrap').style.display = cat === 'url' ? '' : 'none';
  document.getElementById('pg-mcp-wrap').style.display = cat === 'mcp' ? '' : 'none';
  document.getElementById('pg-guardrails-wrap').style.display = cat === 'guardrails' ? '' : 'none';
  document.getElementById('pg-analyze-btn').style.display = cat === 'dos' ? 'none' : '';
  document.getElementById('pg-desc').textContent = PG_DESC[cat] || '';
  renderExamples(cat);
  const result = document.getElementById('pg-result');
  result.style.display = 'none';
  result.innerHTML = '';
  if (cat === 'dos') analyzePrompt(); // info card, no input needed
}

// Encode printable ASCII into invisible Unicode Tag characters (U+E0000 + cp).
// Used to build ASCII-smuggling demo payloads on the fly so the hidden text is
// genuinely invisible in the textarea, exactly like a real attack.
function toTagChars(s) {
  return [...String(s)].map(c => {
    const cp = c.codePointAt(0);
    return (cp >= 0x20 && cp <= 0x7e) ? String.fromCodePoint(0xE0000 + cp) : c;
  }).join('');
}

function fillExample(i) {
  const e = (PG_EXAMPLES[pgCat] || [])[i];
  if (!e) return;
  if (pgCat === 'url') document.getElementById('url-input').value = e.value;
  else if (pgCat === 'mcp') document.getElementById('mcp-input').value = e.value;
  else if (pgCat === 'guardrails') {
    document.getElementById('guardrails-input').value = e.value;
    if (e.tool) document.getElementById('guardrails-tool').value = e.tool;
  }
  else if (pgCat === 'ascii') {
    document.getElementById('prompt-input').value = (e.visible || '') + (e.hidden ? toTagChars(e.hidden) : '');
  }
  else if (pgCat === 'image') {
    pgImageDataUrl = '';
    const ta = document.getElementById('prompt-input');
    if (e.png) {
      pgImageDataUrl = 'data:image/png;base64,' + PNG_1x1;
      ta.value = '[1×1 transparent PNG — a real raster image with no extractable text]';
    } else if (e.pdf) {
      // Minimal PDF with the injection appended after %%EOF (a common smuggling
      // spot the printable-run extractor recovers). btoa needs latin1 input.
      const pdf = '%PDF-1.4\\nstream\\nendstream\\n%%EOF\\n' + e.pdf;
      pgImageDataUrl = 'data:application/pdf;base64,' + btoa(pdf);
      ta.value = '[PDF document containing: "' + e.pdf + '"]';
    } else {
      ta.value = e.value; // free text → simulated text/plain document upload
    }
  }
  else document.getElementById('prompt-input').value = e.value;
  analyzePrompt();
}

// Clear any stashed image/PDF payload when the user types into the textarea, so
// custom input in the Image/Document category is sent as a text document.
function onPromptInput() { pgImageDataUrl = ''; }

// Image/Document upload: read the chosen file as a base64 data URL, stash it as
// the payload, show a preview, and analyze. The data URL flows to /api/test as
// { category:'image', dataUrl } and the backend wraps it in a content block —
// images are surfaced/refused as opaque, text/PDF files are decoded and scanned.
var PG_UPLOAD_MAX = 8 * 1024 * 1024; // 8 MB
function onImageFile(input) {
  const file = input.files && input.files[0];
  const info = document.getElementById('pg-image-info');
  if (!file) { info.innerHTML = ''; pgImageDataUrl = ''; return; }
  if (file.size > PG_UPLOAD_MAX) {
    info.innerHTML = '<span class="text-danger">File is too large (' +
      (file.size / 1048576).toFixed(1) + ' MB). Maximum is 8 MB.</span>';
    input.value = ''; pgImageDataUrl = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = function() {
    pgImageDataUrl = String(reader.result || '');
    document.getElementById('prompt-input').value = '[uploaded file: ' + file.name + ']';
    // file.name / file.type are user-controlled — escape before inserting.
    const meta = '<div>' + esc(file.name) + ' · ' + esc(file.type || 'unknown type') +
      ' · ' + (file.size / 1024).toFixed(0) + ' KB</div>';
    // The preview src is a browser-generated data: URL from THIS file, only set
    // for image types — safe to use directly as an <img> source.
    const preview = (file.type && file.type.indexOf('image/') === 0)
      ? '<img src="' + pgImageDataUrl + '" alt="upload preview" class="pg-img-preview" />'
      : '';
    info.innerHTML = meta + preview;
    analyzePrompt();
  };
  reader.onerror = function() { info.innerHTML = '<span class="text-danger">Could not read that file.</span>'; pgImageDataUrl = ''; };
  reader.readAsDataURL(file);
}

function renderPipeline(d) {
  // enforced === false: observe mode, so the block is recorded, not refused (#318).
  const wouldBlock = d.enforced === false && d.action === 'block';
  const action = wouldBlock ? 'WOULD BLOCK' : (d.action || 'PASS').toUpperCase();
  let judgeStatus;
  if (d.verdict) judgeStatus = d.verdict;
  else if (!d.judgeEnabled) judgeStatus = 'disabled — run llm-fw setup-judge to enable';
  else if (d.stage === 'heuristic') judgeStatus = 'not reached — blocked at Stage 1';
  else if (d.stage === 'embedding') judgeStatus = 'not reached — blocked at Stage 2';
  else if (d.stage === 'rag') judgeStatus = 'n/a — handled by the RAG stage';
  else judgeStatus = 'not triggered — similarity below warn threshold';

  const ragCard = d.stage === 'rag'
    ? '<div class="pg-stage pg-stage-rag"><h3>RAG Poisoning</h3>' +
        '<div class="val">BLOCKED</div>' +
        '<div class="sub">' + (d.ragTag ? 'tag: ' + esc(d.ragTag) : 'instruction confined to a data block') + '</div></div>'
    : '';

  const asciiCard = d.stage === 'ascii-smuggling'
    ? '<div class="pg-stage pg-stage-ascii"><h3>ASCII Smuggling</h3>' +
        '<div class="val">BLOCKED</div>' +
        '<div class="sub">channels: ' + (d.smuggleRanges && d.smuggleRanges.length ? esc(d.smuggleRanges.join(', ')) : 'invisible chars') +
        (d.prompt ? '<br>decoded: ' + esc(String(d.prompt).slice(0, 80)) : '') + '</div></div>'
    : '';

  return '<div class="pg-verdict">Verdict: ' + badgeHtml(action) +
      (d.stage && d.stage !== 'none' ? ' <span class="pg-verdict-note">stage: ' + esc(d.stage) + '</span>' : '') +
      (wouldBlock ? ' <span class="pg-verdict-note observe">observe mode: recorded, not refused; enforcing would block it</span>' : '') + '</div>' +
    '<div class="pg-stages">' +
      '<div class="pg-stage"><h3>Stage 1 — Heuristic</h3><div class="val">' +
        (d.score != null ? 'Score: ' + Number(d.score).toFixed(1) : 'Score: n/a') + '</div><div class="sub">' +
        (d.heuristicMatches && d.heuristicMatches.length ? 'Matched: ' + esc(d.heuristicMatches.join(', ')) : 'No rule matches') + '</div></div>' +
      '<div class="pg-stage"><h3>Stage 2 — Embedding</h3><div class="val">' +
        (d.similarity != null ? 'Similarity: ' + Number(d.similarity).toFixed(4) : 'n/a') + '</div><div class="sub">' +
        (d.nearestTemplate ? 'Nearest: ' + esc(d.nearestTemplate.slice(0, 80)) + (d.nearestTemplate.length > 80 ? '…' : '') : 'No match') + '</div></div>' +
      '<div class="pg-stage"><h3>Stage 3 — Judge</h3><div class="val" style="font-size:0.9rem">' + esc(judgeStatus) + '</div></div>' +
      ragCard +
      asciiCard +
    '</div>';
}

function renderImageMediaCard(d) {
  const m = d.media || {};
  const blocks = m.blocks || [];
  let html = '<div class="pg-info-card"><h3>Non-text content (issue #60)</h3>';
  if (!d.nonTextEnabled) {
    html += '<div class="note text-danger" style="margin-bottom:8px">Non-text scanning is disabled in config — blocks below were extracted but not inspected.</div>';
  }
  if (!blocks.length) {
    html += '<div class="note">No non-text content blocks found.</div></div>';
    return html;
  }
  html += '<dl class="pg-kv">';
  blocks.forEach(b => {
    const head = esc(b.kind) + (b.mimeType ? ' · ' + esc(b.mimeType) : '');
    const status = b.scanned
      ? '<span class="text-ok">decoded &amp; scanned by the pipeline</span>'
      : '<span class="text-warn">opaque — cannot be inspected locally</span>';
    const preview = b.decodedPreview
      ? '<br><code style="font-size:0.78rem">' + esc(b.decodedPreview) + (b.decodedPreview.length >= 200 ? '…' : '') + '</code>'
      : '';
    html += '<dt>' + head + '</dt><dd>' + status + preview + '</dd>';
  });
  html += '</dl>';
  if (m.opaqueCount) {
    const note = d.nonTextMode === 'block'
      ? 'Refused — <code>nonText.mode = block</code> rejects uninspectable media.'
      : 'Forwarded with a warn event — <code>nonText.mode = audit</code>. Switch to block mode to refuse uninspectable media.';
    html += '<div class="note" style="margin-top:10px">' +
      esc(m.opaqueCount) + ' opaque block(s): <b>' + esc(m.opaqueSummary) + '</b>. ' + note + '</div>';
  }
  html += '</div>';
  return html;
}

function renderImage(d) {
  const card = renderImageMediaCard(d);
  // When a text/PDF block was decoded, the pipeline scored it — show the full
  // stage breakdown (which includes the verdict). For opaque-only media the
  // pipeline has nothing to score, so render just the verdict + media card.
  if (d.media && d.media.scannedCount) return renderPipeline(d) + card;
  const action = d.enforced === false && d.action === 'block' ? 'WOULD BLOCK' : (d.action || 'PASS').toUpperCase();
  const verdict = '<div class="pg-verdict">Verdict: ' + badgeHtml(action) +
    (d.stage && d.stage !== 'none' ? ' <span class="pg-verdict-note">stage: ' + esc(d.stage) + '</span>' : '') + '</div>';
  return verdict + card;
}

function highlightMarkers(s) {
  return esc(s).replace(/\\[REDACTED[^\\]]*\\]/g, m => '<span class="mark">' + m + '</span>');
}

function renderDlp(d) {
  const blocked = (d.count || 0) > 0;
  const action = !blocked ? 'PASS' : (d.mode === 'block' ? 'BLOCK' : d.mode === 'audit' ? 'WARN' : 'REDACT');
  let html = '<div class="pg-verdict">Verdict: ' + badgeHtml(action) +
    (!d.enabled ? ' <span class="pg-verdict-note">DLP disabled in config</span>' : '') + '</div>';
  if (!blocked) {
    html += '<div class="pg-stage pg-stage-ok">No secrets or PII detected.</div>';
    return html;
  }
  html += '<div class="pg-info-card"><h3>Detected ' + d.count + ' secret' + (d.count > 1 ? 's' : '') + ' — mode: ' + esc(d.mode) + '</h3>' +
    '<div class="pg-findings">' + d.findings.map(t => '<div class="pg-finding"><span class="pg-finding-type">' + esc(t) + '</span></div>').join('') + '</div>';
  if (d.redacted && d.mode !== 'block') {
    html += '<div class="eyebrow" style="margin:14px 0 4px">Forwarded payload (redacted)</div>' +
      '<div class="pg-redacted">' + highlightMarkers(d.redacted) + '</div>';
  }
  html += '</div>';
  return html;
}

function renderMcp(d) {
  const action = (d.action === 'block' || d.action === 'BLOCK') ? 'BLOCK' : 'PASS';
  let html = '<div class="pg-verdict">Verdict: ' + badgeHtml(action) +
    (!d.enabled ? ' <span class="pg-verdict-note">MCP filter disabled in config</span>' : '') + '</div>';
  html += '<div class="pg-info-card"><h3>Tool policy check</h3>';
  html += d.reason
    ? '<div class="note text-danger" style="margin-bottom:10px">' + esc(d.reason) + '</div>'
    : '<div class="note text-ok" style="margin-bottom:10px">All tools allowed by policy.</div>';
  html += '<dl class="pg-kv"><dt>Blocklist</dt><dd>' +
    (d.blockedTools && d.blockedTools.length ? d.blockedTools.map(t => '<span class="pg-tool-pill">' + esc(t) + '</span>').join('') : '<span class="muted">none</span>') +
    '</dd></dl></div>';
  return html;
}

function renderGuardrails(d) {
  const action = (d.action || 'PASS').toUpperCase();
  let html = '<div class="pg-verdict">Verdict: ' + badgeHtml(action) + '</div>';
  html += '<div class="pg-info-card"><h3>Security Guardrails check</h3>';
  html += '<dl class="pg-kv">';
  html += '<dt>Simulated Tool</dt><dd><span class="pg-tool-pill">' + esc(d.tool) + '</span></dd>';
  html += '<dt>Command</dt><dd><code>' + esc(d.text) + '</code></dd>';
  if (action === 'BLOCK') {
    html += '<dt>Block Rule</dt><dd class="strong text-danger">' + esc(d.reason) + '</dd>';
  } else {
    html += '<dt>Status</dt><dd class="strong text-ok">Command allowed.</dd>';
  }
  html += '</dl></div>';
  if (action === 'BLOCK') {
    const alertMsg = '[Firewall] Blocked tool execution: ' + d.reason;
    html = '<div class="pg-alert">' + esc(alertMsg) + '</div>' + html;
  }
  return html;
}

function renderDos(d) {
  const c = d.dos || {};
  return '<div class="pg-info-card"><h3>Active DoS / cost-control policy</h3>' +
    '<dl class="pg-kv">' +
      '<dt>Enabled</dt><dd>' + (c.enabled ? 'yes' : 'no') + '</dd>' +
      '<dt>Max requests / min</dt><dd>' + esc(c.maxRequestsPerMinute) + '</dd>' +
      '<dt>Token budget / window</dt><dd>' + esc(c.maxTokensPerSession) + '</dd>' +
      '<dt>Loop detection</dt><dd>' + (c.loopDetectionEnabled ? 'on — ≥4 identical request bodies within 10s trips the breaker' : 'off') + '</dd>' +
    '</dl>' +
    '<div class="note" style="margin-top:12px">These limits are <b>behavioral</b>: they trip on traffic patterns (request rate, token volume, repeated identical bodies), so a single test prompt can\\'t demonstrate them. Watch the <b>Rate Limit / DoS</b> counter and the Events feed when an agent loops or floods the API.</div>' +
    '</div>';
}

function renderUrl(d) {
  const action = (d.action || 'pass').toUpperCase();
  let reason = d.reason || 'clean';
  if (!d.urlFilterEnabled) reason += ' (URL filter disabled in config)';
  const checks = (d.checks || []).map(c =>
    '<div class="pg-check pg-check-' + c.result + '"><span class="pg-check-icon">' + (c.result === 'block' ? '✗' : '✓') + '</span>' +
    '<span class="pg-check-name">' + esc(c.name) + '</span><span class="pg-check-reason">' + esc(c.reason) + '</span></div>'
  ).join('');
  return '<div class="pg-verdict">Verdict: ' + badgeHtml(action === 'BLOCK' ? 'BLOCK' : 'PASS') + '</div>' +
    '<div class="pg-url-card"><h3>URL Filter</h3><div class="val">' + (action === 'BLOCK' ? 'Blocked' : 'Allowed') + '</div>' +
    '<div class="pg-url-reason">Reason: ' + esc(reason) + '</div>' +
    '<div class="pg-url-checks">' + checks + '</div></div>';
}

async function analyzePrompt() {
  const result = document.getElementById('pg-result');
  try {
    let payload;
    if (pgCat === 'url') {
      const url = document.getElementById('url-input').value.trim();
      if (!url) return;
      payload = { category: 'url', url };
    } else if (pgCat === 'mcp') {
      const text = document.getElementById('mcp-input').value.trim();
      if (!text) return;
      payload = { category: 'mcp', text };
    } else if (pgCat === 'guardrails') {
      const text = document.getElementById('guardrails-input').value.trim();
      if (!text) return;
      const tool = document.getElementById('guardrails-tool').value;
      const toggles = {
        a: document.getElementById('guardrails-cat-a').checked,
        b: document.getElementById('guardrails-cat-b').checked,
        c: document.getElementById('guardrails-cat-c').checked,
        d: document.getElementById('guardrails-cat-d').checked
      };
      payload = { category: 'guardrails', text, tool, toggles };
    } else if (pgCat === 'dos') {
      payload = { category: 'dos' };
    } else if (pgCat === 'image') {
      const text = document.getElementById('prompt-input').value.trim();
      if (!pgImageDataUrl && !text) return;
      payload = pgImageDataUrl ? { category: 'image', dataUrl: pgImageDataUrl } : { category: 'image', text };
    } else {
      const text = document.getElementById('prompt-input').value.trim();
      if (!text) return;
      payload = { category: pgCat, text };
    }
    const res = await fetch('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    let html;
    if (pgCat === 'url') html = renderUrl(d);
    else if (pgCat === 'dlp') html = renderDlp(d);
    else if (pgCat === 'mcp') html = renderMcp(d);
    else if (pgCat === 'guardrails') html = renderGuardrails(d);
    else if (pgCat === 'dos') html = renderDos(d);
    else if (pgCat === 'image') html = renderImage(d);
    else html = renderPipeline(d);
    result.innerHTML = html;
    result.style.display = 'block';
  } catch (err) {
    result.innerHTML = '<div class="text-danger">Error: ' + esc(err.message) + '</div>';
    result.style.display = 'block';
  }
}

// ── Translate injection text ──────────────────────────────────────────────────
// Populate the language picker from the full Google Translate list (served by
// /api/languages). Default the selection to Spanish — a useful first multilingual
// probe — falling back to the first language if it is somehow absent.
async function loadLanguages() {
  const sel = document.getElementById('translate-lang');
  if (!sel) return;
  try {
    const langs = await (await fetch('/api/languages')).json();
    sel.innerHTML = langs.map(l => '<option value="' + esc(l.code) + '">' + esc(l.name) + '</option>').join('');
    if (langs.some(l => l.code === 'es')) sel.value = 'es';
  } catch (_) {
    sel.innerHTML = '<option value="es">Spanish</option>';
  }
}

async function translateInjection(btn) {
  const ta = document.getElementById('prompt-input');
  const sel = document.getElementById('translate-lang');
  const status = document.getElementById('translate-status');
  const text = (ta.value || '').trim();
  if (!text) { status.className = 'pg-translate-status error'; status.textContent = 'Enter or pick an example first.'; return; }
  const target = sel.value;
  btn.disabled = true;
  status.className = 'pg-translate-status';
  status.textContent = 'Translating…';
  try {
    const res = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, target })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
    ta.value = d.translated;
    status.textContent = 'Translated ' + (d.detectedSource || 'auto') + ' → ' + target + '. Re-analyzing…';
    analyzePrompt();
  } catch (err) {
    status.className = 'pg-translate-status error';
    status.textContent = 'Translate failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// Initialise the default category's description + examples.
document.getElementById('pg-desc').textContent = PG_DESC.injection;
renderExamples('injection');
loadLanguages();

// ── Settings (live defense toggles) ─────────────────────────────────────────
const SETTINGS_SCHEMA = [
  { group: 'Prompt Injection', desc: 'The heuristic and embedding stages always run (covering direct overrides, persona/DAN jailbreaks, refusal-suppression, prefix-injection, encoding, multilingual). These control the structural, multi-turn, and invisible-character defenses plus the optional local-LLM judge.', rows: [
    { key: 'asciiSmuggling', label: 'ASCII smuggling (invisible chars)', sub: 'Block payloads hidden in Unicode-tag / bidi-override / variation-selector characters that render invisibly but the model still reads' },
    { key: 'classifier', label: 'Trained injection classifier (recommended)', sub: 'A local DeBERTa model that generalizes to novel phrasings the rules miss (≈2× recall on held-out attacks, near-zero added false positives). Opt-in: enabling downloads a ~700 MB model on first use' },
    { key: 'manyShot', label: 'Many-shot jailbreak', sub: 'Flag a prompt stuffed with fabricated dialogue turns whose faux answers comply with harmful asks (in-context conditioning)' },
    { key: 'manyShotMode', label: 'Many-shot mode', type: 'select', options: ['block', 'audit'], sub: 'block: refuse harmful many-shot · audit: warn only' },
    { key: 'crescendo', label: 'Multi-turn crescendo', sub: 'Flag a conversation that escalates over several turns toward harmful content, ending on a boundary-pushing directive' },
    { key: 'crescendoMode', label: 'Crescendo mode', type: 'select', options: ['block', 'audit'], sub: 'block: refuse the escalating request · audit: warn only' },
    { key: 'promptInjectionJudge', label: 'Stage 3 — local LLM judge', sub: 'A local Ollama model reasons about intent for prompts the cheap stages miss. Requires Ollama (run: llm-fw setup-judge)' },
    { key: 'judgeBlock', label: 'Judge blocks (vs. warn-only)', sub: 'Synchronously block the request on a MALICIOUS verdict, instead of only logging a warning' },
    { key: 'judgeUnlessBenign', label: 'Judge unless confidently benign', sub: 'Routes nearly every prompt to the judge. NOT recommended with a small local judge — measured 27-86% false positives on held-out data. Use the trained classifier above for novel-attack coverage instead' },
    { key: 'suppressions', label: 'False-positive suppression list', sub: 'Downgrade a block to a warn when the exact text, on the same surface, was previously marked a false positive from an event’s "Mark false positive" button. Empty until an operator marks one — never loosens detection for anything else' },
  ]},
  { group: 'Data & Context', desc: 'Retrieved-content poisoning, outbound secret leakage, and harmful content in the model response.', rows: [
    { key: 'rag', label: 'RAG context-poisoning', sub: 'Block instructions smuggled inside retrieved <document> / <search_results> / code-fence blocks' },
    { key: 'dlp', label: 'Data Loss Prevention (DLP)', sub: 'Detect secrets leaving in requests: cloud keys, tokens, private keys, payment cards, PII' },
    { key: 'dlpMode', label: 'DLP mode', type: 'select', options: ['block', 'redact', 'audit'], sub: 'block: refuse · redact: mask the secret and forward · audit: warn only' },
    { key: 'responseScan', label: 'Response-side exfil scan', sub: 'Detect data-exfil image/link URLs the model emits (e.g. a zero-click markdown image to an attacker host)' },
    { key: 'responseScanMode', label: 'Response scan mode', type: 'select', options: ['audit', 'block'], sub: 'audit: warn only · block: neutralize the exfil URL in the response' },
    { key: 'responseHarm', label: 'Harmful-compliance scan (response)', sub: 'Defense-in-depth: flag a response that produced harmful how-to content (a jailbreak the input stages missed). Audit-only — never blocks' },
  ]},
  { group: 'Non-text Content', desc: 'Injection carried by images, PDFs, and documents. Text-bearing files (text/*, PDFs) are always decoded and scanned; these control opaque media (raster images, audio).', rows: [
    { key: 'nonText', label: 'Non-text content scanning', sub: 'Inspect/track image, PDF, document, and audio attachments rather than letting them pass uninspected' },
    { key: 'nonTextMode', label: 'Opaque media mode', type: 'select', options: ['audit', 'block'], sub: 'audit: forward + warn · block: refuse uninspectable media' },
    { key: 'nonTextOcr', label: 'OCR raster images', sub: 'Read injection text rendered as pixels and scan it (WASM, no Python; ~12 MB first-run download, ~0.2–2s/image)' },
    { key: 'nonTextTranscribe', label: 'Transcribe WAV/AIFF audio', sub: 'Transcribe speech in WAV and AIFF clips locally with Whisper and scan it (~40 MB first-run download). MP3/AAC/Ogg/FLAC stay opaque' },
  ]},
  { group: 'Tools & Agents (MCP)', desc: 'Tool allow/deny policy and shell-command guardrails for agentic / MCP traffic.', rows: [
    { key: 'mcp', label: 'MCP tool policy', sub: 'Allow/deny tool calls by name and inspect tool definitions for poisoning' },
    { key: 'mcpGuardrails', label: 'Command guardrails', sub: 'Scan shell-command tool arguments (bash, powershell, …) against the category rules below' },
    { key: 'mcpCatA', label: 'Guardrail Cat A — filesystem', sub: 'Destructive or sensitive file operations (rm -rf, reading ~/.ssh, …)' },
    { key: 'mcpCatB', label: 'Guardrail Cat B — network', sub: 'Outbound fetch / reverse shells / piping remote scripts to a shell' },
    { key: 'mcpCatC', label: 'Guardrail Cat C — process', sub: 'Process control and privilege escalation (kill, sudo, scheduled tasks)' },
    { key: 'mcpCatD', label: 'Guardrail Cat D — dev / infra', sub: 'Credential, package, and infrastructure tampering (git push, npm publish, cloud CLIs)' },
  ]},
  { group: 'Network & Exfiltration', desc: 'Outbound destination screening and cross-turn data-flow taint.', rows: [
    { key: 'urlFilter', label: 'URL / exfiltration filter', sub: 'Screen outbound destinations: known exfil sinks, DGA/high-entropy hosts, data-carrying query strings' },
    { key: 'taint', label: 'Cross-turn taint tracking', sub: 'Track untrusted tokens (from tool results) that are later reused as an outbound destination' },
    { key: 'taintMode', label: 'Taint mode', type: 'select', options: ['audit', 'block'], sub: 'audit: warn only · block: refuse the tainted destination' },
  ]},
  { group: 'Cost & Abuse (DoS)', desc: 'Behavioral circuit breakers against denial-of-wallet and cost optimization.', rows: [
    { key: 'dos', label: 'Rate limit / token budget', sub: 'Per-minute request cap and a rolling per-session token budget (numeric limits in the Advanced section below)' },
    { key: 'dosLoopDetection', label: 'Agent loop detection', sub: 'Detect an agent firing the same request over and over and break the loop' },
    { key: 'tokenPruner', label: 'Token Pruner / Cost Optimizer', sub: 'Smart content-aware prompt token optimization — minifies embedded JSON, compacts excessive whitespace, and preserves code indentation (Python, YAML, etc.)' },
  ]},
  { group: 'Advanced — Tuning', desc: 'Numeric thresholds and limits, plus the judge model. All take effect on the next request — no restart. Lowering a detection threshold catches more attacks but risks more false positives; raising it is more permissive.', rows: [
    { key: 'heuristicBlockThreshold', label: 'Heuristic block threshold', type: 'number', min: 1, max: 200, step: 1, sub: 'Stage 1 score at/above which a prompt is blocked (default 50). Rules add weights; one strong rule scores 50' },
    { key: 'embeddingBlockThreshold', label: 'Embedding block threshold', type: 'number', min: 0, max: 1, step: 0.01, sub: 'Stage 2 cosine similarity at/above which a prompt is blocked (default 0.86). Lower = stricter' },
    { key: 'embeddingWarnThreshold', label: 'Embedding warn threshold', type: 'number', min: 0, max: 1, step: 0.01, sub: 'Similarity at/above which a prompt warns and (if enabled) routes to the judge (default 0.80)' },
    { key: 'classifierThreshold', label: 'Classifier block threshold', type: 'number', min: 0, max: 1, step: 0.01, sub: 'INJECTION probability at/above which the trained classifier blocks (default 0.90). Lower = more recall, more false positives' },
    { key: 'dosMaxRpm', label: 'Max requests / minute', type: 'number', min: 1, max: 1000000, step: 1, sub: 'Requests allowed per rolling minute before rate-limiting (default 60)' },
    { key: 'dosMaxTokens', label: 'Max tokens / session', type: 'number', min: 1, max: 1000000000, step: 1000, sub: 'Rolling per-session token budget before the cost circuit-breaker trips (default 50,000,000)' },
    { key: 'judgeModel', label: 'Judge model (Ollama)', type: 'text', sub: 'Ollama model tag the Stage 3 judge uses, e.g. qwen2.5:3b. Pull it first: ollama pull <model>' },
  ]},
];

function settingsRowHtml(row, s) {
  let control;
  if (row.type === 'select') {
    const opts = row.options.map(o => '<option value="' + esc(o) + '"' + (s[row.key] === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
    control = '<select class="settings-select" id="set-' + esc(row.key) + '" data-type="select">' + opts + '</select>';
  } else if (row.type === 'number') {
    const attrs = (row.min != null ? ' min="' + row.min + '"' : '') + (row.max != null ? ' max="' + row.max + '"' : '') + (row.step != null ? ' step="' + row.step + '"' : '');
    control = '<input type="number" class="settings-input" id="set-' + esc(row.key) + '" data-type="number"' + attrs + ' value="' + esc(String(s[row.key])) + '">';
  } else if (row.type === 'text') {
    control = '<input type="text" class="settings-input" id="set-' + esc(row.key) + '" data-type="text" value="' + esc(String(s[row.key] != null ? s[row.key] : '')) + '">';
  } else {
    control = '<label class="switch"><input type="checkbox" id="set-' + esc(row.key) + '" data-type="toggle"' + (s[row.key] ? ' checked' : '') + '><span class="slider"></span></label>';
  }
  return '<div class="setting-row"><div><div class="setting-label">' + esc(row.label) + '</div>' +
    (row.sub ? '<div class="setting-sub">' + esc(row.sub) + '</div>' : '') + '</div>' +
    '<div class="setting-control">' + control + '</div></div>';
}

function renderSettings(s) {
  const body = document.getElementById('settings-body');
  body.innerHTML = SETTINGS_SCHEMA.map(g =>
    '<div class="settings-group"><h3>' + esc(g.group) + '</h3>' +
    (g.desc ? '<div class="grp-desc">' + esc(g.desc) + '</div>' : '') +
    g.rows.map(r => settingsRowHtml(r, s)).join('') + '</div>'
  ).join('');
  // Wire change handlers after the markup exists.
  for (const g of SETTINGS_SCHEMA) {
    for (const r of g.rows) {
      const el = document.getElementById('set-' + r.key);
      if (!el) continue;
      el.addEventListener('change', () => {
        let value;
        if (r.type === 'select' || r.type === 'text') value = el.value;
        else if (r.type === 'number') {
          if (el.value === '' || isNaN(Number(el.value))) { loadSettings(); return; } // ignore empty/invalid; resync
          value = Number(el.value);
        } else value = el.checked;
        saveSetting(r.key, value);
      });
    }
  }
}

let savedTimer = null;
function flashSaved(msg, isError) {
  const el = document.getElementById('settings-saved');
  el.textContent = msg;
  el.style.color = isError ? '#b3261e' : '#388e3c';
  el.style.opacity = '1';
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

async function loadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    renderSettings(s);
  } catch (err) {
    document.getElementById('settings-body').innerHTML =
      '<div class="text-danger">Failed to load settings: ' + esc(err.message) + '</div>';
  }
}

async function saveSetting(key, value) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value })
    });
    const d = await res.json();
    if (!res.ok) throw new Error((d.errors && d.errors.join('; ')) || d.error || ('HTTP ' + res.status));
    flashSaved('Saved ✓', false);
  } catch (err) {
    flashSaved('Save failed: ' + err.message, true);
    loadSettings(); // re-sync controls with actual server state
  }
}

loadSettings();

// ── Live Traffic ──────────────────────────────────────────────────────────────
const CHART_LEN = 60;
let chartHead = Math.floor(Date.now() / 1000);
const chartData = Array.from({length: CHART_LEN}, () => ({sent:0, recv:0, n:0}));
const tStats = {conn:0, sent:0, recv:0, inspected:0, tunneled:0};
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
  if (m.inspected) tStats.inspected++; else tStats.tunneled++;
  document.getElementById('t-inspected').textContent = tStats.inspected;
  document.getElementById('t-tunneled').textContent = tStats.tunneled;
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
const trafficMetrics = {}; // id -> metric, for the detail drawer
let openTrafficDrawerId = null;

function reqSummary(m) {
  if (m.inspected && m.method) {
    const p = esc((m.method || '') + ' ' + (m.path || '/'));
    return '<span class="req-cell" title="' + p + '">' + p + '</span>';
  }
  return '<span class="req-tunnel" title="Encrypted tunnel — body not inspected">encrypted tunnel</span>';
}

function renderTrafficDrawer(m) {
  const left =
    '<div><h4>Connection</h4><dl>' +
      '<dt>From IP</dt><dd>' + esc(m.fromIp || 'unknown') + '</dd>' +
      '<dt>Service</dt><dd>' + esc(m.service) + '</dd>' +
      '<dt>Host</dt><dd>' + esc(m.host) + '</dd>' +
      '<dt>Method</dt><dd>' + esc(m.inspected ? (m.method || 'GET') : '—') + '</dd>' +
      '<dt>Path</dt><dd>' + esc(m.inspected ? (m.path || '/') : '—') + '</dd>' +
      '<dt>Inspected</dt><dd>' + (m.inspected ? 'yes (TLS intercepted)' : 'no (passthrough tunnel)') + '</dd>' +
      '<dt>Sent</dt><dd>' + fmtB(m.bytesSent) + '</dd>' +
      '<dt>Received</dt><dd>' + fmtB(m.bytesReceived) + '</dd>' +
      '<dt>Time</dt><dd>' + esc(m.timestamp || '') + '</dd>' +
    '</dl></div>';

  let hdrs;
  if (m.reqHeaders && Object.keys(m.reqHeaders).length) {
    hdrs = '<div class="tlog-hdrs">' + Object.keys(m.reqHeaders).map(k =>
      '<div><span class="hk">' + esc(k) + ':</span> ' + esc(m.reqHeaders[k]) + '</div>').join('') + '</div>';
  } else {
    hdrs = '<div class="tlog-empty">Headers not captured for passthrough tunnels.</div>';
  }
  const right = '<div><h4>Request Headers</h4>' + hdrs + '</div>';

  let bodyBox;
  if (m.inspected) {
    bodyBox = (m.requestBody && m.requestBody.length)
      ? '<div class="tlog-body-box">' + esc(m.requestBody) + '</div>' +
        (m.bodyTruncated ? '<div class="tlog-trunc">⚠ Body truncated to 16 KB — showing the first part of the request.</div>' : '')
      : '<div class="tlog-empty">Empty request body.</div>';
  } else {
    bodyBox = '<div class="tlog-empty">This connection was a passthrough TLS tunnel (non-target host), so its contents are encrypted end-to-end and cannot be shown. Only the destination host and byte counts are observable.</div>';
  }
  const body = '<div class="full"><h4>Request Body — exactly what is being sent</h4>' + bodyBox + '</div>';

  return '<div class="tlog-drawer">' + left + right + body + '</div>';
}

function toggleTrafficDrawer(id) {
  const existing = document.getElementById('tdrawer-' + id);
  if (existing) {
    existing.remove();
    document.getElementById('trow-' + id)?.classList.remove('selected');
    openTrafficDrawerId = null;
    return;
  }
  if (openTrafficDrawerId) {
    document.getElementById('tdrawer-' + openTrafficDrawerId)?.remove();
    document.getElementById('trow-' + openTrafficDrawerId)?.classList.remove('selected');
  }
  const m = trafficMetrics[id];
  if (!m) return;
  openTrafficDrawerId = id;
  const row = document.getElementById('trow-' + id);
  if (!row) return;
  row.classList.add('selected');
  row.insertAdjacentHTML('afterend',
    '<tr class="tlog-drawer-row" id="tdrawer-' + id + '"><td colspan="8">' + renderTrafficDrawer(m) + '</td></tr>');
}

function addTlogRow(m) {
  if (m.id) trafficMetrics[m.id] = m;
  const cls = 'svc-' + m.service.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const tr = document.createElement('tr');
  tr.className = 'tlog-row';
  if (m.id) tr.id = 'trow-' + m.id;
  tr.innerHTML =
    '<td>' + esc(m.timestamp || '') + '</td>' +
    '<td class="ip-cell">' + esc(m.fromIp || 'unknown') + '</td>' +
    // #336: say outright whether llm-fw saw the contents.
    '<td>' + (m.inspected
      ? '<span class="insp-badge insp-yes" title="TLS intercepted: the request was decrypted and scanned">Inspected</span>'
      : '<span class="insp-badge insp-no" title="Passthrough tunnel: encrypted end to end, never decrypted or scanned">Not inspected</span>') + '</td>' +
    '<td><span class="svc-badge ' + cls + '">' + esc(m.service) + '</span></td>' +
    '<td>' + esc(m.host) + '</td>' +
    '<td>' + reqSummary(m) + '</td>' +
    '<td>' + fmtB(m.bytesSent) + '</td>' +
    '<td>' + fmtB(m.bytesReceived) + '</td>';
  if (m.id) tr.onclick = () => toggleTrafficDrawer(m.id);
  tlogBody.insertBefore(tr, tlogBody.firstChild);
  while (tlogBody.rows.length > 100) {
    const last = tlogBody.rows[tlogBody.rows.length - 1];
    if (last && last.id && last.id.indexOf('tdrawer-') === 0) {
      const did = last.id.slice('tdrawer-'.length);
      if (openTrafficDrawerId === did) openTrafficDrawerId = null;
    }
    tlogBody.deleteRow(tlogBody.rows.length - 1);
  }
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
  const palette = getComputedStyle(document.documentElement);
  const gridColor = palette.getPropertyValue('--line').trim() || '#e2e6ed';
  const lineColor = palette.getPropertyValue('--accent').trim() || '#0b7a8a';
  tCtx.strokeStyle = gridColor; tCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(H * i / 4);
    tCtx.beginPath(); tCtx.moveTo(0, y); tCtx.lineTo(W, y); tCtx.stroke();
  }
  // area fill
  tCtx.fillStyle = lineColor; tCtx.globalAlpha = 0.12;
  tCtx.beginPath();
  data.forEach((d, i) => {
    const x = i * step, y = H - ((d.sent + d.recv) / maxV) * (H - 4);
    i === 0 ? tCtx.moveTo(x, y) : tCtx.lineTo(x, y);
  });
  tCtx.lineTo((CHART_LEN - 1) * step, H); tCtx.lineTo(0, H);
  tCtx.closePath(); tCtx.fill(); tCtx.globalAlpha = 1;
  // line
  tCtx.strokeStyle = lineColor; tCtx.lineWidth = 2;
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

// ── Settings (live defense toggles) ───────────────────────────────────────────
// A flat, UI-friendly view of every defense/attack-type toggle. The dashboard
// reads this with GET /api/settings and writes a partial back with POST. Because
// the proxy and dashboard share ONE Config object in this process and every
// proxy defense now reads its `enabled` flag per-request, mutating `config` here
// takes effect on the proxy's next request — no restart.
interface SettingsView {
  asciiSmuggling: boolean
  classifier: boolean
  classifierThreshold: number
  manyShot: boolean
  manyShotMode: 'audit' | 'block'
  crescendo: boolean
  crescendoMode: 'audit' | 'block'
  promptInjectionJudge: boolean
  judgeBlock: boolean
  judgeUnlessBenign: boolean
  suppressions: boolean
  rag: boolean
  dlp: boolean
  dlpMode: 'block' | 'redact' | 'audit'
  dos: boolean
  dosLoopDetection: boolean
  mcp: boolean
  mcpGuardrails: boolean
  mcpCatA: boolean
  mcpCatB: boolean
  mcpCatC: boolean
  mcpCatD: boolean
  taint: boolean
  taintMode: 'audit' | 'block'
  urlFilter: boolean
  responseScan: boolean
  responseScanMode: 'block' | 'audit'
  responseHarm: boolean
  nonText: boolean
  nonTextMode: 'audit' | 'block'
  nonTextOcr: boolean
  nonTextTranscribe: boolean
  tokenPruner: boolean
  // Advanced — numeric/text tuning (all live, no restart).
  heuristicBlockThreshold: number
  embeddingBlockThreshold: number
  embeddingWarnThreshold: number
  dosMaxRpm: number
  dosMaxTokens: number
  judgeModel: string
}

// Defensive `?.`/defaults throughout: production config is always fully merged
// from DEFAULT_CONFIG, but a partial config (e.g. an embedder, or the screenshot
// launcher) must never make this endpoint throw a 500.
function readSettings(config: Config): SettingsView {
  return {
    tokenPruner: config.modules?.tokenPruner?.enabled ?? false,
    asciiSmuggling: config.asciiSmuggling?.enabled ?? true,
    classifier: config.detection?.classifier?.enabled ?? false,
    classifierThreshold: config.detection?.classifier?.blockThreshold ?? 0.9,
    manyShot: config.manyShot?.enabled ?? true,
    manyShotMode: config.manyShot?.mode ?? 'block',
    crescendo: config.crescendo?.enabled ?? true,
    crescendoMode: config.crescendo?.mode ?? 'block',
    promptInjectionJudge: config.detection?.judgeEnabled ?? false,
    judgeBlock: config.detection?.judgeBlock ?? false,
    judgeUnlessBenign: config.detection?.judgeUnlessBenign ?? false,
    suppressions: config.detection?.suppressions ?? true,
    rag: config.rag?.enabled ?? true,
    dlp: config.dlp?.enabled ?? true,
    dlpMode: config.dlp?.mode ?? 'redact',
    dos: config.dos?.enabled ?? true,
    dosLoopDetection: config.dos?.loopDetectionEnabled ?? true,
    mcp: config.mcp?.enabled ?? true,
    mcpGuardrails: config.mcp?.guardrailsEnabled ?? true,
    mcpCatA: config.mcp?.guardrailsCategories?.a ?? true,
    mcpCatB: config.mcp?.guardrailsCategories?.b ?? true,
    mcpCatC: config.mcp?.guardrailsCategories?.c ?? true,
    mcpCatD: config.mcp?.guardrailsCategories?.d ?? true,
    taint: config.taint?.enabled ?? false,
    taintMode: config.taint?.mode ?? 'audit',
    urlFilter: config.proxy?.urlFilter?.enabled ?? true,
    responseScan: config.responseScan?.enabled ?? true,
    responseScanMode: config.responseScan?.mode ?? 'audit',
    responseHarm: config.responseScan?.harmfulCompliance ?? true,
    nonText: config.nonText?.enabled ?? true,
    nonTextMode: config.nonText?.mode ?? 'audit',
    nonTextOcr: config.nonText?.ocr ?? false,
    nonTextTranscribe: config.nonText?.transcribe ?? false,
    heuristicBlockThreshold: config.detection?.heuristicBlockThreshold ?? 50,
    embeddingBlockThreshold: config.detection?.embeddingBlockThreshold ?? 0.86,
    embeddingWarnThreshold: config.detection?.embeddingWarnThreshold ?? 0.80,
    dosMaxRpm: config.dos?.maxRequestsPerMinute ?? 60,
    dosMaxTokens: config.dos?.maxTokensPerSession ?? 50_000_000,
    judgeModel: config.detection?.judgeModel ?? 'qwen2.5:3b',
  }
}

// Per-key appliers — the all-list of what POST /api/settings may change. Any key
// not present here is rejected, so the endpoint can never mutate arbitrary config.
const BOOL_SETTERS: Record<string, (c: Config, v: boolean) => void> = {
  asciiSmuggling: (c, v) => { c.asciiSmuggling ??= { enabled: true }; c.asciiSmuggling.enabled = v },
  classifier: (c, v) => { c.detection.classifier ??= { enabled: false, blockThreshold: 0.9 }; c.detection.classifier.enabled = v },
  manyShot: (c, v) => { c.manyShot ??= { enabled: true, minTurns: 8, harmfulComplianceThreshold: 2, mode: 'block' }; c.manyShot.enabled = v },
  crescendo: (c, v) => { c.crescendo ??= { enabled: true, minUserTurns: 3, mode: 'block' }; c.crescendo.enabled = v },
  responseHarm: (c, v) => { c.responseScan ??= { enabled: true, mode: 'audit' }; c.responseScan.harmfulCompliance = v },
  suppressions: (c, v) => { c.detection.suppressions = v },
  promptInjectionJudge: (c, v) => { c.detection.judgeEnabled = v },
  judgeBlock: (c, v) => { c.detection.judgeBlock = v },
  judgeUnlessBenign: (c, v) => { c.detection.judgeUnlessBenign = v },
  rag: (c, v) => { c.rag.enabled = v },
  dlp: (c, v) => { c.dlp.enabled = v },
  dos: (c, v) => { c.dos.enabled = v },
  dosLoopDetection: (c, v) => { c.dos.loopDetectionEnabled = v },
  mcp: (c, v) => { c.mcp.enabled = v },
  mcpGuardrails: (c, v) => { c.mcp.guardrailsEnabled = v },
  mcpCatA: (c, v) => { c.mcp.guardrailsCategories.a = v },
  mcpCatB: (c, v) => { c.mcp.guardrailsCategories.b = v },
  mcpCatC: (c, v) => { c.mcp.guardrailsCategories.c = v },
  mcpCatD: (c, v) => { c.mcp.guardrailsCategories.d = v },
  taint: (c, v) => { c.taint ??= { enabled: true, mode: 'audit' }; c.taint.enabled = v },
  urlFilter: (c, v) => { c.proxy.urlFilter.enabled = v },
  responseScan: (c, v) => { c.responseScan ??= { enabled: true, mode: 'audit' }; c.responseScan.enabled = v },
  nonText: (c, v) => { c.nonText ??= { enabled: true, mode: 'audit' }; c.nonText.enabled = v },
  nonTextOcr: (c, v) => { c.nonText ??= { enabled: true, mode: 'audit' }; c.nonText.ocr = v },
  nonTextTranscribe: (c, v) => { c.nonText ??= { enabled: true, mode: 'audit' }; c.nonText.transcribe = v },
  // Writes the config object the running TokenPrunerModule reads, so the
  // toggle is live without telling the ModuleManager.
  tokenPruner: (c, v) => { c.modules ??= { enabled: true, tokenPruner: { enabled: false } }; c.modules.tokenPruner ??= { enabled: false }; c.modules.tokenPruner.enabled = v },
}

// Numeric tuning setters with an inclusive valid range (the POST allowlist for
// numbers). Out-of-range or non-finite values are rejected.
const NUMBER_SETTERS: Record<string, { min: number; max: number; apply: (c: Config, v: number) => void }> = {
  classifierThreshold: { min: 0, max: 1, apply: (c, v) => { c.detection.classifier ??= { enabled: false, blockThreshold: 0.9 }; c.detection.classifier.blockThreshold = v } },
  heuristicBlockThreshold: { min: 1, max: 200, apply: (c, v) => { c.detection.heuristicBlockThreshold = v } },
  embeddingBlockThreshold: { min: 0, max: 1, apply: (c, v) => { c.detection.embeddingBlockThreshold = v } },
  embeddingWarnThreshold: { min: 0, max: 1, apply: (c, v) => { c.detection.embeddingWarnThreshold = v } },
  dosMaxRpm: { min: 1, max: 1_000_000, apply: (c, v) => { c.dos.maxRequestsPerMinute = Math.round(v) } },
  dosMaxTokens: { min: 1, max: 1_000_000_000, apply: (c, v) => { c.dos.maxTokensPerSession = Math.round(v) } },
}

// Free-text setters (the POST allowlist for strings). Trimmed, non-empty, capped.
const STRING_SETTERS: Record<string, { apply: (c: Config, v: string) => void }> = {
  judgeModel: { apply: (c, v) => { c.detection.judgeModel = v } },
}

const ENUM_SETTERS: Record<string, { values: readonly string[]; apply: (c: Config, v: string) => void }> = {
  dlpMode: { values: ['block', 'redact', 'audit'], apply: (c, v) => { c.dlp.mode = v as Config['dlp']['mode'] } },
  manyShotMode: { values: ['audit', 'block'], apply: (c, v) => { c.manyShot ??= { enabled: true, minTurns: 8, harmfulComplianceThreshold: 2, mode: 'block' }; c.manyShot.mode = v as 'audit' | 'block' } },
  crescendoMode: { values: ['audit', 'block'], apply: (c, v) => { c.crescendo ??= { enabled: true, minUserTurns: 3, mode: 'block' }; c.crescendo.mode = v as 'audit' | 'block' } },
  taintMode: { values: ['audit', 'block'], apply: (c, v) => { c.taint ??= { enabled: true, mode: 'audit' }; c.taint.mode = v as 'audit' | 'block' } },
  responseScanMode: { values: ['block', 'audit'], apply: (c, v) => { c.responseScan ??= { enabled: true, mode: 'audit' }; c.responseScan.mode = v as 'block' | 'audit' } },
  nonTextMode: { values: ['audit', 'block'], apply: (c, v) => { c.nonText ??= { enabled: true, mode: 'audit' }; c.nonText.mode = v as 'audit' | 'block' } },
}

// Reconstruct the toggle-relevant subset of config as a nested partial for
// persistence. Written as a plain object (not full sub-configs) and deep-merged
// into the existing ~/.llm-fw/config.json so unrelated keys (e.g. proxy.mode)
// survive — same approach as src/cli/setup.ts.
function toPersistedPartial(config: Config): Record<string, unknown> {
  return {
    detection: {
      judgeEnabled: config.detection.judgeEnabled,
      judgeBlock: config.detection.judgeBlock,
      judgeUnlessBenign: config.detection.judgeUnlessBenign ?? false,
      suppressions: config.detection.suppressions ?? true,
      judgeModel: config.detection.judgeModel,
      heuristicBlockThreshold: config.detection.heuristicBlockThreshold,
      embeddingBlockThreshold: config.detection.embeddingBlockThreshold,
      embeddingWarnThreshold: config.detection.embeddingWarnThreshold,
      classifier: {
        enabled: config.detection.classifier?.enabled ?? false,
        blockThreshold: config.detection.classifier?.blockThreshold ?? 0.9,
      },
    },
    rag: { enabled: config.rag.enabled },
    dlp: { enabled: config.dlp.enabled, mode: config.dlp.mode },
    dos: {
      enabled: config.dos.enabled,
      loopDetectionEnabled: config.dos.loopDetectionEnabled,
      maxRequestsPerMinute: config.dos.maxRequestsPerMinute,
      maxTokensPerSession: config.dos.maxTokensPerSession,
    },
    mcp: {
      enabled: config.mcp.enabled,
      guardrailsEnabled: config.mcp.guardrailsEnabled,
      guardrailsCategories: { ...config.mcp.guardrailsCategories },
    },
    taint: { enabled: config.taint?.enabled ?? false, mode: config.taint?.mode ?? 'audit' },
    proxy: { urlFilter: { enabled: config.proxy.urlFilter.enabled } },
    asciiSmuggling: { enabled: config.asciiSmuggling?.enabled ?? true },
    manyShot: { enabled: config.manyShot?.enabled ?? true, mode: config.manyShot?.mode ?? 'block' },
    crescendo: { enabled: config.crescendo?.enabled ?? true, mode: config.crescendo?.mode ?? 'block' },
    responseScan: {
      enabled: config.responseScan?.enabled ?? true,
      mode: config.responseScan?.mode ?? 'audit',
      harmfulCompliance: config.responseScan?.harmfulCompliance ?? true,
    },
    // Every module's switch and options. persistSettings writes only the
    // leaves that changed, so a module added later persists without an edit
    // here.
    modules: structuredClone(config.modules ?? { enabled: true, tokenPruner: { enabled: false } }),
  }
}

/**
 * Validate and apply a partial settings object to the live config.
 * Returns which keys were applied and any validation errors. Does NOT persist —
 * the caller writes to disk after a successful apply.
 */
function applySettings(config: Config, patch: Record<string, unknown>): { applied: string[]; errors: string[] } {
  const applied: string[] = []
  const errors: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    // Bind the setter, then test it. `key in TABLE` tells a reader the entry
    // exists but tells the compiler nothing about TABLE[key], and the tables
    // are constants with no undefined values, so the two forms select exactly
    // the same entries. Validation order is unchanged: type first, apply after.
    const boolSetter = BOOL_SETTERS[key]
    const enumSpec = ENUM_SETTERS[key]
    const numberSpec = NUMBER_SETTERS[key]
    const stringSpec = STRING_SETTERS[key]
    if (boolSetter) {
      if (typeof value !== 'boolean') { errors.push(`${key}: expected boolean`); continue }
      boolSetter(config, value)
      applied.push(key)
    } else if (enumSpec) {
      const spec = enumSpec
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push(`${key}: expected one of ${spec.values.join(', ')}`); continue
      }
      spec.apply(config, value)
      applied.push(key)
    } else if (numberSpec) {
      const spec = numberSpec
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) {
        errors.push(`${key}: expected a number in [${spec.min}, ${spec.max}]`); continue
      }
      spec.apply(config, value)
      applied.push(key)
    } else if (stringSpec) {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
        errors.push(`${key}: expected a non-empty string (≤ 100 chars)`); continue
      }
      stringSpec.apply(config, value.trim())
      applied.push(key)
    } else {
      errors.push(`${key}: unknown setting`)
    }
  }
  return { applied, errors }
}

// The leaves of `after` that differ from `before`, as a nested partial. Both
// come from toPersistedPartial, so the keys are that function's static ones.
function changedLeaves(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    const prior = before[key]
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
    if (isObj(value) && isObj(prior)) {
      const sub = changedLeaves(prior, value)
      if (Object.keys(sub).length) out[key] = sub
    } else if (JSON.stringify(prior) !== JSON.stringify(value)) {
      out[key] = value
    }
  }
  return out
}

// Persists to <LLM_FW_DIR>/config.json, deep-merging so unrelated keys are
// preserved, and writes only the settings this request changed: `before` is
// toPersistedPartial(config) taken before the change was applied. Writing the
// whole live snapshot persisted values that are not file config: under
// `start --observe` stage modes are relaxed in memory, so one toggle wrote
// dlp.mode "audit" (and up to four more) to disk and the firewall stayed relaxed
// after a restart without --observe; LLM_FW_* overrides were copied into the
// file the same way.
function persistSettings(config: Config, before: Record<string, unknown>): void {
  const changed = changedLeaves(before, toPersistedPartial(config))
  if (!Object.keys(changed).length) return
  const dir = getLlmFwDir()
  const file = join(dir, 'config.json')
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { /* none */ }
  const merged = deepMerge<Record<string, unknown>>(existing, changed)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
}

// CSRF guard for state-changing POSTs. The dashboard has no auth/cookies, but it
// can bind to 0.0.0.0 (standalone mode) and its endpoints mutate the firewall's
// security posture (e.g. disabling a defense via /api/settings), so a page in the
// operator's browser must not be able to drive it cross-origin. Two checks:
//   1. Content-Type must be application/json — a cross-origin fetch with this
//      type triggers a CORS preflight the (CORS-header-less) dashboard fails, so
//      the browser never sends the actual request. Blocks simple-request CSRF.
//   2. If an Origin/Referer is present it must match this server's own host —
//      blocks anything that does reach us from another origin.
// Non-browser clients (curl, scripts) have no ambient credentials to abuse and
// send no Origin, so they are unaffected beyond the JSON content-type rule.
function checkSameOrigin(req: http.IncomingMessage): { ok: true } | { ok: false; status: number; error: string } {
  const ct = ((req.headers['content-type'] ?? '').split(';')[0] ?? '').trim().toLowerCase()
  if (ct !== 'application/json') {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' }
  }
  const host = req.headers.host ?? ''
  const origin = req.headers.origin ?? req.headers.referer ?? ''
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return { ok: false, status: 403, error: 'cross-origin request blocked' }
    } catch {
      return { ok: false, status: 403, error: 'bad origin' }
    }
  }
  return { ok: true }
}

// ── Dashboard authentication ──────────────────────────────────────────────────
// The dashboard exposes captured payloads and (now) defense toggles, so it must
// not be open when reachable from the network. Policy: the operator on the SAME
// machine (loopback) always has access with zero config; any NON-loopback client
// must present the shared token. Bootstrap endpoints that serve the public CA are
// always open (a client needs the CA before it can trust anything).
const AUTH_EXEMPT_PATHS = new Set(['/ca.crt', '/ca.pem', '/crl'])

// Credential primitives live in src/auth.ts so the dashboard, the forward
// proxy and the gateway share one implementation. Re-exported here because
// they were part of this module's surface before the move.
export { isLoopbackAddr, tokenMatches } from '../auth.js'

// The playground answers "would this be blocked?". Under observe mode the
// pipeline downgrades a block to warn so nothing is refused, and marks it
// enforced: false; report the underlying verdict instead of the downgrade
// (#318), and keep the flag so the UI can say it is not enforced.
function playgroundVerdict(result: PipelineResult): PipelineResult {
  return result.enforced === false ? { ...result, action: 'block' } : result
}

/** Pull a presented token from Authorization (Bearer/Basic), ?token=, in that order. */
export function presentedToken(req: http.IncomingMessage, url: URL): string {
  return credentialFromAuthHeader(req.headers.authorization) || (url.searchParams.get('token') ?? '')
}

export function createDashboardServer(config: Config, eventBus: EventBus, pipeline: Pipeline, suppressions?: SuppressionStore, metrics?: MetricsRegistry, moduleManager?: ModuleManager): http.Server {
  const modManager = moduleManager ?? new ModuleManager(config)
  // Defaults to a private store (behaviorally an always-empty suppression
  // list) when the caller doesn't share one — e.g. tests that construct the
  // dashboard server directly. cli/start.ts passes the SAME instance used by
  // the live-traffic pipeline so a false positive marked here actually
  // affects real traffic.
  const suppressionStore = suppressions ?? new SuppressionStore()
  suppressionStore.load()
  // Task C4 — same sharing pattern as suppressionStore above: cli/start.ts
  // passes the SAME registry used by the proxy's live-traffic pipeline (via
  // EventBus.emit()) so GET /metrics reports on both surfaces, not just
  // playground scans run from this dashboard.
  const metricsRegistry = metrics ?? new MetricsRegistry()
  // Effective auth token: configured value, else a generated one so a
  // remotely-reachable dashboard is never left open. Loopback callers bypass auth
  // entirely, so a purely local dashboard never needs the token.
  const bindHost = config.dashboard.bindHost as string | undefined
  const bindLocal = bindHost === undefined || isLoopback(bindHost)
  const authToken = config.dashboard.authToken || generateToken()
  if (!bindLocal) {
    if (config.dashboard.authToken) {
      log.info('remote access requires the configured auth token (Authorization: Bearer <token>, or Basic with the token as the password).')
    } else {
      log.info(`reachable remotely — auth token (no LLM_FW_DASHBOARD_TOKEN set): ${authToken}`)
    }
  }

  const isAuthorized = (req: http.IncomingMessage, url: URL, path: string): boolean => {
    // Loopback trust needs a Host that names loopback: a page that rebinds
    // its own domain to 127.0.0.1 arrives from loopback too (GHSA-c725-vwcm-h8rr).
    if (isLoopback(req.socket.remoteAddress) && isLoopbackHostHeader(req.headers.host)) return true
    if (AUTH_EXEMPT_PATHS.has(path)) return true
    return matchesToken(presentedToken(req, url), authToken)
  }

  const urlClassifier = config.proxy.urlFilter.enabled
    ? new UrlClassifier(config.proxy.urlFilter)
    : null
  // Playground detectors — stateless, so always available regardless of whether
  // the corresponding stage is enabled for live traffic (the response notes the
  // configured enabled/mode so the UI can flag a disabled stage).
  const dlpScanner = new DlpScanner(config.dlp)
  const mcpScanner = new McpScanner(config, dlpScanner)

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.dashboard.port}`)
    const path = url.pathname

    // Auth gate — loopback bypasses; non-loopback needs the token. 401 with a
    // Basic challenge so a remote browser is prompted natively.
    if (!isAuthorized(req, url, path)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="llm-fw dashboard", charset="UTF-8"',
      })
      res.end(JSON.stringify({ error: 'authentication required' }))
      return
    }

    // Task C4 — Prometheus scrape endpoint. Behind the SAME auth gate as
    // every other dashboard route (the check above already ran); gated by
    // config.dashboard.metrics (default true) so an operator can opt out.
    if (req.method === 'GET' && path === '/metrics') {
      if (config.dashboard.metrics === false) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(metricsRegistry.render(pipeline.getModelStatus()))
      return
    }

    if (req.method === 'GET' && path === '/') {
      // The page ships every style and script inline and talks only to this
      // origin (fetch to /api/*, the /events stream), so the policy says
      // exactly that: nothing external can load even if markup ever slipped
      // past esc(), no site can frame the dashboard to click-jack its live
      // switches, and the favicon and SVG backgrounds stay data: URIs.
      // 'unsafe-inline' is the price of inline on* handlers; 'unsafe-eval' is
      // not granted. Pinned by dashboard.integration.test.ts (the header) and
      // csp.spec.ts (the real page running under it).
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
          "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      })
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

    if (req.method === 'GET' && path === '/api/settings') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(readSettings(config)))
      return
    }

    // Toggle defenses live. Mutates the shared in-memory config (effective on the
    // proxy's next request) and persists to ~/.llm-fw/config.json.
    if (req.method === 'POST' && path === '/api/settings') {
      const guard = checkSameOrigin(req)
      if (!guard.ok) {
        res.writeHead(guard.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: guard.error }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          let patch: unknown
          try {
            patch = JSON.parse(body || '{}') as unknown
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'body must be a JSON object of settings' }))
            return
          }
          const before = toPersistedPartial(config)
          const { applied, errors } = applySettings(config, patch as Record<string, unknown>)
          if (errors.length && !applied.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'no valid settings', errors }))
            return
          }
          if (applied.length) persistSettings(config, before)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, applied, errors, settings: readSettings(config) }))
        } catch (err) {
          log.error('/api/settings handler error', { err: err })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request read error' }))
      })
      return
    }

    // What this process started (#338). The runtime record is written by
    // `llm-fw start` (src/cli/runtimeState.ts) and trusted only for this pid;
    // enforcement comes from live config, which is authoritative in-process.
    if (req.method === 'GET' && path === '/api/status') {
      const state = readRuntimeState(getLlmFwDir(), process.pid)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        enforcement: config.enforcement === 'observe' ? 'observe' : 'enforce',
        sinkhole: state?.sinkhole ?? false,
        gatewayUrl: state?.gatewayUrl ?? null,
        proxyUrl: state?.proxyUrl ?? null,
        startedAt: state?.startedAt ?? null,
      }))
      return
    }

    if (req.method === 'GET' && path === '/api/modules') {
      const summary = modManager.getSummaryStats()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ...summary,
        tokenEconomy: modManager.getTokenEconomy(),
        modules: modManager.listModules().map(m => ({ ...m.getStats(), description: m.description, options: modManager.getModuleOptions(m.id) ?? [] })),
        summary,
      }))
      return
    }

    if (req.method === 'POST' && path === '/api/modules') {
      const guard = checkSameOrigin(req)
      if (!guard.ok) {
        res.writeHead(guard.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: guard.error }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}') as { id?: string; enabled?: boolean; options?: unknown }
          const hasSwitch = typeof patch.enabled === 'boolean'
          const options = patch.options !== undefined && typeof patch.options === 'object' && patch.options !== null && !Array.isArray(patch.options)
            ? patch.options as Record<string, unknown> : undefined
          if (!patch.id || typeof patch.id !== 'string' || (!hasSwitch && !options)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'id and enabled (boolean) or options (object) are required' }))
            return
          }
          if (patch.id !== TOKEN_ECONOMY_ID && !modManager.getModule(patch.id)) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unknown module', id: patch.id }))
            return
          }
          const before = toPersistedPartial(config)
          // Options are validated as a whole before anything changes (#354),
          // and checked before the switch so a bad request changes nothing.
          if (options) {
            const error = modManager.setModuleOptions(patch.id, options)
            if (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error }))
              return
            }
          }
          if (hasSwitch) modManager.setModuleEnabled(patch.id, patch.enabled!)
          // A built-in module's switch and options live in config (the module
          // holds a reference to it), so persisting config persists them.
          persistSettings(config, before)
          const mod = modManager.getModule(patch.id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, module: mod ? { ...mod.getStats(), options: modManager.getModuleOptions(patch.id) ?? [] } : undefined, tokenEconomy: modManager.getTokenEconomy() }))
        } catch (err) {
          log.error('/api/modules handler error', { err: err })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request read error' }))
      })
      return
    }

    if (req.method === 'GET' && path === '/api/prompts') {
      const monitor = modManager.getModule('prompt-monitor')
      if (!(monitor instanceof PromptMonitorModule)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'prompt monitor is not available' }))
        return
      }
      const param = (name: string): string | undefined => url.searchParams.get(name) || undefined
      const num = (name: string): number | undefined => {
        const n = parseInt(url.searchParams.get(name) ?? '', 10)
        return Number.isNaN(n) ? undefined : n
      }
      const page = monitor.query({
        q: param('q'), target: param('target'), model: param('model'), session: param('session'),
        since: param('since'), until: param('until'), limit: num('limit'), offset: num('offset'),
      })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ enabled: monitor.enabled, ...page }))
      return
    }

    if (req.method === 'POST' && path === '/api/prompts/clear') {
      const guard = checkSameOrigin(req)
      if (!guard.ok) {
        res.writeHead(guard.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: guard.error }))
        return
      }
      const monitor = modManager.getModule('prompt-monitor')
      if (!(monitor instanceof PromptMonitorModule)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'prompt monitor is not available' }))
        return
      }
      monitor.clear()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && path === '/api/test') {
      let body = ''
      let tooLarge = false
      // Image/Document uploads ride this endpoint as base64 data URLs (capped at
      // 8 MB client-side ≈ ~11 MB encoded). Guard the server too so a rogue
      // client can't grow the in-memory body unbounded.
      const POST_BODY_LIMIT = 16 * 1024 * 1024
      req.on('data', chunk => {
        if (tooLarge) return
        body += chunk
        if (body.length > POST_BODY_LIMIT) {
          tooLarge = true
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooLarge) return
        void (async () => {
        try {
          let parsed: { prompt?: string; url?: string; category?: string; text?: string; dataUrl?: string }
          try {
            parsed = JSON.parse(body) as { prompt?: string; url?: string; category?: string; text?: string; dataUrl?: string }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const category = parsed.category
          // Unified text field with back-compat fallback to the original `prompt`.
          const text = (parsed.text ?? parsed.prompt ?? '').toString()

          // ── Non-text content (issue #60) ──────────────────────────────────
          // Wrap the input as an image/document content block and run it
          // through the real pipeline, so the playground demonstrates that
          // injections smuggled inside files are decoded & blocked, and that
          // opaque media (raster images) is surfaced or refused.
          if (category === 'image') {
            const dataUrl = (parsed.dataUrl ?? '').toString().trim()
            const rawText = text.trim()
            if (!dataUrl && !rawText) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'image text or dataUrl is required' }))
              return
            }

            let block: Record<string, unknown>
            if (dataUrl) {
              const du = parseDataUrl(dataUrl)
              if (!du) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'invalid base64 data URL' }))
                return
              }
              const isImage = du.mimeType.startsWith('image/')
              block = {
                type: isImage ? 'image' : 'document',
                source: { type: 'base64', media_type: du.mimeType, data: du.data },
              }
            } else {
              // Free-typed text → simulate an uploaded text document carrying it.
              block = {
                type: 'document',
                source: { type: 'base64', media_type: 'text/plain', data: Buffer.from(rawText, 'utf-8').toString('base64') },
              }
            }

            const imageBody = JSON.stringify({
              model: 'claude-3-haiku-20240307',
              max_tokens: 1,
              messages: [{ role: 'user', content: [block] }],
            })
            // Task C4 — timed at this call boundary (mirrors proxy.ts) to
            // feed llmfw_requests_total{surface="playground"} + the overall
            // llmfw_scan_duration_seconds histogram.
            const imageScanStart = Date.now()
            const imageResult = await pipeline.run(
              '/v1/messages',
              imageBody,
              { target: 'playground', method: 'POST', path: '/v1/messages' }
            )
            metricsRegistry.recordScan('playground', Date.now() - imageScanStart)

            // Mode-independent introspection: report what was extracted and
            // whether it was decodable, so the UI is informative even in audit
            // mode (where opaque media passes through without a 403).
            const parser = getParser('/v1/messages')
            const blocks = parser?.extractMediaBlocks ? parser.extractMediaBlocks(imageBody) : []
            // Mirror the pipeline's opt-in OCR so the card shows the recovered
            // text (and counts the image as scanned), not just "opaque".
            const ocrOn = config.nonText?.ocr ?? false
            if (ocrOn) {
              for (const b of blocks) {
                if (!b.text && b.data && isOcrCandidate(b.mimeType)) {
                  const text = await ocrImage(b.data, b.mimeType)
                  if (text) b.text = text
                }
              }
            }
            const opaque = blocks.filter(b => !b.text)
            // #334: in audit mode the pipeline forwards opaque media (verdict
            // pass) and raises a warn event. The playground reports what an
            // operator sees in Events, a warning, rather than a bare PASS.
            const auditedOpaque = imageResult.action === 'pass' && opaque.length > 0
              && (config.nonText?.enabled ?? false) && (config.nonText?.mode ?? 'audit') === 'audit'
            const verdict: PipelineResult = auditedOpaque
              ? { ...imageResult, action: 'warn', stage: 'non-text' }
              : playgroundVerdict(imageResult)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              ...verdict,
              category: 'image',
              judgeEnabled: config.detection.judgeEnabled,
              nonTextEnabled: config.nonText?.enabled ?? false,
              nonTextMode: config.nonText?.mode ?? 'audit',
              nonTextOcr: ocrOn,
              media: {
                blocks: blocks.map(b => ({
                  kind: b.kind,
                  mimeType: b.mimeType,
                  sizeBytes: b.sizeBytes,
                  scanned: !!b.text,
                  decodedPreview: b.text ? b.text.slice(0, 200) : undefined,
                })),
                scannedCount: blocks.length - opaque.length,
                opaqueCount: opaque.length,
                opaqueSummary: opaque.length ? summarizeOpaque(opaque) : '',
              },
            }))
            return
          }

          // ── Data Loss Prevention ──────────────────────────────────────────
          if (category === 'dlp') {
            const findings = dlpScanner.scan(text)
            const types = Array.from(new Set(findings.map(f => f.type)))
            const redacted = findings.length ? dlpScanner.redact(text, findings) : text
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              category: 'dlp',
              count: findings.length,
              findings: types,
              redacted,
              mode: config.dlp.mode,
              enabled: config.dlp.enabled,
            }))
            return
          }

          // ── MCP tool policy ───────────────────────────────────────────────
          if (category === 'mcp') {
            const names = text.split(',').map(s => s.trim()).filter(Boolean)
            const tools = names.map(name => ({ name }))
            const result = mcpScanner.checkToolDefinitions(tools)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              category: 'mcp',
              action: result.action,
              reason: result.reason,
              blockedTools: config.mcp.blockedTools,
              enabled: config.mcp.enabled,
            }))
            return
          }

          // ── Security Guardrails ───────────────────────────────────────────
          if (category === 'guardrails') {
            const tool = (parsed as { tool?: string }).tool ?? 'bash'
            const toggles = (parsed as { toggles?: { a: boolean; b: boolean; c: boolean; d: boolean } }).toggles ?? { a: true, b: true, c: true, d: true }
            
            const scanner = new CommandScanner()
            const scanResult = scanner.scan(text, toggles)
            
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              category: 'guardrails',
              action: scanResult.isBlocked ? 'block' : 'pass',
              reason: scanResult.reason,
              tool,
              text,
            }))
            return
          }

          // ── DoS / cost-control policy (informational) ─────────────────────
          if (category === 'dos') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ category: 'dos', dos: config.dos }))
            return
          }

          if (parsed.url !== undefined || category === 'url') {
            const raw = (parsed.url ?? text).trim()
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

          // Prompt injection (Stage 1-3) and RAG context-poisoning both run
          // through the detection pipeline, which reports the blocking stage.
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text is required' }))
            return
          }
          const anthropicBody = JSON.stringify({
            model: 'claude-3-haiku-20240307',
            messages: [{ role: 'user', content: text }],
            max_tokens: 1,
          })
          const textScanStart = Date.now()
          const result = await pipeline.run(
            '/v1/messages',
            anthropicBody,
            { target: 'playground', method: 'POST', path: '/v1/messages' }
          )
          metricsRegistry.recordScan('playground', Date.now() - textScanStart)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...playgroundVerdict(result), judgeEnabled: config.detection.judgeEnabled, category: category ?? 'injection' }))
        } catch (err) {
          log.error('/api/test handler error', { err: err })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })() })
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request read error' }))
      })
      return
    }

    // Mark a buffered event as a false positive; persists it to
    // ~/.llm-fw/whitelist.json via the EventBus.
    if (req.method === 'POST' && path === '/api/whitelist') {
      const guard = checkSameOrigin(req)
      if (!guard.ok) {
        res.writeHead(guard.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: guard.error }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          let id: string | undefined, reason: string | undefined
          try {
            ;({ id, reason } = JSON.parse(body || '{}') as { id?: string; reason?: string })
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'id is required' }))
            return
          }
          const entry = eventBus.whitelist(id, reason)
          if (!entry) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'event not found' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, entry }))
        } catch (err) {
          log.error('/api/whitelist handler error', { err: err })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request read error' }))
      })
      return
    }

    if (req.method === 'GET' && path === '/api/whitelist') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(eventBus.readWhitelist()))
      return
    }

    // Operator false-positive feedback loop (Task B2). Distinct from
    // /api/whitelist above: whitelist is an audit trail only (never consulted
    // by the pipeline). This endpoint resolves the buffered event's ORIGINAL
    // prompt text (payload_full) and adds it to the persisted suppression
    // list, so an identical future prompt is downgraded from block to warn by
    // the detection pipeline (see Pipeline.isSuppressed).
    if (req.method === 'POST' && path === '/api/feedback') {
      const guard = checkSameOrigin(req)
      if (!guard.ok) {
        res.writeHead(guard.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: guard.error }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          let eventId: string | undefined
          try {
            ;({ eventId } = JSON.parse(body || '{}') as { eventId?: string })
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          if (!eventId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'eventId is required' }))
            return
          }
          const event = eventBus.find(eventId)
          if (!event) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              error: 'event not found: events are held in memory only, so llm-fw forgets them on restart, ' +
                'and it keeps the last ' + config.dashboard.maxEvents + ' blocked ones. Re-send the request and mark the new event.',
            }))
            return
          }
          if (event.action !== 'blocked') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'only blocked events can be suppressed' }))
            return
          }
          const promptText = event.payload_full || event.payload_preview
          if (!promptText) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'event has no payload to suppress' }))
            return
          }
          const entry = event.suppressionKey
            ? suppressionStore.addKey(event.suppressionKey, event.payload_preview || promptText)
            : suppressionStore.add(promptText)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, entry }))
        } catch (err) {
          log.error('/api/feedback handler error', { err: err })
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        }
      })
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request read error' }))
      })
      return
    }

    if (req.method === 'GET' && path === '/api/suppressions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(suppressionStore.list()))
      return
    }

    // Remove a suppression, e.g. the operator changes their mind. hash is the
    // sha256 identifying the suppressed (normalized) text — see suppressions.ts.
    if (req.method === 'DELETE' && path === '/api/suppressions') {
      const guard = checkSameOrigin(req)
      if (!guard.ok) {
        res.writeHead(guard.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: guard.error }))
        return
      }
      const hash = url.searchParams.get('hash') ?? ''
      if (!hash) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'hash query param is required' }))
        return
      }
      const removed = suppressionStore.remove(hash)
      if (!removed) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no suppression with that hash' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Full Google Translate language list, used to populate the playground's
    // language picker.
    if (req.method === 'GET' && path === '/api/languages') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(TRANSLATE_LANGUAGES))
      return
    }

    // Translate the playground's injection text into a target language so the
    // same attack can be exercised across locales. Server-side to dodge CORS.
    if (req.method === 'POST' && path === '/api/translate') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => { void (async () => {
        try {
          let parsed: { text?: string; target?: string; source?: string }
          try {
            parsed = JSON.parse(body || '{}') as { text?: string; target?: string; source?: string }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const { text, target, source } = parsed
          if (!text || !target) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text and target are required' }))
            return
          }
          const result = await translateText(text, target, source ?? 'auto')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          log.error('/api/translate handler error', { err: err })
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'translation request failed' }))
        }
      })() })
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

    // Serve the CA certificate so standalone clients can download and trust it.
    // Offered both as an inline view and a forced download (?download).
    if (req.method === 'GET' && (path === '/ca.crt' || path === '/ca.pem')) {
      const caPath = join(getLlmFwDir(), 'ca.crt')
      if (fs.existsSync(caPath)) {
        const caData = fs.readFileSync(caPath)
        const disposition = url.searchParams.has('download')
          ? 'attachment; filename="llm-fw-ca.crt"'
          : 'inline'
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Length': String(caData.length),
          'Content-Disposition': disposition,
        })
        res.end(caData)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'CA certificate not found — run "llm-fw setup" first' }))
      }
      return
    }

    // Serve the CRL so Windows Schannel can verify revocation status of MITM certs.
    if (req.method === 'GET' && path === '/crl') {
      const crlPath = join(getLlmFwDir(), 'ca.crl')
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

export { HTML as DASHBOARD_HTML }
