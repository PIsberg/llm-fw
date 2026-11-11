"""Offline tests for the pipeline builder and the runner. No agent LLM, no scan server.

They pin what a run against a local model depends on:

* ``--base-url`` routes the agent through an OpenAI-compatible server (Ollama,
  vLLM, llama.cpp) with the model id passed through unchanged.
* Pipeline names are valid path segments on Windows. AgentDojo writes its run
  logs under ``<logdir>/<pipeline name>/``, and an Ollama id such as
  ``qwen2.5:14b`` made that path invalid.
* A local pipeline's name contains ``local``, the key AgentDojo's
  ``important_instructions`` attack looks up to address the model by name; any
  other name makes ``load_attack`` raise.
* ``run_suite`` runs a subset of tasks to completion. It used to call the
  benchmark outside an ``OutputLogger`` and crashed before the first task.

Run:  pytest integrations/agentdojo/test_pipeline.py -v
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import pytest

pytest.importorskip("agentdojo")

from agentdojo.agent_pipeline import BasePipelineElement, ToolsExecutionLoop, ToolsExecutor  # noqa: E402
from agentdojo.agent_pipeline.llms.openai_llm import OpenAILLM  # noqa: E402
from agentdojo.attacks import load_attack  # noqa: E402
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionsRuntime  # noqa: E402
from agentdojo.task_suite.load_suites import get_suites  # noqa: E402
from agentdojo.types import ChatAssistantMessage, ChatMessage, text_content_block_from_string  # noqa: E402

import pipeline as pipeline_mod  # noqa: E402
import run_agentdojo  # noqa: E402
from llm_fw_detector import LlmFwDetector  # noqa: E402

BASE_URL = "http://127.0.0.1:11434/v1"
MODEL = "qwen2.5:14b"
WINDOWS_INVALID = re.compile(r'[<>:"/\\|?*]')


def _elements(pipe) -> list:
    out = []
    for el in pipe.elements:
        out.append(el)
        if isinstance(el, ToolsExecutionLoop):
            out.extend(el.elements)
    return out


@pytest.mark.parametrize("kind", ["undefended", "llm-fw"])
def test_base_url_routes_the_agent_to_a_local_server(kind: str) -> None:
    pipe = pipeline_mod.build(kind, MODEL, base_url=BASE_URL)
    llms = [el for el in _elements(pipe) if isinstance(el, OpenAILLM)]
    assert llms, "no OpenAI-compatible LLM element in the pipeline"
    for llm in llms:
        assert llm.model == MODEL
        assert str(llm.client.base_url).rstrip("/") == BASE_URL


@pytest.mark.parametrize("kind", ["undefended", "llm-fw"])
def test_local_pipeline_names_are_path_safe_and_name_the_model_local(kind: str) -> None:
    pipe = pipeline_mod.build(kind, MODEL, base_url=BASE_URL)
    assert pipe.name is not None
    assert not WINDOWS_INVALID.search(pipe.name), pipe.name
    assert "local" in pipe.name
    # The attack resolves the model's prose name from the pipeline name.
    load_attack("important_instructions", get_suites("v1.2.1")["banking"], pipe)


def test_llm_fw_detector_sits_right_after_the_tools_executor() -> None:
    pipe = pipeline_mod.build("llm-fw", MODEL, base_url=BASE_URL)
    loop = next(el for el in pipe.elements if isinstance(el, ToolsExecutionLoop))
    kinds = [type(el) for el in loop.elements]
    assert kinds.index(LlmFwDetector) == kinds.index(ToolsExecutor) + 1


class _AnswerWithoutTools(BasePipelineElement):
    """An agent that replies once and never calls a tool."""

    name = "local-stub"

    def query(
        self,
        query: str,
        runtime: FunctionsRuntime,
        env: Env = EmptyEnv(),
        messages: Sequence[ChatMessage] = [],
        extra_args: dict = {},
    ):
        reply = ChatAssistantMessage(
            role="assistant", content=[text_content_block_from_string("Done.")], tool_calls=None
        )
        return query, runtime, env, [*messages, reply], extra_args


def test_run_suite_runs_a_task_subset_to_completion(tmp_path) -> None:
    pipe = pipeline_mod.undefended_pipeline(_AnswerWithoutTools())
    suite = get_suites("v1.2.1")["banking"]
    result = run_agentdojo.run_suite(
        pipe,
        suite,
        "important_instructions",
        tmp_path,
        user_tasks=["user_task_0", "user_task_1"],
        injection_tasks=["injection_task_0"],
    )
    assert result["n_no_attack"] == 2
    assert result["n_under_attack"] == 2
    # An agent that does nothing completes no task and executes no injection.
    assert result["utility_no_attack"] == 0.0
    assert result["asr"] == 0.0


def test_task_lists_parse_from_comma_separated_flags() -> None:
    assert run_agentdojo.task_list("user_task_0, user_task_3,") == ["user_task_0", "user_task_3"]
    assert run_agentdojo.task_list(None) is None
    assert run_agentdojo.task_list("") is None
