import { SCENES, PRESETS, buildPanels } from "./scenes.js";
import { trace } from "./trace.js";
import {
  solarPosition,
  sunVector,
  previewDni,
  localToUtc,
  dayOfYear,
  fromDayOfYear,
  formatStamp,
} from "./solar.js";

const state = {
  sceneId: "A",
  alpha: 30,
  year: 2026,
  month: 6,
  day: 21,
  hour: 12,
  minute: 0,
  rho: 0.3,
  mode: "both",
};

const panels = new Map();
let relax = null;
let frame = 0;

const $ = (id) => document.getElementById(id);

function scene() {
  return SCENES[state.sceneId];
}

function panelsFor(id) {
  if (!panels.has(id)) panels.set(id, buildPanels(SCENES[id]));
  return panels.get(id);
}

function fmt(n) {
  return new Intl.NumberFormat("zh-CN").format(n);
}

function pct(n, d) {
  if (!d) return "—";
  return `${((100 * n) / d).toFixed(1)}%`;
}

function syncControls() {
  $("alpha").value = String(state.alpha);
  $("alpha-val").textContent = `${state.alpha.toFixed(1)}°`;
  $("doy").value = String(dayOfYear(state.month, state.day));
  $("date-val").textContent = `${state.month}月${state.day}日`;
  $("clock").value = String(state.hour * 60 + state.minute);
  $("time-val").textContent = formatStamp(state.year, state.month, state.day, state.hour, state.minute).slice(11);
  $("year").value = String(state.year);
  $("year-val").textContent = String(state.year);
  $("rho").value = String(state.rho);
  $("rho-val").textContent = state.rho.toFixed(2);
  $("mode-both").setAttribute("aria-checked", state.mode === "both" ? "true" : "false");
  $("mode-street").setAttribute("aria-checked", state.mode === "street" ? "true" : "false");
  for (const button of document.querySelectorAll("#scenes button")) {
    button.setAttribute("aria-pressed", button.dataset.id === state.sceneId ? "true" : "false");
  }
  for (const button of document.querySelectorAll("#rho-picks button")) {
    button.setAttribute("aria-pressed", Math.abs(Number(button.dataset.rho) - state.rho) < 0.001 ? "true" : "false");
  }
}

function renderPresets() {
  const host = $("presets");
  host.replaceChildren();
  for (const preset of PRESETS.filter((item) => item.scene === state.sceneId)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.label;
    button.addEventListener("click", () => {
      state.year = preset.year;
      state.month = preset.month;
      state.day = preset.day;
      state.hour = preset.hour;
      state.minute = preset.minute;
      state.alpha = preset.alpha;
      schedule();
    });
    host.appendChild(button);
  }
}

function momentSun() {
  const current = scene();
  const utc = localToUtc(state.year, state.month, state.day, state.hour, state.minute, current.tz);
  const pos = solarPosition(utc, current.lat, current.lon);
  const dni = previewDni(pos.elevationDeg);
  return { pos, dni, utc, sun: sunVector(pos.elevationDeg, pos.azimuthDeg) };
}

function schedule() {
  syncControls();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(draw);
}

function draw() {
  const current = scene();
  const sun = momentSun();
  const active = sunActive(sun);
  const result = active
    ? trace(current, panelsFor(current.id), sun.sun, state.alpha, state.rho, sun.dni)
    : emptyResult(current);
  paintPlan(current, result, active);
  paintSection(current, result, active);
  writeCopy(current, result, sun, active);
}

function sunActive(sun) {
  return sun.pos.elevationDeg > 0 && sun.dni >= 50;
}

function emptyResult(current) {
  const [xmin, ymin, xmax, ymax] = current.street;
  const cell = 2;
  return {
    nx: Math.max(1, Math.floor((xmax - xmin) / cell + 1e-9)),
    ny: Math.max(1, Math.floor((ymax - ymin) / cell + 1e-9)),
    xmin,
    ymin,
    cell,
    heat: new Float32Array(0),
    peak: 0,
    hotCells: 0,
    counts: { panels: panelsFor(current.id).length, lit: 0, backlit: 0, shaded: 0, street: 0, neighbor: 0, sky: 0, other: 0 },
    boxes: [],
    rays: [],
  };
}

function fit(canvas, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function mapper(frameBox, w, h, pad) {
  const [xmin, ymin, xmax, ymax] = frameBox;
  const scale = Math.min((w - pad * 2) / (xmax - xmin), (h - pad * 2) / (ymax - ymin));
  const ox = pad + ((w - pad * 2) - (xmax - xmin) * scale) / 2;
  const oy = pad + ((h - pad * 2) - (ymax - ymin) * scale) / 2;
  return {
    x: (wx) => ox + (wx - xmin) * scale,
    y: (wy) => oy + (ymax - wy) * scale,
    scale,
  };
}

function hex(color) {
  const n = color.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

function mix(a, b, t) {
  const pa = hex(a);
  const pb = hex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function heatColor(value, peak) {
  if (value >= 100) {
    const cap = Math.max(peak, 140);
    const u = Math.min(1, (value - 100) / (cap - 100));
    return mix("#e25a12", "#7a140e", u);
  }
  return mix("#f6e7c8", "#e7a15a", Math.min(1, value / 100));
}

function rect(ctx, map, min, max, fill, stroke) {
  const x = map.x(min[0]);
  const y = map.y(max[1]);
  const w = map.x(max[0]) - x;
  const h = map.y(min[1]) - y;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  return { x, y, w, h };
}

function paintPlan(current, result, active) {
  const canvas = $("plan");
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 640;
  const [x0, y0, x1, y1] = current.frame;
  const narrow = window.innerWidth < 800;
  const cssH = Math.max(220, Math.min(cssW * ((y1 - y0) / (x1 - x0)), narrow ? 420 : 480));
  const { ctx, w, h } = fit(canvas, cssW, cssH);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#f7f3ea";
  ctx.fillRect(0, 0, w, h);
  const map = mapper(current.frame, w, h, 16);

  const street = current.street;
  rect(ctx, map, [street[0], street[1]], [street[2], street[3]], "#e7dcc8", "rgba(28,24,20,0.25)");

  if (active && result.heat.length) {
    for (let iy = 0; iy < result.ny; iy += 1) {
      for (let ix = 0; ix < result.nx; ix += 1) {
        const value = result.heat[iy * result.nx + ix];
        if (value <= 1) continue;
        const wx = result.xmin + ix * result.cell;
        const wy = result.ymin + iy * result.cell;
        const x = map.x(wx);
        const y = map.y(wy + result.cell);
        const rw = Math.max(1, map.x(wx + result.cell) - x);
        const rh = Math.max(1, map.y(wy) - y);
        ctx.fillStyle = heatColor(value, result.peak);
        ctx.fillRect(x, y, rw + 0.4, rh + 0.4);
      }
    }
  }

  ctx.save();
  ctx.strokeStyle = "rgba(28,24,20,0.35)";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const lane of current.lanes) {
    ctx.beginPath();
    ctx.moveTo(map.x(current.frame[0]), map.y(lane.y));
    ctx.lineTo(map.x(current.frame[2]), map.y(lane.y));
    ctx.stroke();
  }
  ctx.restore();

  for (const box of current.boxes) {
    const drawn = rect(ctx, map, box.min, box.max, "#d7cdb8", "#2a241e");
    if (drawn.w > 42 && drawn.h > 16) {
      ctx.fillStyle = "#1c1814";
      ctx.font = "12px 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif";
      ctx.fillText(box.name, drawn.x + 4, drawn.y + 14);
    }
  }

  if (current.target) {
    const { lengthEw, widthNs } = current.target;
    rect(ctx, map, [-lengthEw / 2, -widthNs / 2], [lengthEw / 2, widthNs / 2], "#fbf7ef", "#1c1814");
    ctx.lineWidth = 2;
    ctx.strokeRect(
      map.x(-lengthEw / 2),
      map.y(widthNs / 2),
      map.x(lengthEw / 2) - map.x(-lengthEw / 2),
      map.y(-widthNs / 2) - map.y(widthNs / 2),
    );
  }
  if (current.mass) {
    rect(ctx, map, current.mass.min, current.mass.max, "#fbf7ef", "#1c1814");
  }
  if (current.curve) {
    ctx.beginPath();
    const xs = [];
    const half = current.curve.width_m / 2;
    for (let i = 0; i <= 24; i += 1) xs.push(-half + (current.curve.width_m * i) / 24);
    xs.forEach((x, i) => {
      const z = 40;
      const { sag_h_m: sag, overhang_m: overhang, overhang_exp: exponent, height_m: height, width_m: width } = current.curve;
      const y = sag * (1 - (2 * x / width) ** 2) - overhang * (z / height) ** exponent;
      const px = map.x(x);
      const py = map.y(y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = "#e25a12";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const showNeighbor = state.mode === "both";
  for (const hit of result.boxes) {
    const box = current.boxes.find((item) => item.name === hit.name);
    if (!box) continue;
    const cx = map.x((box.min[0] + box.max[0]) / 2);
    const cy = map.y((box.min[1] + box.max[1]) / 2);
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fillStyle = showNeighbor ? "#7a3048" : "rgba(122,48,72,0.25)";
    ctx.fill();
    ctx.strokeStyle = "#1c1814";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = showNeighbor ? "#f4efe4" : "#1c1814";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(hit.count), cx, cy + 4);
    ctx.textAlign = "left";
  }

  ctx.fillStyle = "#1c1814";
  ctx.font = "12px sans-serif";
  ctx.fillText("北", w - 28, 22);
  ctx.beginPath();
  ctx.moveTo(w - 22, 28);
  ctx.lineTo(w - 22, 52);
  ctx.lineTo(w - 26, 42);
  ctx.moveTo(w - 22, 28);
  ctx.lineTo(w - 18, 38);
  ctx.strokeStyle = "#1c1814";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  const bar = 40 * map.scale;
  ctx.strokeStyle = "#1c1814";
  ctx.beginPath();
  ctx.moveTo(18, h - 16);
  ctx.lineTo(18 + bar, h - 16);
  ctx.stroke();
  ctx.fillText("40 m", 18, h - 22);
}

function paintSection(current, result, active) {
  const canvas = $("section");
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 640;
  const narrow = window.innerWidth < 800;
  const cssH = narrow ? 190 : 230;
  const { ctx, w, h } = fit(canvas, cssW, cssH);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#f7f3ea";
  ctx.fillRect(0, 0, w, h);
  const height = current.target ? current.target.height : current.curve.height_m;
  const opp = current.section.opposite;
  const zMax = Math.max(height, opp ? opp.h : 0) * 1.08;
  const yMin = current.frame[1];
  const yMax = current.frame[3];
  const map = mapper([yMin, 0, yMax, zMax], w, h, 18);
  const yToX = map.x;
  const zToY = (z) => map.y(z);

  if (current.section.road) {
    const [a, b] = current.section.road;
    ctx.fillStyle = "#e7dcc8";
    const x = yToX(Math.min(a, b));
    const rw = yToX(Math.max(a, b)) - x;
    ctx.fillRect(x, zToY(1.2), rw, zToY(0) - zToY(1.2));
  }

  ctx.strokeStyle = "#5c5348";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(yToX(yMin), zToY(0));
  ctx.lineTo(yToX(yMax), zToY(0));
  ctx.stroke();

  if (opp) {
    const x = yToX(Math.min(opp.yNear, opp.yFar));
    const rw = Math.abs(yToX(opp.yNear) - yToX(opp.yFar));
    ctx.fillStyle = "#d7cdb8";
    ctx.strokeStyle = "#2a241e";
    ctx.fillRect(x, zToY(opp.h), rw, zToY(0) - zToY(opp.h));
    ctx.strokeRect(x, zToY(opp.h), rw, zToY(0) - zToY(opp.h));
  }

  if (current.target) {
    const south = -current.target.widthNs / 2;
    const north = current.target.widthNs / 2;
    const x = yToX(south);
    const rw = yToX(north) - x;
    ctx.fillStyle = "#fbf7ef";
    ctx.strokeStyle = "#1c1814";
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, zToY(height), rw, zToY(0) - zToY(height));
    ctx.strokeRect(x, zToY(height), rw, zToY(0) - zToY(height));
  } else if (current.mass) {
    const x = yToX(current.mass.min[1]);
    const rw = yToX(current.mass.max[1]) - x;
    ctx.fillStyle = "#fbf7ef";
    ctx.strokeStyle = "#1c1814";
    ctx.strokeRect(x, zToY(current.mass.max[2]), rw, zToY(0) - zToY(current.mass.max[2]));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(8, 8, w - 16, h - 16);
  ctx.clip();
  if (active) {
    for (const ray of result.rays) {
      ctx.beginPath();
      ctx.moveTo(yToX(ray.y0), zToY(ray.z0));
      ctx.lineTo(yToX(ray.y1), zToY(ray.z1));
      ctx.strokeStyle = ray.kind === "street" ? "#e25a12"
        : ray.kind === "neighbor" ? (state.mode === "both" ? "#7a3048" : "rgba(122,48,72,0.35)")
          : ray.kind === "sky" ? "#1d6a62" : "#8a8175";
      ctx.lineWidth = ray.kind === "street" || (ray.kind === "neighbor" && state.mode === "both") ? 1.6 : 1;
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.fillStyle = "#5c5348";
  ctx.font = "12px 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif";
  ctx.fillText("南", 12, h - 8);
  ctx.fillText("北", w - 24, h - 8);
  ctx.fillText("剖面", 12, 18);
}

function concernCount(counts) {
  return state.mode === "street" ? counts.street : counts.street + counts.neighbor;
}

function writeCopy(current, result, sun, active) {
  $("scene-note").textContent = current.note;
  const pack = relax && relax.scenes[current.id];
  const official = pack && pack.official;
  $("gate").textContent = official
    ? `${official.sentence} 全年 TMY 无解板元·时刻 ${fmt(official.tmy_unsolved)} / ${fmt(official.tmy_total)}。主反射比 ρ=${official.rho.toFixed(2)} 时，窗 ${official.windows}，驾驶员 ${official.drivers}，街面峰值 ${official.street_peak_Wm2} W/m²。`
    : "全年 Gate 文字未载入。刷新后再看旁注。";

  const note = $("sun-note");
  if (!active) {
    note.hidden = false;
    note.textContent = sun.pos.elevationDeg <= 0
      ? "太阳在地平线下。这一时刻没有镜面反射可画。"
      : `预览晴空约 ${sun.dni.toFixed(0)} W/m²，低于 50 W/m²，按全年规则跳过。`;
  } else {
    note.hidden = true;
  }

  const elev = sun.pos.elevationDeg;
  const az = sun.pos.azimuthDeg;
  $("plan-cap").textContent = active
    ? `平面热力 · 太阳高度 ${elev.toFixed(1)}°，方位 ${az.toFixed(0)}°（北起顺时针）。预览直射 ${sun.dni.toFixed(0)} W/m²。峰值格子 ${result.peak.toFixed(0)} W/m²，超过 100 的格子 ${result.hotCells} 个。`
    : "平面只留街块。把时刻往白天拖。";
  $("section-cap").textContent = current.section.caption;

  const modeName = state.mode === "street" ? "只护街" : "连邻窗一起算";
  const counts = result.counts;
  const concern = concernCount(counts);
  $("mode-hint").textContent = state.mode === "street"
    ? "只统计落到街面范围的反射。打进邻楼的仍画成淡色，不计入下面的条数。这不是新的全年结论。"
    : "街面和邻楼一起计入。这是现行几何口径：反射要导离周边建筑，而不只是离开马路。";

  const boxLine = result.boxes.length
    ? result.boxes.map((item) => `${item.name} ${item.count} 条（最高约 ${item.maxZ.toFixed(0)} m）`).join("，")
    : "这一时刻没有反射进入邻楼盒子。";

  $("stats").innerHTML = `
    <div class="concern"><span>本时刻按「${modeName}」</span><b>${fmt(concern)} 条</b></div>
    <div><span>受照</span><b>${fmt(counts.lit)}</b></div>
    <div><span>落街</span><b>${fmt(counts.street)}</b></div>
    <div><span>进邻楼</span><b>${fmt(counts.neighbor)}</b></div>
    <div><span>导天</span><b>${fmt(counts.sky)}</b></div>
    <div><span>背光</span><b>${fmt(counts.backlit)}</b></div>
    <div><span>被挡住的入射</span><b>${fmt(counts.shaded)}</b></div>
    <p class="fine" style="grid-column:1/-1;margin:0">${boxLine} 板元 ${fmt(counts.panels)} 个，步长 4 m。</p>
  `;

  $("relax").innerHTML = relaxHtml(current, pack);
}

function relaxHtml(current, pack) {
  if (!pack) return "<h2>抽样还没载入</h2><p>需要 data/relax.json。</p>";
  const off = pack.official;
  const head = current.id === "A" ? "九龙 A 会松多少" : "同一套抽样";
  const body = `粗网格 ${pack.panels} 块板、${pack.moments_used} 个晴空时刻、倾角 0–50° 每 2.5°。现行口径无解 ${fmt(pack.strict_unsolved)} / ${fmt(pack.panel_times)}（${pct(pack.strict_unsolved, pack.panel_times)}）。只护街无解 ${fmt(pack.street_unsolved)} / ${fmt(pack.panel_times)}。其中 ${fmt(pack.relaxed_onto_facade)} 个板元时刻能离开街面，但没有任何倾角能导离邻楼。`;
  const z = pack.strict_unsolved
    ? `无解里 z&lt;20 m 为 ${fmt(pack.strict_z_below_20)}，z≥20 m 为 ${fmt(pack.strict_z_at_least_20)}。`
    : "抽样里没有「0–50° 仍进邻楼」的板元时刻。";
  const official = `全年官方结论仍是「${off.headline}」：TMY ${fmt(off.tmy_unsolved)} / ${fmt(off.tmy_total)}。${state.mode === "street" ? "现在看的是只护街。上面的比例是搬移说明，不把全年 Gate 改写成通过。" : "切到「只护街」只改这一时刻的计数和这句话的对照，不改全年数字。"}`;
  return `<h2>${head}</h2><p>${body}${z}</p><p>${official}</p>`;
}

function bind() {
  const scenes = $("scenes");
  for (const id of ["A", "B", "C", "walkie_talkie"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = id;
    button.textContent = SCENES[id].short;
    button.addEventListener("click", () => {
      state.sceneId = id;
      state.rho = SCENES[id].rho;
      renderPresets();
      schedule();
    });
    scenes.appendChild(button);
  }
  const picks = $("rho-picks");
  for (const rho of [0.08, 0.16, 0.25, 0.3]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.rho = String(rho);
    button.textContent = `ρ ${rho.toFixed(2)}`;
    button.addEventListener("click", () => {
      state.rho = rho;
      schedule();
    });
    picks.appendChild(button);
  }
  $("mode-both").addEventListener("click", () => {
    state.mode = "both";
    schedule();
  });
  $("mode-street").addEventListener("click", () => {
    state.mode = "street";
    schedule();
  });
  $("alpha").addEventListener("input", (event) => {
    state.alpha = Number(event.target.value);
    schedule();
  });
  $("doy").addEventListener("input", (event) => {
    const date = fromDayOfYear(Number(event.target.value));
    state.month = date.month;
    state.day = date.day;
    schedule();
  });
  $("clock").addEventListener("input", (event) => {
    const minutes = Number(event.target.value);
    state.hour = Math.floor(minutes / 60);
    state.minute = minutes % 60;
    schedule();
  });
  $("year").addEventListener("input", (event) => {
    state.year = Number(event.target.value);
    schedule();
  });
  $("rho").addEventListener("input", (event) => {
    state.rho = Number(event.target.value);
    schedule();
  });
  $("controls").addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener("resize", schedule);
}

async function loadRelax() {
  try {
    const response = await fetch("data/relax.json");
    if (!response.ok) throw new Error(String(response.status));
    relax = await response.json();
  } catch (error) {
    relax = null;
    console.warn(error);
  }
  schedule();
}

bind();
renderPresets();
loadRelax();
