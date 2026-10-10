# 中环幕墙光路 · STATUS

日期：2026-10-11。公网：https://er-s-an.github.io/curtainwall-glare-preview/

## 高度来源占比（渲染 370 栋，omittedNoHeight=0）

| 来源 | 栋数 | 占比 | 说明 |
|---|---:|---:|---|
| OSM height 标签 | 98 | 26.5% | `source=height` |
| 公开数据（地政总署 CSDI 等） | 249 | 67.3% | `source=opendata` |
| Wikidata | 0 | 0.0% | 本轮 0 |
| OSM levels×3.2 m 推断 | 9 | 2.4% | `source=levels` |
| 类型/面积默认推断 | 14 | 3.8% | `source=default` |
| 几何无效省略 | 42 | — | 非缺高度 |
| 父子合并丢掉 | 74 | — | part/parent |

Microsoft Global ML Building Footprints：索引无港岛瓦片，未使用。未请求 Google/Apple 3D tiles。

许可：OSM ODbL；地政总署/CSDI 按门户条款；脚本见 `data/height_fill.py`、`data/fetch_osm.py`。

## 功能

- three.js orbit；多跳光路；「只看街 / 单纯看反射」
- 非 SJG 专业评估软件
