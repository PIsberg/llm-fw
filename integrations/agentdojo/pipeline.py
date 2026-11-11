"""Build AgentDojo pipelines defended by llm-fw (and matching baselines).

Three pipelines make the head-to-head meaningful, all identical except for the
defense element inside the tools loop:

  * ``undefended``               — no detector; the attack's natural success rate.
  * ``llm-fw``                   — ``LlmFwDetector`` (this integration).
  * ``transformers_pi_detector`` — AgentDojo's built-in ProtectAI-deberta
                                   detector, for a like-for-like comparison.

The llm-fw pipeline is assembled by taking AgentDojo's own undefended pipeline
and inserting ``LlmFwDetector`` immediately after the ``ToolsExecutor`` inside
the ``ToolsExecutionLoop`` — the exact position AgentDojo's ``from_config`` uses
for ``transformers_pi_detector`` — so nothing else about the agent differs.
"""

from __future__ import annotations

import os
import re

from agentdojo.agent_pipeline import (
    AgentPipeline,
    BasePipelineElement,
    PipelineConfig,
    ToolsExecutionLoop,
    ToolsExecutor,
)

from llm_fw_detector import LlmFwDetector

# Characters Windows refuses in a path segment. AgentDojo writes each run's log
# under <logdir>/<pipeline name>/, so an Ollama id such as ``qwen2.5:14b`` in
# the name made every write fail with EINVAL.
_PATH_UNSAFE = re.compile(r'[<>:"/\\|?*]')

Agent = str | BasePipelineElement


def agent_llm(model: str, base_url: str | None = None) -> Agent:
    """The agent LLM: an AgentDojo model id, or ``model`` on an OpenAI-compatible server.

    With ``base_url`` (Ollama's ``http://127.0.0.1:11434/v1``, vLLM, llama.cpp)
    the agent uses native tool calling through AgentDojo's ``OpenAILLM`` at
    temperature 0. AgentDojo's own ``local`` provider prompts for tool calls in
    text instead, and qwen2.5:3b never produced a parseable call that way.
    """
    if base_url is None:
        return model
    import openai
    from agentdojo.agent_pipeline.llms.openai_llm import OpenAILLM

    client = openai.OpenAI(base_url=base_url, api_key=os.environ.get("AGENT_API_KEY", "local"))
    llm = OpenAILLM(client, model, temperature=0.0)
    llm.name = f"local-{model}"
    return llm


def pipeline_name(llm: Agent, suffix: str) -> str:
    """A path-safe pipeline name. A local model's name contains ``local``, the key
    AgentDojo's ``important_instructions`` attack uses to address the model."""
    base = llm if isinstance(llm, str) else (llm.name or "local")
    return _PATH_UNSAFE.sub("_", f"{base}-{suffix}")


def _config(llm: Agent, defense: str | None) -> PipelineConfig:
    return PipelineConfig(
        llm=llm, model_id=None, defense=defense, system_message_name=None, system_message=None
    )


def _base_pipeline(llm: Agent) -> AgentPipeline:
    """AgentDojo's standard undefended pipeline for ``llm``."""
    return AgentPipeline.from_config(_config(llm, None))


def undefended_pipeline(llm: Agent) -> AgentPipeline:
    pipeline = _base_pipeline(llm)
    pipeline.name = pipeline_name(llm, "undefended")
    return pipeline


def transformers_pi_detector_pipeline(llm: Agent) -> AgentPipeline:
    """AgentDojo's built-in detector defense, via its own config path."""
    pipeline = AgentPipeline.from_config(_config(llm, "transformers_pi_detector"))
    pipeline.name = pipeline_name(llm, "transformers_pi_detector")
    return pipeline


def llm_fw_pipeline(llm: Agent, *, scan_url: str | None = None, block_on_warn: bool = False) -> AgentPipeline:
    """Undefended pipeline with ``LlmFwDetector`` spliced into the tools loop."""
    pipeline = _base_pipeline(llm)
    loop = _find_tools_loop(pipeline)
    executor_idx = _find_executor_index(loop)
    detector = LlmFwDetector(scan_url, block_on_warn=block_on_warn)
    # Insert right after the ToolsExecutor, before control returns to the LLM —
    # exactly where transformers_pi_detector sits in AgentDojo's from_config.
    loop.elements.insert(executor_idx + 1, detector)
    pipeline.name = pipeline_name(llm, "llm-fw")
    return pipeline


def build(
    kind: str,
    model: str,
    *,
    base_url: str | None = None,
    scan_url: str | None = None,
    block_on_warn: bool = False,
) -> AgentPipeline:
    llm = agent_llm(model, base_url)
    if kind == "undefended":
        return undefended_pipeline(llm)
    if kind == "llm-fw":
        return llm_fw_pipeline(llm, scan_url=scan_url, block_on_warn=block_on_warn)
    if kind == "transformers_pi_detector":
        return transformers_pi_detector_pipeline(llm)
    raise ValueError(f"unknown pipeline kind '{kind}' — one of: undefended, llm-fw, transformers_pi_detector")


# --- structural helpers (guarded against AgentDojo internals drift) ----------

def _find_tools_loop(pipeline: AgentPipeline) -> ToolsExecutionLoop:
    for el in pipeline.elements:
        if isinstance(el, ToolsExecutionLoop):
            return el
    raise RuntimeError(
        "no ToolsExecutionLoop in the AgentDojo pipeline — the internal structure "
        "changed; update integrations/agentdojo/pipeline.py to match this AgentDojo version."
    )


def _find_executor_index(loop: ToolsExecutionLoop) -> int:
    for i, el in enumerate(loop.elements):
        if isinstance(el, ToolsExecutor):
            return i
    raise RuntimeError(
        "no ToolsExecutor inside the ToolsExecutionLoop — cannot place the detector; "
        "update integrations/agentdojo/pipeline.py to match this AgentDojo version."
    )
