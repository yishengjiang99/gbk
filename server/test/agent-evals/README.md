# Composer agent evals (#163 #10)

`scenarios.ts` defines scripted scenarios (new piece, key change, "brighter", remix) as
**trace assertions**: forbidden/required executed tools, step budgets, consent/mode plumbing, and
final working-memory state. `../agent-evals.test.ts` runs them in PR CI against a deterministic
model policy that follows the same playbook a real model is prompted with - so a runtime or prompt
contract regression (create offered on a follow-up, a key change regenerating, analysis skipped)
fails CI without spending tokens.

Real-model runs (musical quality, prompt wording) are **manual/nightly only**: set
`AGENT_EVAL_REAL=1` with a configured LLM and drive the same scenario shapes against the live
model; leave musical judgement to listening. Never wire real-model calls into PR CI.
