/** Song share text and OG/Twitter titles. Used by the web app and the server. */

export type ShareAuthor = {
  handle?: string | null;
  displayName?: string | null;
  /** X/Twitter handle, used only when already stored and valid. Never guessed. */
  xHandle?: string | null;
};

export type ShareSong = ShareAuthor & { title?: string | null };

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** Return a stored X handle, or null if missing/invalid. Does not invent one. */
export function storedXHandle(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const h = String(raw).trim().replace(/^@/, "");
  return X_HANDLE.test(h) ? h : null;
}

export function songTitleOf(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  return t || "Untitled";
}

/** `@xhandle` if stored, else `@gbkhandle`, else a display name, else null. */
export function songAuthorCredit(a: ShareAuthor, opts?: { forX?: boolean }): string | null {
  if (opts?.forX) {
    const x = storedXHandle(a.xHandle);
    if (x) return `@${x}`;
  }
  const h = (a.handle ?? "").trim().replace(/^@/, "");
  if (h) return `@${h}`;
  const d = (a.displayName ?? "").trim();
  return d || null;
}

function quotedTitle(title: string | null | undefined): string {
  return `"${songTitleOf(title).replace(/"/g, "'")}"`;
}

/** `"Title" by @handle` (or `"Title"` when the author is missing). */
export function songShareLine(s: ShareSong, opts?: { forX?: boolean }): string {
  const credit = songAuthorCredit(s, opts);
  return credit ? `${quotedTitle(s.title)} by ${credit}` : quotedTitle(s.title);
}

/** Share body: the line, then the /s/<slug> URL. */
export function songShareText(s: ShareSong & { url: string }, opts?: { forX?: boolean }): string {
  return `${songShareLine(s, opts)}\n${s.url}`;
}

/** og:title / twitter:title: `"Title" by @handle`. */
export function songOgTitle(s: ShareSong): string {
  return songShareLine(s);
}

export function xIntentUrl(text: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

/** Fields for Song / share API payloads so web and iOS use the same wording. */
export function songShareFields(s: ShareSong & { url: string }): { share_title: string; share_text: string; x_intent_url: string } {
  return { share_title: songShareLine(s), share_text: songShareText(s), x_intent_url: xIntentUrl(songShareText(s, { forX: true })) };
}
