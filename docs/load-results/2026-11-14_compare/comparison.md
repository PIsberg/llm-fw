Baseline: 0.9.4. Each cell is the median of the runs, with the range in brackets; a change counts only when the ranges do not overlap.

|Version|Ruleset|Commit|Runs|Node|Runtime|
|---|---|---|---|---|---|
|0.9.4|2026.11.1|dad5805|2|v26.13.0|not recorded|
|0.9.6|2026.11.45|8b80a06|2|v26.13.0|not recorded|
|main|2026.11.69|de95876|2|v26.13.0|not recorded|
|main, embedding.spinWait=true|2026.11.69|de95876 (dirty)|2|v26.13.0|@huggingface/transformers 4.3.2, onnxruntime-node 1.30.0|

### Chat prompt

|Metric|0.9.4|0.9.6|main|main, embedding.spinWait=true|
|---|---|---|---|---|
|Peak throughput|82.7 req/s (74.8 req/s-90.6 req/s)|104 req/s (78.4 req/s-129 req/s), +25.2%, within noise|77.1 req/s (75.5 req/s-78.7 req/s), -6.7%, within noise|154 req/s (147 req/s-162 req/s), +86.8%, better|
|p50 at 1 client|16 ms (15 ms-17 ms)|19 ms (14 ms-24 ms), +21.2%, within noise|25 ms (24 ms-25 ms), +54.4%, worse|15 ms (14 ms-15 ms), -8.4%, better|
|p99 at 1 client|26 ms (23 ms-29 ms)|31 ms (23 ms-39 ms), +18.6%, within noise|40 ms (40 ms-41 ms), +54.5%, worse|23 ms (23 ms-24 ms), -11.1%, within noise|
|CPU per request at 1 client|194 ms (179 ms-208 ms)|44 ms (38 ms-50 ms), -77.1%, better|51 ms (50 ms-52 ms), -73.5%, better|177 ms (175 ms-178 ms), -8.9%, better|
|First request, cold|166 ms (156 ms-175 ms)|188 ms (145 ms-231 ms), +13.6%, within noise|304 ms (301 ms-306 ms), +83.4%, worse|287 ms (282 ms-291 ms), +73.1%, worse|
|Worst event-loop p99|136 ms (112 ms-159 ms)|21 ms (19 ms-24 ms), -84.5%, better|24 ms (24 ms-24 ms), -82.0%, better|27 ms (24 ms-30 ms), -80.0%, better|

### Agent request

|Metric|0.9.4|0.9.6|main|main, embedding.spinWait=true|
|---|---|---|---|---|
|Peak throughput|6.4 req/s (6.0 req/s-6.8 req/s)|6.5 req/s (5.8 req/s-7.1 req/s), +1.3%, within noise|6.1 req/s (6.1 req/s-6.1 req/s), -4.4%, within noise|6.4 req/s (5.9 req/s-6.9 req/s), +0.2%, within noise|
|p50 at 1 client|158 ms (150 ms-166 ms)|209 ms (206 ms-212 ms), +32.0%, worse|215 ms (211 ms-219 ms), +36.0%, worse|182 ms (170 ms-195 ms), +15.2%, worse|
|p99 at 1 client|200 ms (194 ms-205 ms)|257 ms (226 ms-288 ms), +28.6%, worse|253 ms (233 ms-272 ms), +26.6%, worse|231 ms (188 ms-274 ms), +15.8%, within noise|
|CPU per request at 1 client|1.91 s (1.81 s-2.00 s)|1.26 s (1.21 s-1.32 s), -33.7%, better|1.25 s (1.24 s-1.26 s), -34.5%, better|2.18 s (2.02 s-2.34 s), +14.6%, worse|
|First request, cold|2.51 s (2.29 s-2.74 s)|3.31 s (3.29 s-3.34 s), +31.8%, worse|3.48 s (3.44 s-3.51 s), +38.3%, worse|2.65 s (2.62 s-2.69 s), +5.5%, within noise|
|Worst event-loop p99|2.16 s (1.94 s-2.38 s)|37 ms (32 ms-41 ms), -98.3%, better|46 ms (45 ms-47 ms), -97.9%, better|86 ms (73 ms-99 ms), -96.0%, better|

### Attack (refused)

|Metric|0.9.4|0.9.6|main|main, embedding.spinWait=true|
|---|---|---|---|---|
|Peak throughput|344 req/s (258 req/s-429 req/s)|332 req/s (287 req/s-378 req/s), -3.3%, within noise|460 req/s (383 req/s-538 req/s), +34.0%, within noise|374 req/s (366 req/s-382 req/s), +8.8%, within noise|
|p50 at 1 client|4.1 ms (3.4 ms-4.8 ms)|3.4 ms (3.1 ms-3.8 ms), -15.9%, within noise|4.6 ms (4.6 ms-4.7 ms), +13.2%, within noise|3.7 ms (3.7 ms-3.7 ms), -9.1%, within noise|
|p99 at 1 client|8.3 ms (5.7 ms-11 ms)|8.2 ms (7.7 ms-8.7 ms), -0.5%, within noise|10 ms (10 ms-10 ms), +26.4%, within noise|8.9 ms (8.5 ms-9.3 ms), +7.5%, within noise|
|CPU per request at 1 client|3.3 ms (2.5 ms-4.0 ms)|2.3 ms (2.1 ms-2.5 ms), -30.0%, better|3.0 ms (2.9 ms-3.1 ms), -8.3%, within noise|2.6 ms (2.6 ms-2.7 ms), -19.0%, within noise|
|First request, cold|13 ms (6.0 ms-19 ms)|6.0 ms (5.0 ms-7.0 ms), -52.0%, within noise|6.0 ms (5.0 ms-7.0 ms), -52.0%, within noise|7.5 ms (6.0 ms-9.0 ms), -40.0%, within noise|
|Worst event-loop p99|62 ms (59 ms-64 ms)|52 ms (40 ms-64 ms), -15.5%, within noise|40 ms (39 ms-42 ms), -34.7%, better|40 ms (39 ms-41 ms), -35.5%, better|

### Memory

|Metric|0.9.4|0.9.6|main|main, embedding.spinWait=true|
|---|---|---|---|---|
|RSS idle after start|588 MB (588 MB-588 MB)|631 MB, +7.3%, worse|631 MB (631 MB-632 MB), +7.4%, worse|643 MB (631 MB-654 MB), +9.3%, worse|
|Peak RSS under load|791 MB (788 MB-794 MB)|619 MB (583 MB-656 MB), -21.7%, better|591 MB (589 MB-593 MB), -25.3%, better|635 MB (605 MB-665 MB), -19.7%, better|
|RSS idle after load|652 MB (641 MB-664 MB)|563 MB (553 MB-573 MB), -13.7%, better|572 MB (568 MB-576 MB), -12.4%, better|587 MB (575 MB-600 MB), -10.0%, better|

### Startup

|Metric|0.9.4|0.9.6|main|main, embedding.spinWait=true|
|---|---|---|---|---|
|Model and pipeline init|1.13 s (1.08 s-1.18 s)|1.96 s (1.58 s-2.34 s), +73.2%, worse|1.66 s (1.66 s-1.67 s), +47.2%, worse|1.57 s (1.55 s-1.59 s), +39.0%, worse|
|Process start to ready|1.88 s (1.87 s-1.90 s)|2.39 s (1.99 s-2.80 s), +26.9%, worse|2.16 s (2.10 s-2.22 s), +14.8%, worse|2.02 s (1.98 s-2.07 s), +7.4%, worse|

### Caveats

- detection settings were recorded by 1 of 4 versions; older runs predate the field
- Noisy run: 0.9.4, 2026-11-14T19:06:55.746Z: other processes used 10% or more of the machine in 2 of 18 levels (worst 13.46%, chat at 2)
- Noisy run: 0.9.4, 2026-11-14T19:06:55.746Z: the CPU speed probe varied by 21.85% over the run (18.3 ms before chat, 15.1 ms before agent, 15.4 ms before attack, 18.4 ms end): the machine slowed down
- Noisy run: 0.9.6, 2026-11-14T19:12:36.888Z: other processes used 10% or more of the machine in 6 of 18 levels (worst 27.94%, attack at 4)
- Noisy run: 0.9.6, 2026-11-14T19:12:36.888Z: the CPU speed probe varied by 27.44% over the run (20.9 ms before chat, 17.7 ms before agent, 16.4 ms before attack, 19.6 ms end): the machine slowed down
- Noisy run: 0.9.6, 2026-11-14T19:29:34.884Z: the CPU speed probe varied by 34.73% over the run (16.7 ms before chat, 19.6 ms before agent, 22.5 ms before attack, 18.6 ms end): the machine slowed down
- Noisy run: main, 2026-11-14T19:19:42.400Z: other processes used 10% or more of the machine in 5 of 18 levels (worst 20.91%, chat at 4)
- Noisy run: main, 2026-11-14T19:24:43.662Z: the CPU speed probe varied by 36.71% over the run (20 ms before chat, 21.6 ms before agent, 20.4 ms before attack, 15.8 ms end): the machine slowed down
- Noisy run: main, embedding.spinWait=true, 2026-11-14T19:39:49.520Z: other processes used 10% or more of the machine in 1 of 18 levels (worst 11.1%, chat at 4)
- Noisy run: main, embedding.spinWait=true, 2026-11-14T19:39:49.520Z: the CPU speed probe varied by 20.67% over the run (21.6 ms before chat, 20.5 ms before agent, 19.6 ms before attack, 17.9 ms end): the machine slowed down
- Noisy run: main, embedding.spinWait=true, 2026-11-14T19:44:49.344Z: the CPU speed probe varied by 24.59% over the run (22.8 ms before chat, 20 ms before agent, 18.3 ms before attack, 18.8 ms end): the machine slowed down
