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
* ``llm-fw`` aborts the agent on a block, and ``llm-fw-withhold`` replaces the
  blocked tool output and lets the agent go on, as the proxy's default does
  (#768). The two log under different names, because AgentDojo reuses a cached
  task result from ``<logdir>/<pipeline name>/``.

Run:  pytest integrations/agentdojo/test_pipeline.py -v
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import httpx
import pytest

pytest.importorskip("agentdojo")

from agentdojo.agent_pipeline import BasePipelineElement, ToolsExecutionLoop, ToolsExecutor  # noqa: E402
from agentdojo.agent_pipeline.errors import AbortAgentError  # noqa: E402
from agentdojo.agent_pipeline.llms.openai_llm import OpenAILLM  # noqa: E402
from agentdojo.attacks import load_attack  # noqa: E402
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionCall, FunctionsRuntime  # noqa: E402
from agentdojo.task_suite.load_suites import get_suites  # noqa: E402
from agentdojo.types import (  # noqa: E402
    ChatAssistantMessage,
    ChatMessage,
    ChatToolResultMessage,
    ChatUserMessage,
    get_text_content_as_str,
    text_content_block_from_string,
)

import pipeline as pipeline_mod  # noqa: E402
import run_agentdojo  # noqa: E402
from llm_fw_detector import LlmFwDetector  # noqa: E402

BASE_URL = "http://127.0.0.1:11434/v1"
MODEL = "qwen2.5:14b"
WINDOWS_INVALID = re.compile(r'[<>:"/\\|?*]')
LLM_FW_KINDS = ["llm-fw", "llm-fw-withhold"]
# What AgentDojo's PromptInjectionDetector.transform puts in place of a flagged output.
OMITTED = "<Data omitted because a prompt injection was detected>"


def _elements(pipe) -> list:
    out = []
    for el in pipe.elements:
        out.append(el)
        if isinstance(el, ToolsExecutionLoop):
            out.extend(el.elements)
    return out


@pytest.mark.parametrize("kind", ["undefended", *LLM_FW_KINDS])
def test_base_url_routes_the_agent_to_a_local_server(kind: str) -> None:
    pipe = pipeline_mod.build(kind, MODEL, base_url=BASE_URL)
    llms = [el for el in _elements(pipe) if isinstance(el, OpenAILLM)]
    assert llms, "no OpenAI-compatible LLM element in the pipeline"
    for llm in llms:
        assert llm.model == MODEL
        assert str(llm.client.base_url).rstrip("/") == BASE_URL


@pytest.mark.parametrize("kind", ["undefended", *LLM_FW_KINDS])
def test_local_pipeline_names_are_path_safe_and_name_the_model_local(kind: str) -> None:
    pipe = pipeline_mod.build(kind, MODEL, base_url=BASE_URL)
    assert pipe.name is not None
    assert not WINDOWS_INVALID.search(pipe.name), pipe.name
    assert "local" in pipe.name
    # The attack resolves the model's prose name from the pipeline name.
    load_attack("important_instructions", get_suites("v1.2.1")["banking"], pipe)


@pytest.mark.parametrize("kind", LLM_FW_KINDS)
def test_llm_fw_detector_sits_right_after_the_tools_executor(kind: str) -> None:
    pipe = pipeline_mod.build(kind, MODEL, base_url=BASE_URL)
    loop = next(el for el in pipe.elements if isinstance(el, ToolsExecutionLoop))
    kinds = [type(el) for el in loop.elements]
    assert kinds.index(LlmFwDetector) == kinds.index(ToolsExecutor) + 1


def test_each_llm_fw_mode_logs_under_its_own_name() -> None:
    # AgentDojo reuses a cached task result from <logdir>/<pipeline name>/
    # (force_rerun=False), so two modes sharing a name would report the first
    # mode's results for both.
    names = {pipeline_mod.build(kind, MODEL, base_url=BASE_URL).name for kind in LLM_FW_KINDS}
    assert len(names) == len(LLM_FW_KINDS), names


def _detector_answering(kind: str, action: str, monkeypatch) -> LlmFwDetector:
    """The LlmFwDetector of a ``kind`` pipeline, its scan server answering ``action``."""
    pipe = pipeline_mod.build(kind, MODEL, base_url=BASE_URL)
    loop = next(el for el in pipe.elements if isinstance(el, ToolsExecutionLoop))
    detector = next(el for el in loop.elements if isinstance(el, LlmFwDetector))

    def scan(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/scan"
        return httpx.Response(200, json={"action": action, "score": 1.0 if action == "block" else 0.0})

    monkeypatch.setattr(detector, "_client", httpx.Client(transport=httpx.MockTransport(scan)))
    return detector


def _after_a_tool_call(output: str) -> list[ChatMessage]:
    call = FunctionCall(function="get_most_recent_transactions", args={}, id="call_0")
    return [
        ChatUserMessage(role="user", content=[text_content_block_from_string("What did I spend?")]),
        ChatAssistantMessage(role="assistant", content=None, tool_calls=[call]),
        ChatToolResultMessage(
            role="tool",
            content=[text_content_block_from_string(output)],
            tool_call_id="call_0",
            tool_call=call,
            error=None,
        ),
    ]


def test_withhold_mode_replaces_a_blocked_tool_output_and_goes_on(monkeypatch) -> None:
    detector = _detector_answering("llm-fw-withhold", "block", monkeypatch)
    _, _, _, messages, _ = detector.query("What did I spend?", FunctionsRuntime([]), EmptyEnv(), _after_a_tool_call("a tool output"), {})
    assert get_text_content_as_str(messages[-1]["content"]) == OMITTED


def test_abort_mode_stops_the_agent_on_a_blocked_tool_output(monkeypatch) -> None:
    detector = _detector_answering("llm-fw", "block", monkeypatch)
    with pytest.raises(AbortAgentError):
        detector.query("What did I spend?", FunctionsRuntime([]), EmptyEnv(), _after_a_tool_call("a tool output"), {})


@pytest.mark.parametrize("kind", LLM_FW_KINDS)
@pytest.mark.parametrize("action", ["pass", "warn"])
def test_both_modes_leave_an_unblocked_tool_output_alone(kind: str, action: str, monkeypatch) -> None:
    detector = _detector_answering(kind, action, monkeypatch)
    _, _, _, messages, _ = detector.query("What did I spend?", FunctionsRuntime([]), EmptyEnv(), _after_a_tool_call("a tool output"), {})
    assert get_text_content_as_str(messages[-1]["content"]) == "a tool output"


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
