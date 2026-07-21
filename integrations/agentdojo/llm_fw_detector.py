"""llm-fw as an AgentDojo prompt-injection defense.

AgentDojo (https://github.com/ethz-spylab/agentdojo) evaluates whether a
tool-calling agent (a) still completes its task (utility) and (b) resists
prompt injections planted in tool outputs (measured as Attack Success Rate).
Its built-in `transformers_pi_detector` defense runs a local HuggingFace
classifier (`protectai/deberta-v3-base-prompt-injection-v2`) over each tool
output and aborts the agent when an injection is detected.

`LlmFwDetector` is a drop-in replacement for that detector: it subclasses the
same `PromptInjectionDetector` base and overrides `detect()` to call the llm-fw
detection pipeline over HTTP (the `scripts/scan-server.ts` bridge) instead of a
local model. Because it slots into the exact same pipeline position, running the
benchmark with it vs. with `transformers_pi_detector` vs. undefended is a true
head-to-head on identical tasks and attacks.

It scans on the `tool_result` surface — the same surface llm-fw's InjecAgent
benchmark exercises — so this validates whether that corpus recall translates
into blocked *actions* inside a live agent loop.

Run the bridge first:  npm run scan-server   (or)   node --import tsx/esm scripts/scan-server.ts
Point at it with:       LLM_FW_SCAN_URL=http://127.0.0.1:8790  (default)
"""

from __future__ import annotations

import os

import httpx
from agentdojo.agent_pipeline import PromptInjectionDetector

DEFAULT_SCAN_URL = "http://127.0.0.1:8790"


class LlmFwDetector(PromptInjectionDetector):
    """PromptInjectionDetector that delegates to the llm-fw scan server.

    Parameters
    ----------
    scan_url:
        Base URL of the llm-fw scan server (``scripts/scan-server.ts``).
        Defaults to ``$LLM_FW_SCAN_URL`` or ``http://127.0.0.1:8790``.
    surface:
        Which llm-fw scan surface to tag tool outputs with. ``tool_result`` is
        the correct indirect-injection surface (attacker text arriving in tool
        output, not from the user) and is the default.
    block_on_warn:
        Treat a ``warn`` verdict as an injection too. Off by default so only a
        hard ``block`` aborts the agent — matching llm-fw's proxy default, where
        ``warn`` audits but does not stop traffic.
    mode / raise_on_injection:
        Forwarded to the base class. ``mode='message'`` scans each new tool
        output as it arrives (the correct per-output granularity);
        ``raise_on_injection=True`` aborts the agent via ``AbortAgentError`` on
        detection, which is how AgentDojo scores a defended attack as prevented.
    """

    def __init__(
        self,
        scan_url: str | None = None,
        *,
        surface: str = "tool_result",
        block_on_warn: bool = False,
        mode: str = "message",
        raise_on_injection: bool = True,
        timeout: float = 30.0,
    ) -> None:
        super().__init__(mode=mode, raise_on_injection=raise_on_injection)
        self.scan_url = (scan_url or os.environ.get("LLM_FW_SCAN_URL", DEFAULT_SCAN_URL)).rstrip("/")
        self.surface = surface
        self.block_on_warn = block_on_warn
        self._client = httpx.Client(timeout=timeout)

    def detect(self, tool_output: str) -> tuple[bool, float]:
        """Return ``(is_injection, safety_score)`` for one tool output.

        ``safety_score`` is on a higher-is-safer scale to match the base
        class's convention; it is derived from llm-fw's suspicion ``score`` and
        used only for logging — the ``is_injection`` decision comes directly
        from llm-fw's ``action`` verdict, not from re-thresholding the score.
        """
        try:
            resp = self._client.post(
                f"{self.scan_url}/scan",
                json={"text": tool_output, "surface": self.surface},
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:  # noqa: BLE001 — surface a clear, actionable message
            raise RuntimeError(
                f"llm-fw scan server unreachable at {self.scan_url} — start it with "
                f"`npm run scan-server` (or `node --import tsx/esm scripts/scan-server.ts`). "
                f"Underlying error: {exc}"
            ) from exc

        action = data.get("action", "pass")
        is_injection = action == "block" or (self.block_on_warn and action == "warn")

        # llm-fw's `score` rises with suspicion and is unbounded; squash to a
        # (0, 1] safety score where 1.0 = a clean pass. Cosmetic only.
        raw = float(data.get("score", 0.0) or 0.0)
        safety_score = 1.0 / (1.0 + raw) if raw > 0 else 1.0
        return is_injection, safety_score
