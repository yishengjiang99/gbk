import test from "node:test";
import assert from "node:assert/strict";
import { applyMasterDynamicsToBuffer, compressionReductionDb, DYNAMICS_CEILING_DB, MasterDynamics, type DynamicsMode } from "../src/master-dynamics.ts";

const SR = 44100;
const ceiling = 10 ** (DYNAMICS_CEILING_DB / 20);

function signal(length: number, amplitude = 1, sampleRate = SR): Float32Array {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * i / sampleRate));
}

function stream(left: Float32Array, right: Float32Array, mode: DynamicsMode, blockSize = 128, sampleRate = SR) {
  const dynamics = new MasterDynamics(sampleRate, mode);
  const outL = new Float32Array(left.length + dynamics.latencyFrames);
  const outR = new Float32Array(outL.length);
  const inputL = new Float32Array(outL.length);
  const inputR = new Float32Array(outR.length);
  inputL.set(left);
  inputR.set(right);
  for (let start = 0; start < outL.length; start += blockSize) {
    const end = Math.min(outL.length, start + blockSize);
    dynamics.process(inputL.subarray(start, end), inputR.subarray(start, end), outL.subarray(start, end), outR.subarray(start, end));
  }
  return { left: outL.slice(dynamics.latencyFrames), right: outR.slice(dynamics.latencyFrames), dynamics };
}

function audioBuffer(left: Float32Array, right: Float32Array, sampleRate = SR): AudioBuffer {
  return { sampleRate, length: left.length, numberOfChannels: 2, getChannelData: (ch: number) => ch === 0 ? left : right } as AudioBuffer;
}

function rms(data: Float32Array): number {
  return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
}

test("soft knee joins smoothly and quiet passages receive no reduction", () => {
  assert.equal(compressionReductionDb(-40, -22, 2, 12), 0);
  assert.equal(compressionReductionDb(-28, -22, 2, 12), 0);
  assert.equal(compressionReductionDb(-16, -22, 2, 12), 3);
  assert.equal(compressionReductionDb(-4, -22, 2, 12), 9);
  for (const edge of [-28, -16]) {
    assert.ok(Math.abs(compressionReductionDb(edge - 0.0001, -22, 2, 12) - compressionReductionDb(edge + 0.0001, -22, 2, 12)) < 0.0002);
  }
});

test("silence stays silent and bypass reproduces samples exactly, including the final frame", async () => {
  const silent = stream(new Float32Array(1000), new Float32Array(1000), "epic");
  assert.ok(silent.left.every((sample) => sample === 0));
  const input = signal(10003, 3);
  input[input.length - 1] = -0.73;
  const right = Float32Array.from(input, (sample) => sample * 0.2);
  const bypass = stream(input, right, "off");
  assert.deepEqual(bypass.left, input);
  assert.deepEqual(bypass.right, right);
  const offline = audioBuffer(input.slice(), right.slice());
  await applyMasterDynamicsToBuffer(offline, "off");
  assert.deepEqual(offline.getChannelData(0), input);
});

test("compression narrows the quiet-to-loud range while leaving quiet detail intact", () => {
  const quiet = signal(SR, 0.02);
  const loud = signal(SR, 0.65);
  const quietOutput = stream(quiet, quiet, "epic").left;
  const loudOutput = stream(loud, loud, "epic").left;
  const tail = SR / 2;
  const quietGain = rms(quietOutput.subarray(tail)) / rms(quiet.subarray(tail));
  const loudGain = rms(loudOutput.subarray(tail)) / rms(loud.subarray(tail));
  assert.ok(Math.abs(20 * Math.log10(quietGain) - 3) < 0.02);
  assert.ok(loudGain < quietGain * 0.6, `quiet gain ${quietGain}, loud gain ${loudGain}`);
  assert.ok(rms(loudOutput) > rms(quietOutput) * 5, "Crescendos must retain substantial contrast");
  const gentle = stream(loud, loud, "gentle");
  assert.ok(gentle.dynamics.compressionReduction < stream(loud, loud, "epic").dynamics.compressionReduction);
});

for (const sampleRate of [44100, 48000, 96000]) {
  test(`limiter catches sudden peaks at ${sampleRate} Hz without moving the stereo image`, () => {
    const left = signal(sampleRate, 4, sampleRate);
    // Include startup and end impulses and peaks on both sides of block boundaries.
    for (const frame of [0, 127, 128, 8191, 8192, left.length - 1]) left[frame] = 15;
    const right = Float32Array.from(left, (sample) => sample * -0.25);
    const output = stream(left, right, "epic", 128, sampleRate);
    for (let i = 0; i < left.length; i += 1) {
      assert.ok(Number.isFinite(output.left[i]));
      assert.ok(Math.abs(output.left[i]) <= ceiling + 1e-7, `Peak at ${i}: ${output.left[i]}`);
      assert.ok(Math.abs(output.right[i] + output.left[i] * 0.25) < 1e-7);
    }
  });
}

test("offline mastering matches 128-frame streaming and retains the entire tail", async () => {
  for (const length of [1, 220, 8192, 17333]) {
    const left = signal(length, 2);
    const right = signal(length, 0.3);
    left[length - 1] = 0.41;
    const expected = stream(left, right, "epic");
    const buffer = audioBuffer(left.slice(), right.slice());
    const progress: number[] = [];
    await applyMasterDynamicsToBuffer(buffer, "epic", (value) => progress.push(value));
    assert.deepEqual(buffer.getChannelData(0), expected.left);
    assert.deepEqual(buffer.getChannelData(1), expected.right);
    assert.equal(progress[progress.length - 1], 1);
  }
});

test("changing modes fades smoothly and settles to exact bypass", () => {
  const dynamics = new MasterDynamics(SR, "epic");
  const input = new Float32Array(SR).fill(0.1);
  const output = new Float32Array(SR);
  const right = new Float32Array(SR);
  dynamics.process(input, input, output, right);
  const previous = output[output.length - 1];
  dynamics.setMode("off");
  dynamics.process(input, input, output, right);
  assert.ok(Math.abs(output[0] - previous) < 0.0001);
  for (let i = 1; i < output.length; i += 1) assert.ok(Math.abs(output[i] - output[i - 1]) < 0.0001);
  assert.equal(output[output.length - 1], input[0]);
});
