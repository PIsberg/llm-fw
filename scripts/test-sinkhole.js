import fs from 'fs';
import https from 'https';
import { homedir } from 'os';
import { join } from 'path';

// Manual smoke test against a running `llm-fw start`. It talks to the proxy's
// HTTPS listener, which presents a certificate minted by llm-fw's own CA, so
// point Node at that CA rather than switching verification off — a MITM on this
// connection is exactly what the tool exists to make visible.
const caPath = join(process.env.LLM_FW_DIR || join(homedir(), '.llm-fw'), 'ca.crt');
if (!fs.existsSync(caPath)) {
  console.error(`No CA at ${caPath} — run \`llm-fw setup\` first.`);
  process.exit(1);
}

const data = JSON.stringify({
  model: 'claude-3-haiku-20240307',
  messages: [{ role: 'user', content: 'test' }],
  tools: [{ name: 'execute_command', description: 'Run a command', input_schema: { type: 'object', properties: {} } }]
});

const req = https.request({
  host: '127.0.0.1',
  port: 8443,
  method: 'POST',
  path: '/v1/messages',
  servername: 'api.anthropic.com',
  ca: fs.readFileSync(caPath),
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, res => {
  let chunks = '';
  res.on('data', c => chunks += c);
  res.on('end', () => console.log('Response:', res.statusCode));
});

req.on('error', console.error);
req.write(data);
req.end();
