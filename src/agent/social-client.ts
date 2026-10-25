// Browser client for gbk Social (docs/social-api.md). Cookie auth + CSRF header on writes.
import { apiBase } from "./bridge-client.ts";
import type { PianoRollPreview } from "./piano-roll-preview.ts";

export const LABELS = ["ambient", "lofi", "classical", "jazz", "rnb", "electronic", "cinematic", "game", "pop", "experimental", "wip"] as const;
export interface SUser { handle: string; display_name: string; bio?: string | null; badge?: string | null; avatar_url: string | null; song_count: number; rating_avg: number | null; created_at: number }
export interface Me extends SUser { id: string; dm_policy: "all" | "off"; handle_changed: boolean; is_admin: boolean }
export interface Song { slug: string; title: string; url: string; author: SUser; created_at: number; published_at: number | null; labels: string[]; tags: string[]; rating_avg: number | null; rating_count: number; comment_count: number; play_count: number; fork_count: number; my_rating: number | null; media: { mp3: string | null; wav: string | null; midi: string | null }; preview: PianoRollPreview | null; prompt_shared: boolean; prompt_text: string | null; parent_slug: string | null; is_mine: boolean }
export interface SComment { id: string; author: SUser; body: string; created_at: number; can_delete: boolean }
export interface Page<T> { items: T[]; next_cursor: string | null }

const csrf = () => decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("gbk_csrf="))?.slice(9) ?? "");
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, { method, credentials: "same-origin", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-gbk-csrf": csrf() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(b.message ?? `HTTP ${r.status}`) as Error & { status: number; code?: string }; e.status = r.status; e.code = b.code; throw e; }
  return b as T;
}
const qs = (o: Record<string, string | number | null | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ""; };

export const social = {
  me: () => call<Me>("GET", "/me").catch((e) => { if ((e as { status?: number }).status === 401) return null; throw e; }),
  feed: (o: { sort?: string; label?: string; tag?: string; cursor?: string | null; limit?: number }) => call<Page<Song> & { model_version?: string }>("GET", `/feed${qs(o)}`),
  song: (slug: string) => call<Song>("GET", `/songs/${encodeURIComponent(slug)}`),
  setMeta: (slug: string, m: { labels?: string[]; tags?: string[]; prompt_shared?: boolean; prompt_text?: string | null }) => call<Song>("PATCH", `/songs/${encodeURIComponent(slug)}/meta`, m),
  promptSuggestion: (slug: string) => call<{ prompt: string | null }>("GET", `/songs/${encodeURIComponent(slug)}/prompt-suggestion`).catch(() => ({ prompt: null })),
  tags: () => call<{ tags: { tag: string; count: number }[]; labels: { label: string; count: number }[] }>("GET", "/tags/top"),
  rate: (slug: string, stars: number | null) => call<{ rating_avg: number | null; rating_count: number; my_rating: number | null }>(stars === null ? "DELETE" : "PUT", `/shares/${encodeURIComponent(slug)}/rating`, stars === null ? undefined : { stars }),
  comments: (slug: string, cursor?: string | null) => call<Page<SComment>>("GET", `/shares/${encodeURIComponent(slug)}/comments${qs({ cursor })}`),
  comment: (slug: string, body: string) => call<SComment>("POST", `/shares/${encodeURIComponent(slug)}/comments`, { body }),
  deleteComment: (id: string) => call<{ ok: true }>("DELETE", `/comments/${encodeURIComponent(id)}`),
  play: (slug: string) => call<{ play_count: number }>("POST", `/shares/${encodeURIComponent(slug)}/play`).catch(() => null),
  user: (handle: string, cursor?: string | null) => call<{ user: SUser; songs: Song[]; next_cursor: string | null }>("GET", `/users/${encodeURIComponent(handle)}${qs({ cursor })}`),
  settings: (o: { display_name?: string; handle?: string; dm_policy?: string }) => call<Me>("PATCH", "/me/settings", o),
  report: (kind: "comment" | "song" | "user" | "message", target: string, reason: string) => call<{ ok: true; id: string; deleted?: boolean; message?: string }>("POST", "/reports", { kind, target, reason }),
  adminReports: (status = "open") => call<{ items: { id: string; kind: string; target: string; reason: string; reporter: string; status: string; created_at: number; preview: { text: string; by: string; song: string | null; hidden: boolean } | null }[]; next_cursor: string | null }>("GET", `/admin/reports${qs({ status })}`),
  resolve: (id: string, action: "hide" | "dismiss") => call<{ ok: true }>("POST", `/admin/reports/${encodeURIComponent(id)}`, { action }),
};
