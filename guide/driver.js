// main.js
const ctx = new AudioContext();
await ctx.audioWorklet.addModule("sf2-processor.js");

const node = new AudioWorkletNode(ctx, "sf2-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2], // stereo out
});
node.connect(ctx.destination);

/**
 * You must build "regions" on the main thread from your SF2 parser.
 * Each region already has merged preset+instrument generators and resolved sample data.
 *
 * For demo purposes, this is the expected region shape:
 */
function exampleRegionFromYourSf2(sampleL, sampleR, sampleRate) {
    return {
        // ranges
        keyRange: [0, 127],
        velRange: [0, 127],

        // sample
        sample: {
            dataL: sampleL,           // Float32Array
            dataR: sampleR ?? null,   // Float32Array or null -> mono
            sampleRate,               // Hz
            start: 0,
            end: sampleL.length,
            loopStart: Math.floor(sampleL.length * 0.1),
            loopEnd: Math.floor(sampleL.length * 0.9),
        },
        sampleModes: 1, // 0=no loop, 1=loop continuous, 3=loop until release then tail (optional)

        // pitch
        originalKey: 60,
        overridingRootKey: null,
        coarseTune: 0,
        fineTune: 0,
        scaleTuning: 100,

        // amp
        initialAttenuationCb: 0, // 0.. (centibels attenuation)

        // pan
        pan: 0, // -500..+500

        // envelopes
        volEnv: {
            delayTc: -12000,
            attackTc: -12000,
            holdTc: -12000,
            decayTc: 0,
            sustainCb: 200,     // 20 dB attenuation at sustain
            releaseTc: 0,
        },
        modEnv: {
            delayTc: -12000,
            attackTc: -12000,
            holdTc: -12000,
            decayTc: 0,
            sustain: 0.0,       // 0..1
            releaseTc: 0,
        },

        // filter + modulation depths
        initialFilterFcCents: 13500,
        modEnvToFilterFcCents: 0,
        modLfoToFilterFcCents: 0,
        initialFilterQCb: 0, // ignored by 1-pole, kept for future

        // LFOs
        modLfoDelayTc: -12000,
        modLfoFreqCents: 2400,      // starter mapping
        modLfoToPitchCents: 0,

        vibLfoDelayTc: -12000,
        vibLfoFreqCents: 2400,
        vibLfoToPitchCents: 0,

        // voice mgmt
        exclusiveClass: 0,
    };
}

/**
 * Load your SF2, parse it, decode sample data to Float32Array(s),
 * build an array of regions for a given preset.
 *
 * Then call:
 */
function setPresetRegions(regions) {
    // Transfer buffers (fast) if not using SharedArrayBuffer
    const transfers = [];
    for (const r of regions) {
        transfers.push(r.sample.dataL.buffer);
        if (r.sample.dataR) transfers.push(r.sample.dataR.buffer);
    }
    node.port.postMessage({ type: "setPreset", regions }, transfers);
}

// NOTE ON / OFF
function noteOn(note, velocity) {
    node.port.postMessage({ type: "noteOn", note, velocity });
}
function noteOff(note) {
    node.port.postMessage({ type: "noteOff", note });
}

await ctx.resume();

// --- DEMO HOOKS (replace with your SF2 regions) ---
// Suppose you already have sampleL Float32Array (and optional sampleR) from SF2
// const regions = [exampleRegionFromYourSf2(sampleL, sampleR, 44100)];
// setPresetRegions(regions);

// Quick test trigger after you set regions:
window.sf2NoteOn = noteOn;
window.sf2NoteOff = noteOff;