// Composition WebMCP tools: whole arrangements + reusable primitives (parts, transforms, orchestration).
// All produce real notes / CC events. Large results return summaries, never every note.
import type { WorkstationController } from "../workstation/controller.ts";
import { WorkstationError, applyOps, type Op } from "../workstation/ops.ts";
import type { Project, Track } from "../workstation/model.ts";
import { parseKey } from "../music/keys.ts";
import { STRATEGIES, defaultSections, generateArrangement, barGrid, type Assigned } from "../music/arrangement.ts";
import {
  INSTRUMENTS, accompaniment, articulate, bassLine, chordProgression, counterpoint, drumPattern, humanize, instrumentSpec, invert, melody, phraseDynamics,
  quantize, retrograde, rng, sequence, transpose, variation, type BarGrid,
} from "../music/compose.ts";
import { estimateKey, type MNote } from "../music/theory.ts";
import { rangeToTicks, type ToolDef, type JsonSchema } from "./tools.ts";
import { applied, trackOps } from "./compose-tools.ts";

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const int = (minimum: number, maximum: number, description?: string): JsonSchema => ({ type: "integer", minimum, maximum, ...(description ? { description } : {}) });
const str = (maxLength = 200, extra: JsonSchema = {}): JsonSchema => ({ type: "string", maxLength, ...extra });
const BAR_RANGE = obj({ unit: { type: "string", enum: ["bars", "beats", "ticks", "seconds"] }, start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 } }, ["unit", "start", "end"]);
const BASE_REV = int(0, Number.MAX_SAFE_INTEGER);

const DEFAULT_INSTR: Record<string, string[]> = { baroque: ["violin", "viola", "cello", "harpsichord"], classical: ["flute", "violin", "cello", "piano"], pop: ["piano", "bass", "strings", "drums"], jazz: ["trumpet", "piano", "bass", "drums"], ambient: ["strings", "choir", "piano"] };

function findTrack(p: Project, id: string): Track {
  const t = p.tracks.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!t) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${JSON.stringify(id.slice(0, 60))}; call gbk_list_tracks`);
  return t;
}
function keyOf(p: Project, k?: string) {
  if (k) return parseKey(k);
  if (p.meta?.key) { try { return parseKey(p.meta.key); } catch { /* free text */ } }
  const e = estimateKey(p.notes); return { label: e.label, tonic: e.tonic, mode: e.mode, sf: 0 };
}
function gridFor(p: Project, startTick: number, endTick: number): BarGrid[] {
  return barGrid(p, 100000 > 0 ? Math.min(100000, Math.ceil(endTick / (p.ppq)) + 2) : 1).filter((g) => g.tick >= startTick && g.tick < endTick);
}

export function buildArrangementTools(c: WorkstationController): ToolDef[] {
  const P = () => c.project;
  return [
    { name: "gbk_generate_arrangement", readOnly: false,
      description: "Generate a complete multi-track arrangement (real notes + CC11 phrase dynamics, CC1 vibrato, CC91 reverb send) from a seeded rule-based strategy: baroque (GBK Bach fugue generator + continuo), classical, pop, jazz, ambient. Creates or reuses tracks for `instrumentation`, sets sections/key/tempo when missing, and applies it as ONE transaction (immediately inside an autonomous session, else as a proposal). Returns a summary (counts, ranges, counterpoint metrics), not the notes.",
      inputSchema: obj({ style: { type: "string", enum: Object.keys(STRATEGIES) }, key: str(32), tempo: { type: "number", minimum: 10, maximum: 400 }, bars: int(1, 512), seed: int(0, 2 ** 31), voices: { type: "integer", enum: [3, 4] }, complexity: int(1, 5),
        instrumentation: { type: "array", maxItems: 12, items: str(32, { description: `one of ${Object.keys(INSTRUMENTS).join(", ")} or an existing track name` }) },
        features: obj({ counterpoint: { type: "boolean" }, dynamicExpression: { type: "boolean" }, articulation: { type: "boolean" }, cadences: { type: "boolean" } }),
        replaceExisting: { type: "boolean", description: "remove existing notes on the target tracks in the range first (default true)" }, baseRevision: BASE_REV }, ["style"]),
      run: (a, signal) => {
        const p = P();
        const style = a.style as string; const key = keyOf(p, a.key as string | undefined);
        const secs = p.meta?.sections ?? [];
        const nBars = (a.bars as number) ?? (secs.length ? Math.max(...secs.map((s) => s.startBar + s.bars - 1)) : 32);
        const pre: Op[] = []; const warnings: string[] = [];
        if (a.tempo !== undefined) { if (p.tempos.length <= 1) pre.push({ op: "setTempoMap", events: [{ tick: 0, microPerQuarter: Math.round(60e6 / (a.tempo as number)) }] }); else warnings.push("project has a tempo map; tempo argument ignored (use gbk_set_tempo_map)"); }
        if (a.key || !p.meta?.key) pre.push({ op: "setMeta", key: key.label, style, seed: (a.seed as number) ?? 1 });
        if (!secs.length) pre.push({ op: "setSections", sections: defaultSections(nBars) });
        const names = (a.instrumentation as string[] | undefined) ?? DEFAULT_INSTR[style] ?? DEFAULT_INSTR.classical;
        const assigned: { trackId: string; spec: ReturnType<typeof instrumentSpec> }[] = []; const create: { name: string; spec: ReturnType<typeof instrumentSpec> }[] = [];
        const taken = new Set<string>();
        for (const nm of names) {
          const spec = instrumentSpec(nm);
          const ex = p.tracks.find((t) => !taken.has(t.id) && (t.name.toLowerCase() === nm.toLowerCase() || t.name.toLowerCase().includes(spec.name.toLowerCase()) || (p.programs.find((g) => g.trackId === t.id)?.program === spec.program && spec.family !== "drums")));
          if (ex) { taken.add(ex.id); assigned.push({ trackId: ex.id, spec }); } else create.push({ name: spec.name, spec });
        }
        if (create.length) {
          const t = trackOps(p, create.map((x) => ({ name: x.name, program: x.spec.program, role: x.spec.role, pan: x.spec.pan, volume: 100, expression: 127 })));
          pre.push(...t.ops); warnings.push(...t.warnings);
          t.ids.forEach((id, i) => assigned.push({ trackId: id, spec: create[i].spec }));
        }
        if (signal.aborted) throw new WorkstationError("OPERATION_CANCELLED", "cancelled");
        const cand = applyOps(p, pre);
        const parts: Assigned[] = assigned.map((x) => ({ track: cand.tracks.find((t) => t.id === x.trackId)!, spec: x.spec }));
        const plan = { style, key, bars: nBars, seed: (a.seed as number) ?? 1, voices: ((a.voices as 3 | 4) ?? 4), complexity: ((a.complexity as 1) ?? 3), features: { counterpoint: true, dynamicExpression: true, articulation: true, cadences: true, ...((a.features as object) ?? {}) } };
        const res = generateArrangement(cand, plan, parts);
        const grid = barGrid(cand, nBars); const end = grid.length ? grid[grid.length - 1].tick + grid[grid.length - 1].length : 0;
        const remove: Op[] = a.replaceExisting === false ? [] : [{ op: "removeNotes", ids: p.notes.filter((n) => taken.has(n.trackId) && n.tick < end).map((n) => n.id) }];
        const ops = [...pre, ...(remove.length && (remove[0] as { ids: string[] }).ids.length ? remove : []), ...res.ops];
        const out = applied(c, ops, `${style} arrangement (${nBars} bars, ${key.label}, seed ${plan.seed}, ${res.totalNotes} notes)`, signal, a.baseRevision as number | undefined, {
          style, key: key.label, bars: nBars, seed: plan.seed, durationSec: res.durationSec, totalNotes: res.totalNotes, totalCcs: res.totalCcs, tracks: res.perTrack, sections: res.sections, metrics: res.metrics, analysis: res.analysis.slice(0, 12),
        });
        return { data: out.data, warnings: [...warnings, ...(out.warnings ?? []), "rule-based generator (not a trained model); metrics are heuristic"] };
      } },
    { name: "gbk_generate_part", readOnly: false,
      description: "Generate one part into a track over a range: melody (chord tones + passing tones), bass (roots / root-fifth / walking), chords (block), arpeggio, alberti, drums (GM grid), or counterpoint (against `againstTrackId`). Seeded; uses the project key unless `key` is given; optional explicit `progression` of scale degrees (one per bar).",
      inputSchema: obj({ trackId: str(), range: BAR_RANGE, kind: { type: "string", enum: ["melody", "bass", "walking_bass", "chords", "arpeggio", "alberti", "drums", "counterpoint"] }, seed: int(0, 2 ** 31), key: str(32), progression: { type: "array", maxItems: 512, items: int(1, 7) }, againstTrackId: str(), low: int(0, 127), high: int(0, 127), velocity: int(1, 127), baseRevision: BASE_REV }, ["trackId", "range", "kind"]),
      run: (a, signal) => {
        const p = P(); const t = findTrack(p, a.trackId as string); const r = rangeToTicks(p, a.range as never); const key = keyOf(p, a.key as string | undefined);
        const R = rng((a.seed as number) ?? 1); const grid = gridFor(p, r.startTick, r.endTick);
        if (!grid.length) throw new WorkstationError("INVALID_RANGE", "range contains no bar starts");
        const prog = (a.progression as number[] | undefined) ?? chordProgression(grid.length, p.meta?.style ?? "classical", R);
        const chords = grid.map((_, i) => prog[i % prog.length]);
        const spec = instrumentSpec(t.name); const lo = (a.low as number) ?? spec.lo, hi = (a.high as number) ?? spec.hi;
        let ns: MNote[];
        switch (a.kind) {
          case "melody": ns = melody(grid, chords, key, lo, hi, R); break;
          case "bass": ns = bassLine(grid, chords, key, lo, Math.min(hi, 62), R, "root-fifth"); break;
          case "walking_bass": ns = bassLine(grid, chords, key, lo, Math.min(hi, 62), R, "walking"); break;
          case "chords": ns = accompaniment(grid, chords, key, Math.max(lo, 48), Math.min(hi, 79), R, "block"); break;
          case "arpeggio": ns = accompaniment(grid, chords, key, Math.max(lo, 48), Math.min(hi, 79), R, "arpeggio"); break;
          case "alberti": ns = accompaniment(grid, chords, key, Math.max(lo, 48), Math.min(hi, 79), R, "alberti"); break;
          case "drums": ns = drumPattern(grid, R, "pop"); break;
          default: {
            if (!a.againstTrackId) throw new WorkstationError("INVALID_ARGUMENT", "counterpoint needs againstTrackId");
            const cf = findTrack(p, a.againstTrackId as string);
            const cantus = p.notes.filter((n) => n.trackId === cf.id && n.tick < r.endTick && n.tick + n.duration > r.startTick);
            if (!cantus.length) throw new WorkstationError("INVALID_RANGE", "againstTrackId has no notes in range");
            const above = (cantus.reduce((s, n) => s + n.pitch, 0) / cantus.length) < (lo + hi) / 2;
            ns = counterpoint(cantus, { lo, hi, rhythm: 2, seed: (a.seed as number) ?? 1, ...r, ppq: p.ppq, tonic: key.tonic, mode: key.mode, above }).notes;
          }
        }
        ns = ns.filter((n) => n.tick < r.endTick).map((n) => ({ ...n, velocity: (a.velocity as number) ?? n.velocity, duration: Math.max(1, Math.min(n.duration, r.endTick - n.tick)) }));
        return applied(c, [{ op: "addNotes", notes: ns.map((n) => ({ trackId: t.id, channel: t.channel, tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity })) }], `${a.kind} on ${t.name} (${ns.length} notes)`, signal, a.baseRevision as number | undefined, { notes: ns.length, key: key.label, progression: chords.slice(0, 32) });
      } },
    { name: "gbk_transform_notes", readOnly: false,
      description: "Transform a track's notes in a range: transpose, invert (around axis pitch), retrograde, repeat / sequence (copies after the range, shifted by `semitones` per copy), quantize (grid in beats, strength), humanize (velocity ± amount, timing ± ticks, seeded), articulation (legato/detache/staccato/tenuto/marcato), phrase_dynamics (velocity arcs per `phraseBars`), variation (ornament/diminution/inversion).",
      inputSchema: obj({ trackId: str(), range: BAR_RANGE, transform: { type: "string", enum: ["transpose", "invert", "retrograde", "repeat", "sequence", "quantize", "humanize", "articulation", "phrase_dynamics", "variation"] }, semitones: int(-48, 48), axis: int(0, 127), times: int(1, 64), grid: { type: "number", minimum: 0.0625, maximum: 4 }, strength: { type: "number", minimum: 0, maximum: 1 }, amount: int(0, 64), timing: int(0, 240), articulation: { type: "string", enum: ["legato", "detache", "staccato", "tenuto", "marcato"] }, variation: { type: "string", enum: ["ornament", "diminution", "inversion"] }, phraseBars: int(1, 64), seed: int(0, 2 ** 31), baseRevision: BASE_REV }, ["trackId", "range", "transform"]),
      run: (a, signal) => {
        const p = P(); const t = findTrack(p, a.trackId as string); const r = rangeToTicks(p, a.range as never);
        const src = p.notes.filter((n) => n.trackId === t.id && n.tick >= r.startTick && n.tick < r.endTick);
        if (!src.length) throw new WorkstationError("INVALID_RANGE", "no notes of that track in range");
        const R = rng((a.seed as number) ?? 1); const span = r.endTick - r.startTick;
        let out: MNote[]; let keep = false;
        switch (a.transform) {
          case "transpose": out = transpose(src, (a.semitones as number) ?? 12); break;
          case "invert": out = invert(src, (a.axis as number) ?? src[0].pitch); break;
          case "retrograde": out = retrograde(src); break;
          case "repeat": out = sequence(src, ((a.times as number) ?? 1) + 1, span, 0).filter((n) => n.tick >= r.endTick); keep = true; break;
          case "sequence": out = sequence(src, ((a.times as number) ?? 2) + 1, span, (a.semitones as number) ?? -2).filter((n) => n.tick >= r.endTick); keep = true; break;
          case "quantize": out = quantize(src, Math.max(1, Math.round(((a.grid as number) ?? 0.25) * p.ppq)), (a.strength as number) ?? 1); break;
          case "humanize": out = humanize(src, R, (a.amount as number) ?? 6, (a.timing as number) ?? 0); break;
          case "articulation": out = articulate(src, (a.articulation as "legato") ?? "detache"); break;
          case "phrase_dynamics": { const g = gridFor(p, r.startTick, r.endTick); const pb = (a.phraseBars as number) ?? 4; out = phraseDynamics(src, (g[0]?.length ?? p.ppq * 4) * pb, (a.amount as number) ?? 14, r.startTick); break; }
          default: out = variation(src, keyOf(p), R, (a.variation as "ornament") ?? "ornament");
        }
        const clean = out.map((n) => ({ trackId: t.id, channel: t.channel, tick: Math.max(0, n.tick), duration: Math.max(1, n.duration), pitch: Math.max(0, Math.min(127, n.pitch)), velocity: Math.max(1, Math.min(127, n.velocity)) }));
        const ops: Op[] = keep ? [{ op: "addNotes", notes: clean }] : [{ op: "removeNotes", ids: src.map((n) => n.id) }, { op: "addNotes", notes: clean }];
        return applied(c, ops, `${a.transform} ${t.name} (${src.length} -> ${clean.length} notes)`, signal, a.baseRevision as number | undefined, { sourceNotes: src.length, resultNotes: clean.length });
      } },
    { name: "gbk_orchestrate", readOnly: false,
      description: "Track orchestration: copy (double) a passage from one track to another with an octave/semitone shift and velocity scale, folding into the target instrument's range.",
      inputSchema: obj({ sourceTrackId: str(), targetTrackId: str(), range: BAR_RANGE, semitones: int(-48, 48), velocityScale: { type: "number", minimum: 0.1, maximum: 2 }, baseRevision: BASE_REV }, ["sourceTrackId", "targetTrackId", "range"]),
      run: (a, signal) => {
        const p = P(); const s = findTrack(p, a.sourceTrackId as string), t = findTrack(p, a.targetTrackId as string); const r = rangeToTicks(p, a.range as never);
        const spec = instrumentSpec(t.name);
        const src = p.notes.filter((n) => n.trackId === s.id && n.tick >= r.startTick && n.tick < r.endTick);
        const notes = src.map((n) => { let pitch = n.pitch + ((a.semitones as number) ?? 0); while (pitch < spec.lo) pitch += 12; while (pitch > spec.hi) pitch -= 12; return { trackId: t.id, channel: t.channel, tick: n.tick, duration: n.duration, pitch: Math.max(0, Math.min(127, pitch)), velocity: Math.max(1, Math.min(127, Math.round(n.velocity * ((a.velocityScale as number) ?? 1)))) }; });
        if (!notes.length) throw new WorkstationError("INVALID_RANGE", "source has no notes in range");
        return applied(c, [{ op: "addNotes", notes }], `orchestrate ${s.name} -> ${t.name} (${notes.length})`, signal, a.baseRevision as number | undefined, { notes: notes.length });
      } },
  ];
}
