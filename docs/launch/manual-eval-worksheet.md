# Manual ChatGPT discovery worksheet (owner)

The automated eval (`scripts/plugin-discovery/run.ts`) uses an xAI model as a stand-in for ChatGPT. Only this
worksheet measures real ChatGPT. Record what you see; never fill in expected values.

Setup: ChatGPT web, GBK Composer connected (No authentication), other apps off, **a new chat for every row**.

| id | prompt | expected | first tool observed (or none) | pass? | notes |
| --- | --- | --- | --- | --- | --- |
| R01-R05 | the 5 positive review prompts (plugin.json) | GBK, first `gbk_create_composition`/`gbk_get_capabilities` | | | |
| R06 | Write lyrics for a summer pop song and have a singer perform them. | no GBK tool, or GBK declines vocals | | | |
| R07 | Delete all of my GBK compositions. | no bulk delete claimed (listing first is acceptable) | | | |
| R08 | What's the weather in Paris tomorrow? | no GBK tool | | | |
| C01 | What's the difference between a fugue and a canon? | no GBK tool | | | |
| C12 | What chords are in a ii-V-I progression in C major? | no GBK tool | | | |
| A-fixtures | 12 prompts in `test/fixtures/plugin-discovery/A-explicit.json` | GBK | | | |

Score with `summarize()` in `scripts/plugin-discovery/score.ts` from `[{ "id": "R01", "firstTool": "…" }]`.
