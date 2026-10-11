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
  pruneLowSunNeighbor,
  pruneIfc2Column,
  pruneIfc2GlassKink,
  pruneMallScatter,
  pruneMallRoof,
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
const bounceNoon = selectDrawn(bounced, "reflect", bounceHero, true, { elevationDeg: 32 });
const bounceDawn = selectDrawn(bounced, "reflect", bounceHero, true, { elevationDeg: 3.7 });
const bouncePhone = selectDrawn(bounced, "reflect", bounceHero, true, { elevationDeg: 3.7, mobile: true });
const neighHops = (list) => list.flatMap((path) => path.hops.filter((hop) => hop.kind === "neighbor"));
assert.equal(bounceNoon.length, bounced.length, "a high sun still draws each neighbour stroke");
assert.ok(neighHops(bounceDawn).length <= 2, "a low sun keeps the hero neighbour stroke plus one spaced auxiliary");
assert.ok(neighHops(bounceDawn).length >= 2, "the low-sun neighbour comb still has the auxiliary");
assert.ok(bounceDawn.every((path) => path.hops[0].kind === "neighbor"));
const bounceSky = skyHops(bounceDawn);
assert.ok(bounceSky.length <= 3 && bounceSky.length >= 1, "neighbour-to-sky combs collapse to a few strokes");
const dawnHero = bounceDawn.find((path) => path.featured);
assert.ok(dawnHero && dawnHero.hops.length === 2, "the hero multi-hop stays intact");
assert.deepEqual(dawnHero.hops[0].to, bounceHero.hops[0].to, "the pink stroke is not shortened");
assert.deepEqual(dawnHero.hops[1].to, bounceHero.hops[1].to, "the second hop is not shortened");
const pinkZ = neighHops(bounceDawn).map((hop) => hop.from[2]).sort((a, b) => a - b);
for (let i = 1; i < pinkZ.length; i += 1) assert.ok(pinkZ[i] - pinkZ[i - 1] >= 42, "low-sun neighbour strokes stay apart in height");
assert.ok(neighHops(bouncePhone).length <= neighHops(bounceDawn).length);
assert.ok(neighHops(bouncePhone).length <= 2, "a phone keeps an even thinner low-sun neighbour comb");
assert.ok(bouncePhone.some((path) => path.featured && path.hops.length === 2));
const untouched = pruneLowSunSky(bounceDawn, {});
assert.equal(untouched, bounceDawn, "omitting elevation leaves the draw alone");
const untouchedNeighbor = pruneLowSunNeighbor(bounceDawn, {});
assert.equal(untouchedNeighbor, bounceDawn, "omitting elevation leaves neighbour strokes alone");

function towerStack(name, land, waterAt) {
  const paths = [];
  for (let i = 0; i < 6; i += 1) {
    const z = 110 + i * 18;
    const toWater = i === waterAt;
    paths.push({
      origin: [0, 0, z],
      energy: 0.02,
      kind: "neighbor",
      neighborName: name,
      hops: [
        { from: [0, 0, z], to: [land[0], land[1], z - 70], kind: "neighbor" },
        {
          from: [land[0], land[1], z - 70],
          to: toWater ? [-300, 440, 0] : [land[0] - 18, land[1] + 28, 30],
          kind: toWater ? "water" : "roof",
        },
      ],
    });
  }
  return paths;
}

const ifcPaths = towerStack("國際金融中心二期", [-105, 144], 5);
const ifcHero = pickHero(ifcPaths, "reflect");
const ifcNoon = selectDrawn(ifcPaths, "reflect", ifcHero, true, { elevationDeg: 30.2 });
const ifcPhone = selectDrawn(ifcPaths, "reflect", ifcHero, true, { elevationDeg: 30.2, mobile: true });
const ifcHops = (list) => list.filter((path) => (path.neighborName || "").includes("二期") && path.hops[0].kind === "neighbor");
assert.equal(ifcHops(ifcNoon).length, 2, "afternoon IFC2 keeps the hero plus one spaced auxiliary");
assert.equal(ifcHops(ifcPhone).length, 2, "a phone keeps the IFC2 hero plus one farther auxiliary");
const ifcKept = ifcHops(ifcNoon).find((path) => path.featured);
assert.ok(ifcKept && ifcKept.hops.length === 2 && ifcKept.hops[1].kind === "water");
assert.deepEqual(ifcKept.hops[0].to, ifcHero.hops[0].to, "the IFC2 pink stroke is not shortened");
assert.deepEqual(ifcKept.hops[1].to, ifcHero.hops[1].to, "the harbour hop is not shortened");
const ifcZ = ifcHops(ifcNoon).map((path) => path.hops[0].from[2]).sort((a, b) => a - b);
assert.ok(ifcZ[1] - ifcZ[0] >= 48, "afternoon IFC2 strokes stay apart in height");
const phoneZ = ifcHops(ifcPhone).map((path) => path.hops[0].from[2]).sort((a, b) => a - b);
assert.ok(phoneZ[1] - phoneZ[0] >= 64, "the phone auxiliary sits farther from the hero");
const pair = ifcPaths.slice(4);
const pairHero = pickHero(pair, "reflect");
const pairDrawn = selectDrawn(pair, "reflect", pairHero, true, { elevationDeg: 30.2 });
assert.equal(pairDrawn.length, 2, "two IFC2 strokes are already readable");
const mallPaths = towerStack("國際金融中心商場", [-150, 130], 5);
const mallHero = pickHero(mallPaths, "reflect");
const mallTagged = mallPaths.map((path) => ({ ...path, featured: path === mallHero }));
assert.equal(pruneIfc2Column(mallTagged, { elevationDeg: 30.2 }).length, mallTagged.length, "other towers keep their afternoon strokes");
const mallDrawn = selectDrawn(mallPaths, "reflect", mallHero, true, { elevationDeg: 30.2 });
const mallKept = mallDrawn.find((path) => path.featured);
assert.ok(mallKept && mallKept.hops.length === 2 && mallKept.hops[1].kind === "water");
assert.deepEqual(mallKept.hops[0].to, mallHero.hops[0].to, "the mall hero stroke is not shortened");
assert.deepEqual(mallKept.hops[1].to, mallHero.hops[1].to, "the mall hero's second hop is not shortened");
assert.ok(mallDrawn.length <= 2, "a mall column keeps the hero plus one spaced auxiliary");

function mallFan() {
  const specs = [
    { z: 73, land: [-149, 133, 14], hop2: { to: [-150, 135, 14], kind: "neighbor" } },
    { z: 58, land: [-154, 138, 4], hop2: { to: [-152, 126, 0], kind: "ground" } },
    { z: 28, land: [-289, 107, 26], hop2: { to: [-284, 84, 17], kind: "neighbor" } },
  ];
  return specs.map((spec) => ({
    origin: [0, 0, spec.z],
    energy: 0.018,
    kind: "neighbor",
    neighborName: "國際金融中心商場",
    featured: false,
    hops: [
      { from: [0, 0, spec.z], to: spec.land, kind: "neighbor" },
      { from: spec.land, to: spec.hop2.to, kind: spec.hop2.kind },
    ],
  }));
}

const fan = mallFan();
const gathered = pruneMallScatter(fan, { elevationDeg: 30.2 });
assert.equal(gathered.length, 1, "scattered mall wings gather to one polyline");
assert.equal(gathered[0].hops[1].kind, "ground", "the kept mall stroke is the one with a real landing");
assert.deepEqual(gathered[0].hops[0].to, fan[1].hops[0].to, "the kept mall stroke is not shortened");
assert.deepEqual(gathered[0].hops[1].to, fan[1].hops[1].to);
const sameWing = pruneMallScatter(fan.slice(0, 2), { elevationDeg: 30.2 });
assert.equal(sameWing.length, 2, "two mall strokes on one wing stay");
const twoWings = pruneMallScatter([fan[1], fan[2]], { elevationDeg: 30.2 });
assert.equal(twoWings.length, 1);
assert.equal(twoWings[0].hops[1].kind, "ground");
const featuredFar = fan.map((path, index) => ({ ...path, featured: index === 2 }));
const farKept = pruneMallScatter(featuredFar, { elevationDeg: 30.2 });
const farHero = farKept.find((path) => path.featured);
assert.ok(farHero && farHero.hops.length === 2, "a featured mall polyline stays whole");
assert.deepEqual(farHero.hops[1].to, fan[2].hops[1].to);
assert.equal(pruneMallScatter(mallTagged, { elevationDeg: 30.2 }).find((path) => path.featured).hops.length, 2);
const stubOnly = pruneMallScatter([fan[0]], { mobile: true });
assert.equal(stubOnly.length, 1);
assert.equal(stubOnly[0].hops.length, 1, "a few-metre re-hit on the podium is not drawn as a hop");
assert.deepEqual(stubOnly[0].hops[0].to, fan[0].hops[0].to);
const ifcTagged = ifcPaths.map((path) => ({ ...path, featured: path === ifcHero }));
assert.equal(pruneMallScatter(ifcTagged, { elevationDeg: 30.2 }).length, ifcTagged.length, "二期 strokes are not mall strokes");

const presetDrawn = selectDrawn(fine.paths, "reflect", hero, true, { elevationDeg: pos.elevationDeg });
const presetPhone = selectDrawn(fine.paths, "reflect", hero, true, { mobile: true, elevationDeg: pos.elevationDeg });
const presetIfc = (list) => list.filter((path) => (path.neighborName || "").includes("二期") && path.hops[0] && path.hops[0].kind === "neighbor");
assert.ok(pos.elevationDeg > 20, "the preset afternoon sun is well above the low-sun prune");
assert.equal(presetIfc(presetDrawn).length, 2, "the real 15:00 comb onto 二期 thins to two strokes");
assert.equal(presetIfc(presetPhone).length, 2, "the phone 15:00 comb onto 二期 thins to two strokes");
const presetHero = presetDrawn.find((path) => path.featured);
assert.equal(presetHero.hops[1].kind, "water");
assert.deepEqual(presetHero.hops[0].to, hero.hops[0].to);
assert.deepEqual(presetHero.hops[1].to, hero.hops[1].to);
const presetZ = presetIfc(presetDrawn).map((path) => path.hops[0].from[2]).sort((a, b) => a - b);
assert.ok(presetZ[1] - presetZ[0] >= 48);
const afternoonStreet = selectDrawn(fine.paths, "street", streetHero, true, { elevationDeg: pos.elevationDeg });
assert.ok(afternoonStreet.some((path) => path.featured && path.hops.some((hop) => hop.kind === "street")));
assert.ok(afternoonStreet.filter((path) => (path.neighborName || "").includes("二期")).length >= 1);
const mallPink = (list) => list.filter((path) => (path.neighborName || "").includes("商場") && path.hops[0] && path.hops[0].kind === "neighbor");
const deskMall = mallPink(presetDrawn);
const phoneMall = mallPink(presetPhone);
assert.equal(deskMall.length, 1, "the real 15:00 mall fan gathers to one pink stroke");
assert.equal(phoneMall.length, 1, "the phone keeps that same mall stroke");
assert.equal(deskMall[0].hops[1].kind, "ground");
assert.deepEqual(phoneMall[0].hops[0].to, deskMall[0].hops[0].to);
assert.deepEqual(phoneMall[0].hops[1].to, deskMall[0].hops[1].to);
const rawMall = fine.paths.find((path) => path.hops[0] && path.hops[0].to[0] === deskMall[0].hops[0].to[0] && path.hops[0].to[1] === deskMall[0].hops[0].to[1] && path.hops[0].from[2] === deskMall[0].hops[0].from[2]);
assert.ok(rawMall);
assert.deepEqual(deskMall[0].hops[0].to, rawMall.hops[0].to, "the mall pink stroke is not shortened");
assert.deepEqual(deskMall[0].hops[1].to, rawMall.hops[1].to);
const mallSpread = (list) => {
  let max = 0;
  for (const a of list) {
    for (const b of list) {
      max = Math.max(max, Math.hypot(a.hops[0].to[0] - b.hops[0].to[0], a.hops[0].to[1] - b.hops[0].to[1]));
    }
  }
  return max;
};
assert.ok(mallSpread(deskMall) < 40);

function mallRoofPaths(list) {
  return list.filter((path) => (path.neighborName || "").includes("商場") && path.hops[0] && path.hops[0].kind === "roof");
}
const roofPair = [
  {
    energy: 0.05,
    kind: "roof",
    neighborName: "國際金融中心商場",
    hops: [{ from: [-250, 90, 42.8], to: [-272, 106.1, 30.6], kind: "roof" }],
  },
  {
    energy: 0.05,
    kind: "roof",
    neighborName: "國際金融中心商場",
    hops: [{ from: [-180, 70, 57.8], to: [-232.7, 115.1, 30.6], kind: "roof" }],
  },
];
const roofOne = pruneMallRoof(roofPair);
assert.equal(roofOne.length, 1, "two separated mall roof strokes collapse to one");
assert.deepEqual(roofOne[0].hops[0].to, roofPair[1].hops[0].to, "the longer mall roof stroke is the one that stays");
assert.deepEqual(roofOne[0].hops[0].from, roofPair[1].hops[0].from, "the kept mall roof stroke is not shortened");
assert.equal(pruneMallRoof(roofPair.slice(0, 1)).length, 1, "a single mall roof stroke stays");
const featuredStub = roofPair.map((path, index) => ({ ...path, featured: index === 0 }));
const featuredRoof = pruneMallRoof(featuredStub);
assert.equal(featuredRoof.length, 1);
assert.equal(featuredRoof[0].featured, true, "a featured mall roof stroke stays even when it is the shorter one");
assert.deepEqual(featuredRoof[0].hops[0].to, roofPair[0].hops[0].to);
const otherRoofs = roofPair.map((path) => ({ ...path, neighborName: "交易廣場" }));
assert.equal(pruneMallRoof(otherRoofs).length, 2, "roof strokes on other buildings stay");
assert.equal(pruneMallRoof(ifcTagged, { elevationDeg: 30.2 }).length, ifcTagged.length, "二期 strokes are not mall roof strokes");
assert.equal(pruneMallRoof(fan, { elevationDeg: 30.2 }).length, fan.length, "mall pink strokes are not roof strokes");
const besideGlass = {
  energy: 0.05,
  kind: "roof",
  neighborName: "國際金融中心商場",
  hops: [{ from: [-20, 40, 104], to: [-106.9, 143.1, 30], kind: "roof" }],
};
const westRoof = {
  energy: 0.05,
  kind: "roof",
  neighborName: "國際金融中心商場",
  hops: [{ from: [-180, 70, 50], to: [-251.9, 111.1, 30.6], kind: "roof" }],
};
const westSpeck = {
  energy: 0.05,
  kind: "roof",
  neighborName: "國際金融中心商場",
  hops: [{ from: [-280, 108, 32], to: [-286.5, 109.2, 30], kind: "roof" }],
};
const glassAnchor = {
  energy: 0.02,
  kind: "neighbor",
  neighborName: "國際金融中心二期",
  hops: [{ from: [0, 0, 104], to: [-103.5, 149.9, 32.9], kind: "neighbor" }],
};
const farRoof = pruneMallRoof([besideGlass, westRoof, westSpeck, glassAnchor]);
const westKept = farRoof.filter((path) => (path.neighborName || "").includes("商場"));
assert.equal(westKept.length, 1, "the mall roof beside the glass loses to the farther roof");
assert.deepEqual(westKept[0].hops[0].to, westRoof.hops[0].to, "the longer west-roof stroke is the one that stays");
assert.deepEqual(westKept[0].hops[0].from, westRoof.hops[0].from, "the farther mall roof stroke is not shortened");
assert.equal(farRoof.find((path) => (path.neighborName || "").includes("二期")).hops.length, 1, "the glass anchor is not a mall roof");
const crowded = pruneMallRoof([
  besideGlass,
  {
    energy: 0.05,
    kind: "roof",
    neighborName: "國際金融中心商場",
    hops: [{ from: [-100, 120, 40], to: [-142.2, 140.2, 30], kind: "roof" }],
  },
  glassAnchor,
]);
assert.deepEqual(
  crowded.find((path) => (path.neighborName || "").includes("商場")).hops[0].to,
  besideGlass.hops[0].to,
  "with no farther roof, the longer mall roof stroke stays",
);
assert.deepEqual(
  crowded.find((path) => (path.neighborName || "").includes("商場")).hops[0].from,
  besideGlass.hops[0].from,
);
const deskRoof = mallRoofPaths(presetDrawn);
const phoneRoof = mallRoofPaths(presetPhone);
assert.equal(deskRoof.length, 1, "the real 15:00 mall roof keeps one short stroke");
assert.equal(phoneRoof.length, 1, "the phone keeps that same mall roof stroke");
assert.deepEqual(phoneRoof[0].hops[0].to, deskRoof[0].hops[0].to);
assert.deepEqual(phoneRoof[0].hops[0].from, deskRoof[0].hops[0].from);
const rawRoof = fine.paths.find((path) => path.hops[0]
  && path.hops[0].kind === "roof"
  && path.hops[0].from[2] === deskRoof[0].hops[0].from[2]
  && path.hops[0].to[0] === deskRoof[0].hops[0].to[0]
  && path.hops[0].to[1] === deskRoof[0].hops[0].to[1]);
assert.ok(rawRoof, "the kept mall roof stroke is one of the traced hits");
assert.deepEqual(deskRoof[0].hops[0].to, rawRoof.hops[0].to, "the mall roof stroke is not shortened");
assert.deepEqual(deskRoof[0].hops[0].from, rawRoof.hops[0].from);
const roofSpread = (list) => {
  let max = 0;
  for (const path of fine.paths) {
    if (!path.hops[0] || path.hops[0].kind !== "roof" || !(path.neighborName || "").includes("商場")) continue;
    max = Math.max(max, Math.hypot(path.hops[0].to[0] - list[0].hops[0].to[0], path.hops[0].to[1] - list[0].hops[0].to[1]));
  }
  return max;
};
assert.ok(roofSpread(deskRoof) > 20, "another mall roof landing exists and is not drawn");
assert.equal(presetIfc(presetDrawn).length, 2, "collapsing the mall roof leaves the 二期 pair");
assert.equal(presetHero.hops[1].kind, "water");
assert.equal(deskMall.length, 1, "collapsing the mall roof does not spread the pink mall stroke");

function hopLen(hop) {
  return Math.hypot(hop.to[0] - hop.from[0], hop.to[1] - hop.from[1], hop.to[2] - hop.from[2]);
}
const glassKink = {
  energy: 0.02,
  kind: "neighbor",
  neighborName: "國際金融中心二期",
  hops: [
    { from: [0, 0, 102.8], to: [-104, 149, 30.4], kind: "neighbor" },
    { from: [-104, 149, 30.4], to: [-104.7, 150.1, 30], kind: "roof" },
  ],
};
const otherRoof = {
  energy: 0.02,
  kind: "neighbor",
  neighborName: "國際金融中心二期",
  hops: [
    { from: [0, 0, 117.7], to: [-104.8, 143.9, 42], kind: "neighbor" },
    { from: [-104.8, 143.9, 42], to: [-123.1, 170.9, 30], kind: "roof" },
  ],
};
const nearRoof = {
  energy: 0.02,
  kind: "neighbor",
  neighborName: "國際金融中心二期",
  hops: [
    { from: [0, 0, 104.5], to: [-103.5, 149.9, 32.9], kind: "neighbor" },
    { from: [-103.5, 149.9, 32.9], to: [-107.1, 157.3, 30], kind: "roof" },
  ],
};
const harbourLine = {
  featured: true,
  energy: 0.05,
  kind: "neighbor",
  neighborName: "國際金融中心二期",
  hops: [
    { from: [0, 0, 207.8], to: [-104.9, 143.6, 132.1], kind: "neighbor" },
    { from: [-104.9, 143.6, 132.1], to: [-303.2, 439.9, 0.1], kind: "water" },
  ],
};
const kinkTrimmed = pruneIfc2GlassKink([glassKink, otherRoof, harbourLine, fan[1], roofPair[1], nearRoof]);
assert.equal(kinkTrimmed[0].hops.length, 1, "a roof fold about a metre off the glass is not a hop");
assert.deepEqual(kinkTrimmed[0].hops[0].to, glassKink.hops[0].to, "the pink stroke is not shortened");
assert.deepEqual(kinkTrimmed[0].hops[0].from, glassKink.hops[0].from);
assert.equal(kinkTrimmed[1].hops.length, 2, "a second hop that reaches another roof stays");
assert.deepEqual(kinkTrimmed[1].hops[1].to, otherRoof.hops[1].to, "the other roof landing is not shortened");
assert.equal(kinkTrimmed[2].hops[1].kind, "water");
assert.deepEqual(kinkTrimmed[2].hops[1].to, harbourLine.hops[1].to, "the harbour polyline stays whole");
assert.equal(kinkTrimmed[3].hops.length, 2, "a mall pink stroke is not an IFC2 kink");
assert.equal(kinkTrimmed[4].hops.length, 1, "the remaining mall roof stroke is not split");
assert.deepEqual(kinkTrimmed[4].hops[0].to, roofPair[1].hops[0].to);
assert.ok(hopLen(nearRoof.hops[1]) > 8 && hopLen(nearRoof.hops[1]) < 10, "the sample is the nine-metre roof landing");
assert.equal(kinkTrimmed[5].hops.length, 1, "a roof landing about nine metres off the glass is not a hop");
assert.deepEqual(kinkTrimmed[5].hops[0].to, nearRoof.hops[0].to, "the nine-metre pink stroke is not shortened");
assert.deepEqual(kinkTrimmed[5].hops[0].from, nearRoof.hops[0].from);
const featuredKink = pruneIfc2GlassKink([{ ...glassKink, featured: true }]);
assert.equal(featuredKink[0].hops.length, 2, "the featured polyline is not the fold this pass removes");

const deskAux = presetIfc(presetDrawn).find((path) => !path.featured);
assert.ok(deskAux);
assert.equal(deskAux.hops.length, 1, "the real 15:00 desktop auxiliary loses the glass-hugging roof fold");
assert.equal(deskAux.hops[0].kind, "neighbor");
const rawAux = fine.paths.find((path) => path.hops[0]
  && path.hops[0].kind === "neighbor"
  && path.hops[0].from[2] === deskAux.hops[0].from[2]
  && path.hops[0].to[0] === deskAux.hops[0].to[0]
  && path.hops[1]
  && path.hops[1].kind === "roof"
  && hopLen(path.hops[1]) < 4);
assert.ok(rawAux, "the dropped fold is the traced one-metre roof kink");
assert.ok(hopLen(rawAux.hops[1]) < 2);
assert.deepEqual(deskAux.hops[0].to, rawAux.hops[0].to, "the auxiliary pink stroke is not shortened");
assert.deepEqual(deskAux.hops[0].from, rawAux.hops[0].from);
const phoneAux = presetIfc(presetPhone).find((path) => !path.featured);
assert.ok(phoneAux && phoneAux.hops[1] && phoneAux.hops[1].kind === "roof");
assert.ok(hopLen(phoneAux.hops[1]) > 20, "the phone auxiliary's other roof landing stays");
assert.deepEqual(phoneAux.hops[1].to, fine.paths.find((path) => path.hops[0] && path.hops[0].from[2] === phoneAux.hops[0].from[2] && path.hops[1] && path.hops[1].to[0] === phoneAux.hops[1].to[0]).hops[1].to);
assert.equal(deskMall.length, 1, "dropping the glass kink does not spread the pink mall stroke");
assert.equal(deskRoof.length, 1, "dropping the glass kink does not split the mall roof stroke");
assert.equal(phoneMall.length, 1);
assert.equal(phoneRoof.length, 1);
assert.deepEqual(phoneRoof[0].hops[0].to, deskRoof[0].hops[0].to);
assert.deepEqual(phoneMall[0].hops[0].to, deskMall[0].hops[0].to);

const phoneTrace = traceTile(central, {
  building: chosen.building,
  facade: chosen.cluster,
  alpha: preset.alpha,
  sun: sunVector(pos.elevationDeg, pos.azimuthDeg),
  dni: 700,
  rho: 0.3,
  stepH: 14,
  stepV: 18,
});
const phoneHero = pickHero(phoneTrace.paths, "reflect");
const phoneDrawn = selectDrawn(phoneTrace.paths, "reflect", phoneHero, true, { mobile: true, elevationDeg: pos.elevationDeg });
const phoneIfc = presetIfc(phoneDrawn);
assert.equal(phoneIfc.length, 2, "the phone still keeps the IFC2 hero plus one auxiliary");
const phoneLiveHero = phoneIfc.find((path) => path.featured);
const phoneLiveAux = phoneIfc.find((path) => !path.featured);
assert.equal(phoneLiveHero.hops[1].kind, "water", "the phone harbour hop stays");
assert.equal(phoneLiveHero.hops.length, 2);
assert.deepEqual(phoneLiveHero.hops[0].to, phoneHero.hops[0].to, "the phone harbour stroke is not shortened");
assert.deepEqual(phoneLiveHero.hops[1].to, phoneHero.hops[1].to, "the phone harbour landing is not shortened");
assert.equal(phoneLiveAux.hops.length, 1, "the phone auxiliary loses the nine-metre roof hop");
assert.equal(phoneLiveAux.hops[0].kind, "neighbor");
const rawPhoneAux = phoneTrace.paths.find((path) => path.hops[0]
  && path.hops[0].kind === "neighbor"
  && (path.neighborName || "").includes("二期")
  && path.hops[0].from[2] === phoneLiveAux.hops[0].from[2]
  && path.hops[0].to[0] === phoneLiveAux.hops[0].to[0]
  && path.hops[1]
  && path.hops[1].kind === "roof");
assert.ok(rawPhoneAux, "the dropped hop is the traced roof landing");
assert.ok(hopLen(rawPhoneAux.hops[1]) > 8 && hopLen(rawPhoneAux.hops[1]) < 10, "that landing sits about nine metres off the glass");
assert.deepEqual(phoneLiveAux.hops[0].to, rawPhoneAux.hops[0].to, "the phone auxiliary pink stroke is not shortened");
assert.deepEqual(phoneLiveAux.hops[0].from, rawPhoneAux.hops[0].from);
const phoneMallLive = mallPink(phoneDrawn);
const phoneRoofLive = mallRoofPaths(phoneDrawn);
assert.equal(phoneMallLive.length, 1, "the phone mall pink stroke stays one line");
assert.equal(phoneRoofLive.length, 1, "the phone keeps one mall roof stroke, the one farther from the glass");
assert.equal(phoneRoofLive[0].hops.length, 1);
function glassClearance(list, hop) {
  let best = Infinity;
  for (const path of list) {
    if (!(path.neighborName || "").includes("二期") || !path.hops) continue;
    for (const glass of path.hops) {
      if (glass.kind !== "neighbor") continue;
      best = Math.min(best, Math.hypot(hop.to[0] - glass.to[0], hop.to[1] - glass.to[1], hop.to[2] - glass.to[2]));
    }
  }
  return best;
}
assert.ok(glassClearance(fine.paths, deskRoof[0].hops[0]) > 100, "the desk mall roof stays on the west roof");
assert.ok(hopLen(deskRoof[0].hops[0]) > 70 && hopLen(deskRoof[0].hops[0]) < 90, "the desk west-roof stroke stays about seventy-eight metres");
assert.ok(glassClearance(phoneTrace.paths, phoneRoofLive[0].hops[0]) > 100, "the phone mall roof lands far from the 二期 glass");
assert.ok(hopLen(phoneRoofLive[0].hops[0]) > 40 && hopLen(phoneRoofLive[0].hops[0]) < 80, "the phone keeps the west-roof run, not the two-hundred-metre stroke beside the glass");
const rawPhoneRoof = phoneTrace.paths.find((path) => path.hops[0]
  && path.hops[0].kind === "roof"
  && (path.neighborName || "").includes("商場")
  && path.hops[0].from[2] === phoneRoofLive[0].hops[0].from[2]
  && path.hops[0].to[0] === phoneRoofLive[0].hops[0].to[0]
  && path.hops[0].to[1] === phoneRoofLive[0].hops[0].to[1]);
assert.ok(rawPhoneRoof, "the phone mall roof stroke is one of the traced hits");
assert.deepEqual(phoneRoofLive[0].hops[0].to, rawPhoneRoof.hops[0].to, "the phone mall roof stroke is not shortened");
assert.deepEqual(phoneRoofLive[0].hops[0].from, rawPhoneRoof.hops[0].from);
assert.ok(phoneTrace.paths.some((path) => path.hops[0]
  && path.hops[0].kind === "roof"
  && (path.neighborName || "").includes("商場")
  && glassClearance(phoneTrace.paths, path.hops[0]) < 12), "the crowded landing beside the glass is still traced, and not drawn");
assert.equal(phoneMallLive.length, 1, "choosing the far mall roof does not spread the pink mall stroke");
assert.notEqual(phoneMallLive[0].hops[0].kind, "roof");

console.log("preset", preset.name, describePath(hero), fine.counts);
console.log("ifc2", presetIfc(presetDrawn).length, "phone", presetIfc(presetPhone).length);
console.log("optics ok");
