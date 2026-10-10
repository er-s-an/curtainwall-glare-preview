"""粗网格抽样：只护街 vs 连邻窗（导离邻楼）。

不是全年 Gate。板元 4 m、倾角 0–50° 步长 2.5°、每月 15 日五个钟点、
pvlib Ineichen 且 DNI≥50。全年官方数字不在这里重算。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pvlib

ROOT = Path("/workspace/competitions/chunwo-curtainwall/glare-sim")
sys.path.insert(0, str(ROOT))

from glare_sim.physics import extra_tilt, reflect, tilt_normal  # noqa: E402
from glare_sim.trace import ray_aabb_any, ray_aabb_tmin  # noqa: E402
from glare_sim.weather import read_epw_altitude  # noqa: E402
from glare_sim.world import load_scene  # noqa: E402

OUT = Path("/workspace/competitions/chunwo-curtainwall/glare-sim/web/data")
PANEL_M = 4.0
ALPHAS = np.arange(0.0, 50.0 + 1e-9, 2.5)
HOURS = (8, 10, 12, 14, 16)
T_MIN = 0.30
T_MAX = 4000.0
MARGIN = 0.05
STREET_Z = 1.2

OFFICIAL = {
    "A": {
        "headline": "无解",
        "sentence": "香港九龙：无解。四侧邻楼使大量板元时刻在 0–50° 内无法导离周边建筑。无解不是方案可行。",
        "tmy_unsolved": 14689432,
        "tmy_total": 108077760,
        "clear_unsolved": 16321943,
        "clear_total": 125375040,
        "rho": 0.30,
        "windows": "2434/6085",
        "window_longest_min": 290,
        "drivers": "70/208",
        "street_peak_Wm2": 306,
        "ped_longest_min": 690,
        "static_angle": None,
    },
    "B": {
        "headline": "无解",
        "sentence": "深圳·深南大道量级主干道旁塔楼：无解。不是地王大厦，不是京基100，不是香港。无解不是方案可行。",
        "tmy_unsolved": 658606,
        "tmy_total": 127320000,
        "clear_unsolved": 704609,
        "clear_total": 149076000,
        "rho": 0.25,
        "windows": "600/768",
        "window_longest_min": 110,
        "drivers": "78/520",
        "street_peak_Wm2": 257,
        "ped_longest_min": 580,
        "static_angle": None,
    },
    "C": {
        "headline": "仅动态可解",
        "sentence": "开阔对照（深圳湾岸线）：仅动态可解。没有无解板元时刻，也没有全楼统一角。仅动态可解不是方案可行。不是香港九龙，也不是深南大道旁塔楼。",
        "tmy_unsolved": 0,
        "tmy_total": 15447432,
        "clear_unsolved": 0,
        "clear_total": 18090800,
        "rho": 0.30,
        "windows": "无窗",
        "window_longest_min": None,
        "drivers": "46/96",
        "street_peak_Wm2": 309,
        "ped_longest_min": 570,
        "static_angle": None,
    },
    "walkie_talkie": {
        "headline": "仅动态可解",
        "sentence": "伦敦金融城验证场景：仅动态可解。不是香港，不是深圳。凹面能在街面聚焦；没有无解板元时刻，也没有全楼统一角。仅动态可解不是方案可行。",
        "tmy_unsolved": 0,
        "tmy_total": 36146968,
        "clear_unsolved": 0,
        "clear_total": 48066200,
        "rho": 0.30,
        "windows": "无窗",
        "window_longest_min": None,
        "drivers": "22/64",
        "street_peak_Wm2": 5291,
        "ped_longest_min": 300,
        "static_angle": None,
    },
}


def street_rect(scene) -> tuple[float, float, float, float]:
    raw = scene.meta.get("street_grid")
    if raw:
        return float(raw["x_min"]), float(raw["y_min"]), float(raw["x_max"]), float(raw["y_max"])
    bounds = scene.meta.get("pedestrians", {}).get("bounds", [-40, -40, 40, 40])
    return tuple(map(float, bounds))  # type: ignore[return-value]


def footprints(scene) -> list[tuple[np.ndarray, np.ndarray]]:
    boxes = []
    for lo, hi in zip(scene.bmin, scene.bmax):
        boxes.append((np.asarray(lo, dtype=np.float64), np.asarray(hi, dtype=np.float64)))
    target = scene.meta.get("target")
    if target:
        boxes.append(
            (
                np.array([-target["length_ew_m"] / 2, -target["width_ns_m"] / 2, 0.0]),
                np.array([target["length_ew_m"] / 2, target["width_ns_m"] / 2, target["height_m"]]),
            )
        )
    return boxes


def _inside_street(hx, hy, rect, prints) -> np.ndarray:
    xmin, ymin, xmax, ymax = rect
    inside = (hx >= xmin) & (hx <= xmax) & (hy >= ymin) & (hy <= ymax)
    for lo, hi in prints:
        inside &= ~((hx >= lo[0]) & (hx <= hi[0]) & (hy >= lo[1]) & (hy <= hi[1]))
    return inside


def face_over_alphas(face, sun, bmin, bmax, rect, prints):
    """Per panel, over the alpha grid. Returns strict_ok (P,A), street_hit (P,A), lit (P,A), neighbor (P,A)."""
    origins = face.origins
    p_count = len(origins)
    a_count = len(ALPHAS)
    strict_ok = np.ones((p_count, a_count), dtype=bool)
    street_hit = np.zeros((p_count, a_count), dtype=bool)
    lit = np.zeros((p_count, a_count), dtype=bool)
    neighbor = np.zeros((p_count, a_count), dtype=bool)
    if p_count == 0:
        return strict_ok, street_hit, lit, neighbor

    have_box = bmin is not None and len(bmin) > 0
    sun_row = np.asarray(sun, dtype=np.float64).reshape(1, 3)
    if have_box:
        shade = ray_aabb_any(origins, sun_row, bmin, bmax, T_MIN, T_MAX)[:, 0]
    else:
        shade = np.zeros(p_count, dtype=bool)

    for ia, alpha in enumerate(ALPHAS):
        if face.normals is None:
            normal = tilt_normal(face.n_h, float(alpha))
            nd = float(np.dot(normal, sun))
            ray = reflect(normal, sun)
            nd_panel = np.full(p_count, nd, dtype=np.float64)
            rays = np.repeat(ray.reshape(1, 3), p_count, axis=0)
            ray_arg = ray.reshape(1, 3)
        else:
            normals = extra_tilt(face.normals, float(alpha))
            nd_panel = normals @ sun
            rays = reflect(normals, sun)
            # (P,3) would be read as many shared directions. Per-panel rays are (P,1,3).
            ray_arg = rays[:, None, :]
        this_lit = (nd_panel > 1e-8) & ~shade
        lit[:, ia] = this_lit
        if have_box:
            blocked = ray_aabb_any(origins, ray_arg, bmin, bmax, T_MIN, T_MAX)[:, 0]
            t_occ = ray_aabb_tmin(origins, ray_arg, bmin, bmax, T_MIN, T_MAX)[:, 0]
        else:
            blocked = np.zeros(p_count, dtype=bool)
            t_occ = np.full(p_count, np.inf, dtype=np.float64)
        upward = rays[:, 2] > 0.0
        strict_ok[:, ia] = ~this_lit | (upward & ~blocked)

        rz = rays[:, 2]
        denom = np.where(np.abs(rz) > 1e-6, rz, np.nan)
        t_ground = (STREET_Z - origins[:, 2]) / denom
        valid = this_lit & np.isfinite(t_ground) & (t_ground > T_MIN) & (t_ground < T_MAX)
        valid &= t_ground + MARGIN < t_occ
        hx = origins[:, 0] + t_ground * rays[:, 0]
        hy = origins[:, 1] + t_ground * rays[:, 1]
        on_street = valid & _inside_street(hx, hy, rect, prints)
        street_hit[:, ia] = on_street
        neighbor[:, ia] = this_lit & blocked & ~on_street
    return strict_ok, street_hit, lit, neighbor


def summarize_scene(scene) -> dict:
    rect = street_rect(scene)
    prints = footprints(scene)
    bmin = scene.bmin if len(scene.bmin) else np.zeros((0, 3))
    bmax = scene.bmax if len(scene.bmax) else np.zeros((0, 3))
    tz = scene.meta["timezone"]
    epw = ROOT / scene.meta["epw"]
    altitude = read_epw_altitude(epw)
    loc = pvlib.location.Location(scene.meta["lat"], scene.meta["lon"], tz, altitude)
    stamps = [
        pd.Timestamp(year=2026, month=month, day=15, hour=hour, tz=tz)
        for month in range(1, 13)
        for hour in HOURS
    ]
    index = pd.DatetimeIndex(stamps)
    solar = loc.get_solarposition(index)
    clear = loc.get_clearsky(index, model="ineichen")
    elev = solar["apparent_elevation"].to_numpy()
    az = solar["azimuth"].to_numpy()
    dni = clear["dni"].to_numpy()

    z_all = np.concatenate([face.origins[:, 2] for face in scene.faces])
    strict_u = 0
    street_u = 0
    relaxed = 0
    onto = 0
    by_backlit = 0
    strict_low = 0
    strict_high = 0
    street_low = 0
    street_high = 0
    used = 0
    for i, stamp in enumerate(index):
        if not (dni[i] >= 50.0 and elev[i] > 0.0):
            continue
        used += 1
        el = np.deg2rad(elev[i])
        azr = np.deg2rad(az[i])
        sun = np.array(
            [np.sin(azr) * np.cos(el), np.cos(azr) * np.cos(el), np.sin(el)],
            dtype=np.float64,
        )
        offset = 0
        for face in scene.faces:
            strict_ok, street_hit, lit, _neighbor = face_over_alphas(face, sun, bmin, bmax, rect, prints)
            z = face.origins[:, 2]
            # 某一倾角导天 → 现行口径可解。某一倾角不落街（含背光）→ 只护街可解。
            panel_strict_unsolved = ~np.any(strict_ok, axis=1)
            panel_street_unsolved = ~np.any(~street_hit, axis=1)
            moved = panel_strict_unsolved & ~panel_street_unsolved
            # 能离开街面的最小倾角上，是背光，还是打进邻楼。
            clear_alpha = np.argmax(~street_hit, axis=1)
            backlit_clear = moved & ~lit[np.arange(len(z)), clear_alpha]
            facade_clear = moved & ~backlit_clear
            low = z < 20.0
            strict_u += int(panel_strict_unsolved.sum())
            street_u += int(panel_street_unsolved.sum())
            relaxed += int(moved.sum())
            onto += int(facade_clear.sum())
            by_backlit += int(backlit_clear.sum())
            strict_low += int((panel_strict_unsolved & low).sum())
            strict_high += int((panel_strict_unsolved & ~low).sum())
            street_low += int((panel_street_unsolved & low).sum())
            street_high += int((panel_street_unsolved & ~low).sum())
            offset += len(z)
        print(
            f"  {scene.sid} {stamp.strftime('%m-%d %H:%M')} elev={elev[i]:.1f} dni={dni[i]:.0f}",
            flush=True,
        )
    panels = int(scene.n_panels)
    panel_times = panels * used
    return {
        "moments_scheduled": len(index),
        "moments_used": used,
        "panels": panels,
        "panel_times": panel_times,
        "strict_unsolved": strict_u,
        "street_unsolved": street_u,
        "relaxed": relaxed,
        "relaxed_onto_facade": onto,
        "relaxed_by_backlit": by_backlit,
        "strict_z_below_20": strict_low,
        "strict_z_at_least_20": strict_high,
        "street_z_below_20": street_low,
        "street_z_at_least_20": street_high,
        "street_rect": list(rect),
        "altitude_m": altitude,
    }


def golden(scene_id: str, stamp: str, alpha: float) -> dict:
    path = {
        "A": ROOT / "configs/scenario_a.yaml",
        "B": ROOT / "configs/scenario_b.yaml",
        "C": ROOT / "configs/scenario_c.yaml",
        "walkie_talkie": ROOT / "configs/walkie_talkie.yaml",
    }[scene_id]
    scene = load_scene(path, PANEL_M)
    tz = scene.meta["timezone"]
    loc = pvlib.location.Location(
        scene.meta["lat"],
        scene.meta["lon"],
        tz,
        read_epw_altitude(ROOT / scene.meta["epw"]),
    )
    when = pd.Timestamp(stamp, tz=tz)
    solar = loc.get_solarposition(when)
    elev = float(solar["apparent_elevation"].iloc[0])
    az = float(solar["azimuth"].iloc[0])
    el = np.deg2rad(elev)
    azr = np.deg2rad(az)
    sun = np.array([np.sin(azr) * np.cos(el), np.cos(azr) * np.cos(el), np.sin(el)])
    # Reuse the alpha loop but read only the requested column by temporarily slicing.
    global ALPHAS
    saved = ALPHAS
    ALPHAS = np.array([alpha], dtype=np.float64)
    rect = street_rect(scene)
    prints = footprints(scene)
    bmin = scene.bmin if len(scene.bmin) else np.zeros((0, 3))
    bmax = scene.bmax if len(scene.bmax) else np.zeros((0, 3))
    counts = {"panels": 0, "lit": 0, "backlit": 0, "shaded": 0, "street": 0, "neighbor": 0, "sky": 0, "other": 0}
    for face in scene.faces:
        strict_ok, street_hit, lit, neighbor = face_over_alphas(face, sun, bmin, bmax, rect, prints)
        lit_c = lit[:, 0]
        street_c = street_hit[:, 0]
        neighbor_c = neighbor[:, 0]
        sky_c = lit_c & strict_ok[:, 0]
        other = lit_c & ~street_c & ~neighbor_c & ~sky_c
        counts["panels"] += int(len(lit_c))
        counts["lit"] += int(lit_c.sum())
        counts["backlit"] += int((~lit_c).sum())  # includes shade; split below
        counts["street"] += int(street_c.sum())
        counts["neighbor"] += int(neighbor_c.sum())
        counts["sky"] += int(sky_c.sum())
        counts["other"] += int(other.sum())
        # shaded is not separated once lit is false. Recompute shade count roughly: backlit field
        # overwrites below.
        counts["shaded"] += 0
    # Second pass for shade vs backlit, one alpha.
    counts["backlit"] = 0
    for face in scene.faces:
        origins = face.origins
        if face.normals is None:
            normal = tilt_normal(face.n_h, alpha)
            nd = np.full(len(origins), float(np.dot(normal, sun)))
        else:
            nd = extra_tilt(face.normals, alpha) @ sun
        if len(bmin):
            shade = ray_aabb_any(origins, sun.reshape(1, 3), bmin, bmax, T_MIN, T_MAX)[:, 0]
        else:
            shade = np.zeros(len(origins), dtype=bool)
        counts["shaded"] += int(((nd > 1e-8) & shade).sum())
        counts["backlit"] += int((nd <= 1e-8).sum())
    ALPHAS = saved
    return {
        "scene": scene_id,
        "stamp_local": stamp,
        "timezone": tz,
        "elev_deg": round(elev, 4),
        "az_deg": round(az, 4),
        "sun": [round(float(v), 6) for v in sun],
        "alpha_deg": alpha,
        "panel_m": PANEL_M,
        "counts": counts,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    paths = {
        "A": ROOT / "configs/scenario_a.yaml",
        "B": ROOT / "configs/scenario_b.yaml",
        "C": ROOT / "configs/scenario_c.yaml",
        "walkie_talkie": ROOT / "configs/walkie_talkie.yaml",
    }
    scenes = {}
    for sid, path in paths.items():
        print(f"scene {sid}", flush=True)
        scene = load_scene(path, PANEL_M)
        summary = summarize_scene(scene)
        summary["official"] = OFFICIAL[sid]
        scenes[sid] = summary
        print(
            f"  RESULT strict {summary['strict_unsolved']}/{summary['panel_times']} "
            f"street {summary['street_unsolved']}/{summary['panel_times']} "
            f"relaxed {summary['relaxed']}",
            flush=True,
        )
    payload = {
        "method": {
            "panel_m": PANEL_M,
            "alpha_deg": [0, 50, 2.5],
            "calendar": "2026-每月-15",
            "hours_local": list(HOURS),
            "weather": "pvlib Ineichen 晴空，DNI≥50 且太阳高度>0 才计入",
            "strict": "与全年 Gate 相同的几何：照不到（背光或入射被挡）不算失败；被照亮则反射仰角须高于地平，且 4000 m 内不进入邻楼 AABB。",
            "street_only": "照不到不算失败；被照亮则反射不得先落到街面矩形（z=1.2 m，范围与全年街面热图相同，并挖去建筑足迹）。打进邻楼仍算只护街通过。",
            "not_official": "这是搬移说明。不替换 results/*/gate_analysis.md 里的全年数字。",
        },
        "scenes": scenes,
    }
    (OUT / "relax.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    goldens = [
        golden("A", "2026-06-21 12:00", 0.0),
        golden("A", "2026-06-21 12:00", 30.0),
        golden("A", "2026-12-21 09:30", 15.0),
        golden("walkie_talkie", "2013-09-03 13:00", 0.0),
    ]
    (OUT / "golden.json").write_text(json.dumps(goldens, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", OUT / "relax.json")


if __name__ == "__main__":
    main()
