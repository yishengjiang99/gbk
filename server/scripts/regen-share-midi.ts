// #189 backfill: give every share with no playable media (no midi/mp3/wav) a MIDI derived from its stored project_json.
// Dry run by default (opens the DB read-only and writes nothing). Pass --apply to write.
//   node regen-share-midi.mjs [--db /var/lib/gbk-composer/shares.sqlite] [--public-only] [--apply]
import { DatabaseSync } from "node:sqlite";
import { deriveMidi } from "../src/persistence/share-media.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply"), publicOnly = args.includes("--public-only");
const dbi = args.indexOf("--db");
const file = dbi >= 0 ? args[dbi + 1] : `${process.env.COMPOSER_DATA_DIR ?? "/var/lib/gbk-composer"}/shares.sqlite`;
const db = new DatabaseSync(file, { readOnly: !apply });
const rows = db.prepare(`SELECT s.id, s.slug, s.owner, s.public, s.created_at, s.project_json, p.handle FROM shares s LEFT JOIN profiles p ON p.user_id = s.owner
  WHERE midi IS NULL AND mp3 IS NULL AND wav IS NULL ${publicOnly ? "AND s.public = 1" : ""} ORDER BY s.public DESC, s.created_at`).all() as
  { id: string; slug: string; owner: string; public: number; created_at: number; project_json: string; handle: string | null }[];
const put = apply ? db.prepare("UPDATE shares SET midi = ? WHERE id = ? AND midi IS NULL AND mp3 IS NULL AND wav IS NULL") : null;
let ok = 0, skip = 0;
console.log(`${apply ? "APPLY" : "DRY RUN"} ${file}: ${rows.length} share(s) without playable media`);
for (const r of rows) {
  const midi = deriveMidi(r.project_json);
  const who = r.handle ? `@${r.handle}` : r.owner.slice(0, 14);
  const line = `${r.public ? "public " : "private"} ${new Date(r.created_at).toISOString().slice(0, 16)}Z ${who.padEnd(16)} ${r.slug}`;
  if (!midi) { skip++; console.log(`SKIP  ${line}  (no notes / invalid project)`); continue; }
  ok++; console.log(`${apply ? "WROTE" : "WOULD"} ${line}  midi=${midi.length}B`);
  put?.run(midi, r.id);
}
console.log(`${apply ? "wrote" : "would write"} ${ok}, skipped ${skip}`);
db.close();
