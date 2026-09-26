import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { autocrop } from "./src/geometry/staff.ts";
import { GrayImage } from "./src/geometry/image.ts";

const png = PNG.sync.read(readFileSync("../test/fixtures/ocr-ground-truth/c-scale.png"));
console.log("orig:", png.width, png.height);
const gray = new Uint8Array(png.width * png.height);
for (let i = 0; i < gray.length; i++) {
  gray[i] = Math.round(0.299 * png.data[i*4] + 0.587 * png.data[i*4+1] + 0.114 * png.data[i*4+2]);
}
const img = new GrayImage(png.width, png.height, gray);
const cropped = autocrop(img);
console.log("ts autocrop:", cropped.width, cropped.height);
console.log("py autocrop: 1096 x 456");
console.log("ts resized h would be:", Math.round(cropped.height * 1920 / cropped.width));
