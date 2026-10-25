# Plugin discovery eval — 2026-10-25-review-base

Model `grok-4.20-0309-non-reasoning` via tool calling (temperature 0) against the live tool list of `https://compose.grepawk.com/mcp` (17 tools) plus distractors (web_search, image_generation, python). Tool calls are recorded, never executed. This is a proxy for ChatGPT's own app selection, not a ChatGPT measurement.

| Metric | Score |
| --- | --- |
| Invocation accuracy (A+B+C) | 81.8% (9/11) |
| Recall on positives (A+B) | 100.0% (8/8) |
| False-positive rate on negatives (C) | 66.7% |
| First-tool accuracy on positives | 100.0% (8/8) |
| A explicit / B follow-up / C negative | 100.0% (8/8) / n/a / 33.3% (1/3) |
| Borderline (D) invoked GBK | 0/0 (not scored) |
| First-call arguments valid vs live schema | 10/10 |
| First call was gbk_publish_composition | none |
| Errors | 0 |
| Usage | 61007 in / 463 out tokens, ≈ $0.19 (cap $0.9) |

## Misses

| id | prompt | expected | first tool |
| --- | --- | --- | --- |
| R06 | Write lyrics for a summer pop song and have a singer perform them. | no GBK tool | gbk_get_capabilities |
| R07 | Delete all of my GBK compositions. | no GBK tool | gbk_list_compositions |
