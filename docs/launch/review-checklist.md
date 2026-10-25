# Review checklist (what an OpenAI reviewer will exercise)

Run before any portal submission. The owner does the portal steps; the bot never touches the portal.

- [ ] `npm run smoke:prod` passes (pages, MCP init, anonymous create/edit, server render, WAV/SMF validation, cross-project denial, read-only key cannot edit or publish, cleanup).
- [ ] The review test cases in `plugins/gbk-composer/plugin.json` (5 positive, 3 negative) each work in a **clean** ChatGPT conversation with no history. See `chatgpt-acceptance.md` and `manual-eval-worksheet.md`. Only a real ChatGPT run counts as ChatGPT evidence.
- [ ] The tool list on the server matches the docs (`launch-consistency.test.ts`).
- [ ] New compositions are private; publish happens only on explicit request; share URLs contain no key.
- [ ] No lyrics/vocals claims; no claims of features the code lacks.
- [ ] Privacy, terms, and support pages are reachable and accurate (`/privacy`, `/terms`, `/support`).
- [ ] The uploaded ZIP matches the intended commit (`portal-package-delta.md`).
