[llm-fw](../../README.md) > [Documentation](../README.md) > Running in development (from source)

# Running in development (from source)

```bash
# One-time setup (run as admin/root for CA install):
npm run dev setup

# Start (auto-stops any previous instance):
npm run dev start

# Point Node.js tools at the proxy:
# macOS / Linux
export NODE_EXTRA_CA_CERTS="$HOME/.llm-fw/ca.crt"
export HTTPS_PROXY="http://127.0.0.1:8080"

# PowerShell
$env:NODE_EXTRA_CA_CERTS="$env:USERPROFILE\.llm-fw\ca.crt"
$env:HTTPS_PROXY="http://127.0.0.1:8080"

# Windows cmd
set NODE_EXTRA_CA_CERTS=%USERPROFILE%\.llm-fw\ca.crt
set HTTPS_PROXY=http://127.0.0.1:8080
```

To enable the sinkhole from source (elevated terminal required):

```powershell
# Windows — elevated PowerShell in the project directory:
node ".\node_modules\.bin\tsx.cmd" ".\src\cli\index.ts" setup
```
