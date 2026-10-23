// Timed channel-voice controller events shared by realtime worker, offline WAV render, and MIDI out.
export type CtlKind = "cc" | "pitchBend" | "channelPressure" | "polyPressure";
export interface CtlPlayEvent { sec: number; seq: number; type: CtlKind; channel: number; controller?: number; note?: number; value: number }

const RPN_CCS = new Set([6, 38, 96, 97, 98, 99, 100, 101]);

/** Message understood by Sf2SynthEngine.dispatchEvent. */
export function ctlToSynth(ev: CtlPlayEvent): Record<string, unknown> {
  switch (ev.type) {
    case "cc": return { type: "controlChange", channel: ev.channel, controller: ev.controller, value: ev.value };
    case "pitchBend": return { type: "pitchBend", channel: ev.channel, velocity: ev.value }; // 14-bit 0..16383
    case "channelPressure": return { type: "channelPressure", channel: ev.channel, value: ev.value };
    case "polyPressure": return { type: "polyPressure", channel: ev.channel, note: ev.note, value: ev.value };
  }
}

export function ctlToBytes(ev: CtlPlayEvent): number[] {
  const ch = ev.channel & 15;
  switch (ev.type) {
    case "cc": return [0xb0 | ch, (ev.controller ?? 0) & 127, ev.value & 127];
    case "pitchBend": return [0xe0 | ch, ev.value & 127, (ev.value >> 7) & 127];
    case "channelPressure": return [0xd0 | ch, ev.value & 127];
    case "polyPressure": return [0xa0 | ch, (ev.note ?? 0) & 127, ev.value & 127];
  }
}

export interface MixBase { cc7: number; cc10: number; cc11: number }

/**
 * Controller state at `sec` (exclusive): messages that rebuild channel state on seek/loop/start.
 * Order: reset-all-controllers (CC121; also releases sustain/sostenuto) on each used channel,
 * mix base CC7/10/11 (mixer defaults), then authored state: last value per (channel, CC) except
 * RPN/NRPN which replays in order; last bend / channel pressure per channel; last poly per key.
 */
export function controllerStateAt(events: readonly { sec: number; type: string }[], sec: number, base: MixBase = { cc7: 100, cc10: 64, cc11: 127 }): CtlPlayEvent[] {
  const chans = new Set<number>();
  const lastCc = new Map<number, CtlPlayEvent>();
  const rpn: CtlPlayEvent[] = [];
  const lastOther = new Map<string, CtlPlayEvent>();
  for (const e of events as CtlPlayEvent[]) {
    if (typeof (e as { channel?: number }).channel === "number") chans.add(e.channel);
    if (e.sec >= sec) continue;
    if (e.type === "cc") {
      const c = e.controller ?? 0;
      if (c === 121 || c === 120 || c === 123) continue; // mode messages: don't re-fire
      if (RPN_CCS.has(c)) rpn.push(e); else lastCc.set(e.channel * 128 + c, e);
    } else if (e.type === "pitchBend" || e.type === "channelPressure") lastOther.set(`${e.type}:${e.channel}`, e);
    else if (e.type === "polyPressure") lastOther.set(`poly:${e.channel}:${e.note}`, e);
  }
  const out: CtlPlayEvent[] = [];
  let seq = -1e6;
  for (const ch of [...chans].sort((a, b) => a - b)) {
    out.push({ sec, seq: seq++, type: "cc", channel: ch, controller: 121, value: 0 });
    out.push({ sec, seq: seq++, type: "cc", channel: ch, controller: 7, value: base.cc7 });
    out.push({ sec, seq: seq++, type: "cc", channel: ch, controller: 10, value: base.cc10 });
    out.push({ sec, seq: seq++, type: "cc", channel: ch, controller: 11, value: base.cc11 });
  }
  for (const e of rpn) out.push({ ...e, sec });
  for (const e of [...lastCc.values()].sort((a, b) => a.seq - b.seq)) out.push({ ...e, sec });
  for (const e of lastOther.values()) out.push({ ...e, sec });
  return out;
}
