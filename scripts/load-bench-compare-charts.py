#!/usr/bin/env python3
"""Draw PNG charts from a load benchmark comparison (npm run bench:load:compare).

    python scripts/load-bench-compare-charts.py reports/load-bench/<compare>/comparison.json [--out DIR] [--dpi 200]

Writes three PNGs next to comparison.json (or into --out):

    compare-overview.png            the headline figures per version, with the change from the baseline
    compare-throughput-latency.png  throughput, p50 and p99 per concurrency level, one line per version
    compare-resources.png           CPU time per request, peak RSS and event-loop delay per level

Every value is the median of a version's runs; the whisker is the range from
the fastest to the slowest run. A change is marked only where the ranges do
not overlap (test/load/lib/benchCompare.ts decides, this script only draws).
Shares its palette and helpers with load-bench-charts.py. Needs matplotlib.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location("load_bench_charts", Path(__file__).with_name("load-bench-charts.py"))
if _spec is None or _spec.loader is None:  # pragma: no cover
    sys.exit("load-bench-charts.py must sit next to this script")
lb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lb)
plt = lb.plt
FuncFormatter = lb.FuncFormatter

# Versions are ordered in time, so they take steps of the one blue ramp, the
# newest darkest (the ordinal ramp load-bench-charts.py uses for percentiles).
# A run with a LOAD_BENCH_DETECTION override is not a later version but the
# same code configured differently, so it leaves the ramp for the next
# categorical hues. Validated with the ramp, all pairs: worst CVD dE 19.0.
VERSION_STEPS = {1: ["#2a78d6"], 2: ["#86b6ef", "#104281"], 3: ["#86b6ef", "#2a78d6", "#104281"]}
OVERRIDE_COLORS = ["#eb6834", "#1baf7a"]
WORKLOAD_LABEL = lb.WORKLOAD_LABEL
TEXT, TEXT_2, MUTED, GRID = lb.TEXT, lb.TEXT_2, lb.MUTED, lb.GRID


def version_colors(versions: list[dict]) -> list[str]:
    plain = [v for v in versions if not v.get("override")]
    ramp = VERSION_STEPS.get(len(plain)) or lb.ramp_for(len(plain))
    out, p, o = [], 0, 0
    for v in versions:
        if v.get("override"):
            out.append(OVERRIDE_COLORS[o % len(OVERRIDE_COLORS)])
            o += 1
        else:
            out.append(ramp[p])
            p += 1
    return out


def fmt_unit(v: float, unit: str) -> str:
    if unit == "ms":
        return lb.fmt_ms(v)
    if unit == "req/s":
        return f"{lb.fmt_num(v)} req/s"
    if unit == "MB":
        return f"{v:,.0f} MB"
    return f"{v:,.0f}{unit}"


def tick_unit(unit: str):
    if unit == "ms":
        return lb.tick_ms
    if unit == "MB":
        return lambda v: f"{v:,.0f} MB"
    if unit == "%":
        return lb.fmt_pct
    return lb.tick_num


def describe(d: dict | None) -> str:
    if d is None:
        return "baseline"
    sign = "+" if d["pct"] > 0 else ""
    if not d["beyondNoise"]:
        return f"{sign}{d['pct']:.0f}%, within noise"
    return f"{sign}{d['pct']:.0f}%, {'better' if d['improved'] else 'worse'}"


def footer(fig, data: dict) -> None:
    vs = data["versions"]
    runs = ", ".join(f"{v['label']} x{v['runs']}" for v in vs)
    first = vs[0]
    fig.text(0.01, 0.01,
             f"Runs per version: {runs} · Node {first['node']} · {first['cpu']} ({first['cores']} threads) · "
             f"{data['config']['stepS']:g} s per level after {data['config']['warmupS']:g} s warm-up",
             fontsize=8, color=MUTED, ha="left", va="bottom")


def caveat_line(data: dict) -> str | None:
    noisy = sum(len(v["warnings"]) for v in data["versions"])
    parts = []
    if noisy:
        parts.append(f"{noisy} noisy-run warning{'s' if noisy != 1 else ''}, see comparison.md")
    parts += data.get("notes") or []
    return "Caveats: " + "; ".join(parts) + "." if parts else None


# ---------------------------------------------------------------- overview

OVERVIEW_KEYS = [
    ["chat.peakRps", "chat.p50At1", "chat.cpuMsAt1"],
    ["agent.peakRps", "agent.p50At1", "agent.coldMs"],
    ["attack.peakRps", "attack.p50At1", "attack.cpuMsAt1"],
    ["memory.idleRss", "memory.peakRss", "startup.initMs"],
]
GROUP_LABEL = {**WORKLOAD_LABEL, "memory": "Memory", "startup": "Startup"}


def chart_overview(data: dict, out: Path, dpi: int) -> None:
    rows = {h["key"]: h for h in data["headline"]}
    grid = [[k for k in r if k in rows] for r in OVERVIEW_KEYS]
    grid = [r for r in grid if r]
    versions = [v["label"] for v in data["versions"]]
    colors = version_colors(data["versions"])
    n_rows, n_cols = len(grid), max(len(r) for r in grid)
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(15, 1.15 + n_rows * (0.55 + 0.42 * len(versions)) + 0.6), squeeze=False)
    top = lb.header(fig, "llm-fw, version against version",
                    f"Median of each version's runs, whisker from the fastest to the slowest run. "
                    f"Change from {versions[0]}; it counts only where the runs' ranges do not overlap.")
    caveat = caveat_line(data)
    if caveat:
        h = fig.get_figheight()
        fig.text(0.01, top + 0.1 / h, caveat, fontsize=9, color=TEXT, fontweight="semibold", ha="left", va="top")
        top -= 0.3 / h
    fig.subplots_adjust(left=0.14, right=0.97, top=top - 0.03, bottom=0.06, hspace=0.9, wspace=0.75)
    for r, keys in enumerate(grid):
        for c in range(n_cols):
            ax = axes[r][c]
            if c >= len(keys):
                ax.set_axis_off()
                continue
            h = rows[keys[c]]
            ys = list(range(len(versions)))[::-1]  # oldest at the top
            peak = 0.0
            for i, label in enumerate(versions):
                s = h["values"].get(label)
                if s is None:
                    continue
                y = ys[i]
                ax.barh(y, s["median"], height=0.62, color=colors[i], edgecolor="none")
                if s["n"] > 1 and s["max"] > s["min"]:
                    ax.plot([s["min"], s["max"]], [y, y], color=TEXT, linewidth=1.2, solid_capstyle="butt")
                    ax.plot([s["min"]] * 2, [y - 0.14, y + 0.14], color=TEXT, linewidth=1.2)
                    ax.plot([s["max"]] * 2, [y - 0.14, y + 0.14], color=TEXT, linewidth=1.2)
                peak = max(peak, s["max"])
            ax.set_xlim(0, peak * 1.9 if peak > 0 else 1)
            for i, label in enumerate(versions):
                s = h["values"].get(label)
                if s is None:
                    continue
                d = h["deltas"].get(label)
                text = fmt_unit(s["median"], h["unit"])
                ax.annotate(text, (max(s["max"], s["median"]), ys[i]), xytext=(6, 0), textcoords="offset points",
                            va="center", ha="left", fontsize=9, color=TEXT, fontweight="semibold")
                ax.annotate(describe(d) if d else "", (max(s["max"], s["median"]), ys[i]), xytext=(6, -11),
                            textcoords="offset points", va="center", ha="left", fontsize=7.5,
                            color=TEXT if d and d["beyondNoise"] else MUTED)
            ax.set_yticks(ys)
            ax.set_yticklabels(versions if c == 0 else [""] * len(versions), fontsize=8.5)
            ax.set_ylim(-0.6, len(versions) - 0.4)
            ax.xaxis.set_visible(False)
            ax.grid(False)
            ax.spines["bottom"].set_visible(False)
            group = GROUP_LABEL.get(h["group"], h["group"])
            ax.set_title(f"{group}: {h['label']}" if c == 0 else h["label"], fontsize=10)
    footer(fig, data)
    lb.save(fig, out / "compare-overview.png", dpi)


# --------------------------------------------------- per-level line charts

def level_grid(data: dict, metrics: list[tuple[str, str, str]], title: str, subtitle: str, name: str, out: Path, dpi: int) -> None:
    workloads = data["config"]["workloads"]
    levels = data["config"]["concurrency"]
    versions = [v["label"] for v in data["versions"]]
    colors = version_colors(data["versions"])
    fig, axes = plt.subplots(len(metrics), len(workloads), figsize=(4.8 * len(workloads), 3.3 * len(metrics) + 1.4), squeeze=False)
    top = lb.header(fig, title, subtitle)
    fig.subplots_adjust(left=0.07, right=0.97, top=top - 0.07, bottom=0.08, hspace=0.55, wspace=0.32)
    for r, (metric, label, unit) in enumerate(metrics):
        for c, w in enumerate(workloads):
            ax = axes[r][c]
            peak = 0.0
            for i, v in enumerate(versions):
                pts = [(lv, data["steps"][w][str(lv)].get(v, {}).get(metric)) for lv in levels]
                pts = [(lv, s) for lv, s in pts if s]
                if not pts:
                    continue
                xs = [lv for lv, _ in pts]
                med = [s["median"] for _, s in pts]
                lo = [s["median"] - s["min"] for _, s in pts]
                hi = [s["max"] - s["median"] for _, s in pts]
                ax.errorbar(xs, med, yerr=[lo, hi], color=colors[i], ecolor=colors[i], elinewidth=1.2, capsize=3,
                            label=v, **lb.LINE)
                peak = max(peak, max(s["max"] for _, s in pts))
            lb.level_axis(ax, levels)
            lb.zero_floor(ax, peak, tick_unit(unit))
            ax.set_title(f"{WORKLOAD_LABEL.get(w, w)}: {label}")
            if r < len(metrics) - 1:
                ax.set_xlabel("")
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper left", bbox_to_anchor=(0.06, top + 0.005), ncols=len(versions), handlelength=2)
    footer(fig, data)
    lb.save(fig, out / name, dpi)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("comparison", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()
    data = json.loads(args.comparison.read_text(encoding="utf8"))
    if data.get("kind") != "llm-fw-load-comparison":
        sys.exit(f"{args.comparison} is not a load benchmark comparison (kind={data.get('kind')!r}); "
                 "run npm run bench:load:compare first")
    out = args.out or args.comparison.parent
    out.mkdir(parents=True, exist_ok=True)
    print(f"Comparison charts for {', '.join(v['label'] for v in data['versions'])}:")
    chart_overview(data, out, args.dpi)
    level_grid(data, [("throughputRps", "requests per second", "req/s"), ("p50Ms", "p50 latency", "ms"), ("p99Ms", "p99 latency", "ms")],
               "Throughput and latency by concurrency, per version",
               "Median of each version's runs; whiskers span the fastest to the slowest run. Each panel has its own scale.",
               "compare-throughput-latency.png", out, args.dpi)
    level_grid(data, [("cpuMsPerRequest", "CPU time per request", "ms"), ("peakRssMb", "peak RSS", "MB"),
                      ("eventLoopP99Ms", "event-loop delay p99", "ms")],
               "What each version costs the machine",
               "Measured inside the firewall's own process, every thread counted. Event-loop delay is what every other request waits.",
               "compare-resources.png", out, args.dpi)


if __name__ == "__main__":
    main()
