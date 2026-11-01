---
name: load-benchmark
description: Measure llm-fw's throughput, latency, CPU and memory on the current tree with npm run bench:load, render the PNG charts with scripts/load-bench-charts.py, and report the numbers honestly. Use when asked to load test, benchmark, stress test, profile throughput or latency, measure CPU or memory, or chart the performance of the current version.
---

# Load benchmark of the current version

One run answers: how many requests per second does this tree sustain, how
slow does it get as clients pile up, and what does the firewall process itself
cost in CPU and memory while it does. It measures one version, the checked-out
tree, and compares nothing. For the version-over-version trend, the nightly
`perf-trend.yml` exists (see [docs/LOADTESTS.md](../../../docs/LOADTESTS.md)).

## What runs

`test/load/benchmark.ts` forks the firewall into a child process
(`test/load/lib/firewallProcess.ts`) and drives it from the parent through a
real CONNECT tunnel and TLS, against a mock HTTPS upstream. The child reports
its own CPU (every thread), RSS, V8 heap and event-loop delay over IPC, so the
load generator's TLS work is never counted against the firewall. Scenario A
(`npm run test:load:perf`) cannot say that: everything shares one process there.

Three workloads, each swept over the concurrency levels:

| Workload | Each request | What it exercises |
| --- | --- | --- |
| `chat` | one short benign prompt plus a ticket number | the full cold scan of a small prompt |
| `agent` | a 64 KB coding-agent request: system prompt, tools, a resent history of file reads, one new tool result | the real Claude Code shape: history from the item cache, newest tool result scanned cold |
| `attack` | one prompt from `test/load/data/malicious.json` | the refusal path |

Every request carries text the firewall has not seen. The pipeline caches a
clean item's verdict by its text (`itemCache` in `src/detection/pipeline.ts`),
so replaying a fixed prompt list measures the cache after the first pass. Keep
it that way if you change the workloads.

## Run it

1. **Work in a worktree off `main`** unless the user wants their working tree
   measured. The run records the commit and whether tracked files were dirty;
   a dirty run is labelled so on every chart.
2. **Quiet the machine, and keep it quiet until the run ends.** CPU figures
   are per process but throughput is not: another llm-fw, a build, a vitest
   run, or rendering the previous run's charts moves every number. On
   2026-11-01 a run with other work on the machine measured chat at 1 client at
   8.7 req/s, p50 105 ms; quiet runs of the same commit measured 52 to 59 req/s,
   p50 16 to 18 ms. Do the writing while it runs, nothing that computes. Check
   that ports 19380 and 19931 are free.
3. Run, with defaults unless asked otherwise (about 5 to 6 minutes):

   ```bash
   npm run bench:load
   ```

   | Variable | Default | |
   | --- | --- | --- |
   | `LOAD_BENCH_WORKLOADS` | `chat,agent,attack` | any subset |
   | `LOAD_BENCH_CONCURRENCY` | `1,2,4,8,16,32` | at most 6 levels keep the chart ramp distinct |
   | `LOAD_BENCH_STEP_S` | `10` | measured seconds per level |
   | `LOAD_BENCH_WARMUP_S` | `2` | unmeasured seconds before each level |
   | `LOAD_BENCH_AGENT_KB` | `64` | agent request size |
   | `LOAD_BENCH_OUT` | `reports/load-bench/<timestamp>` | gitignored |
   | `LLM_FW_MODEL_DIR` | `<repo>/.hf-model-cache` | the first run downloads the model there (about 35 s) |

   It exits 1 only if the firewall process dies or a level sees more than 1%
   network errors. It never fails on speed: it reports, it does not gate.

4. Render the charts (needs `pip install matplotlib`; `python3` on Linux and
   macOS):

   ```bash
   python scripts/load-bench-charts.py reports/load-bench/<run>/results.json
   ```

   It writes `overview.png`, `throughput-latency.png`,
   `latency-distribution.png`, `cpu-memory.png` and `timeline.png` next to the
   JSON. **Open every PNG and look at it** before reporting: the script checks
   nothing about label collisions or empty panels.

## Read the result before reporting it

- **CPU above 100% is normal.** It is a percentage of one core, all threads
  counted; onnxruntime runs inference on many threads. Compare `cpuMsPerRequest`
  between workloads, and compare `cpuPct` with the idle figures in
  `startup.idle` and `startup.idleAfter`. CPU that sits at the same ceiling at
  every concurrency level, 1 client included, is onnxruntime's intra-op threads
  spin-waiting, not detection work. Measured 2026-11-01: chat at 1 client used
  1,092% with spinning (the default) and 191% with
  `session.intra_op.allow_spinning` off, at similar throughput (#631). Do not
  read the ceiling as "detection needs 12 cores".
- **Check `warnings` before anything else.** The run records machine-wide CPU
  per level (`machine.otherPct`: other processes, as a share of all threads)
  and a fixed SHA-256 speed probe before each workload and at the end
  (`speedProbes`). Other processes above 10% in a level, or a probe that slows
  by 20% or more, prints a WARNING and puts "Noisy run" on the overview chart.
  A noisy run is not a result: on 2026-11-01 the probe went from 19 ms to
  69 ms mid-run (a laptop on the Balanced power plan, with other sessions
  busy) and every agent level timed out. Report it as noisy and rerun.
- **`coldFirstRequestMs`** is the first request of each workload, sent before
  any level with a 300 s timeout. For `agent` it is the whole history scanned
  cold, which is what an agent's first turn costs. It is primed this way
  because an abandoned cold scan still runs to the end, and every request that
  arrives meanwhile misses the item cache and repeats it.
- **Flat throughput with rising latency is saturation**, not a regression: past
  that level every added client only queues. Quote the knee, the level where
  throughput stops growing, and p99 there.
- **Event-loop delay is the number that hurts other clients.** Detection runs
  on the thread that serves every request, so a p99 delay of N ms means any
  request arriving then waits N ms before it is even read.
- **`unexpected`** counts benign requests not answered 200 and attacks that
  were. `unexpectedPrompts` names the data-file indexes. Benign refusals are
  false positives worth an issue; attack passes are expected (no judge) and are
  measured properly by `npm run scorecard`, not here.
- The mock upstream answers instantly, so latency is the firewall plus the
  client's CONNECT and TLS handshake on loopback. Real provider latency is
  seconds; say so when quoting milliseconds.

## Reporting

Numbers, not adjectives, with the machine: the charts' footer carries
version, ruleset, commit, Node, CPU and core count. Quote per workload the peak
throughput and its concurrency, p50 and p99 at 1 client, CPU time per request,
and peak RSS against idle RSS. Say which results were measured and which were
read.

Do not commit a run unless asked. When asked to record one, copy the PNGs
(not the multi-megabyte `results.json`) into `docs/load-results/<date>_bench/`
and add a dated section to `docs/LOADTESTS.md` next to the earlier recorded
results. Never quote attack prompt text in a commit, PR or doc.
