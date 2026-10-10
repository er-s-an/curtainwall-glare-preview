import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solarPosition, localToUtc, sunVector } from "./js/solar.js";
import {
  toThree,
  reflect,
  tiltNormal,
  prepareTile,
  firstHit,
  rankSubjects,
  facadeClusters,
  traceTile,
  pickHero,
  describePath,
  selectDrawn,
  drawBudget,
  waterReflectance,
  pruneLowSunSky,
} from "./js/optics.js";

const north = toThree(0, 1, 0);
assert.deepEqual(north, [0, 0, -1]);

const sun = sunVector(45, 180);
const n = tiltNormal([0, -1], 0);
assert.ok(Math.abs(n[1] + 1) < 1e-9 && Math.abs(n[2]) < 1e-9);
const { nd, r } = reflect(n, sun);
assert.ok(nd > 0.5);
assert.ok(r[1] < -0.5, "vertical south glass sends the ray south");
assert.ok(r[2] < -0.5, "and downward");

const lifted = tiltNormal([0, -1], 40);
assert.ok(lifted[2] > 0.5, "tilt raises the normal");

const square = prepareTile({
  meta: {},
  roads: [{ width: 18, pts: [[-20, -6], [20, -6]] }],
  water: [[[-80, 30], [80, 30], [80, 140], [-80, 140]]],
  buildings: [
    {
      id: "subject",
      name: "本楼",
      height: 70,
      minHeight: 0,
      source: "height",
      outer: [[-12, 0], [-12, 22], [12, 22], [12, 0]],
      holes: [],
    },
    {
      id: "neighbor",
      name: "邻楼",
      height: 55,
      minHeight: 0,
      source: "height",
      outer: [[-46, -28], [-18, -28], [-18, -8], [-46, -8]],
      holes: [],
    },
  ],
});

const southEdge = square.buildings[0].edges.find((edge) => edge.ny < -0.9 && !edge.hole);
assert.ok(southEdge, "south facade outward normal points south");
assert.ok(southEdge.nx ** 2 < 0.01);

const probe = firstHit([-10, -18, 20], [-1, 0, 0], square, "subject", 0.2, 40);
assert.equal(probe.building.id, "neighbor");
assert.ok(Math.abs(probe.point[0] + 18) < 0.4);

const subject = square.buildings.find((item) => item.id === "subject");
const southFacade = facadeClusters(subject).find((cluster) => cluster.n[1] < -0.8);
assert.ok(southFacade, "subject has a south-facing run");

const sideSun = sunVector(32, 150);
let flatSky = 0;
let tiltedSky = 0;
for (const alpha of [0, 22]) {
  const traced = traceTile(square, {
    building: subject,
    facade: southFacade,
    alpha,
    sun: sideSun,
    dni: 800,
    rho: 0.3,
    stepH: 8,
    stepV: 14,
  });
  if (alpha === 0) flatSky = traced.counts.hop2sky;
  if (alpha === 22) {
    tiltedSky = traced.counts.hop2sky;
    const hero = pickHero(traced.paths, "reflect");
    assert.equal(hero.hops.length, 2);
    assert.equal(hero.hops[1].kind, "sky");
    assert.match(describePath(hero), /邻楼/);
    assert.ok(traced.counts.neighbor > 0);
  }
}
assert.equal(flatSky, 0);
assert.ok(tiltedSky > 0, "tilting the glass sends 本楼 → 邻楼 → 天空");

const central = prepareTile(JSON.parse(readFileSync(new URL("./data/central.json", import.meta.url), "utf8")));
assert.ok(central.buildings.length > 100);
assert.equal(central.meta.waterSource, "coastline");
const harbour = central.water[0];
const hy = harbour.reduce((m, p) => Math.max(m, p[1]), -1e9);
const ly = harbour.reduce((m, p) => Math.min(m, p[1]), 1e9);
assert.ok(hy > 400, "harbour reaches north of the tile");
assert.ok(ly < 80, "harbour meets the Central shore");

const subjects = rankSubjects(central, 8);
assert.ok(subjects.length >= 3);
console.log("top facades:");
for (const row of subjects) {
  console.log(
    row.building.id,
    row.building.name || "(unnamed)",
    row.building.height,
    row.building.source,
    "L",
    row.cluster.length.toFixed(0),
    "n",
    row.cluster.n.map((v) => v.toFixed(2)).join(","),
    "score",
    row.score.toFixed(1),
  );
}

const preset = JSON.parse(readFileSync(new URL("./data/preset.json", import.meta.url), "utf8"));
const chosen = subjects.find((row) => row.building.id === preset.buildingId);
assert.ok(chosen, preset.buildingId);
const utc = localToUtc(preset.year, preset.month, preset.day, preset.hour, preset.minute, "Asia/Hong_Kong");
const pos = solarPosition(utc, central.meta.origin.lat, central.meta.origin.lon);
const fine = traceTile(central, {
  building: chosen.building,
  facade: chosen.cluster,
  alpha: preset.alpha,
  sun: sunVector(pos.elevationDeg, pos.azimuthDeg),
  dni: 700,
  rho: 0.3,
});
const glassToSky = fine.paths.filter(
  (path) => path.hops.length > 1 && path.hops[0].kind === "neighbor" && (path.hops[1].kind === "sky" || path.hops[1].kind === "water"),
);
assert.ok(glassToSky.length >= 1, "preset must show 本楼 → 邻楼玻璃 → 天或水");
assert.ok(fine.paths.some((path) => path.hops.some((hop) => hop.kind === "street")), "preset must also reach the street");
const hero = pickHero(fine.paths, "reflect");
assert.equal(hero.hops.length, 2);
assert.equal(hero.hops[0].kind, "neighbor");
assert.ok(hero.hops[1].kind === "sky" || hero.hops[1].kind === "water");
console.log("preset", preset.name, describePath(hero), fine.counts);

assert.ok(waterReflectance(0.95) < 0.04, "head-on water bounce stays very weak");
assert.ok(waterReflectance(0.12) > waterReflectance(0.95), "grazing water is a bit stronger");
assert.ok(waterReflectance(0.02) <= 0.12);

const northFacade = facadeClusters(subject).find((cluster) => cluster.n[1] > 0.8);
const overWater = traceTile(square, {
  building: subject,
  facade: northFacade,
  alpha: 8,
  sun: sunVector(26, 8),
  dni: 800,
  rho: 0.3,
  stepH: 8,
  stepV: 12,
});
const waterHops = overWater.paths.filter((path) => path.kind === "water" && path.hops.length > 1);
assert.ok(waterHops.length > 0, "north glass can bounce off the harbour");
assert.ok(waterHops.every((path) => path.energy < 0.04), "water second hop stays faint");

const lowSun = sunVector(16, 220);
const blocked = traceTile(square, {
  building: subject,
  facade: southFacade,
  alpha: 0,
  sun: lowSun,
  dni: 500,
  rho: 0.3,
  stepH: 8,
  stepV: 12,
});
assert.ok(blocked.counts.shaded > 0, "a southern neighbor blocks a low southern sun");
assert.ok(blocked.occlusions.length > 0 && blocked.occlusions.length <= 6);

const openTile = prepareTile({
  meta: {},
  roads: [],
  water: [],
  buildings: [{
    id: "subject",
    name: "本楼",
    height: 70,
    minHeight: 0,
    source: "height",
    outer: [[-12, 0], [-12, 22], [12, 22], [12, 0]],
    holes: [],
  }],
});
const openSubject = openTile.buildings[0];
const openSouth = facadeClusters(openSubject).find((cluster) => cluster.n[1] < -0.8);
const open = traceTile(openTile, {
  building: openSubject,
  facade: openSouth,
  alpha: 0,
  sun: lowSun,
  dni: 500,
  rho: 0.3,
  stepH: 8,
  stepV: 12,
});
assert.equal(open.counts.shaded, 0, "without the neighbor the same sun reaches the glass");
assert.ok(open.counts.lit > 0, "low sun still draws a reflection when the facade faces it");

const drawn = selectDrawn(fine.paths, "reflect", hero, true);
const phone = selectDrawn(fine.paths, "reflect", hero, true, { mobile: true });
const budget = drawBudget(false);
const cap = Object.values(budget).reduce((sum, n) => sum + n, 1);
assert.ok(drawn.some((path) => path.featured && path.hops.length === 2));
assert.ok(drawn.length <= cap);
assert.ok(phone.length <= drawn.length);
const streetHero = pickHero(fine.paths, "street");
const streetDrawn = selectDrawn(fine.paths, "street", streetHero, true);
assert.ok(streetDrawn.length >= 1);
assert.ok(streetDrawn.every((path) => path.hops.some((hop) => hop.kind === "street")));
assert.equal(streetDrawn.filter((path) => path.featured).length, 1);

function skyStack(kind) {
  const paths = [];
  for (let i = 0; i < 8; i += 1) {
    const z = 20 + i * 28;
    paths.push({
      origin: [0, 0, z],
      energy: 0.4 - i * 0.01,
      kind,
      hops: kind === "sky"
        ? [{ from: [0, 0, z], to: [12, -40, z + 28], kind: "sky" }]
        : [
          { from: [i * 24, 0, z], to: [i * 24 + 8, 6, z], kind: "neighbor" },
          { from: [i * 24 + 8, 6, z], to: [i * 24 - 20, -10, z + 24], kind: "sky" },
        ],
    });
  }
  return paths;
}

const stacked = skyStack("sky");
const stackedHero = stacked[3];
const noon = selectDrawn(stacked, "reflect", stackedHero, true, { elevationDeg: 32 });
const dawn = selectDrawn(stacked, "reflect", stackedHero, true, { elevationDeg: 4 });
const dawnPhone = selectDrawn(stacked, "reflect", stackedHero, true, { elevationDeg: 4, mobile: true });
const skyHops = (list) => list.flatMap((path) => path.hops.filter((hop) => hop.kind === "sky"));
assert.ok(skyHops(noon).length >= 6, "a high sun still keeps a sky sample from each floor band");
assert.ok(skyHops(dawn).length <= 3, "a low sun keeps the hero sky stroke plus two spaced auxiliaries");
assert.ok(skyHops(dawn).length >= 2, "a low sun still shows more than the hero alone");
assert.equal(dawn.filter((path) => path.featured).length, 1);
const dawnZ = skyHops(dawn).map((hop) => hop.from[2]).sort((a, b) => a - b);
for (let i = 1; i < dawnZ.length; i += 1) assert.ok(dawnZ[i] - dawnZ[i - 1] >= 36, "low-sun sky strokes stay apart in height");
assert.ok(skyHops(dawnPhone).length <= 2, "a phone keeps an even thinner low-sun sky");
assert.ok(skyHops(dawnPhone).some((hop) => hop.from[2] === stackedHero.hops[0].from[2]));

const bounced = skyStack("neighbor");
const bounceHero = bounced[2];
const bounceDawn = selectDrawn(bounced, "reflect", bounceHero, true, { elevationDeg: 3.7 });
assert.equal(bounceDawn.length, bounced.length > 8 ? 8 : bounced.length, "trimming a sky second hop keeps the neighbour stroke");
assert.ok(bounceDawn.every((path) => path.hops[0].kind === "neighbor"));
const bounceSky = skyHops(bounceDawn);
assert.ok(bounceSky.length <= 3 && bounceSky.length >= 1, "neighbour-to-sky combs collapse to a few strokes");
assert.ok(bounceDawn.some((path) => path.featured && path.hops.length === 2));
const untouched = pruneLowSunSky(bounceDawn, {});
assert.equal(untouched, bounceDawn, "omitting elevation leaves the draw alone");

console.log("preset", preset.name, describePath(hero), fine.counts);
console.log("optics ok");
