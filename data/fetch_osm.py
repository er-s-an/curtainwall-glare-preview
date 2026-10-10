#!/usr/bin/env python3
"""Pull a Central Hong Kong tile from OSM and write data/central.json.

Heights, in order (see height_fill.py):
  - OSM height / building:height, kept as tagged metres.
  - Wikidata P2048, then Lands Department top−base, then Microsoft footprints
    when a tile exists.
  - Floor count × LEVEL_M (3.2), from Wikidata, LandsD, or building:levels.
  - A type-and-area prior capped at 48 m, marked inferred.

Footprints are not dropped for a missing height. Google and Apple 3D tiles
are not used.

Coordinate frame written to JSON: local ENU metres, x east, y north, origin at
the bbox centre. three.js conversion lives in js/optics.js (y-up: z = -north).
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import height_fill

SOUTH, WEST, NORTH, EAST = 22.281, 114.155, 22.287, 114.165
LEVEL_M = 3.2
ENDPOINTS = [
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
OUT = Path(__file__).resolve().parent / "central.json"
RAW = Path("/tmp/osm-central-raw.json")
UA = "curtainwall-glare-preview/p1 (educational; contact: github.com/er-s-an)"


def overpass(query: str) -> dict:
    last = None
    data = urllib.parse.urlencode({"data": query}).encode()
    for url in ENDPOINTS:
        for attempt in range(2):
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=180) as res:
                    payload = json.load(res)
                payload["_endpoint"] = url
                return payload
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
                last = exc
                print(f"overpass fail {url} try {attempt + 1}: {exc}")
                time.sleep(2 + attempt * 3)
    raise SystemExit(f"OSM Overpass failed, no tile written: {last}")


def num_m(raw):
    if raw is None:
        return None
    text = str(raw).strip().lower().replace(",", ".")
    feet = any(mark in text for mark in ("ft", "feet", "'"))
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    if not match:
        return None
    value = float(match.group(0))
    if feet:
        value *= 0.3048
    if not math.isfinite(value) or value < 1.5 or value > 600:
        return None
    return value


def num_levels(raw):
    if raw is None:
        return None
    nums = [float(item) for item in re.findall(r"\d+(?:\.\d+)?", str(raw))]
    if not nums:
        return None
    value = max(nums)
    if value < 1 or value > 160:
        return None
    return value


def ring_latlon(geometry):
    ring = []
    for node in geometry or []:
        lat = node.get("lat")
        lon = node.get("lon")
        if lat is None or lon is None:
            continue
        if ring and abs(ring[-1][0] - lat) < 1e-12 and abs(ring[-1][1] - lon) < 1e-12:
            continue
        ring.append((lat, lon))
    if len(ring) >= 2 and ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        return None
    return ring


def stitch(lines):
    unused = [list(line) for line in lines if line and len(line) >= 2]
    rings = []
    while unused:
        ring = unused.pop(0)
        progressed = True
        while progressed and ring[0] != ring[-1]:
            progressed = False
            for index, other in enumerate(unused):
                if other[0] == ring[-1]:
                    ring.extend(other[1:])
                    unused.pop(index)
                    progressed = True
                    break
                if other[-1] == ring[-1]:
                    ring.extend(list(reversed(other[:-1])))
                    unused.pop(index)
                    progressed = True
                    break
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append(ring[:-1])
    return rings


def element_rings(element):
    if element["type"] == "way":
        ring = ring_latlon(element.get("geometry"))
        return ([ring], []) if ring else ([], [])
    outers, inners = [], []
    for member in element.get("members") or []:
        if member.get("type") not in (None, "way"):
            continue
        ring = ring_latlon(member.get("geometry"))
        if not ring:
            continue
        role = member.get("role") or "outer"
        if role == "inner":
            inners.append(ring)
        elif role in ("outer", ""):
            outers.append(ring)
    closed_outers = []
    open_outers = []
    for ring in outers:
        closed_outers.append(ring)
    # Ways in relations are often open segments. Stitch both.
    stitched = stitch(closed_outers)
    if not stitched and closed_outers:
        stitched = [ring for ring in closed_outers if len(ring) >= 3]
    hole_rings = stitch(inners) or [ring for ring in inners if len(ring) >= 3]
    return stitched, hole_rings


def shoelace(ring):
    area = 0.0
    for index, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(index + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area / 2


def centroid(ring):
    return (
        sum(point[0] for point in ring) / len(ring),
        sum(point[1] for point in ring) / len(ring),
    )


def point_in(x, y, ring):
    inside = False
    count = len(ring)
    j = count - 1
    for i in range(count):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def douglas(ring, epsilon):
    if len(ring) < 5:
        return ring

    def recurse(start, end, keep):
        ax, ay = ring[start]
        bx, by = ring[end]
        ex, ey = bx - ax, by - ay
        length = math.hypot(ex, ey) or 1
        worst = -1
        worst_dist = 0
        for index in range(start + 1, end):
            px, py = ring[index]
            dist = abs(ex * (ay - py) - ey * (ax - px)) / length
            if dist > worst_dist:
                worst_dist = dist
                worst = index
        if worst_dist > epsilon and worst > 0:
            recurse(start, worst, keep)
            recurse(worst, end, keep)
        else:
            keep.add(start)
            keep.add(end)

    keep = set()
    recurse(0, len(ring) - 1, keep)
    return [ring[index] for index in range(len(ring)) if index in keep]


def orient(ring, ccw):
    area = shoelace(ring)
    if ccw and area < 0:
        return list(reversed(ring))
    if not ccw and area > 0:
        return list(reversed(ring))
    return ring


def height_of(tags):
    """OSM metre tag only. Floor counts are applied later, after Wikidata and LandsD."""
    tagged = num_m(tags.get("height") or tags.get("building:height"))
    levels = num_levels(tags.get("building:levels"))
    if tagged is not None:
        return tagged, "height", levels
    return None, None, levels


def min_height_of(tags):
    tagged = num_m(tags.get("min_height") or tags.get("building:min_height"))
    if tagged is not None:
        return tagged
    levels = num_levels(tags.get("building:min_level") or tags.get("min_level"))
    if levels is None:
        return 0.0
    return round(levels * LEVEL_M, 2)


def clip_polyline(points, south, west, north, east):
    """Cohen–Sutherland style segment clip, returned in lat/lon."""

    def code(lat, lon):
        bits = 0
        if lon < west:
            bits |= 1
        elif lon > east:
            bits |= 2
        if lat < south:
            bits |= 4
        elif lat > north:
            bits |= 8
        return bits

    clipped = []
    for index in range(len(points) - 1):
        lat1, lon1 = points[index]
        lat2, lon2 = points[index + 1]
        c1, c2 = code(lat1, lon1), code(lat2, lon2)
        accept = False
        for _ in range(12):
            if c1 == 0 and c2 == 0:
                accept = True
                break
            if c1 & c2:
                break
            cout = c1 or c2
            if cout & 8:
                lon = lon1 + (lon2 - lon1) * (north - lat1) / ((lat2 - lat1) or 1e-15)
                lat = north
            elif cout & 4:
                lon = lon1 + (lon2 - lon1) * (south - lat1) / ((lat2 - lat1) or 1e-15)
                lat = south
            elif cout & 2:
                lat = lat1 + (lat2 - lat1) * (east - lon1) / ((lon2 - lon1) or 1e-15)
                lon = east
            else:
                lat = lat1 + (lat2 - lat1) * (west - lon1) / ((lon2 - lon1) or 1e-15)
                lon = west
            if cout == c1:
                lat1, lon1, c1 = lat, lon, code(lat, lon)
            else:
                lat2, lon2, c2 = lat, lon, code(lat, lon)
        if accept:
            if not clipped or clipped[-1] != (lat1, lon1):
                clipped.append((lat1, lon1))
            clipped.append((lat2, lon2))
    return clipped


HARBOUR_NORTH = 22.2905


def chain_coast(lines):
    """Join coastline ways. OSM direction is preserved when the east end is a start."""
    unused = [list(line) for line in lines if len(line) >= 2]
    if not unused:
        return []
    best = None
    start_i, start_end = 0, 0
    for index, line in enumerate(unused):
        for end in (0, -1):
            if best is None or line[end][1] > best:
                best = line[end][1]
                start_i, start_end = index, end
    line = unused.pop(start_i)
    if start_end == -1:
        line = list(reversed(line))
    chain = line

    def near(a, b):
        return abs(a[0] - b[0]) < 1.2e-5 and abs(a[1] - b[1]) < 1.2e-5

    progressed = True
    while progressed:
        progressed = False
        for index, other in enumerate(unused):
            if near(other[0], chain[-1]):
                chain.extend(other[1:])
                unused.pop(index)
                progressed = True
                break
            if near(other[-1], chain[-1]):
                chain.extend(list(reversed(other[:-1])))
                unused.pop(index)
                progressed = True
                break
    return chain


def boundary_t(lat, lon, south, west, north, east):
    eps = 1e-6
    on_s, on_n = abs(lat - south) <= eps, abs(lat - north) <= eps
    on_w, on_e = abs(lon - west) <= eps, abs(lon - east) <= eps
    if on_s and on_w:
        return 0.0
    if on_s and on_e:
        return 1.0
    if on_n and on_e:
        return 2.0
    if on_n and on_w:
        return 3.0
    if on_s:
        return (lon - west) / (east - west)
    if on_e:
        return 1 + (lat - south) / (north - south)
    if on_n:
        return 2 + (east - lon) / (east - west)
    if on_w:
        return 3 + (north - lat) / (north - south)
    return None


def boundary_coord(t, south, west, north, east):
    t = t % 4
    if t < 1:
        return (south, west + (east - west) * t)
    if t < 2:
        return (south + (north - south) * (t - 1), east)
    if t < 3:
        return (north, east - (east - west) * (t - 2))
    return (north - (north - south) * (t - 3), west)


def clip_ordered(points, south, west, north, east):
    pieces = []
    current = []
    for index in range(len(points) - 1):
        segment = clip_polyline(points[index : index + 2], south, west, north, east)
        if len(segment) < 2:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue
        if not current:
            current = segment
            continue
        if abs(current[-1][0] - segment[0][0]) > 1e-7 or abs(current[-1][1] - segment[0][1]) > 1e-7:
            pieces.append(current)
            current = segment
        else:
            current.extend(segment[1:])
    if len(current) >= 2:
        pieces.append(current)
    return pieces


def harbour_ring(shore_lines, south, west, north, east):
    """Water polygon. OSM coastline keeps water on the right. None if it fails the land/sea check."""
    chain = chain_coast(shore_lines)
    if len(chain) < 4:
        return None
    pieces = clip_ordered(chain, south, west, north, east)
    pieces = [piece for piece in pieces if len(piece) >= 4]
    if not pieces:
        return None
    shore = max(pieces, key=lambda piece: len(piece))
    t0 = boundary_t(shore[0][0], shore[0][1], south, west, north, east)
    t1 = boundary_t(shore[-1][0], shore[-1][1], south, west, north, east)
    if t0 is None or t1 is None:
        return None
    mid = len(shore) // 2
    a, b = shore[max(0, mid - 1)], shore[min(len(shore) - 1, mid + 1)]
    dlon, dlat = b[1] - a[1], b[0] - a[0]
    length = math.hypot(dlon, dlat) or 1
    # Right-hand side of the walk, about 40 m, in degrees.
    step = 0.00035
    test = (a[0] + dlat * 0.5 + (-dlon / length) * step, a[1] + dlon * 0.5 + (dlat / length) * step)

    def close(direction):
        delta = ((t0 - t1) % 4) if direction > 0 else ((t1 - t0) % 4)
        if delta < 1e-4:
            delta = 4
        steps = max(4, int(delta * 12))
        extra = []
        for step_index in range(1, steps + 1):
            extra.append(boundary_coord(t1 + direction * delta * step_index / steps, south, west, north, east))
        return shore + extra

    candidates = [close(1), close(-1)]
    chosen = None
    for ring in candidates:
        xy = [(lon, lat) for lat, lon in ring]
        if point_in(test[1], test[0], xy):
            chosen = ring
            break
    if chosen is None:
        return None
    xy = [(lon, lat) for lat, lon in chosen]
    harbour = point_in(114.160, 22.2892, xy)
    inland = point_in(114.158, 22.2835, xy)
    if not harbour or inland:
        return None
    return chosen


def main():
    query = f"""
[out:json][timeout:180];
(
  way["building"]({SOUTH},{WEST},{NORTH},{EAST});
  way["building:part"]({SOUTH},{WEST},{NORTH},{EAST});
  relation["building"]({SOUTH},{WEST},{NORTH},{EAST});
  relation["building:part"]({SOUTH},{WEST},{NORTH},{EAST});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"]({SOUTH},{WEST},{NORTH},{EAST});
  way["natural"="coastline"]({SOUTH - 0.002},{WEST - 0.002},{NORTH + 0.003},{EAST + 0.002});
  way["natural"="water"]({SOUTH - 0.001},{WEST - 0.001},{NORTH + 0.002},{EAST + 0.001});
);
out geom;
"""
    print("querying Overpass…")
    payload = overpass(query)
    RAW.write_text(json.dumps({k: v for k, v in payload.items() if k != "_endpoint"}))
    endpoint = payload.get("_endpoint")
    elements = payload["elements"]
    print(f"{len(elements)} elements from {endpoint}")

    lat0 = (SOUTH + NORTH) / 2
    lon0 = (WEST + EAST) / 2
    m_lat = 111132.92 - 559.82 * math.cos(2 * math.radians(lat0))
    m_lon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))

    def enu(lat, lon):
        return ((lon - lon0) * m_lon, (lat - lat0) * m_lat)

    def enu_ring(latlon):
        ring = [enu(lat, lon) for lat, lon in latlon]
        if len(ring) >= 2 and math.hypot(ring[0][0] - ring[-1][0], ring[0][1] - ring[-1][1]) < 0.3:
            ring = ring[:-1]
        ring = douglas(ring, 0.8)
        # drop near-duplicates after projection
        clean = []
        for point in ring:
            if not clean or math.hypot(point[0] - clean[-1][0], point[1] - clean[-1][1]) > 0.15:
                clean.append((round(point[0], 2), round(point[1], 2)))
        if len(clean) >= 2 and math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) < 0.2:
            clean.pop()
        return clean if len(clean) >= 3 else None

    buildings = []
    omitted_geom = 0
    roads = []
    shore_latlon = []
    water_polys = []

    for element in elements:
        tags = element.get("tags") or {}
        if "highway" in tags and "building" not in tags and "building:part" not in tags:
            line = ring_latlon(element.get("geometry"))
            # ring_latlon strips closure; for an open road that is fine, but it requires 3 points
            geometry = element.get("geometry") or []
            pts = []
            for node in geometry:
                if "lat" in node:
                    pts.append(enu(node["lat"], node["lon"]))
            if len(pts) >= 2:
                kind = tags.get("highway")
                width = {
                    "motorway": 16,
                    "trunk": 16,
                    "primary": 14,
                    "secondary": 11,
                    "tertiary": 8,
                    "unclassified": 7,
                    "residential": 6,
                    "living_street": 6,
                    "pedestrian": 8,
                }.get(kind, 6)
                roads.append({
                    "id": f"{element['type']}/{element['id']}",
                    "name": tags.get("name:zh") or tags.get("name") or "",
                    "kind": kind,
                    "width": width,
                    "pts": [[round(x, 2), round(y, 2)] for x, y in pts],
                })
            continue
        if tags.get("natural") == "coastline":
            geometry = element.get("geometry") or []
            shore_latlon.append([(node["lat"], node["lon"]) for node in geometry if "lat" in node])
            continue
        if tags.get("natural") == "water":
            outers, holes = element_rings(element)
            for outer in outers:
                ring = enu_ring(outer)
                if ring and abs(shoelace(ring)) > 80:
                    water_polys.append(orient(ring, True))
            continue
        if "building" not in tags and "building:part" not in tags:
            continue
        height, source, levels = height_of(tags)
        outers, holes = element_rings(element)
        if not outers:
            omitted_geom += 1
            continue
        outer_ll = max(outers, key=lambda ring: abs(shoelace([(lon, lat) for lat, lon in ring])))
        outer = enu_ring(outer_ll)
        if not outer or abs(shoelace(outer)) < 20:
            omitted_geom += 1
            continue
        outer = orient(outer, True)
        hole_rings = []
        for hole in holes:
            ring = enu_ring(hole)
            if ring and abs(shoelace(ring)) > 12:
                hole_rings.append(orient(ring, False))
        min_h = min_height_of(tags)
        if height is not None and min_h >= height - 0.5:
            min_h = 0.0
        name_zh = tags.get("name:zh") or ""
        name = name_zh or tags.get("name") or ""
        name_en = tags.get("name:en") or ""
        qid = tags.get("wikidata") or ""
        if not re.fullmatch(r"Q\d+", qid):
            qid = ""
        clat = sum(point[0] for point in outer_ll) / len(outer_ll)
        clon = sum(point[1] for point in outer_ll) / len(outer_ll)
        record = {
            "id": f"{element['type']}/{element['id']}",
            "name": name,
            "nameEn": name_en,
            "height": None if height is None else round(height, 2),
            "minHeight": round(min_h, 2),
            "source": source,
            "levels": levels,
            "measured": source == "height",
            "heightMethod": "osm-height" if source == "height" else None,
            "heightRef": "osm:height" if source == "height" else "",
            "heightNote": "OSM 高度" if source == "height" else "",
            "part": "building:part" in tags and "building" not in tags,
            "kind": tags.get("building:part") if "building:part" in tags and "building" not in tags else tags.get("building") or "yes",
            "outer": outer,
            "holes": hole_rings,
            "area": round(abs(shoelace(outer)), 1),
            "centroid": [round(v, 2) for v in centroid(outer)],
            "minFromPodium": False,
            "_qid": qid,
            "_lat": clat,
            "_lon": clon,
            "_osm_levels": levels,
            "_keys": height_fill.name_keys(name, name_en, name_zh),
        }
        buildings.append(record)

    fill_report = height_fill.fill_heights(
        buildings,
        south=SOUTH,
        west=WEST,
        north=NORTH,
        east=EAST,
        m_lat=m_lat,
        m_lon=m_lon,
        level_m=LEVEL_M,
        project=enu,
    )
    unfilled = [item for item in buildings if not item.get("height")]
    buildings = [item for item in buildings if item.get("height")]

    drop = set()
    parts = [item for item in buildings if item["part"]]
    for parent in buildings:
        if parent["part"]:
            continue
        for part in parts:
            if part["area"] > 0.72 * parent["area"] and point_in(part["centroid"][0], part["centroid"][1], parent["outer"]):
                drop.add(parent["id"])
                break
    for part in parts:
        if part["id"] in drop:
            continue
        for parent in buildings:
            if parent["part"] or parent["id"] in drop:
                continue
            if not point_in(part["centroid"][0], part["centroid"][1], parent["outer"]):
                continue
            if parent["height"] <= 40 and part["height"] > parent["height"] + 12 and part["minHeight"] < parent["height"] - 0.5:
                part["minHeight"] = round(parent["height"], 2)
                part["minFromPodium"] = True
                break
    for part in buildings:
        if part["name"] or part["id"] in drop:
            continue
        for parent in buildings:
            if parent["id"] == part["id"] or parent["id"] in drop or not parent["name"]:
                continue
            if part["area"] < parent["area"] and point_in(part["centroid"][0], part["centroid"][1], parent["outer"]):
                part["name"] = parent["name"]
                if not part["nameEn"]:
                    part["nameEn"] = parent["nameEn"]
                break
    contained = set()
    for part in buildings:
        if part["id"] in drop:
            continue
        for parent in buildings:
            if parent["id"] == part["id"] or parent["id"] in drop:
                continue
            if part["area"] >= parent["area"] * 0.55:
                continue
            if parent["height"] + 1 < part["height"]:
                continue
            if point_in(part["centroid"][0], part["centroid"][1], parent["outer"]):
                contained.add(part["id"])
                break
    drop |= contained
    buildings = [item for item in buildings if item["id"] not in drop]

    # Small natural=water rings are basins. The harbour is the OSM coastline,
    # water on the right, closed to a plane north of the Central shore.
    basins = [ring for ring in water_polys if abs(shoelace(ring)) < 20000]
    harbour_ll = harbour_ring(shore_latlon, SOUTH, WEST, HARBOUR_NORTH, EAST)
    water_source = "none"
    water_ll_note = None
    if harbour_ll:
        harbour = enu_ring(harbour_ll)
        if harbour and abs(shoelace(harbour)) > 5000:
            water_polys = [orient(harbour, True)] + basins
            water_source = "coastline"
            water_ll_note = "harbour"
        else:
            water_polys = basins
    else:
        water_polys = basins
        print("blocker: coastline did not yield a harbour polygon that keeps Central dry")

    def bucket(name):
        return sum(1 for item in buildings if item.get("source") == name)

    measured = bucket("height")
    wikidata_n = bucket("wikidata")
    opendata_n = bucket("opendata")
    inferred = bucket("levels")
    default_n = bucket("default")
    xs = [point[0] for item in buildings for point in item["outer"]]
    ys = [point[1] for item in buildings for point in item["outer"]]
    for ring in water_polys:
        xs.extend(point[0] for point in ring)
        ys.extend(point[1] for point in ring)
    meta = {
        "bbox": {"south": SOUTH, "west": WEST, "north": NORTH, "east": EAST},
        "origin": {"lat": round(lat0, 8), "lon": round(lon0, 8)},
        "mPerDegLat": round(m_lat, 4),
        "mPerDegLon": round(m_lon, 4),
        "fetched": "2026-10-11",
        "endpoint": endpoint,
        "license": "ODbL-1.0 + CC0-1.0 + CSDI Terms of Use",
        "attribution": "© OpenStreetMap contributors; Wikidata (CC0); Lands Department Building dataset, HKSAR Government, via CSDI",
        "levelHeightM": LEVEL_M,
        "defaultCapM": height_fill.DEFAULT_CAP_M,
        "harbourNorth": HARBOUR_NORTH,
        "waterSource": water_source,
        "heightFill": fill_report,
        "counts": {
            "rendered": len(buildings),
            "heightTagged": measured,
            "wikidata": wikidata_n,
            "openData": opendata_n,
            "levelsInferred": inferred,
            "defaultInferred": default_n,
            "omittedNoHeight": len(unfilled),
            "omittedGeometry": omitted_geom,
            "droppedParent": len(drop),
            "roads": len(roads),
            "waterPolys": len(water_polys),
        },
        "methods": {},
        "bounds": {
            "minX": round(min(xs), 2) if xs else 0,
            "maxX": round(max(xs), 2) if xs else 0,
            "minY": round(min(ys), 2) if ys else 0,
            "maxY": round(max(ys), 2) if ys else 0,
        },
    }
    methods = {}
    for item in buildings:
        key = item.get("heightMethod") or "unknown"
        methods[key] = methods.get(key, 0) + 1
    meta["methods"] = methods
    # JSON doesn't allow non-list tuples; rings are already lists of pairs from orient of lists.
    def freeze_ring(ring):
        return [[point[0], point[1]] if not isinstance(point, list) else point for point in ring]

    for item in buildings:
        item["outer"] = freeze_ring(item["outer"])
        item["holes"] = [freeze_ring(ring) for ring in item["holes"]]
        for key in ("_qid", "_lat", "_lon", "_osm_levels", "_keys"):
            item.pop(key, None)
    document = {
        "meta": meta,
        "buildings": buildings,
        "roads": roads,
        "water": [freeze_ring(ring) for ring in water_polys],
    }
    OUT.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    if measured == 0:
        raise SystemExit("blocker: OSM returned no tagged building heights")
    if water_source != "coastline":
        raise SystemExit("blocker: OSM coastline did not produce the harbour plane")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--raw":
        payload = json.loads(Path(sys.argv[2]).read_text())
        payload["_endpoint"] = payload.get("_endpoint") or "https://overpass.openstreetmap.fr/api/interpreter"
        # Re-enter main's body by monkeypatching the network call.
        def _use_raw(query):
            return payload
        globals()["overpass"] = _use_raw
    main()
