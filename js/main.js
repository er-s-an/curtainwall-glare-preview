import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { solarPosition, sunVector, previewDni, localToUtc, dayOfYear, fromDayOfYear } from "./solar.js";
import {
  toThree,
  prepareTile,
  rankSubjects,
  traceTile,
  pickHero,
  selectDrawn,
  describePath,
  tiltNormal,
  tiltedPoint,
} from "./optics.js";

const $ = (id) => document.getElementById(id);
const state = {
  buildingId: "",
  alpha: 24,
  month: 12,
  day: 21,
  hour: 10,
  minute: 0,
  rho: 0.3,
  mode: "reflect",
  showHop2: true,
  showIncoming: true,
};

const view = {
  tile: null,
  subjects: [],
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  sunLight: null,
  curtain: null,
  paths: null,
  markers: null,
  sunOrb: null,
  result: null,
  hero: null,
  framed: false,
};

const KIND_COLOR = {
  incoming: 0xf0c14b,
  street: 0xe25a12,
  neighbor: 0xc4496a,
  sky: 0x1f8f86,
  water: 0x2f6fbe,
  ground: 0x8d8374,
  roof: 0x6e645c,
};

function v3(e, n, u = 0) {
  const [x, y, z] = toThree(e, n, u);
  return new THREE.Vector3(x, y, z);
}

function currentSubject() {
  return view.subjects.find((row) => row.building.id === state.buildingId) || view.subjects[0];
}

function momentSun() {
  const origin = view.tile.meta.origin;
  const utc = localToUtc(2026, state.month, state.day, state.hour, state.minute, "Asia/Hong_Kong");
  const pos = solarPosition(utc, origin.lat, origin.lon);
  return { pos, sun: sunVector(pos.elevationDeg, pos.azimuthDeg), dni: previewDni(pos.elevationDeg) };
}

function makeTexture(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  g.fillStyle = kind === "stone" ? "#c4b6a6" : "#b7c6d0";
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = kind === "stone" ? "rgba(70,58,46,0.28)" : "rgba(28,40,48,0.28)";
  for (let y = 0; y < 128; y += 16) g.fillRect(0, y, 64, 2);
  g.fillStyle = "rgba(255,255,255,0.18)";
  for (let x = 4; x < 64; x += 8) g.fillRect(x, 0, 1, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function pushTri(positions, uvs, a, b, c, uvA, uvB, uvC) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
}

function addWall(positions, uvs, ax, ay, bx, by, z0, z1) {
  const length = Math.hypot(bx - ax, by - ay);
  const a0 = v3(ax, ay, z0);
  const a1 = v3(ax, ay, z1);
  const b1 = v3(bx, by, z1);
  const b0 = v3(bx, by, z0);
  const u = length / 4.2;
  const v = (z1 - z0) / 3.4;
  // CCW from outside: a0 → a1 → b1 and a0 → b1 → b0. See test comment in optics frame.
  pushTri(positions, uvs, a0, a1, b1, [0, 0], [0, v], [u, v]);
  pushTri(positions, uvs, a0, b1, b0, [0, 0], [u, v], [u, 0]);
}

function addRoof(positions, building) {
  const contour = building.outer.map(([e, n]) => new THREE.Vector2(e, n));
  const holes = building.holes.map((ring) => ring.map(([e, n]) => new THREE.Vector2(e, n)));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const flat = [...building.outer, ...building.holes.flat()];
  for (const [i, j, k] of faces) {
    const pa = v3(flat[i][0], flat[i][1], building.height);
    const pb = v3(flat[j][0], flat[j][1], building.height);
    const pc = v3(flat[k][0], flat[k][1], building.height);
    const normal = new THREE.Vector3().crossVectors(pb.clone().sub(pa), pc.clone().sub(pa));
    const order = normal.y >= 0 ? [pa, pb, pc] : [pa, pc, pb];
    positions.push(order[0].x, order[0].y, order[0].z, order[1].x, order[1].y, order[1].z, order[2].x, order[2].y, order[2].z);
  }
}

function meshFrom(positions, uvs, material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (uvs) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildCity(tile) {
  const glassTex = makeTexture("glass");
  const stoneTex = makeTexture("stone");
  const measured = new THREE.MeshStandardMaterial({ map: glassTex, color: 0xd5e0e7, roughness: 0.38, metalness: 0.22 });
  const inferred = new THREE.MeshStandardMaterial({ map: glassTex, color: 0xe4d3c2, roughness: 0.62, metalness: 0.05 });
  const stone = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xcec3b4, roughness: 0.86, metalness: 0 });
  const buckets = {
    measured: { positions: [], uvs: [], roofs: [] },
    inferred: { positions: [], uvs: [], roofs: [] },
    stone: { positions: [], uvs: [], roofs: [] },
  };
  for (const building of tile.buildings) {
    const key = building.height >= 40 ? (building.source === "height" ? "measured" : "inferred") : "stone";
    const bucket = buckets[key];
    for (const edge of building.edges) {
      addWall(bucket.positions, bucket.uvs, edge.ax, edge.ay, edge.bx, edge.by, building.minHeight || 0, building.height);
    }
    addRoof(bucket.roofs, building);
  }
  const city = new THREE.Group();
  city.add(meshFrom(buckets.measured.positions, buckets.measured.uvs, measured));
  city.add(meshFrom(buckets.inferred.positions, buckets.inferred.uvs, inferred));
  city.add(meshFrom(buckets.stone.positions, buckets.stone.uvs, stone));
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8e877e, roughness: 0.9 });
  for (const bucket of Object.values(buckets)) {
    if (!bucket.roofs.length) continue;
    city.add(meshFrom(bucket.roofs, null, roofMat));
  }
  return city;
}

function buildRoads(tile) {
  const positions = [];
  for (const road of tile.roads) {
    const half = (road.width || 6) / 2;
    const pts = road.pts;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const bx = pts[i + 1][0];
      const by = pts[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * half;
      const py = (dx / len) * half;
      const aL = v3(ax + px, ay + py, 0.06);
      const aR = v3(ax - px, ay - py, 0.06);
      const bR = v3(bx - px, by - py, 0.06);
      const bL = v3(bx + px, by + py, 0.06);
      positions.push(aL.x, aL.y, aL.z, bL.x, bL.y, bL.z, bR.x, bR.y, bR.z);
      positions.push(aL.x, aL.y, aL.z, bR.x, bR.y, bR.z, aR.x, aR.y, aR.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x3e3a36, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1 }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

function buildWater(tile) {
  const positions = [];
  for (const ring of tile.water || []) {
    if (ring.length < 3) continue;
    const contour = ring.map(([e, n]) => new THREE.Vector2(e, n));
    let faces = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      continue;
    }
    for (const [i, j, k] of faces) {
      const pa = v3(ring[i][0], ring[i][1], 0.14);
      const pb = v3(ring[j][0], ring[j][1], 0.14);
      const pc = v3(ring[k][0], ring[k][1], 0.14);
      const normal = new THREE.Vector3().crossVectors(pb.clone().sub(pa), pc.clone().sub(pa));
      const order = normal.y >= 0 ? [pa, pb, pc] : [pa, pc, pb];
      positions.push(order[0].x, order[0].y, order[0].z, order[1].x, order[1].y, order[1].z, order[2].x, order[2].y, order[2].z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x1a5870,
    roughness: 0.22,
    metalness: 0.08,
    transparent: true,
    opacity: 0.92,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function curtainGeometry(building, facade, alpha) {
  const positions = [];
  const z0 = Math.max((building.minHeight || 0) + 3, 6);
  const z1 = building.height - 1.2;
  const nh = facade.n;
  for (const edge of facade.edges) {
    for (let sill = z0; sill < z1 - 1; sill += 3.5) {
      const head = Math.min(3.15, z1 - sill);
      const corners = [0, head].map((local) => {
        const a = tiltedPoint(edge.ax, edge.ay, local, nh, alpha);
        const b = tiltedPoint(edge.bx, edge.by, local, nh, alpha);
        return [v3(a[0], a[1], a[2] + sill), v3(b[0], b[1], b[2] + sill)];
      });
      const a0 = corners[0][0];
      const b0 = corners[0][1];
      const a1 = corners[1][0];
      const b1 = corners[1][1];
      positions.push(a0.x, a0.y, a0.z, a1.x, a1.y, a1.z, b1.x, b1.y, b1.z);
      positions.push(a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, b0.x, b0.y, b0.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function ribbon(positions, a, b, width) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
  side.normalize().multiplyScalar(width * 0.5);
  const aL = a.clone().add(side);
  const aR = a.clone().sub(side);
  const bL = b.clone().add(side);
  const bR = b.clone().sub(side);
  positions.push(aL.x, aL.y, aL.z, aR.x, aR.y, aR.z, bR.x, bR.y, bR.z);
  positions.push(aL.x, aL.y, aL.z, bR.x, bR.y, bR.z, bL.x, bL.y, bL.z);
}

function segmentMesh(segments, color, opacity, width, depthTest) {
  const positions = [];
  for (const [a, b] of segments) ribbon(positions, a, b, width);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

function frameHero(hero, subject) {
  const facade = subject.cluster.n;
  const anchor = hero ? hero.hops[0].to : [subject.building.centroid[0], subject.building.centroid[1], subject.building.height * 0.45];
  const focus = hero
    ? [
        (hero.hops[0].from[0] + hero.hops[0].to[0]) / 2,
        (hero.hops[0].from[1] + hero.hops[0].to[1]) / 2,
        (hero.hops[0].from[2] + hero.hops[0].to[2]) / 2,
      ]
    : anchor;
  const dist = Math.max(90, Math.min(260, subject.building.height * 0.72));
  view.camera.position.copy(v3(
    focus[0] + facade[0] * dist + facade[1] * dist * 0.35,
    focus[1] + facade[1] * dist - facade[0] * dist * 0.35,
    Math.max(28, focus[2] * 0.35 + dist * 0.28),
  ));
  view.controls.target.copy(v3(focus[0], focus[1], focus[2]));
  view.controls.update();
}

function paintPaths() {
  if (view.paths) view.scene.remove(view.paths);
  if (view.markers) view.scene.remove(view.markers);
  const group = new THREE.Group();
  const marks = new THREE.Group();
  const result = view.result;
  if (!result) {
    view.paths = group;
    view.markers = marks;
    view.scene.add(group);
    view.scene.add(marks);
    return;
  }
  const drawn = selectDrawn(result.paths, state.mode, view.hero, state.showHop2);
  const buckets = {};
  const halo = {};
  const pushSeg = (kind, a, b, hero) => {
    const key = kind;
    if (!buckets[key]) {
      buckets[key] = [];
      halo[key] = [];
    }
    buckets[key].push([a, b]);
    if (hero) halo[key].push([a, b]);
  };
  for (const path of drawn) {
    const hero = path === view.hero;
    const widthBoost = hero ? 1 : 0;
    if (state.showIncoming) {
      const toward = momentSun().sun;
      const from = path.origin;
      const start = [
        from[0] - toward[0] * 70,
        from[1] - toward[1] * 70,
        from[2] - toward[2] * 70,
      ];
      pushSeg("incoming", v3(start[0], start[1], start[2]), v3(from[0], from[1], from[2]), hero);
    }
    for (const hop of path.hops) {
      pushSeg(hop.kind, v3(hop.from[0], hop.from[1], hop.from[2]), v3(hop.to[0], hop.to[1], hop.to[2]), hero);
    }
    const land = path.hops[path.hops.length - 1];
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(hero ? 3.2 : 1.5, 14),
      new THREE.MeshBasicMaterial({ color: KIND_COLOR[land.kind] || 0xffffff, side: THREE.DoubleSide, depthTest: false }),
    );
    disc.position.copy(v3(land.to[0], land.to[1], land.to[2] + 0.4));
    disc.rotation.x = -Math.PI / 2;
    marks.add(disc);
    if (hero && path.hops.length > 1) {
      const joint = new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xfff6df, depthTest: false }),
      );
      joint.position.copy(v3(path.hops[0].to[0], path.hops[0].to[1], path.hops[0].to[2]));
      marks.add(joint);
    }
    void widthBoost;
  }
  for (const kind of Object.keys(buckets)) {
    const color = KIND_COLOR[kind] || 0xffffff;
    group.add(segmentMesh(buckets[kind], color, kind === "incoming" ? 0.55 : 0.92, kind === "incoming" ? 0.55 : 0.9, true));
    if (halo[kind].length) group.add(segmentMesh(halo[kind], color, 0.95, 2.4, false));
  }
  view.paths = group;
  view.markers = marks;
  view.scene.add(group);
  view.scene.add(marks);
}

function updateCurtain() {
  const subject = currentSubject();
  if (!subject) return;
  const geometry = curtainGeometry(subject.building, subject.cluster, state.alpha);
  if (!view.curtain) {
    const material = new THREE.MeshStandardMaterial({
      color: 0xf3efe4,
      roughness: 0.12,
      metalness: 0.35,
      emissive: 0x3a2a22,
      emissiveIntensity: 0.18,
      side: THREE.DoubleSide,
    });
    view.curtain = new THREE.Mesh(geometry, material);
    view.scene.add(view.curtain);
  } else {
    view.curtain.geometry.dispose();
    view.curtain.geometry = geometry;
  }
}

function updateSun() {
  const { pos, sun } = momentSun();
  const subject = currentSubject();
  const focus = subject
    ? [subject.building.centroid[0], subject.building.centroid[1], subject.building.height * 0.4]
    : [0, 0, 40];
  const place = v3(focus[0] + sun[0] * 420, focus[1] + sun[1] * 420, focus[2] + Math.max(sun[2], 0.05) * 420);
  view.sunLight.position.copy(place);
  view.sunLight.target.position.copy(v3(focus[0], focus[1], focus[2]));
  view.sunLight.target.updateMatrixWorld();
  view.sunLight.intensity = pos.elevationDeg > 0 ? 1.15 + Math.min(pos.elevationDeg, 50) / 80 : 0.05;
  const high = pos.elevationDeg > 28;
  const sky = new THREE.Color(high ? 0x9ec4de : 0xe7c7a4);
  if (pos.elevationDeg < 4) sky.set(0x243044);
  view.scene.background = sky;
  view.scene.fog.color.copy(sky);
  if (view.sunOrb) {
    view.sunOrb.position.copy(place);
    view.sunOrb.visible = pos.elevationDeg > 0;
  }
  const box = 180;
  const shadow = view.sunLight.shadow.camera;
  shadow.left = -box;
  shadow.right = box;
  shadow.top = box;
  shadow.bottom = -box;
  shadow.near = 20;
  shadow.far = 900;
  shadow.updateProjectionMatrix();
  view.sunLight.shadow.camera.position.copy(place);
}

function retrace() {
  const subject = currentSubject();
  const sun = momentSun();
  if (!subject || sun.pos.elevationDeg <= 0 || sun.dni < 20) {
    view.result = { paths: [], counts: { panels: 0, lit: 0, backlit: 0, shaded: 0, street: 0, neighbor: 0, water: 0, sky: 0, hop2: 0, hop2sky: 0, hop2water: 0, hop2street: 0 } };
    view.hero = null;
  } else {
    view.result = traceTile(view.tile, {
      building: subject.building,
      facade: subject.cluster,
      alpha: state.alpha,
      sun: sun.sun,
      dni: sun.dni,
      rho: state.rho,
    });
    view.hero = pickHero(view.result.paths, state.mode);
  }
  updateCurtain();
  updateSun();
  paintPaths();
  writeHud(sun);
  window.__glare = {
    ready: true,
    frame: "ENU x east, y north, z up; three.js (e, u, -n)",
    state: { ...state },
    counts: view.result.counts,
    hero: view.hero ? describePath(view.hero) : "",
    heroHops: view.hero ? view.hero.hops.length : 0,
    building: subject ? subject.building.name : "",
    sun: { elevation: sun.pos.elevationDeg, azimuth: sun.pos.azimuthDeg },
  };
}

function writeHud(sun) {
  const subject = currentSubject();
  const building = subject && subject.building;
  $("path-readout").textContent = sun.pos.elevationDeg <= 0
    ? "太阳在地平线以下，没有直射，光路是空的。"
    : describePath(view.hero);
  if (building) {
    const source = building.source === "height"
      ? "OSM 高度"
      : `按 ${building.levels || "?"} 层 × 3.2 m 推断`;
    const face = subject.cluster.n[1] < -0.4 ? "朝南的一面" : "朝街的一面";
    $("building-meta").textContent = `${building.height.toFixed(0)} m · ${source} · 玻璃皮装在${face}，α 让每一层的法线抬起来。`;
  }
  $("alpha-val").textContent = `${state.alpha.toFixed(1)}°`;
  $("date-val").textContent = `${state.month}月${state.day}日`;
  $("time-val").textContent = `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}`;
  $("rho-val").textContent = state.rho.toFixed(2);
  $("mode-street").setAttribute("aria-checked", state.mode === "street" ? "true" : "false");
  $("mode-reflect").setAttribute("aria-checked", state.mode === "reflect" ? "true" : "false");
  $("mode-hint").textContent = state.mode === "street"
    ? "只留下会落到街上的光路，包括先打到邻楼再落到街的。"
    : "整段反射都留着：街、邻楼、水面、天空。不按成败裁。";
  const az = ((sun.pos.azimuthDeg % 360) + 360) % 360;
  $("sun-readout").textContent = `太阳高度 ${sun.pos.elevationDeg.toFixed(1)}° · 方位 ${az.toFixed(0)}°（从北顺时针）· 2026`;
  const c = view.result.counts;
  $("counts").textContent = `板元 ${c.panels} · 照到 ${c.lit} · 背光 ${c.backlit} · 被挡住 ${c.shaded} · 一跳街 ${c.street} / 邻楼 ${c.neighbor} / 水 ${c.water} / 天 ${c.sky} · 二跳 ${c.hop2}（向天 ${c.hop2sky} · 向水 ${c.hop2water} · 向街 ${c.hop2street}）`;
  const counts = view.tile.meta.counts;
  const ratio = counts.rendered ? (100 * counts.heightTagged) / counts.rendered : 0;
  $("ratio").textContent = `这片 ${counts.rendered} 栋里，${counts.heightTagged} 栋（${ratio.toFixed(0)}%）用 OSM 高度，${counts.levelsInferred} 栋按层数推断。缺高度的 ${counts.omittedNoHeight} 栋没有画，也不拿盒子冒充。`;
}

function bind() {
  const select = $("building");
  for (const row of view.subjects) {
    const option = document.createElement("option");
    option.value = row.building.id;
    const tag = row.building.source === "height" ? "高度" : "推断";
    option.textContent = `${row.building.name} · ${row.building.height.toFixed(0)} m · ${tag}`;
    select.appendChild(option);
  }
  select.value = state.buildingId;
  select.addEventListener("change", () => {
    state.buildingId = select.value;
    retrace();
    frameHero(view.hero, currentSubject());
  });
  $("alpha").addEventListener("input", () => {
    state.alpha = Number($("alpha").value);
    retrace();
  });
  $("doy").addEventListener("input", () => {
    const date = fromDayOfYear(Number($("doy").value));
    state.month = date.month;
    state.day = date.day;
    retrace();
  });
  $("clock").addEventListener("input", () => {
    const minutes = Number($("clock").value);
    state.hour = Math.floor(minutes / 60);
    state.minute = minutes % 60;
    retrace();
  });
  $("rho").addEventListener("input", () => {
    state.rho = Number($("rho").value);
    retrace();
  });
  $("mode-street").addEventListener("click", () => {
    state.mode = "street";
    retrace();
  });
  $("mode-reflect").addEventListener("click", () => {
    state.mode = "reflect";
    retrace();
  });
  $("hop2").addEventListener("change", () => {
    state.showHop2 = $("hop2").checked;
    paintPaths();
    writeHud(momentSun());
  });
  $("incoming").addEventListener("change", () => {
    state.showIncoming = $("incoming").checked;
    paintPaths();
  });
  $("frame").addEventListener("click", () => frameHero(view.hero, currentSubject()));
}

function resize() {
  const canvas = $("view");
  const width = window.innerWidth;
  const height = window.innerHeight;
  view.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  view.renderer.setSize(width, height, false);
  view.camera.aspect = width / Math.max(1, height);
  view.camera.updateProjectionMatrix();
  canvas.style.width = "100%";
  canvas.style.height = "100%";
}

async function boot() {
  const [tileRaw, presetRaw] = await Promise.all([
    fetch("./data/central.json").then((res) => res.json()),
    fetch("./data/preset.json").then((res) => (res.ok ? res.json() : null)).catch(() => null),
  ]);
  if (!tileRaw.buildings || !tileRaw.buildings.length || tileRaw.meta.counts.heightTagged < 1) {
    $("boot").textContent = "阻塞：OSM 建筑高度没有装上，页面不拿假楼代替中环。";
    return;
  }
  if (tileRaw.meta.waterSource !== "coastline") {
    $("boot").textContent = "阻塞：海岸线没有形成维多利亚港一侧的水面。";
    return;
  }
  view.tile = prepareTile(tileRaw);
  view.subjects = rankSubjects(view.tile, 10);
  if (presetRaw) {
    state.buildingId = presetRaw.buildingId;
    state.alpha = presetRaw.alpha;
    state.month = presetRaw.month;
    state.day = presetRaw.day;
    state.hour = presetRaw.hour;
    state.minute = presetRaw.minute || 0;
  }
  if (!view.subjects.some((row) => row.building.id === state.buildingId)) state.buildingId = view.subjects[0].building.id;

  const canvas = $("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  view.renderer = renderer;
  view.scene = new THREE.Scene();
  view.scene.fog = new THREE.Fog(0x9ec4de, 380, 1700);
  view.camera = new THREE.PerspectiveCamera(42, 1, 0.4, 4000);
  view.camera.position.set(120, 90, 160);
  view.controls = new OrbitControls(view.camera, canvas);
  view.controls.enableDamping = true;
  view.controls.dampingFactor = 0.08;
  view.controls.maxPolarAngle = Math.PI * 0.49;
  view.controls.minPolarAngle = 0.12;
  view.controls.minDistance = 25;
  view.controls.maxDistance = 1800;
  view.controls.zoomSpeed = 0.75;
  view.controls.rotateSpeed = 0.8;
  view.controls.touches.ONE = THREE.TOUCH.ROTATE;
  view.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  const bounds = view.tile.meta.bounds;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry((bounds.maxX - bounds.minX) + 80, (bounds.maxY - bounds.minY) + 40),
    new THREE.MeshStandardMaterial({ color: 0xc8bfb2, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  const midE = (bounds.minX + bounds.maxX) / 2;
  const midN = (bounds.minY + bounds.maxY) / 2;
  ground.position.copy(v3(midE, midN, 0));
  // PlaneGeometry lies in XY. After rotation.x = -90°, it lies in XZ, normal +Y. Center was placed with toThree,
  // which already sets Y to up (0) and Z to -north. rotation then keeps that translation. Good.
  ground.receiveShadow = true;
  view.scene.add(ground);
  view.scene.add(buildWater(view.tile));
  view.scene.add(buildRoads(view.tile));
  view.scene.add(buildCity(view.tile));

  view.sunLight = new THREE.DirectionalLight(0xfff1d6, 1.3);
  view.sunLight.castShadow = true;
  view.sunLight.shadow.mapSize.set(2048, 2048);
  view.scene.add(view.sunLight);
  view.scene.add(view.sunLight.target);
  view.scene.add(new THREE.HemisphereLight(0xd5e4ef, 0x8d8274, 0.62));
  view.sunOrb = new THREE.Mesh(
    new THREE.SphereGeometry(8, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffe3a3, depthTest: false }),
  );
  view.scene.add(view.sunOrb);

  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), v3(bounds.minX + 36, bounds.minY + 28, 3), 46, 0x1c1814, 12, 7);
  view.scene.add(arrow);

  $("alpha").value = String(state.alpha);
  $("doy").value = String(dayOfYear(state.month, state.day));
  $("clock").value = String(state.hour * 60 + state.minute);
  $("rho").value = String(state.rho);
  bind();
  resize();
  window.addEventListener("resize", resize);
  retrace();
  frameHero(view.hero, currentSubject());
  $("boot").hidden = true;

  renderer.setAnimationLoop(() => {
    view.controls.update();
    renderer.render(view.scene, view.camera);
  });
}

boot().catch((error) => {
  console.error(error);
  $("boot").textContent = "阻塞：场景没有装起来。若是 OSM 数据缺失，不会用假楼顶上。";
});
