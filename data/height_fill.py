#!/usr/bin/env python3
"""Fill building heights when OSM has no height tag.

Priority for a footprint that has no `height` / `building:height`:

1. Wikidata P2048 (metres), from the OSM `wikidata` tag, or from a unique
   name whose coordinate sits within 80 m of the footprint.
2. Lands Department "Building" dataset on the CSDI portal:
   height = TopHeight − BaseHeight (metres).
3. Microsoft Global ML Building Footprints (CDLA Permissive 2.0), when the
   published tile index actually covers this bbox. The 2026-08-13 index has
   no Hong Kong tile; the miss is recorded and nothing is invented from it.
4. Floor count × `level_m` (3.2): Wikidata P1101, then LandsD Storeys, then
   OSM `building:levels`.
5. A documented type-and-area prior, capped at 48 m. Marked inferred.

Google and Apple 3D tiles are not requested. A footprint is not dropped
because a metre value was missing.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "curtainwall-glare-preview/height (educational; https://github.com/er-s-an/curtainwall-glare-preview)"
LANDSD_QUERY = (
    "https://portal.csdi.gov.hk/server/rest/services/common/"
    "landsd_rcd_1637211194312_35158/MapServer/0/query"
)
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
MS_INDEXES = [
    "https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv",
    "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv",
]
METRE_UNITS = {"Q11573"}
FOOT_UNITS = {"Q3710", "Q25343"}
DEFAULT_CAP_M = 48.0
GENERIC_NAMES = {
    "central",
    "hongkong",
    "hong kong",
    "building",
    "tower",
    "house",
    "centre",
    "center",
    "plaza",
    "the",
    "大廈",
    "大厦",
    "中心",
    "廣場",
    "广场",
    "中環",
    "中环",
}


def _get(url, data=None, timeout=120, headers=None):
    req_headers = {"User-Agent": UA}
    if headers:
        req_headers.update(headers)
    if isinstance(data, dict):
        data = urllib.parse.urlencode(data).encode()
    last = None
    for attempt in range(3):
        req = urllib.request.Request(url, data=data, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last = exc
            time.sleep(1.5 + attempt * 2)
    raise last


def _json(url, data=None, timeout=120, headers=None):
    raw = _get(url, data=data, timeout=timeout, headers=headers)
    return json.loads(raw.decode("utf-8"))


def point_in(x, y, ring):
    inside = False
    count = len(ring)
    j = count - 1
    for i in range(count):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def shoelace(ring):
    area = 0.0
    for index, point in enumerate(ring):
        x2, y2 = ring[(index + 1) % len(ring)]
        area += point[0] * y2 - x2 * point[1]
    return area / 2


def norm_name(text):
    text = (text or "").lower().replace("’", "").replace("'", "")
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", text)


def strong_name(text):
    if not text or text in GENERIC_NAMES:
        return False
    if re.fullmatch(r"[\u4e00-\u9fff]+", text):
        return len(text) >= 2
    return len(text) >= 5


def name_keys(*parts):
    keys = set()
    for part in parts:
        if not part:
            continue
        full = norm_name(part)
        if strong_name(full):
            keys.add(full)
        cjk = "".join(re.findall(r"[\u4e00-\u9fff]", part))
        latin = norm_name(re.sub(r"[\u4e00-\u9fff]", " ", part))
        if strong_name(cjk):
            keys.add(cjk)
        if strong_name(latin):
            keys.add(latin)
    return keys


def _claim_amounts(claims, pid, as_length):
    preferred = []
    normal = []
    for claim in claims.get(pid) or []:
        value = (claim.get("mainsnak") or {}).get("datavalue", {}).get("value")
        if not isinstance(value, dict) or "amount" not in value:
            continue
        amount = abs(float(value["amount"]))
        if as_length:
            unit = str(value.get("unit") or "")
            code = unit.rsplit("/", 1)[-1]
            if code in FOOT_UNITS:
                amount *= 0.3048
            elif code not in METRE_UNITS and "Q" in code:
                continue
        bucket = preferred if claim.get("rank") == "preferred" else normal
        bucket.append(amount)
    return preferred or normal


def _merge_wiki(items, qid, height, floors, lat, lon, names):
    row = items.setdefault(
        qid,
        {"qid": qid, "height": None, "floors": None, "lat": None, "lon": None, "names": []},
    )
    if height is not None and 8 <= height <= 500:
        row["height"] = height if row["height"] is None else max(row["height"], height)
    if floors is not None and 1 <= floors <= 160:
        row["floors"] = floors if row["floors"] is None else max(row["floors"], floors)
    if lat is not None and row["lat"] is None:
        row["lat"] = lat
        row["lon"] = lon
    for name in names:
        if name and name not in row["names"]:
            row["names"].append(name)
    return row


def fetch_wikidata(qids, south, west, north, east):
    """Return {qid: record} for tagged ids plus items with a height near the tile."""
    items = {}
    warnings = []
    unique = sorted({qid for qid in qids if re.fullmatch(r"Q\d+", qid or "")})
    for start in range(0, len(unique), 40):
        batch = unique[start : start + 40]
        try:
            payload = _json(
                WIKIDATA_API,
                data={
                    "action": "wbgetentities",
                    "ids": "|".join(batch),
                    "props": "claims|labels",
                    "languages": "en|zh|zh-hk|zh-hant",
                    "format": "json",
                },
                timeout=90,
            )
        except Exception as exc:
            warnings.append(f"wikidata entities failed: {exc}")
            continue
        for qid, entity in (payload.get("entities") or {}).items():
            if not isinstance(entity, dict) or entity.get("missing") is not None and "claims" not in entity:
                continue
            claims = entity.get("claims") or {}
            heights = _claim_amounts(claims, "P2048", True)
            floors = _claim_amounts(claims, "P1101", False)
            lat = lon = None
            for claim in claims.get("P625") or []:
                coord = (claim.get("mainsnak") or {}).get("datavalue", {}).get("value")
                if isinstance(coord, dict) and "latitude" in coord:
                    lat = float(coord["latitude"])
                    lon = float(coord["longitude"])
                    break
            labels = []
            for label in (entity.get("labels") or {}).values():
                if isinstance(label, dict) and label.get("value"):
                    labels.append(label["value"])
            _merge_wiki(
                items,
                qid,
                max(heights) if heights else None,
                max(floors) if floors else None,
                lat,
                lon,
                labels,
            )

    # Radius is in kilometres. 1.6 km reaches towers whose pin sits just
    # outside the tile while the footprint is inside.
    query = """
SELECT ?item ?itemLabel ?nameEn ?nameZh ?height ?floors ?lat ?lon WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point(114.160 22.284)"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "1.6" .
  }
  ?item p:P625/psv:P625 [ wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon ] .
  FILTER(?lat > %s && ?lat < %s && ?lon > %s && ?lon < %s)
  OPTIONAL { ?item wdt:P2048 ?height . }
  OPTIONAL { ?item wdt:P1101 ?floors . }
  OPTIONAL { ?item rdfs:label ?nameEn FILTER(LANG(?nameEn) = "en") . }
  OPTIONAL { ?item rdfs:label ?nameZh FILTER(LANG(?nameZh) IN ("zh", "zh-hant", "zh-hk")) . }
  FILTER(BOUND(?height) || BOUND(?floors))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,zh". }
}
""" % (south - 0.004, north + 0.004, west - 0.004, east + 0.004)
    try:
        payload = _json(
            WIKIDATA_SPARQL,
            data={"query": query},
            timeout=90,
            headers={"Accept": "application/sparql-results+json"},
        )
        for row in payload.get("results", {}).get("bindings", []):
            qid = row["item"]["value"].rsplit("/", 1)[-1]
            height = abs(float(row["height"]["value"])) if "height" in row else None
            floors = abs(float(row["floors"]["value"])) if "floors" in row else None
            names = []
            for key in ("itemLabel", "nameEn", "nameZh"):
                if key in row:
                    names.append(row[key]["value"])
            _merge_wiki(
                items,
                qid,
                height,
                floors,
                float(row["lat"]["value"]),
                float(row["lon"]["value"]),
                names,
            )
    except Exception as exc:
        warnings.append(f"wikidata sparql failed: {exc}")

    by_name = {}
    for row in items.values():
        for key in name_keys(*row["names"]):
            by_name.setdefault(key, []).append(row)
    with_height = sum(1 for row in items.values() if row["height"])
    with_floors = sum(1 for row in items.values() if row["floors"])
    return {
        "by_id": items,
        "by_name": by_name,
        "report": {
            "items": len(items),
            "withHeight": with_height,
            "withFloors": with_floors,
            "taggedQids": len(unique),
            "license": "CC0-1.0",
            "attribution": "Wikidata (CC0)",
            "warnings": warnings,
        },
    }


def _landsd_height(props):
    top = props.get("TopHeight")
    base = props.get("BaseHeight")
    if top is None or base is None:
        return None
    height = float(top) - float(base)
    if not math.isfinite(height) or height < 2 or height > 500:
        return None
    return height


def _landsd_storeys(props):
    raw = props.get("Storeys")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value < 1 or value > 160:
        return None
    return value


def fetch_landsd(south, west, north, east, project):
    warnings = []
    features = []
    offset = 0
    try:
        while True:
            params = {
                "where": "1=1",
                "geometry": f"{west},{south},{east},{north}",
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
                "outFields": "BuildingCSUID,BuildingNameEN,BuildingNameTC,BaseHeight,TopHeight,Storeys,BuildingBlockType",
                "returnGeometry": "true",
                "outSR": "4326",
                "f": "geojson",
                "resultOffset": str(offset),
                "resultRecordCount": "3000",
            }
            url = LANDSD_QUERY + "?" + urllib.parse.urlencode(params)
            payload = _json(url, timeout=120)
            batch = payload.get("features") or []
            features.extend(batch)
            if not payload.get("exceededTransferLimit") or not batch:
                break
            offset += len(batch)
            if offset > 20000:
                warnings.append("landsd pagination stopped at 20000")
                break
    except Exception as exc:
        warnings.append(f"landsd query failed: {exc}")
        features = []

    blocks = []
    for feature in features:
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Polygon":
            continue
        rings = geometry.get("coordinates") or []
        if not rings or len(rings[0]) < 4:
            continue
        outer = []
        for lon, lat in rings[0]:
            if not (west - 0.002 <= lon <= east + 0.002 and south - 0.002 <= lat <= north + 0.002):
                # Keep the vertex; the polygon may clip the tile edge.
                pass
            x, y = project(lat, lon)
            if outer and math.hypot(x - outer[-1][0], y - outer[-1][1]) < 0.2:
                continue
            outer.append((x, y))
        if len(outer) >= 2 and math.hypot(outer[0][0] - outer[-1][0], outer[0][1] - outer[-1][1]) < 0.3:
            outer.pop()
        if len(outer) < 3:
            continue
        area = abs(shoelace(outer))
        if area < 8:
            continue
        xs = [point[0] for point in outer]
        ys = [point[1] for point in outer]
        blocks.append({
            "csuid": props.get("BuildingCSUID") or "",
            "nameEn": props.get("BuildingNameEN") or "",
            "nameTc": props.get("BuildingNameTC") or "",
            "block": props.get("BuildingBlockType") or "",
            "height": _landsd_height(props),
            "storeys": _landsd_storeys(props),
            "ring": outer,
            "area": area,
            "centroid": (sum(xs) / len(xs), sum(ys) / len(ys)),
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
        })
    with_height = sum(1 for block in blocks if block["height"])
    with_storeys = sum(1 for block in blocks if block["storeys"])
    return blocks, {
        "dataset": "landsd_rcd_1637211194312_35158",
        "endpoint": LANDSD_QUERY,
        "features": len(features),
        "blocks": len(blocks),
        "withHeight": with_height,
        "withStoreys": with_storeys,
        "license": "CSDI Terms of Use (free reuse with attribution to the HKSAR Government and the CSDI portal)",
        "attribution": "Lands Department, The Government of the Hong Kong Special Administrative Region, via the Common Spatial Data Infrastructure",
        "portal": "https://portal.csdi.gov.hk/csdi-webpage/dataset/landsd_rcd_1637211194312_35158",
        "heightDefinition": "TopHeight minus BaseHeight, metres above Hong Kong Principal Datum",
        "warnings": warnings,
    }


def _parse_size(text):
    raw = (text or "").strip().upper()
    match = re.match(r"([0-9.]+)\s*([KMG]?B)", raw)
    if not match:
        return 0
    value = float(match.group(1))
    unit = match.group(2)
    return value * {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9}[unit]


def _quadkey(lat, lon, level=9):
    sin_lat = math.sin(math.radians(lat))
    x = (lon + 180) / 360
    y = 0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)
    scale = 1 << level
    tile_x = int(max(0, min(scale - 1, math.floor(x * scale))))
    tile_y = int(max(0, min(scale - 1, math.floor(y * scale))))
    quad = []
    for i in range(level, 0, -1):
        bit = 0
        mask = 1 << (i - 1)
        if tile_x & mask:
            bit += 1
        if tile_y & mask:
            bit += 2
        quad.append(str(bit))
    return "".join(quad)


def fetch_microsoft(south, west, north, east, project):
    """Stream Microsoft footprints for this bbox. Empty when the index has no tile."""
    report = {
        "license": "CDLA-Permissive-2.0",
        "attribution": "Microsoft Global ML Building Footprints",
        "covered": False,
        "quadkey": _quadkey((south + north) / 2, (west + east) / 2, 9),
        "index": None,
        "reason": "",
        "matchedTiles": 0,
        "kept": 0,
        "warnings": [],
    }
    table = None
    for url in MS_INDEXES:
        try:
            raw = _get(url, timeout=90)
            table = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
            report["index"] = url
            break
        except Exception as exc:
            report["warnings"].append(f"microsoft index {url}: {exc}")
    if not table:
        report["reason"] = "tile index unavailable"
        return [], report
    wanted = report["quadkey"]
    hits = [row for row in table if row.get("QuadKey") == wanted]
    if not hits:
        report["reason"] = (
            f"no tile for Bing quadkey {wanted} "
            f"({len(table)} tiles in the index). Hong Kong is outside this release."
        )
        return [], report
    blocks = []
    for row in hits:
        size = _parse_size(row.get("Size"))
        if size > 80e6:
            report["warnings"].append(f"skipped oversized tile {row.get('QuadKey')} ({row.get('Size')})")
            continue
        try:
            blob = _get(row["Url"], timeout=180)
            text = gzip.decompress(blob).decode("utf-8", "replace")
        except Exception as exc:
            report["warnings"].append(f"microsoft tile download failed: {exc}")
            continue
        report["matchedTiles"] += 1
        for line in text.splitlines():
            if "height" not in line:
                continue
            try:
                feature = json.loads(line)
            except json.JSONDecodeError:
                continue
            props = feature.get("properties") or {}
            try:
                height = float(props.get("height"))
            except (TypeError, ValueError):
                continue
            if height < 2 or height > 500:
                continue
            confidence = props.get("confidence")
            if confidence is not None:
                try:
                    if float(confidence) < 0.5:
                        continue
                except (TypeError, ValueError):
                    pass
            geometry = feature.get("geometry") or {}
            if geometry.get("type") != "Polygon":
                continue
            ring_ll = (geometry.get("coordinates") or [[]])[0]
            if len(ring_ll) < 4:
                continue
            lons = [point[0] for point in ring_ll]
            lats = [point[1] for point in ring_ll]
            if max(lons) < west or min(lons) > east or max(lats) < south or min(lats) > north:
                continue
            outer = []
            for lon, lat in ring_ll:
                x, y = project(lat, lon)
                outer.append((x, y))
            if len(outer) >= 2 and math.hypot(outer[0][0] - outer[-1][0], outer[0][1] - outer[-1][1]) < 0.3:
                outer = outer[:-1]
            if len(outer) < 3:
                continue
            area = abs(shoelace(outer))
            if area < 8:
                continue
            blocks.append({
                "csuid": f"ms:{wanted}:{len(blocks)}",
                "height": height,
                "storeys": None,
                "ring": outer,
                "area": area,
                "centroid": (
                    sum(point[0] for point in outer) / len(outer),
                    sum(point[1] for point in outer) / len(outer),
                ),
                "bbox": (
                    min(point[0] for point in outer),
                    min(point[1] for point in outer),
                    max(point[0] for point in outer),
                    max(point[1] for point in outer),
                ),
                "nameEn": "",
                "nameTc": "",
            })
    report["covered"] = bool(blocks)
    report["kept"] = len(blocks)
    if not blocks and not report["reason"]:
        report["reason"] = "tile downloaded but no positive heights inside the bbox"
    return blocks, report


def _ratio_ok(block_area, osm_area, low=0.35, high=2.8):
    if osm_area <= 1 or block_area <= 1:
        return False
    ratio = block_area / osm_area
    return low <= ratio <= high


def _bbox_has(block, x, y, pad=0):
    minx, miny, maxx, maxy = block["bbox"]
    return minx - pad <= x <= maxx + pad and miny - pad <= y <= maxy + pad


def match_block(building, blocks, require):
    """Pick a block whose footprint agrees with the OSM polygon.

    `require` is "height" or "storeys". A block much smaller or larger than
    the OSM ring is rejected so a tower pin does not extrude a whole podium.
    """
    if not blocks:
        return None
    cx, cy = building["centroid"]
    osm_area = building["area"] or 1
    osm_ring = building["outer"]

    def ranked(cands):
        usable = []
        for block in cands:
            if require == "height" and not block.get("height"):
                continue
            if require == "storeys" and not block.get("storeys"):
                continue
            if not _ratio_ok(block["area"], osm_area):
                continue
            ratio = block["area"] / osm_area
            usable.append((abs(math.log(ratio)), block))
        if not usable:
            return None
        usable.sort(key=lambda item: item[0])
        return usable[0][1]

    containing = [
        block for block in blocks
        if _bbox_has(block, cx, cy) and point_in(cx, cy, block["ring"])
    ]
    found = ranked(containing)
    if found:
        return found
    sitting = [
        block for block in blocks
        if point_in(block["centroid"][0], block["centroid"][1], osm_ring)
    ]
    found = ranked(sitting)
    if found:
        return found
    near = []
    for block in blocks:
        if require == "height" and not block.get("height"):
            continue
        if require == "storeys" and not block.get("storeys"):
            continue
        if not _ratio_ok(block["area"], osm_area, 0.5, 2.0):
            continue
        dist = math.hypot(block["centroid"][0] - cx, block["centroid"][1] - cy)
        if dist <= 12:
            near.append((dist, block))
    if not near:
        return None
    near.sort(key=lambda item: item[0])
    return near[0][1]


def _wiki_hit(building, wiki, m_lat, m_lon):
    """Return (tagged_record, named_record, named_distance_m)."""
    tagged = wiki["by_id"].get(building.get("_qid") or "")
    named = None
    named_dist = None
    if building.get("_keys"):
        best = None
        for key in building["_keys"]:
            for row in wiki["by_name"].get(key, []):
                if row.get("lat") is None:
                    continue
                dist = math.hypot((row["lat"] - building["_lat"]) * m_lat, (row["lon"] - building["_lon"]) * m_lon)
                if dist > 80:
                    continue
                if best is None or dist < best[0]:
                    best = (dist, row)
        if best:
            named_dist, named = best
    if tagged and named and tagged["qid"] == named["qid"]:
        named = tagged
    return tagged, named, named_dist


def default_height(kind, area):
    """Type and footprint prior for Central. Height is capped at 48 m.

    Returns (height_m, assumed_levels, floor_m). This is an inference, not a
    survey. Ancillary kinds stay at a single low storey and ignore the cap
    only because they are already under it.
    """
    kind = (kind or "yes").split(";")[0].strip().lower()
    fixed = {
        "roof": (3.0, 1, 3.0),
        "carport": (2.8, 1, 2.8),
        "garage": (3.5, 1, 3.5),
        "garages": (3.5, 1, 3.5),
        "shed": (3.5, 1, 3.5),
        "kiosk": (3.2, 1, 3.2),
        "hut": (3.5, 1, 3.5),
        "cabin": (3.2, 1, 3.2),
        "toilets": (3.5, 1, 3.5),
        "guardhouse": (3.5, 1, 3.5),
        "container": (2.9, 1, 2.9),
        "ruins": (4.0, 1, 4.0),
        "greenhouse": (3.5, 1, 3.5),
        "booth": (3.2, 1, 3.2),
        "subway_entrance": (4.0, 1, 4.0),
    }
    if kind in fixed:
        return fixed[kind]
    bands = {
        "house": (3.2, [(1e12, 3)]),
        "detached": (3.2, [(1e12, 3)]),
        "semidetached_house": (3.2, [(1e12, 3)]),
        "terrace": (3.2, [(1e12, 3)]),
        "bungalow": (3.2, [(1e12, 2)]),
        "residential": (3.0, [(80, 4), (250, 8), (900, 15), (1e12, 16)]),
        "apartments": (3.0, [(80, 4), (250, 8), (900, 15), (1e12, 16)]),
        "dormitory": (3.0, [(250, 6), (1e12, 12)]),
        "hotel": (3.4, [(200, 6), (800, 12), (1e12, 14)]),
        "commercial": (4.0, [(80, 3), (300, 6), (1000, 10), (1e12, 12)]),
        "retail": (4.0, [(80, 2), (300, 5), (1000, 8), (1e12, 10)]),
        "office": (4.0, [(120, 4), (500, 8), (1500, 12), (1e12, 12)]),
        "civic": (4.0, [(400, 4), (1e12, 8)]),
        "public": (4.0, [(400, 4), (1e12, 8)]),
        "government": (4.0, [(400, 5), (1e12, 10)]),
        "parking": (3.2, [(400, 3), (1e12, 6)]),
        "service": (4.5, [(80, 1), (400, 2), (1e12, 3)]),
        "train_station": (5.0, [(1e12, 2)]),
        "transportation": (4.5, [(200, 2), (1e12, 4)]),
        "bridge": (6.0, [(1e12, 1)]),
        "construction": (3.5, [(200, 3), (1e12, 6)]),
        "industrial": (5.0, [(400, 2), (1e12, 4)]),
        "warehouse": (6.0, [(1e12, 2)]),
        "yes": (3.2, [(40, 1), (120, 4), (400, 8), (1500, 12), (1e12, 15)]),
    }
    floor, rows = bands.get(kind, bands["yes"])
    levels = rows[-1][1]
    for max_area, count in rows:
        if area <= max_area:
            levels = count
            break
    height = min(DEFAULT_CAP_M, round(levels * floor, 2))
    return height, levels, floor


def _assign(building, height, source, levels, measured, method, ref, note):
    building["height"] = round(float(height), 2)
    building["source"] = source
    building["levels"] = None if levels is None else round(float(levels), 2)
    building["measured"] = bool(measured)
    building["heightMethod"] = method
    building["heightRef"] = ref
    building["heightNote"] = note
    if building.get("minHeight", 0) >= building["height"] - 0.5:
        building["minHeight"] = 0.0


def fill_heights(buildings, *, south, west, north, east, m_lat, m_lon, level_m, project):
    """Assign a height to every footprint that does not already have an OSM one."""
    pending = [building for building in buildings if building.get("height") is None]
    for building in buildings:
        if building.get("height") is not None and not building.get("heightMethod"):
            building["measured"] = True
            building["heightMethod"] = "osm-height"
            building["heightRef"] = "osm:height"
            building["heightNote"] = "OSM 高度"
            building["source"] = "height"
    qids = [building.get("_qid") for building in pending if building.get("_qid")]
    # Also resolve QIDs on buildings that already have an OSM height, so the
    # report can say how many anchors exist. Matching still does not override.
    qids.extend(building.get("_qid") for building in buildings if building.get("_qid"))
    print(f"height fill: {len(pending)} footprints lack an OSM height")
    wiki = fetch_wikidata(qids, south, west, north, east)
    print(
        f"wikidata items {wiki['report']['items']} "
        f"with height {wiki['report']['withHeight']} floors {wiki['report']['withFloors']}"
    )
    landsd, landsd_report = fetch_landsd(south, west, north, east, project)
    print(
        f"landsd blocks {landsd_report['blocks']} "
        f"with height {landsd_report['withHeight']} storeys {landsd_report['withStoreys']}"
    )
    microsoft, ms_report = fetch_microsoft(south, west, north, east, project)
    print(f"microsoft {ms_report['reason'] or ('kept ' + str(ms_report['kept']))}")

    for building in pending:
        tagged, named, named_dist = _wiki_hit(building, wiki, m_lat, m_lon)
        # 1. Wikidata metres on this element's own QID.
        if tagged and tagged.get("height"):
            _assign(
                building, tagged["height"], "wikidata", tagged.get("floors") or building.get("_osm_levels"),
                True, "wikidata-p2048", f"wikidata:{tagged['qid']}", "维基数据高度",
            )
            continue
        # Name plus a nearby coordinate, and only when this element has no QID
        # (a tagged QID without a height should not inherit a different item).
        if not tagged and named and named.get("height") and named_dist is not None and named_dist <= 80:
            _assign(
                building, named["height"], "wikidata", named.get("floors") or building.get("_osm_levels"),
                True, "wikidata-p2048", f"wikidata:{named['qid']}", "维基数据高度",
            )
            continue
        # 2. Lands Department surveyed top − base.
        block = match_block(building, landsd, "height")
        if block:
            _assign(
                building, block["height"], "opendata", block.get("storeys") or building.get("_osm_levels"),
                True, "landsd-top-base", f"landsd:{block['csuid']}", "地政总署测绘高度",
            )
            continue
        # 3. Microsoft estimate, only when a tile covers the bbox.
        ms_block = match_block(building, microsoft, "height")
        if ms_block:
            _assign(
                building, ms_block["height"], "opendata", building.get("_osm_levels"),
                False, "microsoft-height", ms_block["csuid"], "微软足迹高度估计",
            )
            continue
        # 4. Floor counts.
        if tagged and tagged.get("floors"):
            _assign(
                building, tagged["floors"] * level_m, "wikidata", tagged["floors"],
                False, "wikidata-floors", f"wikidata:{tagged['qid']}", "维基数据层数 × 3.2 m",
            )
            continue
        storey_block = match_block(building, landsd, "storeys")
        if storey_block:
            _assign(
                building, storey_block["storeys"] * level_m, "opendata", storey_block["storeys"],
                False, "landsd-storeys", f"landsd:{storey_block['csuid']}", "地政总署层数 × 3.2 m",
            )
            continue
        osm_levels = building.get("_osm_levels")
        if osm_levels:
            _assign(
                building, osm_levels * level_m, "levels", osm_levels,
                False, "osm-levels", "osm:building:levels", "OSM 层数 × 3.2 m",
            )
            continue
        if named and named.get("floors") and named_dist is not None and named_dist <= 50 and not tagged:
            _assign(
                building, named["floors"] * level_m, "wikidata", named["floors"],
                False, "wikidata-floors", f"wikidata:{named['qid']}", "维基数据层数 × 3.2 m",
            )
            continue
        # 5. Documented prior. Still rendered, still marked inferred.
        height, levels, _floor = default_height(building.get("kind"), building.get("area") or 0)
        _assign(
            building, height, "default", levels,
            False, "type-area-prior", f"prior:{building.get('kind') or 'yes'}",
            "按类型和占地估算，高度推断",
        )

    still = [building["id"] for building in buildings if not building.get("height")]
    return {
        "wikidata": wiki["report"],
        "landsd": landsd_report,
        "microsoft": ms_report,
        "defaultCapM": DEFAULT_CAP_M,
        "levelHeightM": level_m,
        "unfilled": still,
        "priority": [
            "osm-height",
            "wikidata-p2048",
            "landsd-top-base",
            "microsoft-height",
            "wikidata-floors",
            "landsd-storeys",
            "osm-levels",
            "type-area-prior",
        ],
    }
