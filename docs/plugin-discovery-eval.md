# Plugin discovery evaluation

Do models pick GBK's tools for music-making requests, and leave them alone otherwise?

## Fixtures

`test/fixtures/plugin-discovery/*.json`, 42 prompts:

| Category | File | Expectation |
| --- | --- | --- |
| A | `A-explicit.json` (12) | Explicit composition requests: invoke GBK; first tool `gbk_create_composition` or `gbk_get_capabilities`. |
| B | `B-followup.json` (10) | Follow-ups and implicit GBK work (list, render, edit, play): invoke GBK; first tool as listed per fixture. |
| C | `C-negative.json` (12) | Music-adjacent or unrelated questions: no GBK tool. |
| D | `D-borderline.json` (8) | Either is acceptable; reported, not scored. |

`test/plugin-discovery.test.ts` checks fixture shape, that every expected tool exists, and the scoring logic.

## Automated proxy run

`scripts/plugin-discovery/run.ts` fetches the **live** tool list from `/mcp`, adds three generic distractor tools
(web_search, image_generation, python), asks an OpenAI-compatible model to respond to each prompt with
`tool_choice: auto` at temperature 0, and records the first tool call. Nothing is executed. It writes
`docs/evals/plugin-discovery-<date>.{json,md}`.

- Key handling: reads `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` from the environment only. It never prints or saves the key.
- Budget: it stops before estimated spend passes `EVAL_MAX_USD` (default $1.00; the price comes from
  `LLM_PRICE_INPUT_PER_MTOK`/`LLM_PRICE_OUTPUT_PER_MTOK`). A full run costs about $0.60 with grok-4.20.

Run on the server, where the key already lives:

```sh
npm run build:eval                     # -> /tmp/plugin-discovery-eval.mjs (single file, no deps)
scp /tmp/plugin-discovery-eval.mjs root@HOST:/tmp/ && tar czf - test/fixtures/plugin-discovery | ssh root@HOST 'mkdir -p /tmp/gbk-eval && tar xzf - -C /tmp/gbk-eval'
ssh root@HOST 'cd /tmp/gbk-eval && (set -a; . /etc/gbk-composer.env; set +a; node /tmp/plugin-discovery-eval.mjs --fixtures test/fixtures/plugin-discovery --out out)'
```

Locally, with your own key in the environment: `npm run eval:discovery -- [--mcp URL] [--limit N] [--model M]`.

Limits: this measures one model's tool selection given GBK's descriptions. It does not measure ChatGPT's own app routing or directory ranking. Results vary from run to run, so compare several runs.

## Manual ChatGPT run (owner)

1. In ChatGPT, connect `https://compose.grepawk.com/mcp` with no authentication, in a fresh chat with only GBK enabled.
2. For each fixture prompt, start a new chat, send the prompt, and record the first tool ChatGPT calls (or none).
3. Write the outcomes as `[{ "id": "A01", "firstTool": "gbk_create_composition" }, ...]` and score them with
   `summarize()` from `scripts/plugin-discovery/score.ts`. Report only observed results; no fabricated ones.
