/** Single-moment sparse reflection. Same formulas as glare_sim, 4 m panels. */

const T_MIN = 0.3;
const T_MAX = 4000;
const MARGIN = 0.05;
const STREET_Z = 1.2;

function tiltNormal(nh, alphaDeg) {
  const a = (alphaDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const n = [c * nh[0], c * nh[1], s];
  const len = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / len, n[1] / len, n[2] / len];
}

function extraTilt(normal, alphaDeg) {
  const horiz = Math.hypot(normal[0], normal[1]);
  let nhx = 0;
  let nhy = -1;
  if (horiz > 1e-8) {
    nhx = normal[0] / horiz;
    nhy = normal[1] / horiz;
  }
  const beta = Math.atan2(normal[2], horiz);
  const angle = beta + (alphaDeg * Math.PI) / 180;
  const c = Math.cos(angle);
  const n = [c * nhx, c * nhy, Math.sin(angle)];
  const len = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / len, n[1] / len, n[2] / len];
}

function reflect(normal, sun) {
  const nd = normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2];
  const r = [
    2 * nd * normal[0] - sun[0],
    2 * nd * normal[1] - sun[1],
    2 * nd * normal[2] - sun[2],
  ];
  const len = Math.hypot(r[0], r[1], r[2]) || 1;
  return { nd, r: [r[0] / len, r[1] / len, r[2] / len] };
}

function rayAabb(origin, dir, boxMin, boxMax) {
  let tNear = -Infinity;
  let tFar = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const da = dir[axis];
    if (Math.abs(da) < 1e-6) {
      if (origin[axis] < boxMin[axis] || origin[axis] > boxMax[axis]) return Infinity;
      continue;
    }
    let t1 = (boxMin[axis] - origin[axis]) / da;
    let t2 = (boxMax[axis] - origin[axis]) / da;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tNear) tNear = t1;
    if (t2 < tFar) tFar = t2;
  }
  const enter = Math.max(tNear, T_MIN);
  if (tFar >= enter && tNear < T_MAX && tFar > T_MIN) return enter;
  return Infinity;
}

function nearestBox(origin, dir, boxes) {
  let best = Infinity;
  let name = "";
  let hit = null;
  for (const box of boxes) {
    const t = rayAabb(origin, dir, box.min, box.max);
    if (t < best) {
      best = t;
      name = box.name;
      hit = [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
    }
  }
  return { t: best, name, hit };
}

function insideFootprints(x, y, footprints) {
  for (const box of footprints) {
    if (x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1]) return true;
  }
  return false;
}

function footprintsOf(scene) {
  const prints = scene.boxes.map((box) => box);
  if (scene.target) {
    const { lengthEw, widthNs, height } = scene.target;
    prints.push({
      name: "目标楼",
      min: [-lengthEw / 2, -widthNs / 2, 0],
      max: [lengthEw / 2, widthNs / 2, height],
    });
  }
  if (scene.curve) {
    const half = scene.curve.width_m / 2;
    prints.push({
      name: "凹面足迹",
      min: [-half, -1, 0],
      max: [half, scene.curve.sag_h_m + 1, scene.curve.height_m],
    });
  }
  return prints;
}

export function trace(scene, panels, sun, alphaDeg, rho, dni) {
  const [xmin, ymin, xmax, ymax] = scene.street;
  const cell = 2;
  const nx = Math.max(1, Math.floor((xmax - xmin) / cell + 1e-9));
  const ny = Math.max(1, Math.floor((ymax - ymin) / cell + 1e-9));
  const heat = new Float32Array(nx * ny);
  const counts = {
    panels: panels.length,
    lit: 0,
    backlit: 0,
    shaded: 0,
    street: 0,
    neighbor: 0,
    sky: 0,
    other: 0,
  };
  const boxHits = new Map();
  const prints = footprintsOf(scene);
  const section = scene.section;
  let sectionCol = null;
  if (section) {
    let best = Infinity;
    for (const panel of panels) {
      if (panel.face !== section.face) continue;
      const dist = Math.abs(panel.u - section.x);
      if (dist < best - 1e-9) {
        best = dist;
        sectionCol = panel.col;
      }
    }
  }
  const rays = [];
  let peak = 0;

  for (const panel of panels) {
    const origin = [panel.x, panel.y, panel.z];
    const normal = panel.curved ? extraTilt(panel.nh, alphaDeg) : tiltNormal(panel.nh, alphaDeg);
    const { nd, r } = reflect(normal, sun);
    const wantSection = section && panel.face === section.face && panel.col === sectionCol;
    if (nd <= 1e-8) {
      counts.backlit += 1;
      continue;
    }
    const shade = nearestBox(origin, sun, scene.boxes);
    if (Number.isFinite(shade.t)) {
      counts.shaded += 1;
      continue;
    }
    counts.lit += 1;
    const blocked = nearestBox(origin, r, scene.boxes);
    const rz = r[2];
    let tGround = Infinity;
    if (Math.abs(rz) > 1e-6) tGround = (STREET_Z - origin[2]) / rz;
    const groundOk = Number.isFinite(tGround) && tGround > T_MIN && tGround < T_MAX && tGround + MARGIN < blocked.t;
    let hx = 0;
    let hy = 0;
    let onStreet = false;
    if (groundOk) {
      hx = origin[0] + tGround * r[0];
      hy = origin[1] + tGround * r[1];
      onStreet = hx >= xmin && hx <= xmax && hy >= ymin && hy <= ymax && !insideFootprints(hx, hy, prints);
    }
    let kind = "other";
    let end = null;
    if (onStreet) {
      kind = "street";
      counts.street += 1;
      end = [hx, hy, STREET_Z];
      const ix = Math.floor((hx - xmin) / cell);
      const iy = Math.floor((hy - ymin) / cell);
      if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) {
        const weight = dni * nd * rho * Math.abs(rz);
        const idx = iy * nx + ix;
        heat[idx] += weight;
        if (heat[idx] > peak) peak = heat[idx];
      }
    } else if (Number.isFinite(blocked.t)) {
      kind = "neighbor";
      counts.neighbor += 1;
      end = blocked.hit;
      const prev = boxHits.get(blocked.name) || { name: blocked.name, count: 0, maxZ: 0 };
      prev.count += 1;
      prev.maxZ = Math.max(prev.maxZ, blocked.hit[2]);
      boxHits.set(blocked.name, prev);
    } else if (rz > 0) {
      kind = "sky";
      counts.sky += 1;
      const span = 90;
      end = [origin[0] + span * r[0], origin[1] + span * r[1], origin[2] + span * r[2]];
    } else {
      counts.other += 1;
      if (groundOk) end = [hx, hy, STREET_Z];
      else {
        const span = 40;
        end = [origin[0] + span * r[0], origin[1] + span * r[1], Math.max(0, origin[2] + span * r[2])];
      }
    }
    if (wantSection && end) {
      rays.push({ y0: origin[1], z0: origin[2], y1: end[1], z1: end[2], kind });
    }
  }

  let hotCells = 0;
  for (let i = 0; i < heat.length; i += 1) if (heat[i] > 100) hotCells += 1;

  return {
    nx,
    ny,
    xmin,
    ymin,
    cell,
    heat,
    peak,
    hotCells,
    counts,
    boxes: [...boxHits.values()].sort((a, b) => b.count - a.count),
    rays,
  };
}
