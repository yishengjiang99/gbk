import type { WorkstationController } from "../workstation/controller.ts";
import { WorkstationError, type Op } from "../workstation/ops.ts";
import { newId } from "../workstation/model.ts";
import { parseSmf } from "../workstation/smf.ts";
import { bars } from "../workstation/timing.ts";
import { analyze, counterpoint, estimateKey, fitRange, cadences } from "../music/theory.ts";
import { generateBachMidi, BACH_KEY_OPTIONS, type BachFugueConfig } from "../bach-generator.ts";
import { rangeToTicks, proposalView, type ToolDef } from "./tools.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const RANGE = obj({ unit: { type: "string", enum: ["bars", "beats", "ticks", "seconds"] }, start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 } }, ["unit", "start", "end"]);
const int = (minimum: number, maximum: number, description?: string) => ({ type: "integer", minimum, maximum, ...(description ? { description } : {}) });

export function buildMusicTools(c: WorkstationController): ToolDef[] {
  const P = () => c.project;
  const track = (id: string) => { const t = P().tracks.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase()); if (!t) throw new WorkstationError("INVALID_ARGUMENT", "unknown track; call gbk_list_tracks"); return t; };
  const tpb = () => bars(P(), 0)[0].length;
  return [
    { name: "gbk_analyze_passage", readOnly: true, description: "Deterministic stats for a passage: pitch classes, range, density, intervals, recurring motifs, approximate key (heuristic), cadence candidates (heuristic).", inputSchema: obj({ range: RANGE, trackIds: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 64 } }, ["range"]),
      run: (a) => {
        const p = P(); const r = rangeToTicks(p, a.range as never); const ids = a.trackIds ? new Set((a.trackIds as string[]).map((x) => track(x).id)) : null;
        const ns = p.notes.filter((n) => n.tick >= r.startTick && n.tick < r.endTick && (!ids || ids.has(n.trackId)));
        const an = analyze(ns, p.ppq, tpb());
        const bassLine = [...ns].sort((x, y) => x.tick - y.tick || x.pitch - y.pitch).filter((n, i, arr) => i === 0 || arr[i - 1].tick !== n.tick);
        return { data: { ...r, ...an, cadences: cadences(bassLine, an.key.tonic, tpb()) }, warnings: ["key and cadence labels are heuristics"] };
      } },
    { name: "gbk_generate_counterpoint", readOnly: false, description: "Generate a counterpoint line (heuristic species-style rules: consonance on strong beats, voice order, contrary motion preference, parallel 5th/8ve avoidance) against a cantus track over a range. Returns a proposal for the best candidate plus ranked alternatives.", inputSchema: obj({ cantusTrackId: { type: "string", maxLength: 200 }, range: RANGE, targetTrackId: { type: "string", maxLength: 200, description: "existing track to write into; omit to create a new track" }, newTrackName: { type: "string", maxLength: 64 }, channel: int(0, 15), register: obj({ low: int(0, 127), high: int(0, 127) }, ["low", "high"]), position: { type: "string", enum: ["above", "below"] }, rhythmComplexity: int(1, 3, "1 = note against note, 2 = two per beat, 3 = four per beat"), seed: int(0, 2 ** 31), candidates: int(1, 8), baseRevision: int(0, Number.MAX_SAFE_INTEGER) }, ["cantusTrackId", "range"]),
      run: (a) => {
        const p = P(); const r = rangeToTicks(p, a.range as never); const cantusT = track(a.cantusTrackId as string);
        const cantus = p.notes.filter((n) => n.trackId === cantusT.id && n.tick < r.endTick && n.tick + n.duration > r.startTick);
        if (!cantus.length) throw new WorkstationError("INVALID_RANGE", "cantus track has no notes in range");
        const key = estimateKey(p.notes.filter((n) => n.tick >= r.startTick && n.tick < r.endTick));
        const reg = (a.register as { low: number; high: number }) ?? { low: 55, high: 74 }; // alto default
        if (reg.high - reg.low < 7) throw new WorkstationError("INVALID_ARGUMENT", "register must span at least a fifth");
        const base = (a.seed as number) ?? 1; const n = (a.candidates as number) ?? 3;
        const cands = Array.from({ length: n }, (_, i) => ({ seed: base + i, ...counterpoint(cantus, { lo: reg.low, hi: reg.high, rhythm: ((a.rhythmComplexity as 1) ?? 1), seed: base + i, startTick: r.startTick, endTick: r.endTick, ppq: p.ppq, tonic: key.tonic, mode: key.mode, above: a.position !== "below" }) }))
          .sort((x, y) => y.score - x.score);
        const best = cands[0];
        let target = a.targetTrackId ? track(a.targetTrackId as string) : null; const ops: Op[] = [];
        let tid = target?.id; let ch = (a.channel as number) ?? target?.channel;
        if (!target) { tid = newId("trk"); ch = ch ?? (Math.max(...p.tracks.map((t) => t.channel), -1) + 1) % 16; if (ch === 9) ch = 10; ops.push({ op: "addTrack", id: tid, name: ((a.newTrackName as string) ?? "Counterpoint").slice(0, 64), channel: ch }); }
        ops.push({ op: "addNotes", notes: best.notes.map((x) => ({ ...x, trackId: tid!, channel: ch! })) });
        const pr = c.propose(ops, { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: `counterpoint (${a.position ?? "above"} ${cantusT.name}, seed ${best.seed}, key≈${key.label})` });
        return { data: { ...proposalView(pr), key, candidates: cands.map((x) => ({ seed: x.seed, score: x.score, notes: x.notes.length, issues: x.issues })), chosenSeed: best.seed }, warnings: ["counterpoint rules and key are heuristics", ...best.issues] };
      } },
    { name: "gbk_generate_fugue_section", readOnly: false, description: "Generate a fugue exposition with GBK's Bach generator (real generator, seeded) and stage it as new tracks starting at a bar. Only options the generator supports are accepted.", inputSchema: obj({ key: { type: "string", enum: BACH_KEY_OPTIONS }, voices: { type: "integer", enum: [3, 4] }, length: { type: "string", enum: ["short", "medium", "long"] }, complexity: int(1, 5), seed: int(0, 2 ** 31), atBar: int(1, 10000), maxBars: int(1, 64), register: obj({ low: int(0, 127), high: int(0, 127) }, ["low", "high"]) }),
      run: (a) => {
        const p = P();
        const cfg: Partial<BachFugueConfig> = { ...(a.key ? { key: a.key as never } : {}), ...(a.voices ? { voices: a.voices as 3 } : {}), ...(a.length ? { length: a.length as never } : {}), ...(a.complexity ? { complexity: a.complexity as 1 } : {}), seed: (a.seed as number) ?? 7 };
        const gen = parseSmf(generateBachMidi(cfg).midiData, "fugue");
        const scale = p.ppq / gen.ppq; const at = rangeToTicks(p, { unit: "bars", start: (a.atBar as number) ?? 1, end: (a.atBar as number) ?? 1 }).startTick;
        const maxT = a.maxBars ? Math.round(bars(gen, 0)[0].length * (a.maxBars as number)) : Infinity;
        const ops: Op[] = []; let ch = Math.max(-1, ...p.tracks.map((t) => t.channel));
        for (const gt of gen.tracks) {
          let ns = gen.notes.filter((n) => n.trackId === gt.id && n.tick < maxT);
          if (!ns.length) continue;
          if (a.register) ns = fitRange(ns, (a.register as { low: number }).low, (a.register as { high: number }).high) as typeof ns;
          ch = (ch + 1) % 16; if (ch === 9) ch = 10;
          const id = newId("trk");
          ops.push({ op: "addTrack", id, name: `Fugue ${gt.name}`.slice(0, 64), channel: ch });
          ops.push({ op: "addNotes", notes: ns.map((n) => ({ trackId: id, channel: ch, tick: at + Math.round(n.tick * scale), duration: Math.max(1, Math.round(n.duration * scale)), pitch: n.pitch, velocity: n.velocity })) });
        }
        const pr = c.propose(ops, { source: "agent", summary: `fugue section (${cfg.key ?? "default key"}, seed ${cfg.seed})` });
        return { data: proposalView(pr), warnings: ["generated material comes from GBK's rule-based Bach-style generator"] };
      } },
  ];
}
