/* Quick smoke test of TS geometry against the Python oracle labels. */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { GrayImage } from "./src/geometry/image.ts";
import { preprocessPageImage, detectStaffsInImage } from "./src/page.ts";
import { prepareStaffImage } from "./src/geometry/dewarp.ts";
import { StaffRegions } from "./src/geometry/staff-model.ts";
import { masksFromLabels } from "./src/geometry/segnet.ts";

function loadPngGray(path: string): GrayImage {
  const png = PNG.sync.read(readFileSync(path));
  const out = new Uint8Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = png.data[i * 4]; // label PNG is grayscale
  }
  return new GrayImage(png.width, png.height, out);
}

function loadPngAsInput(path: string): { data: Uint8Array; width: number; height: number; format: "rgba" } {
  const png = PNG.sync.read(readFileSync(path));
  return { data: png.data, width: png.width, height: png.height, format: "rgba" as const };
}

const src = loadPngAsInput("../test/fixtures/ocr-ground-truth/c-scale.png");
const page = preprocessPageImage(src.data, src.width, src.height, src.format);
console.log("preprocessed:", page.preprocessed.width, "x", page.preprocessed.height);

const labels = loadPngGray("test/fixtures/c-scale_segnet_labels.png");
console.log("labels:", labels.width, "x", labels.height);
const labelArr = new Int32Array(labels.data.length);
for (let i = 0; i < labelArr.length; i++) labelArr[i] = labels.data[i];
const masks = masksFromLabels(labelArr, labels.width, labels.height);

const { multiStaffs, staffs } = detectStaffsInImage(masks, page.preprocessed);
console.log("staffs:", staffs.length, "multiStaffs:", multiStaffs.map((m) => m.staffs.length));
for (const s of staffs) {
  console.log(
    `  x:[${s.minX},${s.maxX}] y:[${s.minY.toFixed(1)},${s.maxY.toFixed(1)}] unit=${s.averageUnitSize.toFixed(2)} grand=${s.isGrandstaff} notes=${s.getNotes().length}`,
  );
}
if (staffs.length > 0) {
  const crop = prepareStaffImage(staffs[0], page.preprocessed, new StaffRegions(multiStaffs));
  console.log("crop:", crop.image.width, "x", crop.image.height);
  // Compare against the Python oracle crop.
  const oracle = loadPngGray("test/fixtures/c-scale-staff-0_oracle.png");
  let abs = 0;
  let max = 0;
  for (let i = 0; i < crop.image.data.length; i++) {
    const d = Math.abs(crop.image.data[i] - oracle.data[i]);
    abs += d;
    if (d > max) max = d;
  }
  console.log(
    `crop-vs-oracle: meanAbs=${(abs / crop.image.data.length).toFixed(3)} maxAbs=${max}`,
  );
}
