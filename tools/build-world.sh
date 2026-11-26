#!/usr/bin/env bash
# 生成 data/world.js：Natural Earth 1:10m 国界（中国视角版），按 2.5km 容差简化后输出 TopoJSON
#   用距离容差而非百分比，避免复杂海岸（峡湾、群岛）占掉点数、其他地区被削得过粗
#   countries 图层：id 为 ISO 3166 数字代码，name 为中文名；land 图层：全部陆地合并
# 用法：bash tools/build-world.sh   （需要 node / npx，首次运行会临时下载 mapshaper）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -sfL -o "$WORK/ne.zip" "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries_chn.zip"
unzip -q "$WORK/ne.zip" -d "$WORK"

npx -y mapshaper@0.6 -i "$WORK/ne_10m_admin_0_countries_chn.shp" \
  -simplify interval=2500 keep-shapes \
  -clean \
  -rename-layers countries \
  -filter-fields ISO_N3_EH,NAME_ZH \
  -rename-fields name=NAME_ZH \
  -dissolve + name=land \
  -o format=topojson quantization=100000 id-field=ISO_N3_EH target='*' "$WORK/world.json"

{ printf 'window.WORLD_TOPO = '; cat "$WORK/world.json"; printf ';\n'; } > "$ROOT/data/world.js"
echo "已写入 data/world.js（$(du -k "$ROOT/data/world.js" | cut -f1) KB）"
