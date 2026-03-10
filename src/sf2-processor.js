import { Sf2SynthEngine } from "./sf2-renderer.js";

class Sf2Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new Sf2SynthEngine(sampleRate);
    this.scheduledEvents = [];
    this.scheduledEventIndex = 0;
    this.renderedSamples = 0;
    this.port.onmessage = (event) => this.onMsg(event.data);
  }

  onMsg(msg) {
    if (msg.type === "setOfflineTracks") {
      this.engine.setTrackStates(msg.tracks ?? []);
      this.engine.setMaxVoices(Math.max(64, msg.maxVoices ?? 64));
      return;
    }
    if (msg.type === "setSequence") {
      this.scheduledEvents = Array.isArray(msg.events) ? msg.events : [];
      this.scheduledEventIndex = 0;
      this.renderedSamples = 0;
      return;
    }
    this.engine.dispatchEvent(msg);
  }

  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const next = this.engine.renderScheduled(
      outL,
      outR,
      this.scheduledEvents,
      this.scheduledEventIndex,
      this.renderedSamples
    );
    this.scheduledEventIndex = next.eventIndex;
    this.renderedSamples = next.renderedSamples;
    return true;
  }
}

registerProcessor("sf2-processor", Sf2Processor);
