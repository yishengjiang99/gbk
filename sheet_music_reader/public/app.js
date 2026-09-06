import { buildSwedenMidi, getDefaultFilename, midiSummary } from "../src/swedenMidi.js";

const downloadButton = document.querySelector("#downloadButton");
const playButton = document.querySelector("#playButton");
const status = document.querySelector("#status");

const midi = buildSwedenMidi();
const summary = midiSummary(midi);
status.textContent = `Generated ${summary.bytes} bytes with ${summary.tracks} tracks at ${summary.ticksPerQuarter} TPQ.`;

downloadButton.addEventListener("click", () => {
  const blob = new Blob([midi], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = getDefaultFilename();
  link.click();

  URL.revokeObjectURL(url);
});

playButton.addEventListener("click", async () => {
  status.textContent = "Browser MIDI playback is not standardized, so downloading is the reliable path.";
});
