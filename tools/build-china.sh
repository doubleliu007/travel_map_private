#!/usr/bin/env bash
# 生成 data/china.js：中国省级行政区（阿里云 DataV.GeoAtlas），用于国内按省份高亮
#   先按 2.5km 容差简化，再用 data/world.js 里的中国轮廓裁剪，使省份外边界与国界完全重合
#   provinces 图层：id 为行政区划代码，name 为省份简称（浙江、广西……）；港澳由国家图层单独表示
# 用法：bash tools/build-china.sh   （需先生成 data/world.js；需要 node / npx）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -sfL -o "$WORK/cn.json" "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json"
sed -e '1s/^window.WORLD_TOPO = //' -e '$s/;$//' "$ROOT/data/world.js" > "$WORK/world.json"

npx -y mapshaper@0.6 -i "$WORK/world.json" \
  -target countries \
  -filter 'ISO_N3_EH == "156"' \
  -o format=geojson "$WORK/outline.json"

# 两份数据的海岸线不完全重合，裁剪后沿海会留下细缝；用"国界以外"的外框把缝围起来，
# 再让 -clean 把缝并入相邻的省份（并入外框的部分随外框一起丢弃）
npx -y mapshaper@0.6 -rectangle bbox=60,-5,150,60 \
  -erase "$WORK/outline.json" \
  -each 'adcode = "frame"; name = ""' \
  -o format=geojson "$WORK/frame.json"

npx -y mapshaper@0.6 -i "$WORK/cn.json" \
  -filter '/^\d{6}$/.test(String(adcode)) && +adcode < 800000' \
  -simplify interval=2500 keep-shapes \
  -clip "$WORK/outline.json" \
  -each 'adcode = String(adcode); name = name.replace(/(壮族|回族|维吾尔)?自治区$|省$|市$/, "")' \
  -filter-fields adcode,name \
  -o format=geojson "$WORK/provinces.json"

npx -y mapshaper@0.6 -i "$WORK/provinces.json" "$WORK/frame.json" combine-files \
  -merge-layers force \
  -clean gap-fill-area=20000km2 \
  -filter 'adcode != "frame"' \
  -rename-layers provinces \
  -o format=topojson quantization=100000 id-field=adcode "$WORK/china.json"

{ printf 'window.CHINA_TOPO = '; cat "$WORK/china.json"; printf ';\n'; } > "$ROOT/data/china.js"
echo "已写入 data/china.js（$(du -k "$ROOT/data/china.js" | cut -f1) KB）"
