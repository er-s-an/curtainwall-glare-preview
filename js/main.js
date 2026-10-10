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
  sky: null,
  hemi: null,
  city: null,
  roadMat: null,
  waterMat: null,
  result: null,
  hero: null,
  drawnCount: 0,
  quality: null,
  _q: null,
  lastRibbon: 0,
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

function qualityProfile() {
  const narrow = window.innerWidth < 860;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const cores = navigator.hardwareConcurrency || 8;
  const low = narrow || coarse || cores <= 4;
  return {
    low,
    pixelRatio: low ? 1.1 : Math.min(window.devicePixelRatio || 1, 1.5),
    shadow: low ? 1024 : 2048,
    antialias: !low,
    lodNear: low ? 210 : 330,
    stepH: low ? 14 : 12,
    stepV: low ? 18 : 15,
  };
}

function makeTexture(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  if (kind === "stone") {
    g.fillStyle = "#c9b7a2";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#8d7b68";
    g.fillRect(0, 0, 128, 7);
    g.fillStyle = "rgba(60,46,34,0.16)";
    for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 2, 128);
  } else {
    g.fillStyle = "#8ea0ac";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#667480";
    g.fillRect(0, 0, 128, 16);
    g.fillStyle = "#d7e4ec";
    g.fillRect(7, 22, 50, 98);
    g.fillRect(71, 22, 50, 98);
    g.fillStyle = "rgba(255,255,255,0.42)";
    g.fillRect(12, 28, 12, 36);
    g.fillRect(76, 28, 12, 36);
    g.strokeStyle = "#243038";
    g.lineWidth = 4;
    g.strokeRect(7, 22, 50, 98);
    g.strokeRect(71, 22, 50, 98);
    g.fillStyle = "#243038";
    g.fillRect(0, 122, 128, 6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const maxAniso = view.renderer ? view.renderer.capabilities.getMaxAnisotropy() : 4;
  texture.anisotropy = Math.min(8, maxAniso);
  return texture;
}

function pushTri(positions, uvs, a, b, c, uvA, uvB, uvC) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
}

function addWall(positions, uvs, ax, ay, bx, by, z0, z1) {
  const length = Math.hypot(bx - ax, by - ay);
  if (length < 0.15 || z1 <= z0 + 0.3) return;
  const a0 = v3(ax, ay, z0);
  const a1 = v3(ax, ay, z1);
  const b1 = v3(bx, by, z1);
  const b0 = v3(bx, by, z0);
  const u = length / 3.2;
  const v = (z1 - z0) / 3.6;
  // One texture repeat is one floor and one mullion bay.
  pushTri(positions, uvs, a0, a1, b1, [0, 0], [0, v], [u, v]);
  pushTri(positions, uvs, a0, b1, b0, [0, 0], [u, v], [u, 0]);
}

function addInsetWall(positions, uvs, edge, z0, z1, inset) {
  const sign = edge.hole ? -1 : 1;
  const d = inset * sign;
  addWall(
    positions,
    uvs,
    edge.ax + edge.nx * d,
    edge.ay + edge.ny * d,
    edge.bx + edge.nx * d,
    edge.by + edge.ny * d,
    z0,
    z1,
  );
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

function meshFrom(positions, uvs, material, cast) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (uvs) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  return mesh;
}

function buildingCenter(building) {
  if (building.centroid) return building.centroid;
  const box = building.bbox;
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
}

function useCoarseBox(building, focus) {
  if (!focus || building.id === focus.id) return false;
  if (building.height >= 120) return false;
  const center = buildingCenter(building);
  const focusAt = buildingCenter(focus);
  const distance = Math.hypot(center[0] - focusAt[0], center[1] - focusAt[1]);
  return distance > view.quality.lodNear && building.edges.length > 6;
}

function addBoxWalls(positions, uvs, building) {
  const box = building.bbox;
  const z0 = building.minHeight || 0;
  const z1 = building.height;
  addWall(positions, uvs, box.min[0], box.min[1], box.max[0], box.min[1], z0, z1);
  addWall(positions, uvs, box.max[0], box.min[1], box.max[0], box.max[1], z0, z1);
  addWall(positions, uvs, box.max[0], box.max[1], box.min[0], box.max[1], z0, z1);
  addWall(positions, uvs, box.min[0], box.max[1], box.min[0], box.min[1], z0, z1);
}

function addBoxRoof(positions, building) {
  const box = building.bbox;
  const z1 = building.height;
  const a = v3(box.min[0], box.min[1], z1);
  const b = v3(box.max[0], box.min[1], z1);
  const c = v3(box.max[0], box.max[1], z1);
  const d = v3(box.min[0], box.max[1], z1);
  const pushUp = (p, q, r) => {
    const normal = new THREE.Vector3().crossVectors(q.clone().sub(p), r.clone().sub(p));
    const order = normal.y >= 0 ? [p, q, r] : [p, r, q];
    positions.push(order[0].x, order[0].y, order[0].z, order[1].x, order[1].y, order[1].z, order[2].x, order[2].y, order[2].z);
  };
  pushUp(a, b, c);
  pushUp(a, c, d);
}

function recordedHeight(building) {
  return building.measured === true || (building.measured == null && building.source === "height");
}

function buildCity(tile, focus) {
  const glassTex = makeTexture("glass");
  const stoneTex = makeTexture("stone");
  const measured = new THREE.MeshStandardMaterial({ map: glassTex, color: 0xd5e1e8, roughness: 0.32, metalness: 0.18 });
  const inferred = new THREE.MeshStandardMaterial({ map: glassTex, color: 0xe7c9a4, roughness: 0.48, metalness: 0.06 });
  const measuredLow = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xb7c4c8, roughness: 0.9, metalness: 0 });
  const inferredLow = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xd9c4a4, roughness: 0.92, metalness: 0 });
  const buckets = {
    measured: { positions: [], uvs: [], roofs: [] },
    inferred: { positions: [], uvs: [], roofs: [] },
    measuredLow: { positions: [], uvs: [], roofs: [] },
    inferredLow: { positions: [], uvs: [], roofs: [] },
  };
  const far = { positions: [], uvs: [], roofs: [] };
  const seamBuildings = [];
  let coarse = 0;
  for (const building of tile.buildings) {
    if (useCoarseBox(building, focus)) {
      coarse += 1;
      addBoxWalls(far.positions, far.uvs, building);
      addBoxRoof(far.roofs, building);
      continue;
    }
    const tall = building.height >= 24 && building.kind !== "roof";
    const key = recordedHeight(building) ? (tall ? "measured" : "measuredLow") : (tall ? "inferred" : "inferredLow");
    const bucket = buckets[key];
    seamBuildings.push(building);
    const span = Math.min(
      building.bbox.max[0] - building.bbox.min[0],
      building.bbox.max[1] - building.bbox.min[1],
    );
    const inset = span < 3 ? 0.05 : span < 8 ? 0.18 : 0.58;
    for (const edge of building.edges) {
      addInsetWall(bucket.positions, bucket.uvs, edge, building.minHeight || 0, building.height, inset);
    }
    addRoof(bucket.roofs, building);
  }
  const city = new THREE.Group();
  city.userData.coarse = coarse;
  const materials = { measured, inferred, measuredLow, inferredLow };
  const roofColors = { measured: 0x7d8c98, inferred: 0x9a7d62, measuredLow: 0x8a969c, inferredLow: 0xa08b72 };
  for (const [name, bucket] of Object.entries(buckets)) {
    if (bucket.positions.length) city.add(meshFrom(bucket.positions, bucket.uvs, materials[name], true));
    if (!bucket.roofs.length) continue;
    city.add(meshFrom(bucket.roofs, null, new THREE.MeshStandardMaterial({ color: roofColors[name], roughness: 0.92 }), true));
  }
  if (far.positions.length) {
    city.add(meshFrom(
      far.positions,
      far.uvs,
      new THREE.MeshStandardMaterial({ color: 0xb4bdc2, roughness: 0.86, metalness: 0.02 }),
      false,
    ));
    city.add(meshFrom(far.roofs, null, new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.94 }), false));
  }
  addSeams(city, seamBuildings);
  return city;
}

function addSeams(group, buildings) {
  const positions = [];
  for (const building of buildings) {
    const ring = building.outer;
    if (!ring || ring.length < 3) continue;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.45) continue;
      const roofA = v3(a[0], a[1], building.height + 0.22);
      const roofB = v3(b[0], b[1], building.height + 0.22);
      const groundA = v3(a[0], a[1], (building.minHeight || 0) + 0.2);
      const groundB = v3(b[0], b[1], (building.minHeight || 0) + 0.2);
      positions.push(roofA.x, roofA.y, roofA.z, roofB.x, roofB.y, roofB.z, groundA.x, groundA.y, groundA.z, groundB.x, groundB.y, groundB.z);
    }
  }
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: 0x211c18,
    transparent: true,
    opacity: 0.5,
  })));
}

function mountCity() {
  if (view.city) {
    view.scene.remove(view.city);
    view.city.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
    });
  }
  const subject = currentSubject();
  view.city = buildCity(view.tile, subject ? subject.building : null);
  view.scene.add(view.city);
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
  view.roadMat = new THREE.MeshStandardMaterial({
    color: 0x3e3a36,
    roughness: 0.94,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    emissive: 0x000000,
  });
  const mesh = new THREE.Mesh(geometry, view.roadMat);
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
  view.waterMat = new THREE.MeshStandardMaterial({
    color: 0x0e4c62,
    roughness: 0.12,
    metalness: 0.08,
    transparent: true,
    opacity: 0.94,
  });
  view.waterMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <beginnormal_vertex>",
      `vec3 objectNormal = vec3(normal);
      float east = position.x;
      float north = -position.z;
      float rippleX = 0.055 * sin(east * 0.07 + north * 0.02);
      float rippleN = 0.055 * cos(north * 0.05 - east * 0.01);
      objectNormal = normalize(vec3(rippleX, 1.0, -rippleN));
      #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
      #endif`,
    );
  };
  const mesh = new THREE.Mesh(geometry, view.waterMat);
  mesh.receiveShadow = true;
  return mesh;
}

function makeSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x8eb4d6) },
      horizon: { value: new THREE.Color(0xd5e4ef) },
      nadir: { value: new THREE.Color(0xb7aea2) },
      sunDir: { value: new THREE.Vector3(0.2, 0.4, -0.4) },
      sunColor: { value: new THREE.Color(0xfff3d4) },
      sunElev: { value: 0.45 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vDir = worldPos.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 nadir;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform float sunElev;
      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;
        vec3 col = h >= 0.0
          ? mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.38))
          : mix(horizon, nadir, pow(clamp(-h, 0.0, 1.0), 0.75));
        vec3 sun = normalize(sunDir);
        float facing = max(dot(dir, sun), 0.0);
        float disc = pow(facing, mix(900.0, 220.0, clamp(sunElev, 0.0, 1.0)));
        float glow = pow(facing, 14.0);
        float up = smoothstep(-0.02, 0.12, sunElev);
        col += sunColor * disc * 1.15 * up;
        col += sunColor * glow * 0.28 * up;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 32, 18), material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
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
  if (dir.lengthSq() < 0.16) return;
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const toCam = view.camera.position.clone().sub(mid);
  const side = new THREE.Vector3().crossVectors(dir, toCam);
  if (side.lengthSq() < 1e-6) side.crossVectors(dir, new THREE.Vector3(0, 1, 0));
  side.normalize().multiplyScalar(width * 0.5);
  const aL = a.clone().add(side);
  const aR = a.clone().sub(side);
  const bL = b.clone().add(side);
  const bR = b.clone().sub(side);
  positions.push(aL.x, aL.y, aL.z, aR.x, aR.y, aR.z, bR.x, bR.y, bR.z);
  positions.push(aL.x, aL.y, aL.z, bR.x, bR.y, bR.z, bL.x, bL.y, bL.z);
}

function pathReach(hero) {
  let minE = Infinity;
  let minN = Infinity;
  let maxE = -Infinity;
  let maxN = -Infinity;
  let maxZ = 0;
  for (const hop of hero.hops) {
    for (const point of [hop.from, hop.to]) {
      minE = Math.min(minE, point[0]);
      maxE = Math.max(maxE, point[0]);
      minN = Math.min(minN, point[1]);
      maxN = Math.max(maxN, point[1]);
      maxZ = Math.max(maxZ, point[2]);
    }
  }
  return Math.max(Math.hypot(maxE - minE, maxN - minN), Math.min(maxZ, 160) * 0.45);
}

function standOff(e, n, z, focusE, focusN, focusZ, tile, minDist) {
  let eye = clearEye(e, n, z, tile);
  const dx = eye[0] - focusE;
  const dy = eye[1] - focusN;
  const dz = eye[2] - focusZ;
  const len = Math.hypot(dx, dy, dz) || 1;
  if (len >= minDist) return eye;
  const scale = minDist / len;
  return clearEye(focusE + dx * scale, focusN + dy * scale, Math.max(z, focusZ + dz * scale), tile);
}

function clearEye(e, n, z, tile) {
  let x = e;
  let y = n;
  let zz = z;
  for (let guard = 0; guard < 6; guard += 1) {
    const hit = tile.buildings.find((building) => x >= building.bbox.min[0] && x <= building.bbox.max[0]
      && y >= building.bbox.min[1] && y <= building.bbox.max[1]
      && zz < building.height + 1.5 && zz > (building.minHeight || 0) - 0.5);
    if (!hit) return [x, y, zz];
    const cx = (hit.bbox.min[0] + hit.bbox.max[0]) / 2;
    const cy = (hit.bbox.min[1] + hit.bbox.max[1]) / 2;
    let dx = x - cx;
    let dy = y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1.2) {
      zz = hit.height + 20;
      continue;
    }
    dx /= len;
    dy /= len;
    const reach = Math.max(hit.bbox.max[0] - hit.bbox.min[0], hit.bbox.max[1] - hit.bbox.min[1]) * 0.5 + 16;
    x = cx + dx * reach;
    y = cy + dy * reach;
  }
  return [x, y, Math.max(zz, 36)];
}

function heroFitPoints(hero) {
  const points = [hero.hops[0].from];
  for (const hop of hero.hops) {
    if (hop.kind === "sky") {
      points.push([
        hop.from[0] + (hop.to[0] - hop.from[0]) * 0.55,
        hop.from[1] + (hop.to[1] - hop.from[1]) * 0.55,
        hop.from[2] + (hop.to[2] - hop.from[2]) * 0.55,
      ]);
    } else {
      points.push(hop.to);
    }
  }
  return points;
}

function frameOverflow(points) {
  const narrow = window.innerWidth < 860;
  // Desktop sheet covers the right; the phone sheet covers the bottom.
  const xMax = narrow ? 0.78 : 0.3;
  const xMin = narrow ? -0.78 : -0.86;
  const yMin = narrow ? -0.05 : -0.78;
  const yMax = narrow ? 0.72 : 0.78;
  let bad = 0;
  view.camera.updateMatrixWorld(true);
  for (const pt of points) {
    const p = v3(pt[0], pt[1], pt[2]).project(view.camera);
    if (p.z < -1 || p.z > 1) bad += 2;
    bad += Math.max(0, p.x - xMax) * 1.5;
    bad += Math.max(0, xMin - p.x);
    bad += Math.max(0, yMin - p.y) * (narrow ? 1.7 : 1);
    bad += Math.max(0, p.y - yMax);
  }
  return bad;
}

function applySheetFraming() {
  const width = window.innerWidth;
  const height = Math.max(1, window.innerHeight);
  view.camera.aspect = width / height;
  view.camera.clearViewOffset();
  view.camera.updateProjectionMatrix();
}

function applyEyeOffset(target, offset) {
  const dist = Math.min(1280, Math.max(48, offset.length()));
  offset.normalize().multiplyScalar(dist);
  if (offset.y < dist * 0.06) offset.y = dist * 0.06;
  view.camera.position.copy(target).add(offset);
  view.camera.lookAt(target);
  view.camera.updateMatrixWorld(true);
  return offset;
}

// Pull the polyline into the part of the picture the sheet does not cover.
function settleFrame(hero) {
  if (!hero || !hero.hops.length || !view.controls) return;
  const points = heroFitPoints(hero);
  const target = view.controls.target.clone();
  let offset = applyEyeOffset(target, view.camera.position.clone().sub(target));
  for (let i = 0; i < 7 && frameOverflow(points) > 0.045; i += 1) {
    offset = applyEyeOffset(target, offset.multiplyScalar(1.15));
  }
  if (frameOverflow(points) > 0.045) {
    const base = offset.clone();
    let bestScore = frameOverflow(points);
    let best = base.clone();
    for (const dir of [1, -1]) {
      let trial = base.clone();
      for (let i = 1; i <= 8; i += 1) {
        trial = applyEyeOffset(target, trial.applyAxisAngle(new THREE.Vector3(0, 1, 0), dir * 0.1));
        const score = frameOverflow(points);
        if (score < bestScore - 0.01) {
          bestScore = score;
          best = trial.clone();
        }
      }
    }
    offset = applyEyeOffset(target, best);
  }
  const eye = view.camera.position;
  const cleared = clearEye(eye.x, -eye.z, eye.y, view.tile);
  view.camera.position.copy(v3(cleared[0], cleared[1], cleared[2]));
  view.controls.target.copy(target);
  view.controls.update();
  view.fitOverflow = frameOverflow(points);
  if (window.__glare) window.__glare.fit = view.fitOverflow;
}

function frameHero(hero, subject) {
  if (!subject || !view.camera) return;
  const n = subject.cluster.n;
  const tx = -n[1];
  const ty = n[0];
  const building = subject.building;
  const narrow = window.innerWidth < 860;
  const street = state.mode === "street";
  const waterEnd = !!(hero && hero.hops.length && !street && hero.hops[hero.hops.length - 1].kind === "water");
  let focusE;
  let focusN;
  let focusZ;
  if (hero && hero.hops.length) {
    const joint = hero.hops[0].to;
    const end = hero.hops[hero.hops.length - 1].to;
    const from = hero.hops[0].from;
    const wFrom = street ? 0.3 : waterEnd ? 0.24 : 0.28;
    const wJoint = street ? 0.24 : waterEnd ? 0.38 : 0.5;
    const wEnd = street ? 0.46 : waterEnd ? 0.38 : 0.22;
    focusE = from[0] * wFrom + joint[0] * wJoint + end[0] * wEnd;
    focusN = from[1] * wFrom + joint[1] * wJoint + end[1] * wEnd;
    const endZ = street ? end[2] : (waterEnd ? end[2] : Math.min(end[2], joint[2] + 36));
    focusZ = Math.max(
      6,
      from[2] * (street ? 0.22 : waterEnd ? 0.2 : 0.34)
        + joint[2] * (street ? 0.2 : waterEnd ? 0.28 : 0.46)
        + endZ * (street ? 0.58 : waterEnd ? 0.52 : 0.2),
    );
  } else {
    const center = buildingCenter(building);
    focusE = center[0] + n[0] * 8;
    focusN = center[1] + n[1] * 8;
    focusZ = Math.max(12, building.height * 0.28);
  }
  const span = hero ? Math.max(70, pathReach(hero)) : Math.max(70, building.height * 0.35);
  const dist = Math.max(narrow ? 150 : 190, Math.min(narrow ? 340 : 460, span * 0.9 + 130));
  let eyeE = focusE + n[0] * dist * 0.82 + tx * dist * 0.55;
  let eyeN = focusN + n[1] * dist * 0.82 + ty * dist * 0.55;
  let eyeZ = street
    ? focusZ + (narrow ? 22 : 30)
    : focusZ + (waterEnd ? (narrow ? 36 : 58) : Math.max(18, Math.min(48, focusZ * 0.12 + 16)));
  [eyeE, eyeN, eyeZ] = standOff(eyeE, eyeN, eyeZ, focusE, focusN, focusZ, view.tile, dist * 0.72);
  const targetZ = Math.max(3, focusZ - (narrow ? 28 : 0));
  view.camera.fov = narrow ? 54 : 47;
  applySheetFraming();
  view.camera.position.copy(v3(eyeE, eyeN, eyeZ));
  view.controls.target.copy(v3(focusE, focusN, targetZ));
  view.controls.update();
  settleFrame(hero);
  view._q = view.camera.quaternion.clone();
  paintPaths();
}

function dropDraw(obj) {
  if (!obj) return;
  view.scene.remove(obj);
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const list = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of list) material.dispose();
    }
  });
}

function hopStyle(kind, featured, distance) {
  const base = featured
    ? (kind === "incoming" ? 0.7 : kind === "water" ? 0.55 : 0.95)
    : (kind === "water" ? 0.18 : kind === "sky" ? 0.22 : kind === "occlusion" ? 0.14 : kind === "incoming" ? 0.22 : 0.32);
  const width = base * Math.max(0.85, Math.min(2.1, distance / 220));
  let opacity = 0.84;
  if (featured) opacity = kind === "water" ? 0.72 : 0.96;
  else if (kind === "water") opacity = 0.34;
  else if (kind === "sky") opacity = 0.4;
  else if (kind === "occlusion") opacity = 0.42;
  else if (kind === "incoming") opacity = 0.5;
  return { width, opacity, depthTest: !featured };
}

function paintPaths() {
  dropDraw(view.paths);
  dropDraw(view.markers);
  const group = new THREE.Group();
  const marks = new THREE.Group();
  const result = view.result;
  if (!result || !view.camera) {
    view.paths = group;
    view.markers = marks;
    view.drawnCount = 0;
    view.scene.add(group);
    view.scene.add(marks);
    return;
  }
  const drawn = selectDrawn(result.paths, state.mode, view.hero, state.showHop2, { mobile: view.quality.low });
  view.drawnCount = drawn.length;
  const buckets = new Map();
  const pushSeg = (kind, a, b, featured) => {
    const distance = view.camera.position.distanceTo(a.clone().add(b).multiplyScalar(0.5));
    const style = hopStyle(kind, featured, distance);
    const key = `${kind}:${featured ? "hero" : "rest"}:${style.depthTest ? 1 : 0}`;
    if (!buckets.has(key)) buckets.set(key, { kind, segments: [], opacity: style.opacity, depthTest: style.depthTest });
    const bucket = buckets.get(key);
    const positions = [];
    ribbon(positions, a, b, style.width);
    if (positions.length) bucket.segments.push(positions);
  };
  const lift = (e, n, u) => {
    const point = v3(e, n, u);
    point.y += 0.75;
    return point;
  };
  for (const path of drawn) {
    const featured = path.featured === true;
    if (state.showIncoming && featured) {
      const toward = momentSun().sun;
      const from = path.origin;
      pushSeg(
        "incoming",
        lift(from[0] - toward[0] * 78, from[1] - toward[1] * 78, from[2] - toward[2] * 78),
        lift(from[0], from[1], from[2]),
        true,
      );
    }
    for (const hop of path.hops) {
      const a = lift(hop.from[0], hop.from[1], hop.from[2]);
      const b = lift(hop.to[0], hop.to[1], hop.to[2]);
      const end = !featured && hop.kind === "sky" ? a.clone().lerp(b, 0.62) : b;
      pushSeg(hop.kind, a, end, featured);
    }
    const land = path.hops[path.hops.length - 1];
    const discRadius = featured ? (land.kind === "street" || land.kind === "water" ? 5.4 : 3.3) : 1.15;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(discRadius, 14),
      new THREE.MeshBasicMaterial({
        color: KIND_COLOR[land.kind] || 0xffffff,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: featured ? 0.95 : 0.75,
      }),
    );
    disc.position.copy(lift(land.to[0], land.to[1], land.to[2]));
    if (land.kind === "street" || land.kind === "ground" || land.kind === "water") {
      disc.rotation.x = -Math.PI / 2;
      if (featured) {
        const pin = new THREE.Mesh(
          new THREE.SphereGeometry(land.kind === "water" ? 2.4 : 2.8, 12, 10),
          new THREE.MeshBasicMaterial({ color: KIND_COLOR[land.kind] || 0xffffff, depthTest: false }),
        );
        pin.position.copy(disc.position);
        pin.position.y += 1.4;
        marks.add(pin);
      }
    } else disc.lookAt(view.camera.position);
    marks.add(disc);
    if (featured && path.hops.length > 1) {
      const joint = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xfff6df, depthTest: false }),
      );
      joint.position.copy(lift(path.hops[0].to[0], path.hops[0].to[1], path.hops[0].to[2]));
      marks.add(joint);
    }
  }
  if (state.mode === "reflect") {
    for (const mark of (result.occlusions || []).slice(0, view.quality.low ? 3 : 5)) {
      pushSeg("occlusion", lift(mark.from[0], mark.from[1], mark.from[2]), lift(mark.to[0], mark.to[1], mark.to[2]), false);
    }
  }
  for (const bucket of buckets.values()) {
    const positions = bucket.segments.flat();
    if (!positions.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const color = bucket.kind === "occlusion" ? 0x8ea0b8 : (KIND_COLOR[bucket.kind] || 0xffffff);
    group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: bucket.opacity,
      depthTest: bucket.depthTest,
      depthWrite: false,
      side: THREE.DoubleSide,
    })));
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

function skyLook(elev) {
  if (elev <= 0.4) {
    return { zenith: 0x121a2b, horizon: 0x243044, nadir: 0x1a1816, fog: 0x1c2433, sun: 0x8899aa, hemi: 0x243044, ground: 0x3a342e, intensity: 0.08, hemiI: 0.1 };
  }
  if (elev < 8) {
    return { zenith: 0x31466e, horizon: 0xf0a06a, nadir: 0xc4a088, fog: 0xe7b48a, sun: 0xff7a3c, hemi: 0xf0c2a0, ground: 0x6a5344, intensity: 0.7, hemiI: 0.26 };
  }
  if (elev < 20) {
    return { zenith: 0x6d92c2, horizon: 0xf3d3a6, nadir: 0xcbbba6, fog: 0xe6d2b4, sun: 0xffc27a, hemi: 0xf2d2b0, ground: 0x7d6c5c, intensity: 1.35, hemiI: 0.32 };
  }
  return { zenith: 0x1a5c9c, horizon: 0xb9d0e6, nadir: 0xb7aea2, fog: 0xb7cbe0, sun: 0xfff3d4, hemi: 0xc5d7ea, ground: 0x8d8274, intensity: 1.62, hemiI: 0.32 };
}

function updateSun() {
  const { pos, sun } = momentSun();
  const subject = currentSubject();
  const focus = subject
    ? [subject.building.centroid[0], subject.building.centroid[1], subject.building.height * 0.38]
    : [0, 0, 40];
  const elev = pos.elevationDeg;
  const look = skyLook(elev);
  const place = v3(focus[0] + sun[0] * 640, focus[1] + sun[1] * 640, focus[2] + Math.max(sun[2], 0.04) * 640);
  view.sunLight.position.copy(place);
  view.sunLight.target.position.copy(v3(focus[0], focus[1], focus[2]));
  view.sunLight.target.updateMatrixWorld();
  view.sunLight.intensity = look.intensity;
  view.sunLight.color.set(look.sun);
  if (view.hemi) {
    view.hemi.color.set(look.hemi);
    view.hemi.groundColor.set(look.ground);
    view.hemi.intensity = look.hemiI;
  }
  view.scene.background = new THREE.Color(look.horizon);
  view.scene.fog.color.set(look.fog);
  view.scene.fog.near = elev < 10 ? 120 : 260;
  view.scene.fog.far = elev < 10 ? 1050 : 1550;
  if (view.renderer) view.renderer.toneMappingExposure = elev < 8 ? 0.9 : elev < 20 ? 1.0 : 1.08;
  if (view.sky) {
    const uniforms = view.sky.material.uniforms;
    uniforms.zenith.value.set(look.zenith);
    uniforms.horizon.value.set(look.horizon);
    uniforms.nadir.value.set(look.nadir);
    uniforms.sunColor.value.set(look.sun);
    uniforms.sunElev.value = Math.max(0, elev) / 40;
    const [sx, sy, sz] = toThree(sun[0], sun[1], sun[2]);
    uniforms.sunDir.value.set(sx, sy, sz);
  }
  if (view.waterMat) view.waterMat.color.set(elev < 8 ? 0x1a4558 : elev < 20 ? 0x14566c : 0x0d4a60);
  if (view.sunOrb) {
    const orbAt = v3(focus[0] + sun[0] * 980, focus[1] + sun[1] * 980, focus[2] + Math.max(sun[2], 0.02) * 980);
    view.sunOrb.position.copy(orbAt);
    view.sunOrb.visible = elev > 0.4;
    view.sunOrb.scale.setScalar(elev < 10 ? 1.7 : 1);
    view.sunOrb.material.color.set(look.sun);
  }
  const half = elev < 14 ? 280 : 210;
  const shadow = view.sunLight.shadow.camera;
  shadow.left = -half;
  shadow.right = half;
  shadow.top = half;
  shadow.bottom = -half;
  shadow.near = 8;
  shadow.far = 1800;
  shadow.updateProjectionMatrix();
  view.sunLight.shadow.needsUpdate = true;
}

function emptyResult() {
  return {
    paths: [],
    occlusions: [],
    counts: {
      panels: 0, lit: 0, backlit: 0, shaded: 0, street: 0, neighbor: 0, water: 0, sky: 0,
      ground: 0, roof: 0, hop2: 0, hop2sky: 0, hop2water: 0, hop2street: 0,
    },
  };
}

function applyModeLook() {
  if (!view.roadMat) return;
  const street = state.mode === "street";
  view.roadMat.color.set(street ? 0x6d5b48 : 0x3e3a36);
  view.roadMat.emissive.set(street ? 0x5a3418 : 0x000000);
  view.roadMat.emissiveIntensity = street ? 0.35 : 0;
  document.body.dataset.mode = state.mode;
}

function retrace() {
  const subject = currentSubject();
  const sun = momentSun();
  if (!subject || sun.pos.elevationDeg <= 0.35) {
    view.result = emptyResult();
    view.hero = null;
  } else {
    view.result = traceTile(view.tile, {
      building: subject.building,
      facade: subject.cluster,
      alpha: state.alpha,
      sun: sun.sun,
      dni: sun.dni,
      rho: state.rho,
      stepH: view.quality.stepH,
      stepV: view.quality.stepV,
    });
    view.hero = pickHero(view.result.paths, state.mode);
  }
  updateCurtain();
  updateSun();
  applyModeLook();
  paintPaths();
  writeHud(sun);
  window.__glare = {
    ready: true,
    frame: "ENU x east, y north, z up; three.js (e, u, -n)",
    state: { ...state },
    counts: view.result.counts,
    hero: view.hero ? describePath(view.hero) : "",
    heroHops: view.hero ? view.hero.hops.length : 0,
    drawn: view.drawnCount,
    occlusions: (view.result.occlusions || []).length,
    coarse: view.city ? view.city.userData.coarse : 0,
    quality: view.quality.low ? "low" : "high",
    building: subject ? subject.building.name : "",
    sun: { elevation: sun.pos.elevationDeg, azimuth: sun.pos.azimuthDeg },
  };
}

function writeHud(sun) {
  const subject = currentSubject();
  const building = subject && subject.building;
  const counts = view.result.counts;
  const elev = sun.pos.elevationDeg;
  let lead;
  if (elev <= 0.35) lead = "太阳在地平线以下，没有直射，光路是空的。";
  else if (state.mode === "street" && !view.hero) lead = "这一时刻没有光落到街上。拧时刻或倾角，或切到「单纯看反射」看打向楼、水和天的光。";
  else if (!view.hero && counts.shaded > 0 && counts.lit === 0) lead = "这一面的直射被旁边的楼挡住了，所以没有反射折线。换一个时刻，或换一栋朝向太阳的楼。";
  else if (!view.hero && counts.backlit > 0 && counts.lit === 0) lead = "太阳在这面玻璃的背后。拧到太阳照到这面的时刻，折线才会出来。";
  else if (state.mode === "street") lead = describePath(view.hero).replace("折线：", "落到街的折线：").replace("一跳：", "落到街：");
  else lead = describePath(view.hero);
  if (elev > 0.35 && elev < 9 && view.hero) lead = `低太阳。${lead}`;
  $("path-readout").textContent = lead;
  if (building) {
    const source = building.heightNote || (recordedHeight(building) ? "记录高度" : "高度推断");
    const face = subject.cluster.n[1] < -0.4 ? "朝南的一面" : "朝街的一面";
    $("building-meta").textContent = `${building.height.toFixed(0)} m · ${source} · 玻璃皮装在${face}，α 让每一层的法线抬起来。`;
  }
  $("alpha-val").textContent = `${state.alpha.toFixed(1)}°`;
  $("date-val").textContent = `${state.month}月${state.day}日`;
  $("time-val").textContent = `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}`;
  $("rho-val").textContent = state.rho.toFixed(2);
  $("mode-street").setAttribute("aria-checked", state.mode === "street" ? "true" : "false");
  $("mode-reflect").setAttribute("aria-checked", state.mode === "reflect" ? "true" : "false");
  const shown = view.drawnCount || 0;
  const total = view.result.paths.length;
  const streetHits = view.result.paths.filter((path) => path.hops.some((hop) => hop.kind === "street")).length;
  $("mode-hint").textContent = state.mode === "street"
    ? (streetHits
      ? `落到街的有 ${streetHits} 条，画面留了 ${shown} 条，主折线加粗。先打到邻楼或水面、再落到街的也留着。其它方向先藏起来，路面会亮一点。`
      : "画面里没有落到街的光。其它反射先藏起来了。")
    : `算出来 ${total} 条反射，画面收成 ${shown} 条，免得叠成一团。主折线加粗；水面那一跳更细、更淡。不判断过不过。`;
  const az = ((sun.pos.azimuthDeg % 360) + 360) % 360;
  const low = elev > 0.35 && elev < 10 ? " · 低太阳，影子拉长" : "";
  const blocked = counts.panels && counts.shaded / counts.panels > 0.3 ? ` · 直射有 ${counts.shaded} 块被旁边的楼挡住` : "";
  $("sun-readout").textContent = `太阳高度 ${elev.toFixed(1)}° · 方位 ${az.toFixed(0)}°（从北顺时针）${low}${blocked} · 2026`;
  const c = counts;
  $("counts").textContent = `板元 ${c.panels} · 照到 ${c.lit} · 背光 ${c.backlit} · 被挡住 ${c.shaded} · 一跳街 ${c.street} / 邻楼 ${c.neighbor} / 水 ${c.water} / 天 ${c.sky} · 二跳 ${c.hop2}（向天 ${c.hop2sky} · 向水 ${c.hop2water} · 向街 ${c.hop2street}）`;
  const mix = view.tile.meta.counts;
  const pct = (key) => (mix.rendered ? Math.round((100 * (mix[key] || 0)) / mix.rendered) : 0);
  $("ratio").textContent = `这片 ${mix.rendered} 栋都进了场景。OSM 高度 ${mix.heightTagged}（${pct("heightTagged")}%），维基数据 ${mix.wikidata || 0}（${pct("wikidata")}%），开放数据 ${mix.openData || 0}（${pct("openData")}%），层数推断 ${mix.levelsInferred || 0}，默认推断 ${mix.defaultInferred || 0}。缺高度仍没画上的 ${mix.omittedNoHeight || 0} 栋。`;
}

function bind() {
  const select = $("building");
  for (const row of view.subjects) {
    const option = document.createElement("option");
    option.value = row.building.id;
    const tag = recordedHeight(row.building) ? "记录" : "推断";
    option.textContent = `${row.building.name} · ${row.building.height.toFixed(0)} m · ${tag}`;
    select.appendChild(option);
  }
  select.value = state.buildingId;
  select.addEventListener("change", () => {
    state.buildingId = select.value;
    mountCity();
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
    frameHero(view.hero, currentSubject());
  });
  $("mode-reflect").addEventListener("click", () => {
    state.mode = "reflect";
    retrace();
    frameHero(view.hero, currentSubject());
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
  view.renderer.setPixelRatio(view.quality.pixelRatio);
  view.renderer.setSize(width, height, false);
  applySheetFraming();
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  if (view.tile && currentSubject()) frameHero(view.hero, currentSubject());
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

  view.quality = qualityProfile();
  const canvas = $("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: view.quality.antialias });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = view.quality.low ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  view.renderer = renderer;
  view.scene = new THREE.Scene();
  view.scene.fog = new THREE.Fog(0xc9d7e4, 260, 1550);
  view.camera = new THREE.PerspectiveCamera(47, 1, 0.4, 9000);
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
  const groundMat = ground.material;
  groundMat.color.set(0xb7aea2);
  view.scene.add(ground);
  view.sky = makeSky();
  view.sky.position.copy(v3(midE, midN, 0));
  view.scene.add(view.sky);
  view.scene.add(buildWater(view.tile));
  view.scene.add(buildRoads(view.tile));
  mountCity();

  view.sunLight = new THREE.DirectionalLight(0xfff1d6, 1.6);
  view.sunLight.castShadow = true;
  view.sunLight.shadow.mapSize.set(view.quality.shadow, view.quality.shadow);
  view.sunLight.shadow.bias = -0.00035;
  view.sunLight.shadow.normalBias = 1.15;
  view.sunLight.shadow.radius = view.quality.low ? 1.2 : 2.2;
  view.scene.add(view.sunLight);
  view.scene.add(view.sunLight.target);
  view.hemi = new THREE.HemisphereLight(0xd5e4ef, 0x8d8274, 0.38);
  view.scene.add(view.hemi);
  view.sunOrb = new THREE.Mesh(
    new THREE.SphereGeometry(12, 18, 12),
    new THREE.MeshBasicMaterial({ color: 0xffe3a3 }),
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
    const q = view.camera.quaternion;
    const moved = view._q ? Math.abs(q.dot(view._q)) < 0.9996 : false;
    const now = performance.now();
    if (moved && now - view.lastRibbon > 90) {
      view._q.copy(q);
      view.lastRibbon = now;
      paintPaths();
    }
    renderer.render(view.scene, view.camera);
  });
}

boot().catch((error) => {
  console.error(error);
  $("boot").textContent = "阻塞：场景没有装起来。若是 OSM 数据缺失，不会用假楼顶上。";
});
