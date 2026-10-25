# Installing GBK Composer

MCP endpoint: `https://compose.grepawk.com/mcp` (Streamable HTTP). **No authentication is required.**

## ChatGPT
- **Once the listing is published:** open the GBK Composer listing in ChatGPT and add it. The Install button on
  https://compose.grepawk.com/chatgpt appears only when the listing URL is configured (`CHATGPT_PLUGIN_URL`).
- **Before publication (developer mode):** ChatGPT, Settings, Apps & Connectors, Advanced, enable Developer mode,
  then create a connector with URL `https://compose.grepawk.com/mcp` and authentication "No authentication".
- Try: "Compose a 16-bar Baroque fugue in D minor for organ, then show me the piano roll."

## Codex
Add the plugin from `plugins/gbk-composer/`, or add the MCP server to `~/.codex/config.toml`:
```toml
[mcp_servers.gbk_composer]
url = "https://compose.grepawk.com/mcp"
```
Codex has no browser player, so renders run on GBK's server and come back as signed WAV/MIDI links.

## Without an account (default)
`gbk_create_composition` returns `compositionId`, a private `accessToken` (edit), and a `readAccessToken`. The model passes
the token on every follow-up call. Keep it private: a lost token can't be recovered. Compositions stay private
unless you explicitly ask GBK to publish one.

## Optional sign-in
Sign in with Google or GitHub (OAuth) to list your compositions across chats and to claim account-free pieces
(while you still hold their token) into your account.
