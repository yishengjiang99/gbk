// Persist hook_start_ms on a share. Computed from project_json (score) or the MIDI blob.
import type { DatabaseSync } from "node:sqlite";
import { hookStartMsFromShare } from "../../../src/social/hook-start.ts";

export function writeShareHook(db: DatabaseSync, id: string) {
  const r = db.prepare("SELECT project_json, midi FROM shares WHERE id = ?").get(id) as { project_json: string; midi: Uint8Array | null } | undefined;
  if (!r) return;
  db.prepare("UPDATE shares SET hook_start_ms = ? WHERE id = ?").run(hookStartMsFromShare(r.project_json, r.midi), id);
}

/** One-time, idempotent: only fills public rows whose hook is still null. Safe to run on every startup. */
export function backfillShareHooks(db: DatabaseSync) {
  const rows = db.prepare("SELECT id FROM shares WHERE hook_start_ms IS NULL AND public = 1").all() as { id: string }[];
  if (!rows.length) return;
  db.exec("BEGIN");
  try { for (const r of rows) writeShareHook(db, r.id); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
