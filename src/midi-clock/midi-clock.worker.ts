// Web Worker: receives compact [code, timestampMs] clock events, estimates tempo/beat phase, runs the
// transport state machine and the sync-loss watchdog, and posts status snapshots back to the main thread.

import { ClockWorkerCore } from "./clock-worker-core.ts";
import { workerToMainMs } from "./clock-domain.ts";
import type { WorkerInitMessage } from "./protocol.ts";

interface WorkerGlobalCtx {
  postMessage(data: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
}

const workerGlobal: WorkerGlobalCtx = typeof self !== "undefined"
  ? (self as unknown as WorkerGlobalCtx)
  : { postMessage: () => undefined, onmessage: null, close: () => undefined };

let mainTimeOrigin = typeof performance !== "undefined" ? performance.timeOrigin : 0;

const core = new ClockWorkerCore({
  post: (status) => workerGlobal.postMessage(status),
  nowMain: () => workerToMainMs(performance.now(), performance.timeOrigin, mainTimeOrigin),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
});

workerGlobal.onmessage = ({ data }) => {
  if (data && !Array.isArray(data) && (data as WorkerInitMessage).type === "init") {
    mainTimeOrigin = (data as WorkerInitMessage).mainTimeOrigin;
  }
  core.onMessage(data);
  if (data && (data as { type?: string }).type === "dispose") workerGlobal.close();
};
