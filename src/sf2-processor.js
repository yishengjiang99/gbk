// sf2-processor.js

// ---------- Utility ----------
function timecentsToSeconds(tc) {
    // seconds = 2^(tc/1200)
    return Math.pow(2, (tc ?? 0) / 1200);
}
function centsToRatio(c) {
    return Math.pow(2, (c ?? 0) / 1200);
}
function cbAttenToLin(cb) {
    // cb attenuation -> dB = -cb/10 -> linear gain
    const db = -(cb ?? 0) / 10;
    return Math.pow(10, db / 20);
}
function velToLin(vel, curve = 2.0) {
    const x = Math.max(0, Math.min(127, vel)) / 127;
    return Math.pow(x, curve);
}
function panToGains(pan) {
    // SF2 pan: -500..+500
    const p = Math.max(-500, Math.min(500, pan ?? 0)) / 500; // -1..+1
    const angle = (p + 1) * 0.25 * Math.PI; // 0..pi/2
    return { gL: Math.cos(angle), gR: Math.sin(angle) };
}
function fcCentsToHz(fcCents) {
    // common SF2-ish mapping: 8.176 * 2^(cents/1200)
    return 8.176 * Math.pow(2, (fcCents ?? 13500) / 1200);
}
function lerp(a, b, t) { return a + (b - a) * t; }

const MIN_VOL_RELEASE_SEC = 0.06;
const MIN_MOD_RELEASE_SEC = 0.02;

// ---------- Envelopes ----------
class VolEnv {
    constructor(sr) {
        this.sr = sr;
        this.stage = "idle";
        this.level = 0;
        this.t = 0;
        this.peak = 1.0;

        this.delay = 0;
        this.attack = 0.01;
        this.hold = 0;
        this.decay = 0.1;
        this.sustain = 0.5; // linear
        this.release = 0.2;

        this.releaseStart = 0;
    }

    setFromSf2({ delayTc, attackTc, holdTc, decayTc, sustainCb, releaseTc }) {
        this.delay = Math.max(0, timecentsToSeconds(delayTc ?? -12000));
        this.attack = Math.max(0, timecentsToSeconds(attackTc ?? -12000));
        this.hold = Math.max(0, timecentsToSeconds(holdTc ?? -12000));
        this.decay = Math.max(0, timecentsToSeconds(decayTc ?? -12000));
        const rel = timecentsToSeconds(releaseTc ?? 0);
        this.release = Math.max(MIN_VOL_RELEASE_SEC, rel);

        // sustainVolEnv is attenuation in centibels; 0 => 1.0
        const sustainDb = -(sustainCb ?? 0) / 10;
        this.sustain = Math.min(1, Math.max(0, Math.pow(10, sustainDb / 20)));
    }

    noteOn() {
        this.stage = this.delay > 0 ? "delay" : "attack";
        this.t = 0;
        this.level = 0;
    }

    noteOff() {
        if (this.stage === "idle") return;
        this.stage = "release";
        this.t = 0;
        this.releaseStart = this.level;
    }

    next() {
        const dt = 1 / this.sr;
        const eps = 1e-5;

        switch (this.stage) {
            case "idle":
                this.level = 0;
                return 0;

            case "delay":
                this.t += dt;
                if (this.t >= this.delay) { this.stage = "attack"; this.t = 0; }
                this.level = 0;
                return 0;

            case "attack": {
                if (this.attack <= 0) {
                    this.level = this.peak;
                    this.stage = this.hold > 0 ? "hold" : "decay";
                    this.t = 0;
                    return this.level;
                }
                this.t += dt;
                const x = Math.min(1, this.t / this.attack);
                // smooth-ish rise
                const shaped = 1 - Math.exp(-x * 6);
                this.level = this.peak * shaped;

                if (x >= 1) {
                    this.level = this.peak;
                    this.stage = this.hold > 0 ? "hold" : "decay";
                    this.t = 0;
                }
                return this.level;
            }

            case "hold":
                this.t += dt;
                this.level = this.peak;
                if (this.t >= this.hold) { this.stage = "decay"; this.t = 0; }
                return this.level;

            case "decay": {
                if (this.decay <= 0) {
                    this.level = this.sustain;
                    this.stage = "sustain";
                    this.t = 0;
                    return this.level;
                }
                this.t += dt;
                const x = Math.min(1, this.t / this.decay);

                // exp ramp: peak -> sustain
                const start = Math.max(eps, this.peak);
                const end = Math.max(eps, this.sustain);
                const y = Math.exp(Math.log(start) + (Math.log(end) - Math.log(start)) * x);
                this.level = y;

                if (x >= 1) {
                    this.level = this.sustain;
                    this.stage = "sustain";
                    this.t = 0;
                }
                return this.level;
            }

            case "sustain":
                this.level = this.sustain;
                return this.level;

            case "release": {
                if (this.release <= 0) {
                    this.level = 0;
                    this.stage = "idle";
                    return 0;
                }
                this.t += dt;
                const x = Math.min(1, this.t / this.release);
                const start = Math.max(eps, this.releaseStart);
                const end = eps;
                const y = Math.exp(Math.log(start) + (Math.log(end) - Math.log(start)) * x);
                this.level = y;

                if (x >= 1) {
                    this.level = 0;
                    this.stage = "idle";
                }
                return this.level;
            }
        }
    }
}

class ModEnv {
    constructor(sr) {
        this.sr = sr;
        this.stage = "idle";
        this.level = 0;
        this.t = 0;

        this.delay = 0;
        this.attack = 0.01;
        this.hold = 0;
        this.decay = 0.1;
        this.sustain = 0; // 0..1
        this.release = 0.2;

        this.releaseStart = 0;
    }

    setFromSf2({ delayTc, attackTc, holdTc, decayTc, sustain, releaseTc }) {
        this.delay = Math.max(0, timecentsToSeconds(delayTc ?? -12000));
        this.attack = Math.max(0, timecentsToSeconds(attackTc ?? -12000));
        this.hold = Math.max(0, timecentsToSeconds(holdTc ?? -12000));
        this.decay = Math.max(0, timecentsToSeconds(decayTc ?? -12000));
        const rel = timecentsToSeconds(releaseTc ?? 0);
        this.release = Math.max(MIN_MOD_RELEASE_SEC, rel);
        this.sustain = Math.min(1, Math.max(0, sustain ?? 0));
    }

    noteOn() {
        this.stage = this.delay > 0 ? "delay" : "attack";
        this.t = 0;
        this.level = 0;
    }

    noteOff() {
        if (this.stage === "idle") return;
        this.stage = "release";
        this.t = 0;
        this.releaseStart = this.level;
    }

    next() {
        const dt = 1 / this.sr;

        switch (this.stage) {
            case "idle":
                this.level = 0;
                return 0;

            case "delay":
                this.t += dt;
                if (this.t >= this.delay) { this.stage = "attack"; this.t = 0; }
                this.level = 0;
                return 0;

            case "attack": {
                if (this.attack <= 0) {
                    this.level = 1;
                    this.stage = this.hold > 0 ? "hold" : "decay";
                    this.t = 0;
                    return this.level;
                }
                this.t += dt;
                const x = Math.min(1, this.t / this.attack);
                this.level = x; // linear is fine for mod env
                if (x >= 1) { this.level = 1; this.stage = this.hold > 0 ? "hold" : "decay"; this.t = 0; }
                return this.level;
            }

            case "hold":
                this.t += dt;
                this.level = 1;
                if (this.t >= this.hold) { this.stage = "decay"; this.t = 0; }
                return this.level;

            case "decay": {
                if (this.decay <= 0) {
                    this.level = this.sustain;
                    this.stage = "sustain";
                    this.t = 0;
                    return this.level;
                }
                this.t += dt;
                const x = Math.min(1, this.t / this.decay);
                this.level = lerp(1, this.sustain, x);
                if (x >= 1) { this.level = this.sustain; this.stage = "sustain"; this.t = 0; }
                return this.level;
            }

            case "sustain":
                this.level = this.sustain;
                return this.level;

            case "release": {
                if (this.release <= 0) {
                    this.level = 0;
                    this.stage = "idle";
                    return 0;
                }
                this.t += dt;
                const x = Math.min(1, this.t / this.release);
                this.level = lerp(this.releaseStart, 0, x);
                if (x >= 1) { this.level = 0; this.stage = "idle"; }
                return this.level;
            }
        }
    }
}

// ---------- LFO ----------
class LFO {
    constructor(sr) {
        this.sr = sr;
        this.phase = 0;
        this.freqHz = 5;
        this.delayLeft = 0;
    }
    set(freqHz, delaySec) {
        this.freqHz = Math.max(0, freqHz ?? 0);
        this.delayLeft = Math.max(0, delaySec ?? 0);
    }
    next() {
        if (this.delayLeft > 0) {
            this.delayLeft -= 1 / this.sr;
            return 0;
        }
        this.phase += 2 * Math.PI * this.freqHz / this.sr;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
        return Math.sin(this.phase);
    }
}

// ---------- Filter (2-pole LPF using biquad) ----------
class TwoPoleLPF {
    constructor(sr) {
        this.sr = sr;
        // State variables for left channel
        this.z1L = 0;
        this.z2L = 0;
        // State variables for right channel
        this.z1R = 0;
        this.z2R = 0;
        // Biquad coefficients
        this.b0 = 1;
        this.b1 = 0;
        this.b2 = 0;
        this.a1 = 0;
        this.a2 = 0;
    }
    setCutoffHz(hz) {
        const clamped = Math.max(5, Math.min(hz ?? 1000, this.sr * 0.45));
        // Q factor for smooth response (typical value for music synthesis)
        const Q = 0.7071; // Butterworth response (maximally flat)
        
        // Calculate biquad coefficients for low-pass filter
        const w0 = 2 * Math.PI * clamped / this.sr;
        const cosw0 = Math.cos(w0);
        const sinw0 = Math.sin(w0);
        const alpha = sinw0 / (2 * Q);
        
        const a0 = 1 + alpha;
        this.b0 = ((1 - cosw0) / 2) / a0;
        this.b1 = (1 - cosw0) / a0;
        this.b2 = ((1 - cosw0) / 2) / a0;
        this.a1 = (-2 * cosw0) / a0;
        this.a2 = (1 - alpha) / a0;
    }
    processL(x) {
        // Direct Form II Transposed biquad
        const y = this.b0 * x + this.z1L;
        this.z1L = this.b1 * x - this.a1 * y + this.z2L;
        this.z2L = this.b2 * x - this.a2 * y;
        return y;
    }
    processR(x) {
        // Direct Form II Transposed biquad
        const y = this.b0 * x + this.z1R;
        this.z1R = this.b1 * x - this.a1 * y + this.z2R;
        this.z2R = this.b2 * x - this.a2 * y;
        return y;
    }
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
        panL: panG.gL,
        panR: panG.gR,

        // mod
        volEnv: new VolEnv(outSr),
        modEnv: new ModEnv(outSr),
        modLfo: new LFO(outSr),
        vibLfo: new LFO(outSr),
        lpf: new TwoPoleLPF(outSr),

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
                const g = v.baseGain * env;

                sumL += fL * g * v.panL;
                sumR += fR * g * v.panR;

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
