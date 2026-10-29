// "Remix this prompt" handoff (#162): the feed card names the SONG as well as the prompt, so the Studio can
// open the song itself — the user's editable fork — in a fresh agent session, instead of dropping the prompt
// text into an empty project. sessionStorage is the shared contract: web remix() writes it, the iOS
// StudioWebView writes the same key from Swift, and the Studios consume it exactly once.
export interface RemixHandoff { slug: string; prompt: string }
export const REMIX_KEY = "gbk.composerRemix";
export const MAX_REMIX_PROMPT = 4000;

export function setRemixHandoff(h: RemixHandoff): void {
  try { sessionStorage.setItem(REMIX_KEY, JSON.stringify({ slug: h.slug, prompt: h.prompt.slice(0, MAX_REMIX_PROMPT) })); }
  catch { /* storage blocked/full: the composerDraft key still carries the prompt on its own */ }
}

/** Read + remove the pending remix handoff (exactly one consumer wins). Null when absent or malformed. */
export function takeRemixHandoff(): RemixHandoff | null {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(REMIX_KEY); if (raw) sessionStorage.removeItem(REMIX_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { slug?: unknown; prompt?: unknown };
    if (typeof j.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(j.slug)) return null;
    return { slug: j.slug, prompt: typeof j.prompt === "string" ? j.prompt.slice(0, MAX_REMIX_PROMPT) : "" };
  } catch { return null; }
}
