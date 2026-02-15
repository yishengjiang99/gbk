/**
 * Minimal SoundFont2 (.sf2) parser for a Uint8Array.
 *
 * Parses RIFF "sfbk" and extracts:
 *  - INFO: key/value strings
 *  - sdta: "smpl" (16-bit PCM), optional "sm24" (low 8 bits)
 *  - pdta: all required tables (phdr/pbag/pmod/pgen/inst/ibag/imod/igen/shdr)
 *
 * Then provides helpers to:
 *  - getPreset(presetIndex)
 *  - buildRegionsForPreset(presetIndex, options) -> regions suitable for AudioWorklet
 *
 * Notes:
 *  - SF2 generators are in SoundFont "generator operators". We parse raw gen records.
 *  - We implement the common region builder for: key/vel ranges, tuning, attenuation,
 *    pan, sample modes, loop points, vol EG, mod EG, basic filter/LFO params.
 *  - Modulators (pmod/imod) are parsed but not applied (SF2 mod routing is bigger).
 */

export function parseSF2(u8) {
    const r = new Reader(u8);

    // --- RIFF header ---
    const riff = r.readFourCC();
    if (riff !== "RIFF") throw new Error("Not RIFF");
    const riffSize = r.readU32LE();
    const form = r.readFourCC();
    if (form !== "sfbk") throw new Error("Not sfbk (SoundFont2)");

    const sf2 = {
        info: {},
        sdta: { smpl: null, sm24: null },
        pdta: {
            phdr: [],
            pbag: [],
            pmod: [],
            pgen: [],
            inst: [],
            ibag: [],
            imod: [],
            igen: [],
            shdr: [],
        },
        raw: { riffSize },
    };

    // RIFF chunks
    while (!r.eof()) {
        const id = r.readFourCC();
        const size = r.readU32LE();
        const chunkStart = r.pos;

        if (id === "LIST") {
            const listType = r.readFourCC();
            const listEnd = chunkStart + size;
            if (listType === "INFO") parseINFO(r, sf2.info, listEnd);
            else if (listType === "sdta") parseSDTA(r, sf2.sdta, listEnd);
            else if (listType === "pdta") parsePDTA(r, sf2.pdta, listEnd);
            else r.pos = listEnd;
            r.pos = align2(r.pos);
        } else {
            // Unknown top-level chunk
            r.pos = chunkStart + size;
            r.pos = align2(r.pos);
        }
    }

    validatePDTA(sf2.pdta);

    // Public helpers attached
    sf2.getPreset = (presetIndex) => getPreset(sf2.pdta, presetIndex);
    sf2.buildRegionsForPreset = (presetIndex, options = {}) =>
        buildRegionsForPreset(sf2, presetIndex, options);

    return sf2;
}

// ============================================================
// Reader
// ============================================================

class Reader {
    constructor(u8) {
        this.u8 = u8;
        this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        this.pos = 0;
    }
    eof() { return this.pos >= this.u8.length; }
    seek(p) { this.pos = p; }
    skip(n) { this.pos += n; }
    readU8() { return this.u8[this.pos++]; }
    readI16LE() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
    readU16LE() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
    readU32LE() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
    readI32LE() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
    readFourCC() {
        const a = String.fromCharCode(
            this.u8[this.pos], this.u8[this.pos + 1], this.u8[this.pos + 2], this.u8[this.pos + 3]
        );
        this.pos += 4;
        return a;
    }
    readBytes(n) {
        const out = this.u8.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
    readZStr(maxBytes) {
        const start = this.pos;
        const end = start + maxBytes;
        let i = start;
        while (i < end && this.u8[i] !== 0) i++;
        const s = new TextDecoder("ascii").decode(this.u8.subarray(start, i));
        this.pos = end;
        return s;
    }
}

function align2(pos) { return (pos + 1) & ~1; }

// ============================================================
// INFO
// ============================================================

function parseINFO(r, infoOut, endPos) {
    while (r.pos < endPos) {
        const id = r.readFourCC();
        const size = r.readU32LE();
        const start = r.pos;
        // INFO subchunks are usually ASCII strings
        const bytes = r.readBytes(size);
        const str = new TextDecoder("ascii").decode(bytes).replace(/\0+$/, "");
        infoOut[id] = str;
        r.pos = start + size;
        r.pos = align2(r.pos);
    }
}

// ============================================================
// sdta
// ============================================================

function parseSDTA(r, sdtaOut, endPos) {
    while (r.pos < endPos) {
        const id = r.readFourCC();
        const size = r.readU32LE();
        const start = r.pos;

        if (id === "smpl") {
            // 16-bit little-endian signed PCM interleaved mono stream for all samples concatenated
            // store as Int16Array view (no copy)
            const byteOffset = r.u8.byteOffset + r.pos;
            const i16 = new Int16Array(r.u8.buffer, byteOffset, size / 2);
            sdtaOut.smpl = i16;
            r.pos += size;
        } else if (id === "sm24") {
            // optional additional 8 bits for 24-bit samples (low byte)
            const sm24 = r.readBytes(size);
            sdtaOut.sm24 = sm24;
        } else {
            r.pos = start + size;
        }

        r.pos = align2(r.pos);
    }
}

// ============================================================
// pdta tables
// ============================================================

function parsePDTA(r, pdta, endPos) {
    while (r.pos < endPos) {
        const id = r.readFourCC();
        const size = r.readU32LE();
        const start = r.pos;

        switch (id) {
            case "phdr": pdta.phdr = readPhdr(r, size); break;
            case "pbag": pdta.pbag = readBag(r, size); break;
            case "pmod": pdta.pmod = readMod(r, size); break;
            case "pgen": pdta.pgen = readGen(r, size); break;
            case "inst": pdta.inst = readInst(r, size); break;
            case "ibag": pdta.ibag = readBag(r, size); break;
            case "imod": pdta.imod = readMod(r, size); break;
            case "igen": pdta.igen = readGen(r, size); break;
            case "shdr": pdta.shdr = readShdr(r, size); break;
            default:
                r.pos = start + size;
        }

        r.pos = align2(r.pos);
    }
}

// phdr record: 38 bytes
// char[20] presetName
// WORD preset, WORD bank
// WORD presetBagNdx
// DWORD library, genre, morphology
function readPhdr(r, size) {
    const recSize = 38;
    const n = size / recSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const presetName = r.readZStr(20);
        const preset = r.readU16LE();
        const bank = r.readU16LE();
        const presetBagNdx = r.readU16LE();
        const library = r.readU32LE();
        const genre = r.readU32LE();
        const morphology = r.readU32LE();
        out.push({ presetName, preset, bank, presetBagNdx, library, genre, morphology });
    }
    return out;
}

// inst record: 22 bytes
// char[20] instName
// WORD instBagNdx
function readInst(r, size) {
    const recSize = 22;
    const n = size / recSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const instName = r.readZStr(20);
        const instBagNdx = r.readU16LE();
        out.push({ instName, instBagNdx });
    }
    return out;
}

// bag record: 4 bytes
// WORD genNdx, WORD modNdx
function readBag(r, size) {
    const recSize = 4;
    const n = size / recSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const genNdx = r.readU16LE();
        const modNdx = r.readU16LE();
        out.push({ genNdx, modNdx });
    }
    return out;
}

// gen record: 4 bytes
// WORD oper, SHORT amount (raw)
function readGen(r, size) {
    const recSize = 4;
    const n = size / recSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const oper = r.readU16LE();
        const amount = r.readI16LE();
        out.push({ oper, amount });
    }
    return out;
}

// mod record: 10 bytes
// WORD srcOper, WORD destOper, SHORT amount, WORD amtSrcOper, WORD transOper
function readMod(r, size) {
    const recSize = 10;
    const n = size / recSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const srcOper = r.readU16LE();
        const destOper = r.readU16LE();
        const amount = r.readI16LE();
        const amtSrcOper = r.readU16LE();
        const transOper = r.readU16LE();
        out.push({ srcOper, destOper, amount, amtSrcOper, transOper });
    }
    return out;
}

// shdr record: 46 bytes
// char[20] sampleName
// DWORD start, end, startLoop, endLoop
// DWORD sampleRate
// BYTE originalPitch, CHAR pitchCorrection
// WORD sampleLink, WORD sampleType
function readShdr(r, size) {
    const recSize = 46;
    const n = size / recSize;
    const out = [];
    for (let i = 0; i < n; i++) {
        const sampleName = r.readZStr(20);
        const start = r.readU32LE();
        const end = r.readU32LE();
        const startLoop = r.readU32LE();
        const endLoop = r.readU32LE();
        const sampleRate = r.readU32LE();
        const originalPitch = r.readU8();
        const pitchCorrection = (new Int8Array([r.readU8()]))[0]; // signed
        const sampleLink = r.readU16LE();
        const sampleType = r.readU16LE();
        out.push({
            sampleName, start, end, startLoop, endLoop, sampleRate,
            originalPitch, pitchCorrection, sampleLink, sampleType
        });
    }
    return out;
}

function validatePDTA(pdta) {
    const required = ["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"];
    for (const k of required) {
        if (!pdta[k] || !pdta[k].length) throw new Error(`Missing pdta table: ${k}`);
    }
    // Last record in phdr/inst/shdr is terminal ("EOP", "EOI", "EOS") per spec.
    // We don't hard-require names, but indexes rely on terminal records existing.
}

// ============================================================
// Generator op codes (subset we care about)
// (per SF2 spec: sfGenOper enum)
// ============================================================

const Gen = {
    startAddrsOffset: 0,
    endAddrsOffset: 1,
    startloopAddrsOffset: 2,
    endloopAddrsOffset: 3,
    startAddrsCoarseOffset: 4,
    modLfoToPitch: 5,
    vibLfoToPitch: 6,
    modEnvToPitch: 7,
    initialFilterFc: 8,
    initialFilterQ: 9,
    modLfoToFilterFc: 10,
    modEnvToFilterFc: 11,
    endAddrsCoarseOffset: 12,
    modLfoToVolume: 13,
    chorusEffectsSend: 15,
    reverbEffectsSend: 16,
    pan: 17,
    delayModLFO: 21,
    freqModLFO: 22,
    delayVibLFO: 23,
    freqVibLFO: 24,
    delayModEnv: 25,
    attackModEnv: 26,
    holdModEnv: 27,
    decayModEnv: 28,
    sustainModEnv: 29,
    releaseModEnv: 30,
    keynumToModEnvHold: 31,
    keynumToModEnvDecay: 32,
    delayVolEnv: 33,
    attackVolEnv: 34,
    holdVolEnv: 35,
    decayVolEnv: 36,
    sustainVolEnv: 37,
    releaseVolEnv: 38,
    keynumToVolEnvHold: 39,
    keynumToVolEnvDecay: 40,
    instrument: 41,
    keyRange: 43,
    velRange: 44,
    startloopAddrsCoarseOffset: 45,
    keynum: 46,
    velocity: 47,
    initialAttenuation: 48,
    endloopAddrsCoarseOffset: 50,
    coarseTune: 51,
    fineTune: 52,
    sampleID: 53,
    sampleModes: 54,
    scaleTuning: 56,
    exclusiveClass: 57,
    overridingRootKey: 58,
};

// KeyRange / VelRange are packed in amount (low byte = lo, high byte = hi)
function unpackRange(i16) {
    const u = i16 & 0xFFFF;
    const lo = u & 0xFF;
    const hi = (u >> 8) & 0xFF;
    return [lo, hi];
}

// ============================================================
// Preset access + region building
// ============================================================

function getPreset(pdta, presetIndex) {
    // Exclude terminal EOP record (last)
    const phdr = pdta.phdr;
    const last = phdr.length - 1;
    if (presetIndex < 0 || presetIndex >= last) throw new Error("presetIndex out of range");
    const p = phdr[presetIndex];
    const pNext = phdr[presetIndex + 1];
    return { ...p, _bagStart: p.presetBagNdx, _bagEnd: pNext.presetBagNdx };
}

function buildRegionsForPreset(sf2, presetIndex, options = {}) {
    const {
        decodeToFloat32 = true,
        normalize = true,
        includeStereoLinks = true,
    } = options;

    const { pdta } = sf2;
    const preset = getPreset(pdta, presetIndex);

    // Build preset zones (bags) for this preset
    const presetZones = zonesFromBags(pdta.pbag, pdta.pgen, preset._bagStart, preset._bagEnd);

    // Global preset zone = first zone if it has no instrument generator
    const presetGlobal = presetZones.length && presetZones[0].gens[Gen.instrument] == null
        ? presetZones[0].gens
        : {};

    const regions = [];

    // For each preset zone that points to an instrument
    for (const pz of presetZones) {
        const instIndex = pz.gens[Gen.instrument];
        if (instIndex == null) continue;

        const inst = getInstrument(pdta, instIndex);
        const instZones = zonesFromBags(pdta.ibag, pdta.igen, inst._bagStart, inst._bagEnd);

        const instGlobal = instZones.length && instZones[0].gens[Gen.sampleID] == null
            ? instZones[0].gens
            : {};

        for (const iz of instZones) {
            const sampleID = iz.gens[Gen.sampleID];
            if (sampleID == null) continue; // not a playable zone

            // Merge generators: presetGlobal + presetZone + instGlobal + instZone
            // SF2 combine rules vary by generator; this simple merge is "add for most, replace for ranges/ids".
            const merged = mergeGens(presetGlobal, pz.gens, instGlobal, iz.gens);

            const region = makeRegionFromMerged(sf2, merged, {
                decodeToFloat32,
                normalize,
                includeStereoLinks,
            });

            if (region) regions.push(region);
        }
    }

    return regions;
}

function getInstrument(pdta, instIndex) {
    const inst = pdta.inst;
    const last = inst.length - 1;
    if (instIndex < 0 || instIndex >= last) throw new Error("instIndex out of range");
    const i = inst[instIndex];
    const iNext = inst[instIndex + 1];
    return { ...i, _bagStart: i.instBagNdx, _bagEnd: iNext.instBagNdx };
}

function zonesFromBags(bags, gens, bagStart, bagEnd) {
    const zones = [];
    for (let bi = bagStart; bi < bagEnd; bi++) {
        const b = bags[bi];
        const bNext = bags[bi + 1];
        const genStart = b.genNdx;
        const genEnd = bNext ? bNext.genNdx : gens.length;

        const zoneGens = {};
        for (let gi = genStart; gi < genEnd; gi++) {
            const g = gens[gi];
            // Many generators can appear multiple times; last wins in-zone per spec.
            zoneGens[g.oper] = g.amount;
        }
        zones.push({ bagIndex: bi, gens: zoneGens });
    }
    return zones;
}

function mergeGens(pGlobal, pZone, iGlobal, iZone) {
    // Start with globals, then specific zones override/accumulate.
    // For most numeric generators: add. For ids/ranges: replace.
    const out = {};

    function apply(src) {
        for (const kStr of Object.keys(src)) {
            const k = +kStr;
            const v = src[k];

            if (k === Gen.keyRange || k === Gen.velRange || k === Gen.instrument || k === Gen.sampleID) {
                out[k] = v; // replace
            } else if (k === Gen.sampleModes || k === Gen.exclusiveClass || k === Gen.overridingRootKey) {
                out[k] = v; // replace (commonly last wins)
            } else {
                // additive
                out[k] = (out[k] ?? 0) + v;
            }
        }
    }

    apply(pGlobal);
    apply(pZone);
    apply(iGlobal);
    apply(iZone);

    return out;
}

function makeRegionFromMerged(sf2, g, opts) {
    const { pdta, sdta } = sf2;

    const sampleID = g[Gen.sampleID];
    if (sampleID == null) return null;

    const sh = pdta.shdr[sampleID];
    if (!sh) return null;

    // Terminal EOS exists at end; ignore if sampleID points to EOS
    // Many files use "EOS" as last record. We'll accept unless clearly invalid.
    const smplI16 = sdta.smpl;
    if (!smplI16) throw new Error("Missing sdta.smpl sample data");

    // Sample positions are in sample frames (16-bit words), relative to start of smpl
    // Use gen offsets to adjust.
    const startOffset = computeAddressOffset(g, Gen.startAddrsOffset, Gen.startAddrsCoarseOffset);
    const endOffset = computeAddressOffset(g, Gen.endAddrsOffset, Gen.endAddrsCoarseOffset);
    const loopStartOffset = computeAddressOffset(g, Gen.startloopAddrsOffset, Gen.startloopAddrsCoarseOffset);
    const loopEndOffset = computeAddressOffset(g, Gen.endloopAddrsOffset, Gen.endloopAddrsCoarseOffset);

    let start = sh.start + startOffset;
    let end = sh.end + endOffset;
    let loopStart = sh.startLoop + loopStartOffset;
    let loopEnd = sh.endLoop + loopEndOffset;

    // Clamp sanity
    start = clampU32(start, 0, smplI16.length);
    end = clampU32(end, 0, smplI16.length);
    loopStart = clampU32(loopStart, 0, smplI16.length);
    loopEnd = clampU32(loopEnd, 0, smplI16.length);
    if (end <= start) return null;

    // Decode to Float32 for WebAudio (recommended)
    // We do per-region extraction (copy) because regions are independent.
    const { dataL, dataR } = decodeSampleData(sf2, sh, { start, end }, opts);

    // Ranges
    const keyRange = g[Gen.keyRange] != null ? unpackRange(g[Gen.keyRange]) : [0, 127];
    const velRange = g[Gen.velRange] != null ? unpackRange(g[Gen.velRange]) : [0, 127];

    // Pitch-related
    const originalKey = sh.originalPitch ?? 60;
    const pitchCorrection = sh.pitchCorrection ?? 0; // cents
    const overridingRootKey = g[Gen.overridingRootKey] != null ? (g[Gen.overridingRootKey] & 0xFF) : null;
    const coarseTune = g[Gen.coarseTune] ?? 0; // semitones
    const fineTune = (g[Gen.fineTune] ?? 0) + pitchCorrection; // cents + correction
    const scaleTuning = g[Gen.scaleTuning] ?? 100;

    // Amp/pan
    const initialAttenuationCb = g[Gen.initialAttenuation] ?? 0;
    const pan = g[Gen.pan] ?? 0; // -500..+500

    // Envelopes
    const volEnv = {
        delayTc: g[Gen.delayVolEnv] ?? -12000,
        attackTc: g[Gen.attackVolEnv] ?? -12000,
        holdTc: g[Gen.holdVolEnv] ?? -12000,
        decayTc: g[Gen.decayVolEnv] ?? -12000,
        sustainCb: g[Gen.sustainVolEnv] ?? 0,
        releaseTc: g[Gen.releaseVolEnv] ?? -12000,
    };

    // sustainModEnv in SF2 is usually in "centibels"? spec uses 0..1000 (per mille)? Many players map it.
    // For a usable starter, convert sustainModEnv (0..1000) to 0..1 by /1000 if present.
    const sustainModRaw = g[Gen.sustainModEnv];
    const modEnv = {
        delayTc: g[Gen.delayModEnv] ?? -12000,
        attackTc: g[Gen.attackModEnv] ?? -12000,
        holdTc: g[Gen.holdModEnv] ?? -12000,
        decayTc: g[Gen.decayModEnv] ?? -12000,
        sustain: sustainModRaw != null ? clamp01(sustainModRaw / 1000) : 0,
        releaseTc: g[Gen.releaseModEnv] ?? -12000,
    };

    // Filter/LFO
    const region = {
        keyRange,
        velRange,

        sample: {
            dataL,
            dataR,
            sampleRate: sh.sampleRate,
            start: 0,
            end: dataL.length,
            loopStart: Math.max(0, Math.min(loopStart - start, dataL.length)),
            loopEnd: Math.max(0, Math.min(loopEnd - start, dataL.length)),
        },
        sampleModes: g[Gen.sampleModes] ?? 0,

        originalKey,
        overridingRootKey,
        coarseTune,
        fineTune,
        scaleTuning,

        initialAttenuationCb,
        pan,

        volEnv,
        modEnv,

        initialFilterFcCents: g[Gen.initialFilterFc] ?? 13500,
        initialFilterQCb: g[Gen.initialFilterQ] ?? 0,
        modEnvToFilterFcCents: g[Gen.modEnvToFilterFc] ?? 0,
        modLfoToFilterFcCents: g[Gen.modLfoToFilterFc] ?? 0,

        modLfoDelayTc: g[Gen.delayModLFO] ?? -12000,
        modLfoFreqCents: g[Gen.freqModLFO] ?? 0,
        modLfoToPitchCents: g[Gen.modLfoToPitch] ?? 0,

        vibLfoDelayTc: g[Gen.delayVibLFO] ?? -12000,
        vibLfoFreqCents: g[Gen.freqVibLFO] ?? 0,
        vibLfoToPitchCents: g[Gen.vibLfoToPitch] ?? 0,

        exclusiveClass: g[Gen.exclusiveClass] ?? 0,
    };

    // Basic loop sanity: if loop points invalid, disable loop
    if (!(region.sample.loopEnd > region.sample.loopStart + 1)) {
        region.sampleModes = 0;
        region.sample.loopStart = 0;
        region.sample.loopEnd = region.sample.end;
    }

    return region;
}

function computeAddressOffset(g, fineOp, coarseOp) {
    const fine = g[fineOp] ?? 0;   // samples
    const coarse = g[coarseOp] ?? 0; // in 32768-sample units
    return fine + coarse * 32768;
}

function decodeSampleData(sf2, sh, range, opts) {
    const { sdta, pdta } = sf2;
    const { decodeToFloat32, normalize, includeStereoLinks } = opts;

    const start = range.start;
    const end = range.end;

    // Detect stereo linking via sampleType/sampleLink.
    // SF2 sampleType bits encode mono/stereo left/right/linked, but implementations vary.
    // We'll do a conservative approach:
    // - If includeStereoLinks and sampleLink points to valid other sample with same length/rate,
    //   and types suggest L/R, decode both channels.
    let linked = null;
    if (includeStereoLinks && sh.sampleLink && sh.sampleLink < pdta.shdr.length) {
        const other = pdta.shdr[sh.sampleLink];
        if (other && other.sampleRate === sh.sampleRate) linked = other;
    }

    if (!decodeToFloat32) {
        // You can also keep Int16 and convert in worklet; Float32 is more convenient.
        // Here we still return Float32 to match the worklet code you already have.
        throw new Error("decodeToFloat32=false not implemented in this minimal parser");
    }

    const dataL = int16ToFloat32(sdta.smpl, start, end, normalize);

    let dataR = null;
    if (linked) {
        // Try to infer stereo pair: use linked sample's start/end as given by its shdr
        // BUT region offsets are not mirrored here; real SF2 uses separate zones for L/R.
        // This is "best effort".
        const startR = linked.start;
        const endR = linked.end;
        const sR = clampU32(startR, 0, sdta.smpl.length);
        const eR = clampU32(endR, 0, sdta.smpl.length);
        if (eR > sR) dataR = int16ToFloat32(sdta.smpl, sR, eR, normalize);
    }

    return { dataL, dataR };
}

function int16ToFloat32(i16, start, end, normalize) {
    const n = end - start;
    const out = new Float32Array(n);

    if (!normalize) {
        for (let i = 0; i < n; i++) out[i] = i16[start + i] / 32768;
        return out;
    }

    // Peak normalize to [-1,1] if sample isn't already near full scale
    let peak = 0;
    for (let i = 0; i < n; i++) {
        const v = Math.abs(i16[start + i]);
        if (v > peak) peak = v;
    }
    const denom = peak > 0 ? peak : 32768;
    const scale = denom / 32768; // convert peak to 1.0 then map to float
    for (let i = 0; i < n; i++) out[i] = (i16[start + i] / 32768) / scale;
    return out;
}

// ============================================================
// Small helpers
// ============================================================

function clampU32(x, lo, hi) {
    x = x >>> 0;
    if (x < lo) return lo >>> 0;
    if (x > hi) return hi >>> 0;
    return x;
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }