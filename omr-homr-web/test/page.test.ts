/*
 * System/voice normalization tests: Music Reader's post-homr systems fixes
 * (omr-sheet-cam #5, 40ef803) as ported to page.ts. Staffs are fabricated
 * 5-line grids; only minY ordering and isGrandstaff matter here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureSameNumberOfStaffs, splitStackedGrandStaffSystems } from "../src/page.js";
import { MultiStaff, Staff, StaffPoint } from "../src/geometry/staff-model.js";

function staff(y: number, grand = false): Staff {
  const ys = [y, y + 10, y + 20, y + 30, y + 40];
  const s = new Staff([new StaffPoint(0, ys, 0), new StaffPoint(100, ys, 0)]);
  s.isGrandstaff = grand;
  return s;
}

const row = (...staffs: Staff[]): MultiStaff => new MultiStaff(staffs, []);

describe("ensureSameNumberOfStaffs: over-merged row split (40ef803)", () => {
  it("splits a single row of 4 unpaired staffs into grand pairs", () => {
    const rows = ensureSameNumberOfStaffs([row(staff(0), staff(100), staff(200), staff(300))]);
    assert.deepEqual(rows.map((r) => r.staffs.length), [2, 2]);
    assert.ok(rows.every((r) => r.staffs.every((s) => s.isGrandstaff)));
    assert.deepEqual(rows.map((r) => r.staffs[0].minY), [0, 200]);
  });

  it("splits a single row of 6 into 3 pairs", () => {
    const rows = ensureSameNumberOfStaffs([
      row(staff(0), staff(100), staff(200), staff(300), staff(400), staff(500)),
    ]);
    assert.deepEqual(rows.map((r) => r.staffs.length), [2, 2, 2]);
  });

  it("leaves a genuine 2-staff row alone", () => {
    const input = [row(staff(0), staff(100))];
    assert.equal(ensureSameNumberOfStaffs(input), input);
  });

  it("leaves uniform multi-row layouts alone", () => {
    const input = [row(staff(0), staff(100)), row(staff(200), staff(300))];
    assert.equal(ensureSameNumberOfStaffs(input), input);
  });

  it("does not split when the staffs are already grand staffs", () => {
    const input = [row(staff(0, true), staff(100, true), staff(200, true), staff(300, true))];
    // All-grand rows are splitStackedGrandStaffSystems' job, not this one.
    assert.equal(ensureSameNumberOfStaffs(input), input);
  });
});

describe("splitStackedGrandStaffSystems (#5)", () => {
  it("breaks a chained row of grand staffs into sequential single rows", () => {
    const rows = splitStackedGrandStaffSystems([row(staff(300, true), staff(100, true))]);
    assert.deepEqual(rows.map((r) => r.staffs.length), [1, 1]);
    assert.deepEqual(rows.map((r) => r.staffs[0].minY), [100, 300]);
  });

  it("is a no-op when some staff is not a grand staff", () => {
    const input = [row(staff(0, true), staff(100, false))];
    assert.equal(splitStackedGrandStaffSystems(input), input);
  });

  it("is a no-op when every row already holds one grand staff", () => {
    const input = [row(staff(0, true)), row(staff(200, true))];
    assert.equal(splitStackedGrandStaffSystems(input), input);
  });
});
