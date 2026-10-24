// Test-only: installs the Node OfflineAudioContext + AudioWorkletNode (src/audio/node-offline-env.ts) as globals so
// browser-path code (browserOfflineEnv) runs under node --test. Installed with --import.
import { NodeOfflineAudioContext, NodeAudioWorkletNode } from "../../src/audio/node-offline-env.ts";
export { NodeOfflineAudioContext as FakeOfflineAudioContext, NodeAudioWorkletNode as FakeAudioWorkletNode };
const g = globalThis as Record<string, unknown>;
g.OfflineAudioContext ??= NodeOfflineAudioContext;
g.AudioWorkletNode ??= NodeAudioWorkletNode;
g.__gbkSf2WorkletUrl ??= "test:sf2-processor";
