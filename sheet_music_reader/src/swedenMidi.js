const TPQ = 480;
const QUARTER = TPQ;
const WHOLE = TPQ * 4;
const VELOCITY_RH = 62;
const VELOCITY_LH = 50;

const NOTE_BASE = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11
};

function note(name) {
  const match = /^([A-G](?:#|b)?)(-?\d+)$/.exec(name);
  if (!match) {
    throw new Error(`Invalid note name: ${name}`);
  }

  const [, pitch, octaveText] = match;
  return 12 * (Number(octaveText) + 1) + NOTE_BASE[pitch];
}

function vlq(value) {
  const parts = [value & 0x7f];
  let remaining = value >> 7;

  while (remaining) {
    parts.push((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }

  return parts.reverse();
}

function u32(value) {
  return [(value >> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function u16(value) {
  return [(value >> 8) & 255, value & 255];
}

function ascii(text) {
  return Array.from(text, (char) => char.charCodeAt(0) & 255);
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

class Track {
  constructor() {
    this.events = [];
    this.order = 0;
  }

  push(tick, data) {
    this.events.push({ tick, data, order: this.order });
    this.order += 1;
  }

  meta(tick, kind, payload) {
    this.push(tick, [0xff, kind, ...vlq(payload.length), ...payload]);
  }

  noteOn(tick, channel, pitch, velocity) {
    this.push(tick, [0x90 | channel, pitch, velocity]);
  }

  noteOff(tick, channel, pitch) {
    this.push(tick, [0x80 | channel, pitch, 0]);
  }

  addNote(tick, channel, pitch, duration, velocity) {
    this.noteOn(tick, channel, pitch, velocity);
    this.noteOff(tick + duration, channel, pitch);
  }

  addChord(tick, channel, pitches, duration, velocity) {
    for (const pitch of pitches) {
      this.noteOn(tick, channel, pitch, velocity);
    }

    for (const pitch of pitches) {
      this.noteOff(tick + duration, channel, pitch);
    }
  }

  render() {
    const body = [];
    let lastTick = 0;

    const events = [...this.events].sort((a, b) => a.tick - b.tick || a.order - b.order);
    for (const event of events) {
      body.push(...vlq(event.tick - lastTick), ...event.data);
      lastTick = event.tick;
    }

    body.push(0x00, 0xff, 0x2f, 0x00);
    return [...ascii("MTrk"), ...u32(body.length), ...body];
  }
}

function tempoPayload(bpm) {
  const microsPerQuarter = Math.round(60000000 / bpm);
  return [(microsPerQuarter >> 16) & 255, (microsPerQuarter >> 8) & 255, microsPerQuarter & 255];
}

function addRepeatingBass(track, bar, notes) {
  const start = bar * WHOLE;
  notes.forEach((pitch, index) => {
    track.addNote(start + index * QUARTER, 1, note(pitch), QUARTER, VELOCITY_LH);
  });
}

function addRhHits(track, bar, hits) {
  const start = bar * WHOLE;
  for (const [beat, pitches, beats] of hits) {
    track.addChord(
      start + Math.trunc((beat - 1) * QUARTER),
      0,
      pitches.map(note),
      Math.trunc(beats * QUARTER),
      VELOCITY_RH
    );
  }
}

function addRhLine(track, bar, notes) {
  const start = bar * WHOLE;
  for (const [beat, pitch, beats] of notes) {
    track.addNote(
      start + Math.trunc((beat - 1) * QUARTER),
      0,
      note(pitch),
      Math.trunc(beats * QUARTER),
      VELOCITY_RH + 8
    );
  }
}

export function buildSwedenMidi() {
  const conductor = new Track();
  const piano = new Track();

  conductor.meta(0, 0x03, ascii("Sweden - photo transcription"));
  conductor.meta(0, 0x51, tempoPayload(46));
  conductor.meta(0, 0x58, [4, 2, 24, 8]);
  conductor.meta(0, 0x59, [2, 0]);

  piano.push(0, [0xc0, 0]);
  piano.push(0, [0xc1, 0]);

  const bassPatterns = [
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"]
  ];

  bassPatterns.forEach((pattern, bar) => addRepeatingBass(piano, bar, pattern));

  const chordHits = [
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["B3", "D4", "F#4"], 2]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["G3", "B3", "D4"], 2]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["B3", "D4", "F#4"], 2]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["G3", "B3", "D4"], 2]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["A3", "D4", "F#4"], 2]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
    [[1, ["D4", "F#4", "A4"], 1], [3, ["B3", "D4", "F#4"], 1]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["G3", "B3", "D4"], 1]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["A3", "D4", "F#4"], 1]],
    [[1, ["D4", "F#4", "A4"], 1], [3, ["D4", "F#4", "A4"], 1]],
    [[1, ["D4", "F#4", "A4"], 1], [3, ["B3", "D4", "F#4"], 1]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["G3", "B3", "D4"], 1]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["A3", "D4", "F#4"], 1]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]]
  ];

  chordHits.forEach((hits, bar) => addRhHits(piano, bar, hits));

  const melody = new Map([
    [6, [[3, "F#4", 0.5], [3.5, "A4", 0.5], [4, "B4", 1]]],
    [7, [[2, "A4", 0.5], [2.5, "F#4", 0.5], [4, "E4", 1]]],
    [8, [[1, "F#4", 0.5], [1.5, "A4", 0.5], [2, "B4", 0.5], [2.5, "A4", 0.5]]],
    [9, [[3, "F#4", 0.5], [3.5, "E4", 0.5], [4, "D4", 1]]],
    [10, [[3, "F#4", 0.5], [3.5, "A4", 0.5], [4, "B4", 1]]],
    [11, [[1, "A4", 0.5], [1.5, "F#4", 0.5], [2, "D4", 1], [3, "E4", 0.5], [3.5, "F#4", 0.5]]],
    [12, [[1, "F#4", 0.5], [1.5, "A4", 0.5], [2, "B4", 1]]],
    [13, [[1, "A4", 0.5], [1.5, "F#4", 0.5], [3, "F#4", 0.5], [3.5, "A4", 0.5]]],
    [14, [[3, "F#4", 0.5], [3.5, "A4", 0.5], [4, "B4", 1]]],
    [15, [[1, "A4", 0.5], [1.5, "F#4", 0.5], [3, "E4", 0.5], [3.5, "F#4", 0.5]]]
  ]);

  for (const [bar, notes] of melody) {
    addRhLine(piano, bar, notes);
  }

  const tracks = [conductor.render(), piano.render()];
  const header = [...ascii("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TPQ)];

  return concatBytes([header, ...tracks]);
}

export function getDefaultFilename() {
  return "sweden_photo_transcription.mid";
}

export function midiSummary(bytes) {
  const trackCount = new TextDecoder("ascii")
    .decode(bytes)
    .split("MTrk").length - 1;

  return {
    bytes: bytes.length,
    format: bytes[9],
    tracks: trackCount,
    ticksPerQuarter: (bytes[12] << 8) | bytes[13]
  };
}
