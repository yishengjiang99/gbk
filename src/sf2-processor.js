// sf2-processor.js
// 
// DSP computation for SF2 synthesis using WebAssembly

// ---------- WASM Integration ----------
let dspModule = null;
let dspReady = false;

// Module instance is stored globally for the worklet to use
if (typeof globalThis.dspModule !== 'undefined') {
    dspModule = globalThis.dspModule;
    dspReady = true;
}

// Validate WASM is ready
if (!dspReady || !dspModule) {
    throw new Error('WASM DSP module not initialized. Ensure initDSP() is called before loading AudioWorklet.');
}

// Utility functions using WASM
function centsToRatio(c) {
    return dspModule._centsToRatio(c ?? 0);
}

function cbAttenToLin(cb) {
    return dspModule._cbAttenToLin(cb ?? 0);
}

function velToLin(vel, curve = 2.0) {
    return dspModule._velToLin(vel, curve);
}

function fcCentsToHz(fcCents) {
    return dspModule._fcCentsToHz(fcCents ?? 13500);
}

function timecentsToSeconds(tc) {
    return dspModule._timecentsToSeconds(tc ?? 0);
}

// ---------- WASM DSP Object Creators ----------
function createVolEnv(sr) {
    const ptr = dspModule._volEnvCreate(sr);
    return {
        ptr,
        setFromSf2(params) {
            const delayTc = params.delayTc ?? -12000;
            const attackTc = params.attackTc ?? -12000;
            const holdTc = params.holdTc ?? -12000;
            const decayTc = params.decayTc ?? -12000;
            const sustainCb = params.sustainCb ?? 0;
            const releaseTc = params.releaseTc ?? 0;
            dspModule._volEnvSetFromSf2(ptr, delayTc, attackTc, holdTc, decayTc, sustainCb, releaseTc);
        },
        noteOn() {
            dspModule._volEnvNoteOn(ptr);
        },
        noteOff() {
            dspModule._volEnvNoteOff(ptr);
        },
        next() {
            return dspModule._volEnvNext(ptr);
        },
        destroy() {
            dspModule._volEnvDestroy(ptr);
        }
    };
}

function createModEnv(sr) {
    const ptr = dspModule._modEnvCreate(sr);
    return {
        ptr,
        setFromSf2(params) {
            const delayTc = params.delayTc ?? -12000;
            const attackTc = params.attackTc ?? -12000;
            const holdTc = params.holdTc ?? -12000;
            const decayTc = params.decayTc ?? -12000;
            const sustain = params.sustain ?? 0;
            const releaseTc = params.releaseTc ?? 0;
            dspModule._modEnvSetFromSf2(ptr, delayTc, attackTc, holdTc, decayTc, sustain, releaseTc);
        },
        noteOn() {
            dspModule._modEnvNoteOn(ptr);
        },
        noteOff() {
            dspModule._modEnvNoteOff(ptr);
        },
        next() {
            return dspModule._modEnvNext(ptr);
        },
        destroy() {
            dspModule._modEnvDestroy(ptr);
        }
    };
}

function createLFO(sr) {
    const ptr = dspModule._lfoCreate(sr);
    return {
        ptr,
        set(freqHz, delaySec) {
            dspModule._lfoSet(ptr, freqHz ?? 0, delaySec ?? 0);
        },
        next() {
            return dspModule._lfoNext(ptr);
        },
        destroy() {
            dspModule._lfoDestroy(ptr);
        }
    };
}

function createLPF(sr) {
    const ptr = dspModule._lpfCreate(sr);
    return {
        ptr,
        setCutoffHz(hz) {
            dspModule._lpfSetCutoffHz(ptr, hz ?? 1000);
        },
        processL(x) {
            return dspModule._lpfProcessL(ptr, x);
        },
        processR(x) {
            return dspModule._lpfProcessR(ptr, x);
        },
        destroy() {
            dspModule._lpfDestroy(ptr);
        }
    };
}

// ---------- Utility Functions ----------
function lerp(a, b, t) {
    return a + (b - a) * t;
}

function panToGains(pan) {
    // SF2 pan: -500..+500
    const p = Math.max(-500, Math.min(500, pan ?? 0)) / 500; // -1..+1
    const angle = (p + 1) * 0.25 * Math.PI; // 0..pi/2
    return { gL: Math.cos(angle), gR: Math.sin(angle) };
}

function balanceToGains(balance) {
    const p = Math.max(-1, Math.min(1, balance ?? 0));
    const angle = (p + 1) * 0.25 * Math.PI;
    return { gL: Math.cos(angle), gR: Math.sin(angle) };
}

// ---------- Pitch ----------
function regionBaseRate(region, midiNote, outSr) {
    const root = (region.overridingRootKey ?? region.originalKey ?? 60);
    const scale = (region.scaleTuning ?? 100);
    const keyTrackCents = (midiNote - root) * scale;
    const tuneCents = (region.coarseTune ?? 0) * 100 + (region.fineTune ?? 0);
    const totalCents = keyTrackCents + tuneCents;

    const srRatio = (region.sample.sampleRate ?? outSr) / outSr;
    return centsToRatio(totalCents) * srRatio;
}

// ---------- Sample read (linear interpolation) ----------
function readSampleMono(data, pos) {
    const i = pos | 0;
    const f = pos - i;
    const a = data[i] ?? 0;
    const b = data[i + 1] ?? 0;
    return a + (b - a) * f;
}

// ---------- Voice ----------
function makeVoice(region, note, velocity, outSr) {
    const sample = region.sample;
    const start = sample.start ?? 0;
    const end = sample.end ?? sample.dataL.length;
    const loopStart = sample.loopStart ?? start;
    const loopEnd = sample.loopEnd ?? end;

    const sampleModes = region.sampleModes ?? 0;
    const looping = sampleModes === 1 || sampleModes === 3;
    const loopUntilReleaseThenTail = sampleModes === 3;

    const baseRate = regionBaseRate(region, note, outSr);

    const panG = panToGains(region.pan ?? 0);
    const velGain = velToLin(velocity, 2.0);
    const attenGain = cbAttenToLin(region.initialAttenuationCb ?? 0);
    const baseGain = velGain * attenGain;

    const v = {
        note,
        velocity,
        region,

        // playback
        pos: start,
        baseRate,
        rate: baseRate,

        // loop data in frames
        start,
        end,
        loopStart,
        loopEnd,
        looping,
        loopUntilReleaseThenTail,
        inReleaseTail: false,

        // sample buffers
        dataL: sample.dataL,
        dataR: sample.dataR, // null => mono

        // gains
        baseGain,
        regionPanPos: Math.max(-500, Math.min(500, region.pan ?? 0)) / 500,
        panL: panG.gL,
        panR: panG.gR,

        // DSP - using WASM directly
        volEnv: createVolEnv(outSr),
        modEnv: createModEnv(outSr),
        modLfo: createLFO(outSr),
        vibLfo: createLFO(outSr),
        lpf: createLPF(outSr),

        exclusiveClass: region.exclusiveClass ?? 0,
        finished: false,
    };

    v.volEnv.setFromSf2(region.volEnv ?? {});
    v.modEnv.setFromSf2(region.modEnv ?? {});

    const modLfoHz = centsToRatio(region.modLfoFreqCents ?? 0); // starter mapping
    const vibLfoHz = centsToRatio(region.vibLfoFreqCents ?? 0);
    v.modLfo.set(modLfoHz, timecentsToSeconds(region.modLfoDelayTc ?? -12000));
    v.vibLfo.set(vibLfoHz, timecentsToSeconds(region.vibLfoDelayTc ?? -12000));

    // initial filter cutoff
    v.lpf.setCutoffHz(fcCentsToHz(region.initialFilterFcCents ?? 13500));

    v.volEnv.noteOn();
    v.modEnv.noteOn();
    return v;
}

// ---------- Processor ----------
class Sf2Processor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.regions = []; // current preset regions
        this.voices = [];
        this.maxVoices = 64;
        this.cc7Volume = 100;
        this.cc10Pan = 64;
        this.cc11Expression = 127;

        this.port.onmessage = (e) => this.onMsg(e.data);
    }

    onMsg(msg) {
        if (msg.type === "setPreset") {
            this.regions = msg.regions ?? [];
            // Optional: clear current voices
            this.voices.length = 0;
        }

        if (msg.type === "noteOn") {
            const note = msg.note | 0;
            const velocity = msg.velocity | 0;

            const matching = this.pickRegions(note, velocity);
            if (!matching.length) return;

            // exclusiveClass choke
            for (const r of matching) {
                const excl = r.exclusiveClass ?? 0;
                if (excl) this.chokeExclusive(excl);
            }

            // allocate voices (layering allowed)
            for (const r of matching) {
                this.ensurePolyphony();
                this.voices.push(makeVoice(r, note, velocity, sampleRate));
            }
        }

        if (msg.type === "noteOff") {
            const note = msg.note | 0;
            for (const v of this.voices) {
                if (v.note === note) {
                    v.volEnv.noteOff();
                    v.modEnv.noteOff();

                    // if sampleModes == 3: stop looping on release, play tail to end
                    if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
                }
            }
        }

        if (msg.type === "allNotesOff") {
            for (const v of this.voices) {
                v.volEnv.noteOff();
                v.modEnv.noteOff();
                if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
            }
        }

        if (msg.type === "setControllers") {
            if (Number.isFinite(msg.cc7Volume)) {
                this.cc7Volume = Math.max(0, Math.min(127, msg.cc7Volume | 0));
            }
            if (Number.isFinite(msg.cc10Pan)) {
                this.cc10Pan = Math.max(0, Math.min(127, msg.cc10Pan | 0));
            }
            if (Number.isFinite(msg.cc11Expression)) {
                this.cc11Expression = Math.max(0, Math.min(127, msg.cc11Expression | 0));
            }
        }
    }

    pickRegions(note, velocity) {
        const out = [];
        for (const r of this.regions) {
            const [kl, kh] = r.keyRange ?? [0, 127];
            const [vl, vh] = r.velRange ?? [0, 127];
            if (note >= kl && note <= kh && velocity >= vl && velocity <= vh) out.push(r);
        }
        return out;
    }

    chokeExclusive(excl) {
        for (const v of this.voices) {
            if (v.exclusiveClass === excl) {
                v.volEnv.noteOff();
                v.modEnv.noteOff();
                if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
            }
        }
    }

    ensurePolyphony() {
        if (this.voices.length < this.maxVoices) return;

        // steal quietest (or oldest). Here: quietest by current vol env
        let minIdx = 0;
        let minVal = Infinity;
        for (let i = 0; i < this.voices.length; i++) {
            const v = this.voices[i];
            const loud = v.volEnv.level * v.baseGain;
            if (loud < minVal) { minVal = loud; minIdx = i; }
        }
        this.voices.splice(minIdx, 1);
    }

    advancePos(v) {
        v.pos += v.rate;

        // If we are in "release tail" mode, disable looping
        const effectiveLooping = v.looping && !v.inReleaseTail;

        if (effectiveLooping) {
            if (v.pos >= v.loopEnd) {
                const loopLen = v.loopEnd - v.loopStart;
                if (loopLen > 1) {
                    v.pos = v.loopStart + (v.pos - v.loopStart) % loopLen;
                } else {
                    v.pos = v.loopStart;
                }
            }
        } else {
            if (v.pos >= v.end) v.finished = true;
        }
    }

    process(inputs, outputs) {
        const outL = outputs[0][0];
        const outR = outputs[0][1];
        outL.fill(0);
        outR.fill(0);

        const volumeMul = (this.cc7Volume / 127) * (this.cc11Expression / 127);
        const ccPanPos = (this.cc10Pan - 64) / 63;

        for (let i = 0; i < outL.length; i++) {
            let sumL = 0;
            let sumR = 0;

            for (let vi = this.voices.length - 1; vi >= 0; vi--) {
                const v = this.voices[vi];
                if (v.finished || v.volEnv.stage === "idle") {
                    this.voices.splice(vi, 1);
                    continue;
                }

                // --- Mod sources ---
                const modEnv = v.modEnv.next(); // 0..1
                const modLfo = v.modLfo.next(); // -1..1
                const vibLfo = v.vibLfo.next(); // -1..1

                // --- Pitch modulation (cents) ---
                const r = v.region;
                const pitchCents =
                    vibLfo * (r.vibLfoToPitchCents ?? 0) +
                    modLfo * (r.modLfoToPitchCents ?? 0);

                v.rate = v.baseRate * centsToRatio(pitchCents);

                // --- Read sample (stereo if provided; else mono) ---
                const sL = readSampleMono(v.dataL, v.pos);
                const sR = v.dataR ? readSampleMono(v.dataR, v.pos) : sL;

                // --- Filter cutoff modulation ---
                const fcCents =
                    (r.initialFilterFcCents ?? 13500) +
                    modEnv * (r.modEnvToFilterFcCents ?? 0) +
                    modLfo * (r.modLfoToFilterFcCents ?? 0);

                v.lpf.setCutoffHz(fcCentsToHz(fcCents));

                const fL = v.lpf.processL(sL);
                const fR = v.lpf.processR(sR);

                // --- Volume envelope & gain ---
                const env = v.volEnv.next();
                const g = v.baseGain * env * volumeMul;
                const mixPan = Math.max(-1, Math.min(1, v.regionPanPos + ccPanPos));
                const panG = balanceToGains(mixPan);

                sumL += fL * g * panG.gL;
                sumR += fR * g * panG.gR;

                // --- Advance position (looping/tail) ---
                this.advancePos(v);
            }

            outL[i] = sumL;
            outR[i] = sumR;
        }

        return true;
    }
}

registerProcessor("sf2-processor", Sf2Processor);
