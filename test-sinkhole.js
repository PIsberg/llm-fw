import https from 'https';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
