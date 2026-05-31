// Minimal dashboard-only server for screenshotting — no proxy, no ML model.
import { createDashboardServer } from '../src/dashboard/server.js'
import { EventBus } from '../src/dashboard/eventBus.js'
import type { Pipeline } from '../src/detection/pipeline.js'
import type { Config } from '../src/types.js'

const config: Config = {
  proxy: {
    mode: 'proxy', port: 8080, httpsPort: 8443, upstreamTimeoutMs: 30000,
    maxBodyBytes: 10_000_000, dnsServers: [], urlFilter: { enabled: true, entropyThreshold: 3.5, allowlistDomains: [], blocklistDomains: [] },
  },
  detection: {
    heuristicBlockThreshold: 50, embeddingBlockThreshold: 0.85, embeddingWarnThreshold: 0.65,
    chunkTokenLimit: 512, chunkSize: 256, chunkOverlap: 64,
    judgeEnabled: false, judgeModel: '', judgeBlock: false,
  },
  dashboard: { port: 7731, maxEvents: 100 },
  dlp: { enabled: true, mode: 'block', detectors: ['api-key', 'credit-card'] },
  dos: { enabled: true, maxRequestsPerMinute: 60, maxTokensPerSession: 100000, loopDetectionEnabled: true },
  rag: { enabled: false },
  targets: ['api.openai.com', 'api.anthropic.com'],
}

const eventBus = new EventBus(config.dashboard)

// Seed realistic traffic metrics spread across the last 30 seconds so the chart shows a curve.
const seed = [
  { service: 'OpenAI',    host: 'api.openai.com',    bytesSent:  1248, bytesReceived:  9420, delayMs:  0 },
  { service: 'Anthropic', host: 'api.anthropic.com',  bytesSent:  2104, bytesReceived: 15830, delayMs:  0 },
  { service: 'OpenAI',    host: 'api.openai.com',    bytesSent:   892, bytesReceived:  6100, delayMs:  500 },
  { service: 'Anthropic', host: 'api.anthropic.com',  bytesSent:  3410, bytesReceived: 22740, delayMs:  1000 },
  { service: 'Local',     host: 'localhost:11434',    bytesSent:   456, bytesReceived:  3210, delayMs:  1200 },
  { service: 'OpenAI',    host: 'api.openai.com',    bytesSent:  1760, bytesReceived: 11200, delayMs:  1800 },
  { service: 'Local',     host: 'localhost:11434',    bytesSent:   810, bytesReceived:  7450, delayMs:  2000 },
  { service: 'Anthropic', host: 'api.anthropic.com',  bytesSent:  1980, bytesReceived: 18600, delayMs:  2500 },
  { service: 'OpenAI',    host: 'api.openai.com',    bytesSent:  2340, bytesReceived: 14500, delayMs:  3000 },
  { service: 'Local',     host: 'localhost:11434',    bytesSent:   320, bytesReceived:  2100, delayMs:  3200 },
]
for (const m of seed) {
  setTimeout(() => eventBus.emitTraffic({ service: m.service, host: m.host, bytesSent: m.bytesSent, bytesReceived: m.bytesReceived }), m.delayMs)
}

const fakePipeline = { run: async () => ({ action: 'pass' as const, stage: 'none' as const, score: 0, similarity: 0 }), init: async () => {}, checkPartial: async () => null } as unknown as Pipeline

const server = createDashboardServer(config, eventBus, fakePipeline)
server.listen(config.dashboard.port, () => {
  console.log(`Dashboard ready → http://127.0.0.1:${config.dashboard.port}`)
})
