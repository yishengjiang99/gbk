// Web Worker entry for the parallel offline renderer (see track-render-worker-core.ts).
import { runTrackRenderWorker, type WorkerScope } from "./track-render-worker-core.ts";

runTrackRenderWorker(self as unknown as WorkerScope);
