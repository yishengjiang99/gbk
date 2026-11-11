import { songShareLine, songShareText, xIntentUrl, type ShareSong } from "../../agent/share-text.ts";
import { markAction } from "./impressions.ts";

export type ShareTarget = ShareSong & { url: string; slug?: string | null; share_text?: string | null; share_title?: string | null; x_intent_url?: string | null };

export function sharePayload(s: ShareTarget): { line: string; text: string; x: string; url: string } {
  const line = s.share_title || songShareLine(s);
  const text = s.share_text || songShareText(s);
  const x = s.x_intent_url || xIntentUrl(songShareText(s, { forX: true }));
  return { line, text, x, url: s.url };
}

export function webShare(s: ShareTarget) {
  const { line, url, text } = sharePayload(s);
  if (s.slug) markAction(s.slug, "share");
  const n = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (n.share) void n.share({ title: line, text: line, url }).catch(() => undefined);
  else void navigator.clipboard?.writeText(text);
}

export function copyShare(s: ShareTarget) {
  if (s.slug) markAction(s.slug, "share");
  void navigator.clipboard?.writeText(sharePayload(s).text);
}
