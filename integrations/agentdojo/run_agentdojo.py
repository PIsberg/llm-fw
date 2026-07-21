"""Run the AgentDojo benchmark with llm-fw as the defense and report the numbers.

For each requested pipeline (undefended / llm-fw / transformers_pi_detector) and
each requested suite, this measures the two numbers that matter for a defense:

  * Utility (no attack)  — fraction of benign user tasks the agent still
                           completes. A defense that aborts benign runs (false
                           positives) shows up here as a utility drop.
  * ASR (under attack)   — Attack Success Rate: fraction of (user task ×
                           injection task) pairs where the injected instruction
                           was actually executed. Lower is better; the whole
                           point of the defense is to push this toward zero
                           without sacrificing utility.

A good defense drives ASR down while leaving utility ~unchanged. Reporting both
together is the honest picture — ASR alone rewards a detector that simply aborts
everything.

Prerequisites:
  1. Start the llm-fw bridge:   npm run scan-server   (in the repo root)
  2. Set the agent model's API key (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY)
  3. pip install -r integrations/agentdojo/requirements.txt

Example:
  python run_agentdojo.py --model gpt-4o-mini \
      --pipelines undefended,llm-fw,transformers_pi_detector \
      --suites banking,slack --attack important_instructions
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pipeline as pipeline_mod

try:
    from agentdojo.attacks import load_attack
    from agentdojo.benchmark import (
        benchmark_suite_with_injections,
        benchmark_suite_without_injections,
    )
    from agentdojo.task_suite.load_suites import get_suites
except ImportError as exc:  # pragma: no cover - environment guard
    sys.exit(
        f"AgentDojo import failed ({exc}).\n"
        "Install it:  pip install -r integrations/agentdojo/requirements.txt\n"
        "If the import PATHS differ, your agentdojo version differs from the pinned one; "
        "see integrations/agentdojo/requirements.txt for the version this runner targets."
    )


def mean(values: list[bool]) -> float:
    return sum(1 for v in values if v) / len(values) if values else 0.0


def run_suite(pipe, suite, attack_name: str, logdir: Path) -> dict:
    """Return {utility_no_attack, utility_under_attack, asr, n_*} for one suite."""
    # Utility with no injection present — does the defense break normal use?
    util_results = benchmark_suite_without_injections(pipe, suite, logdir=logdir, force_rerun=False)
    utility_no_attack = mean(list(util_results["utility_results"].values()))

    # Under attack: utility (task still done) and ASR (injection executed).
    attack = load_attack(attack_name, suite, pipe)
    inj_results = benchmark_suite_with_injections(pipe, suite, attack, logdir=logdir, force_rerun=False)
    utility_under_attack = mean(list(inj_results["utility_results"].values()))
    asr = mean(list(inj_results["security_results"].values()))

    return {
        "utility_no_attack": utility_no_attack,
        "utility_under_attack": utility_under_attack,
        "asr": asr,
        "n_no_attack": len(util_results["utility_results"]),
        "n_under_attack": len(inj_results["security_results"]),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Benchmark llm-fw as an AgentDojo defense.")
    ap.add_argument("--model", required=True, help="Agent LLM id, e.g. gpt-4o-mini (needs the matching API key).")
    ap.add_argument("--pipelines", default="undefended,llm-fw",
                    help="Comma list: undefended, llm-fw, transformers_pi_detector.")
    ap.add_argument("--suites", default="banking,slack,travel,workspace",
                    help="Comma list of AgentDojo suite names (default: all four).")
    ap.add_argument("--attack", default="important_instructions",
                    help="AgentDojo attack name (default: important_instructions).")
    ap.add_argument("--benchmark-version", default="v1.2.1", help="AgentDojo suite version to load.")
    ap.add_argument("--scan-url", default=None, help="llm-fw scan server URL (default $LLM_FW_SCAN_URL or :8790).")
    ap.add_argument("--block-on-warn", action="store_true", help="Treat llm-fw 'warn' verdicts as injections too.")
    ap.add_argument("--logdir", default="./agentdojo-runs", help="Where AgentDojo caches per-task run logs.")
    ap.add_argument("--json-out", default=None, help="Write the full results object to this JSON file.")
    args = ap.parse_args()

    pipeline_kinds = [p.strip() for p in args.pipelines.split(",") if p.strip()]
    suite_names = [s.strip() for s in args.suites.split(",") if s.strip()]
    logdir = Path(args.logdir)
    logdir.mkdir(parents=True, exist_ok=True)

    suites = get_suites(args.benchmark_version)
    unknown = [s for s in suite_names if s not in suites]
    if unknown:
        sys.exit(f"unknown suite(s) {unknown} for {args.benchmark_version}; available: {sorted(suites)}")

    results: dict[str, dict[str, dict]] = {}
    for kind in pipeline_kinds:
        results[kind] = {}
        for name in suite_names:
            pipe = pipeline_mod.build(kind, args.model, scan_url=args.scan_url, block_on_warn=args.block_on_warn)
            print(f"[{kind}] running suite '{name}' with attack '{args.attack}' …", file=sys.stderr)
            results[kind][name] = run_suite(pipe, suites[name], args.attack, logdir)

    _print_tables(results, pipeline_kinds, suite_names, args)

    if args.json_out:
        payload = {
            "model": args.model,
            "attack": args.attack,
            "benchmark_version": args.benchmark_version,
            "results": results,
        }
        Path(args.json_out).write_text(json.dumps(payload, indent=2))
        print(f"\nwrote {args.json_out}", file=sys.stderr)


def _print_tables(results, pipeline_kinds, suite_names, args) -> None:
    print(f"\n# AgentDojo — model={args.model}  attack={args.attack}  ({args.benchmark_version})\n")

    print("## Attack Success Rate (lower is better)\n")
    header = "| pipeline | " + " | ".join(suite_names) + " | mean |"
    print(header)
    print("|" + "---|" * (len(suite_names) + 2))
    for kind in pipeline_kinds:
        cells = [f"{results[kind][s]['asr'] * 100:.1f}%" for s in suite_names]
        m = sum(results[kind][s]["asr"] for s in suite_names) / len(suite_names)
        print(f"| {kind} | " + " | ".join(cells) + f" | {m * 100:.1f}% |")

    print("\n## Utility — no attack (higher is better; defense false-positive cost)\n")
    print(header)
    print("|" + "---|" * (len(suite_names) + 2))
    for kind in pipeline_kinds:
        cells = [f"{results[kind][s]['utility_no_attack'] * 100:.1f}%" for s in suite_names]
        m = sum(results[kind][s]["utility_no_attack"] for s in suite_names) / len(suite_names)
        print(f"| {kind} | " + " | ".join(cells) + f" | {m * 100:.1f}% |")


if __name__ == "__main__":
    main()
