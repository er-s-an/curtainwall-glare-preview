/** Parametric scenes. Lengths match configs/*.yaml. Panels are rebuilt at 4 m for the preview. */

export const PANEL_M = 4;

export function centers(lo, hi, step) {
  const span = hi - lo;
  const count = Math.floor(span / step + 1e-9);
  if (count <= 0) return [];
  const margin = (span - count * step) / 2;
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = lo + margin + step / 2 + i * step;
  return out;
}

function boxPanels(lengthEw, widthNs, height, step) {
  const xLo = -lengthEw / 2;
  const xHi = lengthEw / 2;
  const yLo = -widthNs / 2;
  const yHi = widthNs / 2;
  const specs = [
    ["S", [0, -1, 0], "x", yLo],
    ["N", [0, 1, 0], "x", yHi],
    ["E", [1, 0, 0], "y", xHi],
    ["W", [-1, 0, 0], "y", xLo],
  ];
  const panels = [];
  for (const [name, nh, uAxis, plane] of specs) {
    const u = uAxis === "x" ? centers(xLo, xHi, step) : centers(yLo, yHi, step);
    const v = centers(0, height, step);
    for (let row = 0; row < v.length; row += 1) {
      for (let col = 0; col < u.length; col += 1) {
        const origin = [0, 0, v[row]];
        if (uAxis === "x") {
          origin[0] = u[col];
          origin[1] = plane;
        } else {
          origin[1] = u[col];
          origin[0] = plane;
        }
        panels.push({
          face: name,
          x: origin[0] + 0.05 * nh[0],
          y: origin[1] + 0.05 * nh[1],
          z: origin[2] + 0.05 * nh[2],
          nh,
          curved: false,
          row,
          col,
          u: u[col],
        });
      }
    }
  }
  return panels;
}

function curvedSouth(cfg, step) {
  const { width_m: width, height_m: height, z_glass_min_m: z0 } = cfg;
  const { sag_h_m: sag, overhang_m: overhang, overhang_exp: exponent } = cfg;
  const xs = centers(-width / 2, width / 2, step);
  const zs = centers(z0, height, step);
  const panels = [];
  for (let row = 0; row < zs.length; row += 1) {
    for (let col = 0; col < xs.length; col += 1) {
      const x = xs[col];
      const z = zs[row];
      const y = sag * (1 - (2 * x / width) ** 2) - overhang * (z / height) ** exponent;
      const dyDx = -sag * (8 * x) / width ** 2;
      const dyDz = -overhang * exponent * (z / height) ** (exponent - 1) / height;
      let nx = dyDx;
      let ny = -1;
      let nz = dyDz;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      panels.push({
        face: "S",
        x: x + 0.05 * nx,
        y: y + 0.05 * ny,
        z: z + 0.05 * nz,
        nh: [nx, ny, nz],
        curved: true,
        row,
        col,
        u: x,
      });
    }
  }
  return panels;
}

export function buildPanels(scene, step = PANEL_M) {
  if (scene.curve) return curvedSouth(scene.curve, step);
  const { lengthEw, widthNs, height } = scene.target;
  return boxPanels(lengthEw, widthNs, height, step);
}

export const SCENES = {
  A: {
    id: "A",
    short: "九龙 A",
    title: "香港九龙",
    note: "参数化街块，不是测绘红线。不是深圳，不是伦敦。",
    lat: 22.3115,
    lon: 114.1705,
    tz: "Asia/Hong_Kong",
    rho: 0.3,
    target: { lengthEw: 60, widthNs: 25, height: 120 },
    curve: null,
    boxes: [
      { name: "南侧楼", min: [-35, -58.5, 0], max: [35, -36.5, 110] },
      { name: "北侧楼", min: [-32, 34.5, 0], max: [32, 62.5, 140] },
      { name: "东侧楼", min: [56, -20, 0], max: [80, 20, 120] },
      { name: "西侧楼", min: [-72, -18, 0], max: [-50, 18, 80] },
    ],
    street: [-80, -70, 80, 70],
    frame: [-88, -78, 96, 78],
    lanes: [
      { name: "东行", y: -15.5 },
      { name: "东行", y: -21.5 },
      { name: "西行", y: -27.5 },
      { name: "西行", y: -33.5 },
    ],
    section: {
      face: "S",
      x: 0,
      road: [-36.5, -12.5],
      opposite: { yNear: -36.5, yFar: -58.5, h: 110, name: "南侧楼" },
      caption: "南立面中线一列，投到南北剖面上。邻楼是剖面里的盒子，不是每扇窗。",
    },
  },
  B: {
    id: "B",
    short: "深南 B",
    title: "深圳 · 深南大道量级",
    note: "40×40×150 m 塔楼。不是地王大厦，不是京基100，不是香港。",
    lat: 22.5408,
    lon: 114.061,
    tz: "Asia/Shanghai",
    rho: 0.25,
    target: { lengthEw: 40, widthNs: 40, height: 150 },
    curve: null,
    boxes: [
      { name: "路对面西座", min: [-45, -114, 0], max: [-12, -84, 48] },
      { name: "路对面东座", min: [12, -114, 0], max: [45, -84, 48] },
    ],
    street: [-90, -130, 90, 40],
    frame: [-100, -140, 100, 50],
    lanes: [
      { name: "西行", y: -37 },
      { name: "西行", y: -43 },
      { name: "西行", y: -49 },
      { name: "东行", y: -55 },
      { name: "东行", y: -61 },
      { name: "东行", y: -67 },
    ],
    section: {
      face: "S",
      x: -16,
      road: [-84, -20],
      opposite: { yNear: -84, yFar: -114, h: 48, name: "路对面西座" },
      caption: "南立面偏西一列，对准路对面西座。塔楼中线对着 T 形缺口，中线剖面看不到对楼。",
    },
  },
  C: {
    id: "C",
    short: "开阔 C",
    title: "开阔对照 · 深圳湾岸线",
    note: "8 层、无高邻楼。不是香港九龙，也不是深南大道旁塔楼。",
    lat: 22.522,
    lon: 113.985,
    tz: "Asia/Shanghai",
    rho: 0.3,
    target: { lengthEw: 36, widthNs: 16, height: 28.8 },
    curve: null,
    boxes: [],
    street: [-50, -40, 50, 25],
    frame: [-60, -48, 60, 32],
    lanes: [
      { name: "西行", y: -14.5 },
      { name: "东行", y: -19.5 },
    ],
    section: {
      face: "S",
      x: 0,
      road: [-28, -8],
      opposite: null,
      caption: "南立面中线一列。这边没有高邻楼，抬起倾角后反射往天上走。",
    },
  },
  walkie_talkie: {
    id: "walkie_talkie",
    short: "伦敦凹面",
    title: "伦敦金融城 · Walkie-Talkie",
    note: "验证场景。曲率是规格书形状，不是竣工测量。不是香港，不是深圳。",
    lat: 51.511278,
    lon: -0.083528,
    tz: "Europe/London",
    rho: 0.3,
    target: null,
    curve: {
      width_m: 52,
      height_m: 160,
      z_glass_min_m: 8,
      sag_h_m: 6,
      overhang_m: 6,
      overhang_exp: 1.2,
    },
    boxes: [],
    street: [-70, -110, 80, 15],
    frame: [-80, -120, 90, 28],
    lanes: [
      { name: "东行", y: -24 },
      { name: "西行", y: -18 },
    ],
    section: {
      face: "S",
      x: 0,
      road: [-40, 6],
      opposite: null,
      caption: "凹面中线一列在南北剖面上的投影。验收日的光斑主要在平面热力里，不在全年 Gate 数字里。",
    },
    mass: { min: [-26, 0, 0], max: [26, 22, 160] },
  },
};

export const PRESETS = [
  { scene: "A", label: "夏至正午", year: 2026, month: 6, day: 21, hour: 12, minute: 0, alpha: 0 },
  { scene: "A", label: "夏至 30°", year: 2026, month: 6, day: 21, hour: 12, minute: 0, alpha: 30 },
  { scene: "A", label: "冬至上午", year: 2026, month: 12, day: 21, hour: 9, minute: 30, alpha: 15 },
  { scene: "B", label: "夏至正午", year: 2026, month: 6, day: 21, hour: 12, minute: 0, alpha: 0 },
  { scene: "B", label: "夏至 30°", year: 2026, month: 6, day: 21, hour: 12, minute: 0, alpha: 30 },
  { scene: "C", label: "夏至正午", year: 2026, month: 6, day: 21, hour: 12, minute: 0, alpha: 0 },
  { scene: "C", label: "冬至正午", year: 2026, month: 12, day: 21, hour: 12, minute: 0, alpha: 20 },
  { scene: "walkie_talkie", label: "验收日 13:00", year: 2013, month: 9, day: 3, hour: 13, minute: 0, alpha: 0 },
  { scene: "walkie_talkie", label: "事发日 13:00", year: 2013, month: 8, day: 29, hour: 13, minute: 0, alpha: 0 },
];
