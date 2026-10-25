// Worker entry for the nightly ranker training (ranker.ts trainInWorker): own DatabaseSync on the shares file.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { Ranker } from "./ranker.ts";

const { file, now } = workerData as { file: string; now?: number };
try {
  const db = new DatabaseSync(file); db.exec("PRAGMA busy_timeout = 5000");
  const r = new Ranker(db, now ? () => now : Date.now).train(); db.close();
  parentPort!.postMessage({ ok: true, result: r });
} catch (e) { parentPort!.postMessage({ ok: false, error: (e as Error).message }); }
