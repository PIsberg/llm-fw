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

from agentdojo.agent_pipeline import (
    AgentPipeline,
    PipelineConfig,
    ToolsExecutionLoop,
    ToolsExecutor,
)

from llm_fw_detector import LlmFwDetector


def _base_pipeline(model: str) -> AgentPipeline:
    """AgentDojo's standard undefended pipeline for ``model``."""
    return AgentPipeline.from_config(PipelineConfig(llm=model, defense=None, system_message_name=None, system_message=None))


def undefended_pipeline(model: str) -> AgentPipeline:
    pipeline = _base_pipeline(model)
    pipeline.name = f"{model}-undefended"
    return pipeline


def transformers_pi_detector_pipeline(model: str) -> AgentPipeline:
    """AgentDojo's built-in detector defense, via its own config path."""
    pipeline = AgentPipeline.from_config(
        PipelineConfig(llm=model, defense="transformers_pi_detector", system_message_name=None, system_message=None)
    )
    return pipeline


def llm_fw_pipeline(model: str, *, scan_url: str | None = None, block_on_warn: bool = False) -> AgentPipeline:
    """Undefended pipeline with ``LlmFwDetector`` spliced into the tools loop."""
    pipeline = _base_pipeline(model)
    loop = _find_tools_loop(pipeline)
    executor_idx = _find_executor_index(loop)
    detector = LlmFwDetector(scan_url, block_on_warn=block_on_warn)
    # Insert right after the ToolsExecutor, before control returns to the LLM —
    # exactly where transformers_pi_detector sits in AgentDojo's from_config.
    loop.elements.insert(executor_idx + 1, detector)
    pipeline.name = f"{model}-llm-fw"
    return pipeline


def build(kind: str, model: str, *, scan_url: str | None = None, block_on_warn: bool = False) -> AgentPipeline:
    if kind == "undefended":
        return undefended_pipeline(model)
    if kind == "llm-fw":
        return llm_fw_pipeline(model, scan_url=scan_url, block_on_warn=block_on_warn)
    if kind == "transformers_pi_detector":
        return transformers_pi_detector_pipeline(model)
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
