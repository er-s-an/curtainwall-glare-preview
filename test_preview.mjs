import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solarPosition, localToUtc, sunVector } from "./js/solar.js";
import { SCENES, buildPanels } from "./js/scenes.js";
import { trace } from "./js/trace.js";

const solarCases = [
  ["A", "2026-06-21 12:00", 84.12, 77.752],
  ["A", "2026-12-21 09:30", 28.187, 135.011],
  ["B", "2026-03-21 15:00", 47.48, 243.581],
  ["walkie_talkie", "2013-09-03 13:00", 45.886, 180.137],
  ["walkie_talkie", "2013-06-21 13:00", 61.929, 178.957],
];

for (const [sid, stamp, elev, az] of solarCases) {
  const scene = SCENES[sid];
  const [date, time] = stamp.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utc = localToUtc(year, month, day, hour, minute, scene.tz);
  const pos = solarPosition(utc, scene.lat, scene.lon);
  const dElev = Math.abs(pos.elevationDeg - elev);
  const dAz = Math.abs(pos.azimuthDeg - az);
  console.log(sid, stamp, "dElev", dElev.toFixed(3), "dAz", dAz.toFixed(3));
  assert.ok(dElev < 0.5, `${sid} elevation ${pos.elevationDeg}`);
  assert.ok(dAz < 0.5, `${sid} azimuth ${pos.azimuthDeg}`);
}

assert.equal(buildPanels(SCENES.A).length, 1260);
assert.equal(buildPanels(SCENES.B).length, 1480);
assert.equal(buildPanels(SCENES.C).length, 182);
assert.equal(buildPanels(SCENES.walkie_talkie).length, 494);

const golden = JSON.parse(readFileSync(new URL("./data/golden.json", import.meta.url), "utf8"));
for (const row of golden) {
  const scene = SCENES[row.scene];
  const panels = buildPanels(scene);
  const hit = trace(scene, panels, row.sun, row.alpha_deg, scene.rho, 800);
  const got = hit.counts;
  const want = row.counts;
  console.log(row.scene, row.stamp_local, "α", row.alpha_deg, "got", got, "want", want);
  for (const key of ["panels", "lit", "backlit", "shaded", "street", "neighbor", "sky", "other"]) {
    assert.equal(got[key], want[key], `${row.scene} ${row.stamp_local} α${row.alpha_deg} ${key}`);
  }
}

const hk = localToUtc(2026, 6, 21, 12, 0, "Asia/Hong_Kong");
const pos = solarPosition(hk, 22.3115, 114.1705);
const sun = sunVector(pos.elevationDeg, pos.azimuthDeg);
assert.ok(sun[2] > 0.9);
console.log("preview ok");
