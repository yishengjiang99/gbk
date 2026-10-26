import assert from "node:assert/strict";

/** Mocked grepawk.com entitlement endpoint: emails in `pro` have an active Stripe subscription. */
export function entitlementFetch(state: { pro: Set<string>; down: boolean; calls: string[] }): typeof fetch {
  const real = globalThis.fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://billing.test/")) return real(input, init);
    state.calls.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-entitlement-token");
    if (state.down) return new Response("boom", { status: 503 });
    const email = new URL(url).searchParams.get("email")!;
    return Response.json({ product: "compose", pro: state.pro.has(email) });
  }) as typeof fetch;
}
