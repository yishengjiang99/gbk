# Package test fixtures (legacy hook)

Canonical fixture pack lives at **repo-root** [`fixtures/`](../../../../../fixtures/).

`WriterOnlyFixtureTests` resolves `../../../../../../fixtures` from this test target via `#filePath`.

This directory keeps `c_scale_staff_oracle/` as a historical Gate-1 hook path; prefer
`fixtures/oracle.c_scale_staff/` for new GT (status `awaiting_oracle_export` until
homr-research lands real 22/22 tokens — do not invent them).
