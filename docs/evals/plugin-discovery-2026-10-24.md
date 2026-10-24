# Plugin discovery eval — 2026-10-24

Model `grok-4.20-0309-non-reasoning` via tool calling (temperature 0) against the live tool list of `http://127.0.0.1:18099/mcp` (14 tools) plus distractors (web_search, image_generation, python). Tool calls are recorded, never executed. This is a proxy for ChatGPT's own app selection, not a ChatGPT measurement.

| Metric | Score |
| --- | --- |
| Invocation accuracy (A+B+C) | 97.1% (33/34) |
| Recall on positives (A+B) | 100.0% (22/22) |
| False-positive rate on negatives (C) | 8.3% |
| First-tool accuracy on positives | 100.0% (22/22) |
| A explicit / B follow-up / C negative | 100.0% (12/12) / 100.0% (10/10) / 91.7% (11/12) |
| Borderline (D) invoked GBK | 8/8 (not scored) |
| Errors | 0 |
| Usage | 193594 in / 1504 out tokens, ≈ $0.6033 (cap $1) |

## Misses

| id | prompt | expected | first tool |
| --- | --- | --- | --- |
| C12 | What chords are in a ii-V-I progression in C major? | no GBK tool | gbk_get_capabilities |

## Run-to-run variance (same day, same fixtures)

Two earlier runs on 2026-10-24 gave false-positive rates of 25% (3/12) and 33% (4/12) on category C, every time from
`gbk_get_capabilities` on music-theory or lyrics questions. Recall and first-tool accuracy were 100% in all three runs.
(The 33% run used an experimental capabilities description that was then reverted, and the first run stopped at the
$0.50 cap after 36 fixtures.) Treat the false-positive rate as roughly 8–33% with this model until more runs are averaged.
