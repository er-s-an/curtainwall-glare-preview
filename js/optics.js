/**
 * Multi-hop glare in one frame.
 *
 * ENU metres: x east, y north, z up. Right-handed.
 * three.js is Y-up, so the only conversion is toThree(e, n, u) = (e, u, -n).
 * ENU +y (north) becomes three.js -Z. A camera on +Z looks north.
 * Meshes and rays both start from these ENU points; do not build a second yaw.
 *
 * Reflection matches glare_sim: r = 2(n·s)n − s, with s pointing toward the source.
 * Facade tilt matches tilt_normal: n = cos(α) n_h + sin(α) up.
 */

const T_MIN = 0.25;
const FLOOR_M = 3.5;

export function toThree(e, n, u = 0) {
  return [e, u, -n];
}

export function reflect(normal, towardSource) {
  const nd = dot(normal, towardSource);
  const r = [
    2 * nd * normal[0] - towardSource[0],
    2 * nd * normal[1] - towardSource[1],
    2 * nd * normal[2] - towardSource[2],
  ];
  const len = Math.hypot(r[0], r[1], r[2]) || 1;
  return { nd, r: [r[0] / len, r[1] / len, r[2] / len] };
}

export function tiltNormal(nh, alphaDeg) {
  const a = (alphaDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const n = [c * nh[0], c * nh[1], s];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Point on a floor panel tilted about its sill. localH is metres above that sill. */
export function tiltedPoint(x, y, localH, nh, alphaDeg) {
  const a = (alphaDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const n = tiltNormal(nh, alphaDeg);
  const skin = 0.45;
  return [
    x - localH * s * nh[0] + skin * n[0],
    y - localH * s * nh[1] + skin * n[1],
    localH * c + skin * n[2],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(origin, dir, t) {
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function ensureWinding(ring, ccw) {
  const area = signedArea(ring);
  if ((ccw && area < 0) || (!ccw && area > 0)) return ring.slice().reverse();
  return ring.slice();
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-15) + xi) inside = !inside;
  }
  return inside;
}

function pointInBuilding(x, y, building) {
  if (!pointInRing(x, y, building.outer)) return false;
  for (const hole of building.holes) if (pointInRing(x, y, hole)) return false;
  return true;
}

function pushEdges(building, ring, hole) {
  for (let i = 0; i < ring.length; i += 1) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.hypot(ex, ey);
    if (len < 0.2) continue;
    // Right of the walk. Outer rings are CCW, so this points out of the mass.
    // Hole rings are CW, so this points into the courtyard, out of the mass.
    const nx = ey / len;
    const ny = -ex / len;
    building.edges.push({ ax, ay, bx, by, nx, ny, len, hole });
  }
}

export function prepareTile(data) {
  const buildings = data.buildings.map((raw) => {
    const building = {
      ...raw,
      outer: ensureWinding(raw.outer, true),
      holes: (raw.holes || []).map((ring) => ensureWinding(ring, false)),
      edges: [],
    };
    pushEdges(building, building.outer, false);
    for (const hole of building.holes) pushEdges(building, hole, true);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of building.outer) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    building.bbox = {
      min: [minX - 0.2, minY - 0.2, building.minHeight || 0],
      max: [maxX + 0.2, maxY + 0.2, building.height],
    };
    return building;
  });
  const roadSegs = [];
  for (const road of data.roads || []) {
    const half = (road.width || 6) / 2;
    const pts = road.pts;
    for (let i = 0; i < pts.length - 1; i += 1) {
      roadSegs.push({ ax: pts[i][0], ay: pts[i][1], bx: pts[i + 1][0], by: pts[i + 1][1], half });
    }
  }
  return { ...data, buildings, roadSegs };
}

function segmentT(ox, oy, dx, dy, edge) {
  const ex = edge.bx - edge.ax;
  const ey = edge.by - edge.ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((edge.ax - ox) * ey - (edge.ay - oy) * ex) / denom;
  const u = ((edge.ax - ox) * dy - (edge.ay - oy) * dx) / denom;
  if (u < 0 || u > 1) return null;
  return t;
}

function slabHit(origin, dir, box, tMin, tMax) {
  let near = tMin;
  let far = tMax;
  for (let axis = 0; axis < 3; axis += 1) {
    const d = dir[axis];
    if (Math.abs(d) < 1e-8) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return false;
      continue;
    }
    let t1 = (box.min[axis] - origin[axis]) / d;
    let t2 = (box.max[axis] - origin[axis]) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (far < near) return false;
  }
  return true;
}

function rayBuilding(origin, dir, building, tMin, tMax) {
  if (!slabHit(origin, dir, building.bbox, tMin, tMax)) return null;
  let best = null;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  for (const edge of building.edges) {
    const t = segmentT(ox, oy, dx, dy, edge);
    if (t === null || t <= tMin || t >= tMax) continue;
    const z = oz + t * dz;
    if (z < building.minHeight - 0.15 || z > building.height + 0.15) continue;
    if (!best || t < best.t) {
      best = {
        t,
        kind: "neighbor",
        wall: true,
        building,
        point: [ox + t * dx, oy + t * dy, z],
        normal: [edge.nx, edge.ny, 0],
      };
    }
  }
  if (Math.abs(dz) > 1e-6) {
    const planes = [[building.height, [0, 0, 1], "roof"]];
    if (building.minHeight > 1.2) planes.push([building.minHeight, [0, 0, -1], "roof"]);
    for (const [zPlane, normal, kind] of planes) {
      const t = (zPlane - oz) / dz;
      if (t <= tMin || t >= tMax) continue;
      const x = ox + t * dx;
      const y = oy + t * dy;
      if (!pointInBuilding(x, y, building)) continue;
      if (!best || t < best.t) {
        best = { t, kind, wall: false, building, point: [x, y, zPlane], normal };
      }
    }
  }
  return best;
}

function inWater(x, y, tile) {
  for (const ring of tile.water || []) if (pointInRing(x, y, ring)) return true;
  return false;
}

function nearRoad(x, y, tile) {
  for (const seg of tile.roadSegs) {
    const abx = seg.bx - seg.ax;
    const aby = seg.by - seg.ay;
    const len2 = abx * abx + aby * aby || 1;
    let u = ((x - seg.ax) * abx + (y - seg.ay) * aby) / len2;
    u = Math.max(0, Math.min(1, u));
    const px = seg.ax + u * abx;
    const py = seg.ay + u * aby;
    if (Math.hypot(x - px, y - py) <= seg.half + 1.2) return true;
  }
  return false;
}

export function waterNormal(x, y) {
  const nx = 0.045 * Math.sin(x * 0.07 + y * 0.02);
  const ny = 0.045 * Math.cos(y * 0.05 - x * 0.01);
  const len = Math.hypot(nx, ny, 1);
  return [nx / len, ny / len, 1 / len];
}

/** Schlick fresnel for air-water, capped so the harbour bounce stays weak. */
export function waterReflectance(nd) {
  const c = Math.max(0, Math.min(1, nd));
  const fresnel = 0.02 + 0.1 * (1 - c) ** 5;
  return Math.min(0.12, fresnel);
}

export function firstHit(origin, dir, tile, skipId, tMin = T_MIN, tMax = 2000) {
  let best = null;
  const limit = () => (best ? best.t : tMax);
  for (const building of tile.buildings) {
    if (building.id === skipId) continue;
    const hit = rayBuilding(origin, dir, building, tMin, limit());
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  if (dir[2] < -1e-6) {
    const waterZ = 0.12;
    const tw = (waterZ - origin[2]) / dir[2];
    if (tw > tMin && tw < limit()) {
      const x = origin[0] + tw * dir[0];
      const y = origin[1] + tw * dir[1];
      if (inWater(x, y, tile)) {
        best = {
          t: tw,
          kind: "water",
          wall: false,
          building: null,
          point: [x, y, waterZ],
          normal: waterNormal(x, y),
        };
      }
    }
    const tg = (0 - origin[2]) / dir[2];
    if (tg > tMin && tg < limit()) {
      const x = origin[0] + tg * dir[0];
      const y = origin[1] + tg * dir[1];
      if (!inWater(x, y, tile)) {
        best = {
          t: tg,
          kind: nearRoad(x, y, tile) ? "street" : "ground",
          wall: false,
          building: null,
          point: [x, y, 0.02],
          normal: [0, 0, 1],
        };
      }
    }
  }
  return best;
}

function normalize2(v) {
  const len = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / len, v[1] / len];
}

export function facadeClusters(building) {
  const edges = building.edges.filter((edge) => !edge.hole);
  const clusters = [];
  let current = null;
  for (const edge of edges) {
    const n = [edge.nx, edge.ny];
    if (!current || n[0] * current.n[0] + n[1] * current.n[1] < 0.94) {
      current = { edges: [], sx: 0, sy: 0, length: 0, n: [0, 0] };
      clusters.push(current);
    }
    current.edges.push(edge);
    current.length += edge.len;
    current.sx += edge.nx * edge.len;
    current.sy += edge.ny * edge.len;
    current.n = normalize2([current.sx, current.sy]);
  }
  if (clusters.length > 1) {
    const first = clusters[0];
    const last = clusters[clusters.length - 1];
    if (first.n[0] * last.n[0] + first.n[1] * last.n[1] > 0.94) {
      last.edges.push(...first.edges);
      last.length += first.length;
      last.sx += first.sx;
      last.sy += first.sy;
      last.n = normalize2([last.sx, last.sy]);
      clusters.shift();
    }
  }
  return clusters.filter((cluster) => cluster.length >= 8);
}

function facadeScore(building, cluster, tile) {
  let walked = 0;
  let mid = [cluster.edges[0].ax, cluster.edges[0].ay];
  const target = cluster.length * 0.5;
  for (const edge of cluster.edges) {
    if (walked + edge.len >= target) {
      const u = (target - walked) / edge.len;
      mid = [edge.ax + (edge.bx - edge.ax) * u, edge.ay + (edge.by - edge.ay) * u];
      break;
    }
    walked += edge.len;
  }
  const z = (building.minHeight || 0) + Math.max(8, (building.height - (building.minHeight || 0)) * 0.45);
  const origin = [mid[0] + cluster.n[0] * 1.2, mid[1] + cluster.n[1] * 1.2, z];
  const hit = firstHit(origin, [cluster.n[0], cluster.n[1], 0], tile, building.id, 0.4, 70);
  let neighbor = 0;
  if (hit && hit.wall && hit.t > 7 && hit.t < 48 && hit.building.height >= 24) neighbor = Math.min(hit.building.height, 180) / (hit.t + 8);
  const south = cluster.n[1] < -0.25 ? 1.35 : cluster.n[1] < 0.15 ? 1.05 : 0.75;
  const named = building.name ? 1.2 : 1;
  const recorded = building.measured === true || (building.measured == null && building.source === "height");
  const measured = recorded ? 1.25 : 0.8;
  const tall = building.height >= 40 && building.height <= 430 ? 1 : 0.45;
  return {
    score: cluster.length * (0.35 + neighbor) * south * named * measured * tall,
    neighbor,
    mid,
    hit,
  };
}

export function rankSubjects(tile, limit = 8) {
  const ranked = [];
  for (const building of tile.buildings) {
    if (building.height < 36 || building.kind === "roof") continue;
    let best = null;
    for (const cluster of facadeClusters(building)) {
      const scored = facadeScore(building, cluster, tile);
      const row = { building, cluster, ...scored };
      if (!best || row.score > best.score) best = row;
    }
    if (best && best.score > 0) ranked.push(best);
  }
  ranked.sort((a, b) => b.score - a.score);
  const named = ranked.filter((row) => row.building.name);
  const canyon = named.slice(0, Math.max(4, limit - 4));
  const skyline = named
    .filter((row) => row.building.height >= 180)
    .sort((a, b) => b.building.height - a.building.height || b.score - a.score);
  const merged = [];
  for (const row of [...canyon, ...skyline, ...named]) {
    if (merged.some((item) => item.building.id === row.building.id)) continue;
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return (merged.length >= 3 ? merged : ranked).slice(0, limit);
}

export function buildPanels(building, cluster, alphaDeg, stepH = 12, stepV = 15) {
  const z0 = Math.max((building.minHeight || 0) + 3, 6);
  const z1 = building.height - 2;
  if (z1 - z0 < 4) return [];
  let hStep = stepH;
  let vStep = stepV;
  let samples = [];
  for (let guard = 0; guard < 5; guard += 1) {
    samples = [];
    let cursor = hStep * 0.5;
    let travelled = 0;
    for (const edge of cluster.edges) {
      while (cursor < travelled + edge.len - 0.05) {
        const u = (cursor - travelled) / edge.len;
        const x = edge.ax + (edge.bx - edge.ax) * u;
        const y = edge.ay + (edge.by - edge.ay) * u;
        for (let z = z0 + vStep * 0.45; z < z1; z += vStep) {
          const sill = z0 + Math.floor((z - z0) / FLOOR_M) * FLOOR_M;
          const local = Math.max(0.4, z - sill);
          const shifted = tiltedPoint(x, y, local, cluster.n, alphaDeg);
          samples.push({
            origin: [shifted[0], shifted[1], shifted[2] + sill],
            nh: cluster.n,
            sill,
          });
        }
        cursor += hStep;
      }
      travelled += edge.len;
    }
    if (samples.length <= 200) break;
    hStep *= 1.28;
    vStep *= 1.22;
  }
  return samples;
}

function bounce(hit, travelDir) {
  let normal = hit.normal.slice();
  const toward = [-travelDir[0], -travelDir[1], -travelDir[2]];
  let nd = dot(normal, toward);
  if (nd < 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
    nd = -nd;
  }
  if (nd < 0.03) return null;
  const { r } = reflect(normal, toward);
  return { r, nd, normal };
}

function skyPoint(origin, dir, span) {
  return add(origin, dir, span);
}

/** Nearly horizontal sky rays need a longer visible run; steep ones stay short. */
function skySpan(dir) {
  const up = Math.max(dir[2], 0.02);
  return Math.min(260, Math.max(64, 16 / up));
}

export function traceTile(tile, options) {
  const { building, facade, alpha, sun, dni, rho } = options;
  const panels = buildPanels(building, facade, alpha, options.stepH || 12, options.stepV || 15);
  const counts = {
    panels: panels.length,
    backlit: 0,
    shaded: 0,
    lit: 0,
    street: 0,
    neighbor: 0,
    water: 0,
    sky: 0,
    ground: 0,
    roof: 0,
    hop2: 0,
    hop2sky: 0,
    hop2water: 0,
    hop2street: 0,
    hop2ground: 0,
    hop2roof: 0,
    hop2neighbor: 0,
  };
  const paths = [];
  const occlusions = [];
  for (const panel of panels) {
    const normal = tiltNormal(facade.n, alpha);
    const { nd, r } = reflect(normal, sun);
    if (nd <= 0.02) {
      counts.backlit += 1;
      continue;
    }
    const shade = firstHit(panel.origin, sun, tile, building.id, 0.6, 5000);
    if (shade) {
      counts.shaded += 1;
      if (occlusions.length < 6 && counts.shaded % 3 === 1) {
        occlusions.push({
          from: panel.origin.slice(),
          to: shade.point.slice(),
          kind: shade.kind,
        });
      }
      continue;
    }
    counts.lit += 1;
    const hit = firstHit(panel.origin, r, tile, building.id, 0.35, 1600);
    let kind = "sky";
    let end = skyPoint(panel.origin, r, skySpan(r));
    let hop2 = null;
    let neighborId = "";
    let neighborName = "";
    let waterRho = 1;
    if (!hit) {
      kind = r[2] > 0.02 ? "sky" : "ground";
      if (kind === "sky") end = skyPoint(panel.origin, r, skySpan(r));
      else if (r[2] < -1e-4) {
        const t = (0.02 - panel.origin[2]) / r[2];
        end = t > 0 ? add(panel.origin, r, t) : skyPoint(panel.origin, r, 60);
        kind = "ground";
      } else end = skyPoint(panel.origin, r, 48);
    } else {
      kind = hit.kind;
      end = hit.point;
      if (hit.building) {
        neighborId = hit.building.id;
        neighborName = hit.building.name || "";
      }
      if (hit.wall || hit.kind === "water") {
        const bounced = bounce(hit, r);
        if (bounced) {
          if (hit.kind === "water") waterRho = waterReflectance(bounced.nd);
          const origin2 = add(hit.point, bounced.normal, 0.3);
          const hit2 = firstHit(origin2, bounced.r, tile, hit.building ? hit.building.id : null, 0.2, 1600);
          let kind2;
          let end2;
          if (!hit2) {
            kind2 = bounced.r[2] > 0.02 ? "sky" : "ground";
            if (kind2 === "sky") end2 = skyPoint(origin2, bounced.r, skySpan(bounced.r));
            else if (bounced.r[2] < -1e-4) end2 = add(origin2, bounced.r, (0.02 - origin2[2]) / bounced.r[2]);
            else end2 = skyPoint(origin2, bounced.r, 40);
          } else {
            kind2 = hit2.kind;
            end2 = hit2.point;
          }
          hop2 = { from: hit.point.slice(), to: end2, kind: kind2 };
          counts.hop2 += 1;
          const key = `hop2${kind2}`;
          if (key in counts) counts[key] += 1;
        }
      }
    }
    counts[kind] += 1;
    const rho2 = hop2 ? (kind === "water" ? waterRho : rho) : 1;
    const energy = Math.max(0, (dni / 1000) * nd * rho * rho2);
    paths.push({
      origin: panel.origin,
      hops: [{ from: panel.origin.slice(), to: end.slice(), kind }, ...(hop2 ? [hop2] : [])],
      energy,
      kind,
      neighborId,
      neighborName,
      normal,
    });
  }
  return { paths, counts, panels: panels.length, occlusions };
}

export function drawBudget(mobile = false) {
  if (mobile) return { street: 8, neighbor: 6, water: 4, sky: 5, ground: 2, roof: 2 };
  return { street: 12, neighbor: 8, water: 5, sky: 6, ground: 3, roof: 2 };
}

const HERO_ORDER = ["sky", "water", "street", "ground", "neighbor", "roof"];

function pathLength(path) {
  let length = 0;
  for (const hop of path.hops) length += dist(hop.from, hop.to);
  return length;
}

export function reachesStreet(path) {
  return path.hops.some((hop) => hop.kind === "street");
}

export function pickHero(paths, mode = "reflect") {
  const pool = mode === "street" ? paths.filter(reachesStreet) : paths;
  const doubles = pool.filter((path) => path.hops.length > 1 && pathLength(path) > 10);
  doubles.sort((a, b) => {
    const ka = HERO_ORDER.indexOf(a.hops[1].kind);
    const kb = HERO_ORDER.indexOf(b.hops[1].kind);
    if (mode !== "street" && ka !== kb) return ka - kb;
    if (mode === "street") {
      const as = a.hops[1] && a.hops[1].kind === "street" ? 0 : 1;
      const bs = b.hops[1] && b.hops[1].kind === "street" ? 0 : 1;
      if (as !== bs) return as - bs;
    }
    const aGlass = a.hops[0].kind === "neighbor" ? 0 : 1;
    const bGlass = b.hops[0].kind === "neighbor" ? 0 : 1;
    if (aGlass !== bGlass) return aGlass - bGlass;
    return b.energy - a.energy || pathLength(b) - pathLength(a);
  });
  if (doubles.length) return doubles[0];
  const singles = pool.slice().sort((a, b) => b.energy - a.energy);
  return singles[0] || null;
}

export function selectDrawn(paths, mode, hero, showHop2, options = {}) {
  const mobile = options.mobile === true;
  const cap = drawBudget(mobile);
  const cell = mobile ? 26 : 18;
  let list = mode === "street" ? paths.filter(reachesStreet) : paths.slice();
  if (!showHop2) list = list.filter((path) => path.hops[0] && (mode !== "street" || path.hops[0].kind === "street"));
  const best = new Map();
  for (const path of list) {
    if (hero && path === hero) continue;
    const key = cap[path.kind] ? path.kind : "ground";
    const p = path.hops[0].to;
    const hop2 = path.hops[1] ? path.hops[1].kind : "-";
    const id = `${key}:${Math.round(p[0] / cell)}:${Math.round(p[1] / cell)}:${Math.round(p[2] / 22)}:${hop2}`;
    const prev = best.get(id);
    if (!prev || path.energy > prev.energy) best.set(id, path);
  }
  const buckets = {};
  for (const key of Object.keys(cap)) buckets[key] = [];
  for (const path of best.values()) {
    const key = buckets[path.kind] ? path.kind : "ground";
    buckets[key].push(path);
  }
  const drawn = [];
  if (hero && list.includes(hero)) drawn.push(hero);
  for (const key of Object.keys(cap)) {
    buckets[key].sort((a, b) => b.energy - a.energy);
    drawn.push(...buckets[key].slice(0, cap[key]));
  }
  return drawn.map((path) => {
    const hops = !showHop2 && path.hops.length > 1 ? [path.hops[0]] : path.hops;
    return { ...path, hops, featured: path === hero };
  });
}

export const KIND_LABEL = {
  street: "街",
  neighbor: "邻楼玻璃",
  water: "水面",
  sky: "天空",
  ground: "空地",
  roof: "屋顶",
};

export function describePath(path) {
  if (!path) return "这一时刻这面墙没有反射光路。拧时刻或倾角，南向的墙会在太阳偏南时亮起来。";
  const first = path.hops[0];
  if (path.hops.length > 1) {
    const via = first.kind === "water" ? "水面" : path.neighborName || "邻楼玻璃";
    return `折线：本楼 → ${via} → ${KIND_LABEL[path.hops[1].kind] || "远处"}`;
  }
  return `一跳：本楼 → ${KIND_LABEL[first.kind] || "远处"}`;
}
