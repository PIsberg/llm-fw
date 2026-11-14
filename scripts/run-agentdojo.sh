#!/usr/bin/env bash
# Run AgentDojo against a local model, with no provider API key (#537).
#
# Starts the llm-fw scan server on the default configuration (a fresh
# LLM_FW_DIR, so your own ~/.llm-fw/config.json does not tune the defense),
# runs a fixed subset of tasks through the undefended, llm-fw (abort on a
# block), llm-fw-withhold (replace the blocked output and go on, as the proxy
# does) and transformers_pi_detector pipelines, and stops the server again.
#
# Prerequisites: Ollama (or any OpenAI-compatible server) serving the model,
# and a Python with `pip install -r integrations/agentdojo/requirements.txt`
# plus `agentdojo[transformers]` for the DeBERTa baseline.
#
# Every setting is an environment variable:
#   AGENTDOJO_MODEL            agent model id          (qwen2.5:14b)
#   AGENTDOJO_BASE_URL         OpenAI-compatible URL   (http://127.0.0.1:11434/v1)
#   AGENTDOJO_PIPELINES        comma list              (undefended,llm-fw,llm-fw-withhold,transformers_pi_detector)
#   AGENTDOJO_SUITES           comma list              (banking)
#   AGENTDOJO_USER_TASKS       comma list, empty = all (empty: all 16 banking tasks)
#   AGENTDOJO_INJECTION_TASKS  comma list, empty = all (injection_task_0)
#   AGENTDOJO_OUT              results JSON            (agentdojo-results.json)
#   AGENTDOJO_LOGDIR           per-task traces         (agentdojo-runs)
#   PYTHON                     interpreter             (python)
#   LLM_FW_MODEL_DIR           embedding model cache, reused if set
#
# Results are model-dependent: always report the model next to the numbers.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
model="${AGENTDOJO_MODEL:-qwen2.5:14b}"
base_url="${AGENTDOJO_BASE_URL:-http://127.0.0.1:11434/v1}"
pipelines="${AGENTDOJO_PIPELINES:-undefended,llm-fw,llm-fw-withhold,transformers_pi_detector}"
suites="${AGENTDOJO_SUITES:-banking}"
user_tasks="${AGENTDOJO_USER_TASKS:-}"
injection_tasks="${AGENTDOJO_INJECTION_TASKS-injection_task_0}"
out="$(realpath -m "${AGENTDOJO_OUT:-agentdojo-results.json}")"
logdir="$(realpath -m "${AGENTDOJO_LOGDIR:-agentdojo-runs}")"
python="${PYTHON:-python}"
scan_url="${LLM_FW_SCAN_URL:-http://127.0.0.1:8790}"

if ! curl -sf --noproxy '*' "${base_url%/}/models" > /dev/null; then
  echo "No OpenAI-compatible server at $base_url. Start it first (ollama serve)." >&2
  exit 1
fi

server_pid=""
fw_dir=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2> /dev/null || true; fi
  if [ -n "$fw_dir" ]; then rm -rf "$fw_dir"; fi
}
trap cleanup EXIT

if curl -sf --noproxy '*' "$scan_url/health" > /dev/null; then
  echo "Using the scan server already running at $scan_url (its configuration applies)." >&2
else
  fw_dir="$(mktemp -d)"
  (cd "$root" && LLM_FW_DIR="$fw_dir" exec node --import tsx/esm scripts/scan-server.ts) &
  server_pid=$!
  for _ in $(seq 1 90); do
    curl -sf --noproxy '*' "$scan_url/health" > /dev/null && break
    sleep 2
  done
  curl -sf --noproxy '*' "$scan_url/health" > /dev/null || { echo "scan server did not start" >&2; exit 1; }
fi

cd "$root/integrations/agentdojo"
"$python" run_agentdojo.py \
  --model "$model" --base-url "$base_url" \
  --pipelines "$pipelines" --suites "$suites" \
  --user-tasks "$user_tasks" --injection-tasks "$injection_tasks" \
  --scan-url "$scan_url" --logdir "$logdir" --json-out "$out"
