# Plugin discovery eval — 2026-10-25-base1

Model `grok-4.20-0309-non-reasoning` via tool calling (temperature 0) against the live tool list of `https://compose.grepawk.com/mcp` (17 tools) plus distractors (web_search, image_generation, python). Tool calls are recorded, never executed. This is a proxy for ChatGPT's own app selection, not a ChatGPT measurement.

| Metric | Score |
| --- | --- |
| Invocation accuracy (A+B+C) | 94.1% (32/34) |
| Recall on positives (A+B) | 100.0% (22/22) |
| False-positive rate on negatives (C) | 16.7% |
| First-tool accuracy on positives | 100.0% (22/22) |
| A explicit / B follow-up / C negative | 100.0% (12/12) / 100.0% (10/10) / 83.3% (10/12) |
| Borderline (D) invoked GBK | 8/8 (not scored) |
| First-call arguments valid vs live schema | 32/32 |
| First call was gbk_publish_composition | none |
| Errors | 0 |
| Usage | 232612 in / 1484 out tokens, ≈ $0.7201 (cap $0.9) |

## Misses

| id | prompt | expected | first tool |
| --- | --- | --- | --- |
| C01 | What's the difference between a fugue and a canon? | no GBK tool | gbk_get_capabilities |
| C12 | What chords are in a ii-V-I progression in C major? | no GBK tool | gbk_get_capabilities |
