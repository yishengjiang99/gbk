// Remote MCP: protocol, discovery, annotations, auth challenges, session binding.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

const model = () => new ScriptModel([() => reply("x")]);

test("well-known OAuth discovery documents follow RFC 9728 / RFC 8414 + MCP requirements", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const pr = await (await fetch(`${s.base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(pr.resource, "http://composer.test/mcp");
    assert.deepEqual(pr.authorization_servers, ["http://composer.test"]);
    assert.ok(pr.scopes_supported.includes("gbk:compositions.write"));
    const asm = await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(asm.issuer, "http://composer.test");
    assert.ok(asm.code_challenge_methods_supported.includes("S256"), "S256 PKCE is mandatory for MCP");
    assert.ok(asm.registration_endpoint.endsWith("/oauth/register"));
    assert.equal(asm.authorization_response_iss_parameter_supported, true);
    assert.equal(asm.client_id_metadata_document_supported, true);
  } finally { await s.app.close(); }
});

test("MCP initialize, tools/list with annotations, anonymous capabilities, auth challenge (guest projects off), session binding", async () => {
  // MCP_GUEST=0 is the off switch: account-free projects disabled -> private tools need OAuth again.
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", MCP_GUEST: "0" });
  try {
    // Unauthenticated tools/call (non-public tool) -> 401 with a discovery challenge.
    const anon = new McpClient(s.base);
    const challenged = await anon.send("tools/call", { name: "gbk_create_composition", arguments: { title: "x" } });
    assert.equal(challenged.status, 401);
    assert.match(challenged.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);

    // Anonymous initialize + tools/list are allowed (discovery surface).
    const init = await anon.initialize();
    assert.equal(init.status, 200);
    const list = await anon.send("tools/list", {});
    const tools = (list.rpc?.result as { tools: { name: string; annotations?: Record<string, boolean>; inputSchema: unknown }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["gbk_cancel_render", "gbk_claim_composition", "gbk_create_composition", "gbk_delete_composition", "gbk_edit_composition", "gbk_get_artifacts", "gbk_get_capabilities",
      "gbk_get_composition", "gbk_get_render_status", "gbk_list_compositions", "gbk_list_soundfonts", "gbk_open_workstation", "gbk_publish_composition",
      "gbk_render_composition", "gbk_show_composition_ui", "gbk_widget_render_finish", "gbk_widget_render_start"].sort());
    const caps = tools.find((t) => t.name === "gbk_get_capabilities")!;
    assert.equal(caps.annotations?.readOnlyHint, true);
    const create = tools.find((t) => t.name === "gbk_create_composition")!;
    assert.equal(create.annotations?.readOnlyHint, false);
    for (const t of tools) assert.ok(t.inputSchema, `${t.name} exposes an input schema`);

    // The one public read-only tool works anonymously.
    const capRes = await anon.call<{ capabilities: { styles: string[]; instruments: { name: string }[] } }>("gbk_get_capabilities");
    assert.ok(capRes.capabilities.styles.includes("baroque"));
    assert.ok(capRes.capabilities.instruments.some((i) => i.name === "organ"));

    // The MCP Apps player resource declares CSP domains for the artifact origin — sandboxed hosts
    // block the <audio> element and the download links without them (they point at the public origin).
    const uiRes = await anon.send("resources/read", { uri: "ui://gbk/composer-v2.html" });
    const contents = (uiRes.rpc?.result as { contents: { _meta?: { ui?: { csp?: { resourceDomains?: string[]; connectDomains?: string[] } } } }[] }).contents;
    assert.deepEqual(contents[0]._meta?.ui?.csp?.resourceDomains, ["http://composer.test"]);
    assert.deepEqual(contents[0]._meta?.ui?.csp?.connectDomains, ["http://composer.test"]);

    // Unknown tool and invalid arguments produce errors, not crashes.
    const alice = new McpClient(s.base, { "x-gbk-test-user": "alice" });
    await alice.initialize();
    const unknown = await alice.callRaw("gbk_no_such_tool", {});
    assert.ok(unknown.rpc?.error || (unknown.rpc?.result as { isError?: boolean })?.isError, "unknown tool must error");
    const invalid = await alice.callRaw("gbk_create_composition", { style: "baroque" }); // title missing
    const invRes = invalid.rpc?.result as { isError?: boolean } | undefined;
    assert.ok(invalid.rpc?.error || invRes?.isError, "schema validation must reject missing title");

    // Session binding: alice's session rejects bob's identity.
    const bobOnAlice = new McpClient(s.base, { "x-gbk-test-user": "bob" });
    bobOnAlice.sessionId = alice.sessionId;
    const cross = await bobOnAlice.send("tools/list", {});
    assert.equal(cross.status, 403);
  } finally { await s.app.close(); }
});

test("test-auth header is ignored unless MCP_TEST_AUTH=1 (fail closed)", async () => {
  const s = await startServer(model()); // no MCP_TEST_AUTH
  try {
    const c = new McpClient(s.base, { "x-gbk-test-user": "mallory" });
    await c.initialize(); // initialize is anonymous-allowed, but bound to NO user
    const r = await c.send("tools/call", { name: "gbk_list_compositions", arguments: {} });
    // The session is anonymous: the ignored header establishes no account, so the guest list is empty.
    assert.equal(r.status, 200);
    assert.deepEqual((r.rpc?.result as { structuredContent: { items: unknown[] } }).structuredContent.items, [], "test header must not establish an account");
  } finally { await s.app.close(); }
});

test("Codex-style probes: GET/DELETE before initialize -> 405, stale session id -> 404 then clean re-init", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const hdr = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const get = await fetch(`${s.base}/mcp`, { method: "GET", headers: { accept: "text/event-stream" } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
    const del = await fetch(`${s.base}/mcp`, { method: "DELETE" });
    assert.equal(del.status, 405);
    const stale = "00000000-0000-4000-8000-000000000000";
    const post = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...hdr, "mcp-session-id": stale }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(post.status, 404, "unknown session must be 404 so clients re-initialize");
    const staleGet = await fetch(`${s.base}/mcp`, { method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": stale } });
    assert.equal(staleGet.status, 404);
    const c = new McpClient(s.base);
    assert.equal((await c.initialize()).status, 200);
    assert.ok((await c.send("tools/list", {})).rpc?.result);
  } finally { await s.app.close(); }
});
