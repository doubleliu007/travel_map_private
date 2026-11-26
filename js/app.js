(function () {
  'use strict';

  const TRIPS = window.TRIPS;
  const COUNTRY_NAMES = window.COUNTRY_NAMES || {};

  const MODE_LABEL = { car: '公路', bus: '巴士', train: '铁路', shinkansen: '新干线', ferry: '轮渡', flight: '航班', walk: '步行', cable: '缆车' };
  // 折线是道路的简化，乘以系数估算实际里程
  const ROUTE_FACTOR = { car: 1.18, bus: 1.18, walk: 1.2, train: 1.08, shinkansen: 1.05, ferry: 1, flight: 1, cable: 1 };
  const DASHED_MODES = new Set(['ferry', 'walk', 'cable']);
  const TRIP_MAX_ZOOM = 12;
  const TYPE_LABEL = { city: '住宿', sight: '到访', pass: '途经' };
  const TYPE_RANK = { city: 3, sight: 2, pass: 1 };

  const PALETTE = {
    land: { fillColor: '#173328', fillOpacity: 1, color: '#25483a', weight: 0.6 },
    visited: { fillColor: '#245442', fillOpacity: 1, color: '#6aa888', weight: 0.9 },
    visitedHover: { fillColor: '#2d6852', color: '#9fd6b8', weight: 1.2 },
    province: { fill: false, color: '#2a5141', weight: 0.5 },
  };
  const CHINA = '156';

  const $ = (sel, el = document) => el.querySelector(sel);
  const mobile = window.matchMedia('(max-width: 760px)');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKm = (km) => (km < 100 ? Math.round(km) : Math.round(km / 10) * 10).toLocaleString('zh-CN');

  /* ---------------- 地理工具 ---------------- */

  function haversine(a, b) {
    const R = 6371;
    const r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r;
    const dLng = (b[1] - a[1]) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  const geometryRings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();

  function inRing([lat, lng], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[j];
      if (y1 > lat !== y2 > lat && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }

  // 奇偶规则：落在外环内、洞内各算一次，洞自然被排除
  const inGeometry = (pt, g) => geometryRings(g).reduce((n, ring) => n + inRing(pt, ring), 0) % 2 === 1;

  // 向心 Catmull-Rom 样条：曲线经过每个途经点，且急转弯处不会打圈
  function smooth(pts, samples = 8) {
    const P = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    if (P.length < 3) return P;
    const k = Math.cos((P[0][0] * Math.PI) / 180);
    const xy = P.map(([lat, lng]) => [lng * k, lat]);
    const n = xy.length;
    const ext = [
      [2 * xy[0][0] - xy[1][0], 2 * xy[0][1] - xy[1][1]],
      ...xy,
      [2 * xy[n - 1][0] - xy[n - 2][0], 2 * xy[n - 1][1] - xy[n - 2][1]],
    ];
    const knot = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5, 1e-9);
    const lerp = (a, b, ta, tb, t) => {
      const u = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };

    const out = [];
    for (let i = 1; i < n; i++) {
      const [p0, p1, p2, p3] = [ext[i - 1], ext[i], ext[i + 1], ext[i + 2]];
      const t0 = 0;
      const t1 = t0 + knot(p0, p1);
      const t2 = t1 + knot(p1, p2);
      const t3 = t2 + knot(p2, p3);
      for (let j = 0; j < samples; j++) {
        const t = t1 + ((t2 - t1) * j) / samples;
        const a1 = lerp(p0, p1, t0, t1, t);
        const a2 = lerp(p1, p2, t1, t2, t);
        const a3 = lerp(p2, p3, t2, t3, t);
        const b1 = lerp(a1, a2, t0, t2, t);
        const b2 = lerp(a2, a3, t1, t3, t);
        const [x, y] = lerp(b1, b2, t1, t2, t);
        out.push([y, x / k]);
      }
    }
    out.push(P[n - 1]);
    return out;
  }

  function arc(a, b, n = 64) {
    const dLat = b[0] - a[0];
    const dLng = b[1] - a[1];
    const k = 0.2;
    const ctrl = [(a[0] + b[0]) / 2 + dLng * k, (a[1] + b[1]) / 2 - dLat * k];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      pts.push([
        u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1],
      ]);
    }
    return pts;
  }

  // 从翡翠绿渐变到香槟金
  function dayColor(i, n) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const h = 152 + (43 - 152) * t;
    const s = 44 + (58 - 44) * t;
    const l = 63 + (71 - 63) * t;
    return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
  }

  /* ---------------- 数据预处理 ---------------- */

  TRIPS.forEach((trip) => {
    trip.km = 0;
    trip.coords = [];
    trip.places = new Map();
    trip.dayColors = trip.days.map((_, i) => dayColor(i, trip.days.length));

    trip.days.forEach((day, di) => {
      day.no = di + 1;
      day.km = 0;
      day.coords = [];
      day.stops = [];

      day.legs.forEach((leg) => {
        const pts = [];
        leg.path.forEach((p) => {
          if (Array.isArray(p)) {
            pts.push(p);
            return;
          }
          pts.push(p.c);
          day.stops.push(p);
          const place = trip.places.get(p.n);
          if (!place) {
            trip.places.set(p.n, { ...p, days: [day.no], firstDay: di });
          } else {
            if (TYPE_RANK[p.t] > TYPE_RANK[place.t]) place.t = p.t;
            if (!place.days.includes(day.no)) place.days.push(day.no);
          }
        });

        leg.line = leg.mode === 'flight' ? arc(pts[0], pts[pts.length - 1]) : smooth(pts);
        let km = 0;
        for (let i = 1; i < pts.length; i++) km += haversine(pts[i - 1], pts[i]);
        leg.km = km * (ROUTE_FACTOR[leg.mode] || 1.1);
        day.km += leg.km;
        day.coords.push(...leg.line);
      });

      const cities = day.stops.filter((s) => s.t === 'city');
      day.stay = cities.length ? cities[cities.length - 1].n : '';
      day.modes = [...new Set(day.legs.map((l) => l.label || MODE_LABEL[l.mode]))];
      trip.km += day.km;
      trip.coords.push(...day.coords);
    });

    const places = [...trip.places.values()];
    trip.count = {
      city: places.filter((p) => p.t === 'city').length,
      sight: places.filter((p) => p.t === 'sight').length,
      pass: places.filter((p) => p.t === 'pass').length,
    };
    trip.chain = trip.days.map((d) => d.stay).filter((s, i, arr) => s && s !== arr[i - 1]);
    trip.bounds = L.latLngBounds(trip.coords);
  });

  const visitedCountries = new Set(TRIPS.flatMap((t) => t.countries));
  const allBounds = TRIPS.reduce((b, t) => b.extend(t.bounds), L.latLngBounds(TRIPS[0].coords));

  /* ---------------- 迷你路线图（SVG） ---------------- */

  function miniRoute(trip, size = 92, pad = 14) {
    const lat0 = trip.bounds.getCenter().lat * (Math.PI / 180);
    const proj = ([lat, lng]) => [lng * Math.cos(lat0), -lat];
    const xy = trip.coords.map(proj);
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY, 1e-6);
    const ox = (size - (maxX - minX) * scale) / 2;
    const oy = (size - (maxY - minY) * scale) / 2;
    const toSvg = (c) => {
      const [x, y] = proj(c);
      return [(x - minX) * scale + ox, (y - minY) * scale + oy];
    };

    let paths = '';
    trip.days.forEach((day, di) => {
      day.legs.forEach((leg) => {
        const d = leg.line.map((c, i) => (i ? 'L' : 'M') + toSvg(c).map((v) => v.toFixed(1)).join(' ')).join('');
        const dash = leg.mode === 'flight' ? ' stroke-dasharray="1.5 4"' : DASHED_MODES.has(leg.mode) ? ' stroke-dasharray="3 3"' : '';
        paths += `<path d="${d}" fill="none" stroke="${trip.dayColors[di]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
      });
    });

    let dots = '';
    trip.places.forEach((p) => {
      if (p.t !== 'city') return;
      const [x, y] = toSvg(p.c);
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#0b1d17" stroke="${trip.dayColors[p.firstDay]}" stroke-width="1.4"/>`;
    });

    return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${paths}${dots}</svg>`;
  }

  /* ---------------- 地图 ---------------- */

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    minZoom: 2,
    maxZoom: 13,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 110,
    maxBounds: [[-62, -200], [85, 200]],
    maxBoundsViscosity: 0.85,
  });

  const canvas = L.canvas({ padding: 0.5 });
  const routePane = map.createPane('routes');
  routePane.style.zIndex = 450;

  // 经纬网
  const graticule = [];
  for (let lat = -60; lat <= 80; lat += 20) graticule.push([[lat, -180], [lat, 180]]);
  for (let lng = -180; lng <= 180; lng += 20) graticule.push([[-62, lng], [85, lng]]);
  L.polyline(graticule, { renderer: canvas, color: '#8fd4ae', opacity: 0.05, weight: 1, interactive: false }).addTo(map);

  // 跨越 180° 经线的环（俄罗斯、斐济）在平面投影下会被拉成横贯全图的条带，
  // 需展开经度使其连续；绕极一周无法闭合的环（南极洲）在可视范围外，直接舍弃
  function unwrapRing(ring) {
    let shift = 0;
    let prev = null;
    const out = ring.map(([lng, lat]) => {
      if (prev !== null) {
        const d = lng + shift - prev;
        if (d > 180) shift -= 360;
        else if (d < -180) shift += 360;
      }
      prev = lng + shift;
      return [prev, lat];
    });
    return shift === 0 ? out : null;
  }

  function fixAntimeridian(fc) {
    fc.features.forEach((f) => {
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      g.type = 'MultiPolygon';
      g.coordinates = polys
        .map((rings) => rings.map(unwrapRing))
        .filter((rings) => rings[0])
        .map((rings) => rings.filter(Boolean));
    });
    return fc;
  }

  const topo = window.WORLD_TOPO;
  const land = fixAntimeridian(topojson.feature(topo, topo.objects.land));
  const countries = fixAntimeridian(topojson.feature(topo, topo.objects.countries));
  countries.features = countries.features.filter((f) => f.id !== '010');

  // 国内按省份高亮：中国整体按未到访绘制，到访过的省份叠加在上面
  const provinces = window.CHINA_TOPO ? topojson.feature(window.CHINA_TOPO, window.CHINA_TOPO.objects.provinces) : null;
  const byProvince = provinces && ((f) => f.id === CHINA);

  // 简化后的海岸线与省界略有出入，海岛、海边的点可能落在缝隙里，按最近的省份归属
  function provinceOf(pt) {
    const hit = provinces.features.find((f) => inGeometry(pt, f.geometry));
    if (hit) return hit.id;
    let best = null;
    let min = Infinity;
    provinces.features.forEach((f) => {
      geometryRings(f.geometry).forEach((ring) => ring.forEach(([lng, lat]) => {
        const d = (lat - pt[0]) ** 2 + ((lng - pt[1]) * Math.cos((pt[0] * Math.PI) / 180)) ** 2;
        if (d < min) [min, best] = [d, f.id];
      }));
    });
    return best;
  }

  TRIPS.forEach((trip) => {
    trip.provinces = provinces && trip.countries.includes(CHINA)
      ? [...new Set([...trip.places.values()].filter((p) => p.t !== 'pass').map((p) => provinceOf(p.c)))]
      : [];
  });
  const visitedProvinces = new Set(TRIPS.flatMap((t) => t.provinces));

  // 海岸光晕
  L.geoJSON(land, { renderer: canvas, interactive: false, style: { color: '#8fd4ae', weight: 7, opacity: 0.045, fill: false } }).addTo(map);

  L.geoJSON(countries, {
    renderer: canvas,
    interactive: false,
    filter: (f) => !visitedCountries.has(f.id) || (byProvince && byProvince(f)),
    style: PALETTE.land,
  }).addTo(map);

  function bindRegion(layer, name, trips) {
    const names = trips.slice(0, 4).map((t) => esc(t.title)).join('、');
    layer.bindTooltip(
      `<b>${esc(name)}</b><span>${trips.length > 4 ? `${names} 等 ${trips.length} 次旅行` : names}</span>`,
      { sticky: true, className: 'country-tip', direction: 'top', offset: [0, -10] }
    );
    layer.on('mouseover', () => layer.setStyle(PALETTE.visitedHover));
    layer.on('mouseout', () => layer.setStyle(PALETTE.visited));
    layer.on('click', () => {
      if (state.active && trips.includes(state.active)) return;
      if (trips.length === 1) {
        selectTrip(trips[0].id);
        return;
      }
      if (state.active) backToList(false);
      const bounds = trips.reduce((b, t) => b.extend(t.bounds), L.latLngBounds(trips[0].coords));
      map.flyToBounds(bounds, { ...fitPadding(), maxZoom: 7, duration: 1 });
    });
  }

  if (provinces) {
    L.geoJSON(provinces, {
      renderer: canvas,
      interactive: false,
      filter: (f) => !visitedProvinces.has(f.id),
      style: PALETTE.province,
    }).addTo(map);

    L.geoJSON(provinces, {
      renderer: canvas,
      filter: (f) => visitedProvinces.has(f.id),
      style: PALETTE.visited,
      onEachFeature: (f, layer) => bindRegion(layer, f.properties.name, TRIPS.filter((t) => t.provinces.includes(f.id))),
    }).addTo(map);
  }

  L.geoJSON(countries, {
    renderer: canvas,
    filter: (f) => visitedCountries.has(f.id) && !(byProvince && byProvince(f)),
    style: PALETTE.visited,
    onEachFeature: (f, layer) =>
      bindRegion(layer, COUNTRY_NAMES[f.id] || f.properties.name, TRIPS.filter((t) => t.countries.includes(f.id))),
  }).addTo(map);

  const previewGroup = L.layerGroup().addTo(map);
  const pinGroup = L.layerGroup().addTo(map);
  const activeGroup = L.layerGroup().addTo(map);

  const state = { active: null, token: 0, legLayers: [], markers: new Map() };
  const previews = new Map();
  const pins = new Map();

  TRIPS.forEach((trip) => {
    const lines = trip.days.flatMap((d) => d.legs.map((l) => l.line));
    const pl = L.polyline(lines, {
      pane: 'routes',
      color: '#d8c38b',
      weight: 2,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(previewGroup);
    previews.set(trip.id, pl);

    const pin = L.marker(trip.anchor, {
      icon: L.divIcon({
        className: 'trip-pin',
        html: `<span class="pulse"></span><span class="dot"></span><span class="pin-label">${esc(trip.title)}<small>${trip.days.length} 日</small></span>`,
        iconSize: [0, 0],
      }),
      riseOnHover: true,
      keyboard: false,
    }).addTo(pinGroup);
    pin.on('click', () => selectTrip(trip.id));
    pins.set(trip.id, pin);
  });

  function updateZoomClass() {
    const z = map.getZoom();
    const el = map.getContainer();
    el.classList.toggle('z-sight', z >= 9.75);
    el.classList.toggle('z-pass', z >= 11);
  }
  map.on('zoomend', updateZoomClass);

  // 旅行标签避让：长行程优先，依次尝试右、左、上、下，都放不下则隐藏（悬停时再显示）
  const LABEL_SIDES = ['right', 'left', 'top', 'bottom'];

  function layoutPinLabels() {
    const visible = TRIPS.map((trip) => ({ trip, el: pins.get(trip.id).getElement() }))
      .filter(({ el }) => el && el.style.display !== 'none')
      .map((item) => ({ ...item, p: map.latLngToContainerPoint(item.trip.anchor) }));
    const boxes = visible.map(({ p }) => [p.x - 9, p.y - 9, p.x + 9, p.y + 9]);
    document.querySelectorAll('#panel, .legend, .map-controls').forEach((ui) => {
      const r = ui.getBoundingClientRect();
      if (r.width) boxes.push([r.left, r.top, r.right, r.bottom]);
    });
    const hit = (b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    const gap = 14;

    visible
      .sort((a, b) => b.trip.days.length - a.trip.days.length)
      .forEach(({ el, p }) => {
        const label = el.querySelector('.pin-label');
        const w = label.offsetWidth;
        const h = label.offsetHeight;
        const cand = {
          right: [p.x + gap, p.y - h / 2, p.x + gap + w, p.y + h / 2],
          left: [p.x - gap - w, p.y - h / 2, p.x - gap, p.y + h / 2],
          top: [p.x - w / 2, p.y - gap - h, p.x + w / 2, p.y - gap],
          bottom: [p.x - w / 2, p.y + gap, p.x + w / 2, p.y + gap + h],
        };
        const side = LABEL_SIDES.find((s) => !hit(cand[s]));
        LABEL_SIDES.forEach((s) => el.classList.toggle(`label-${s}`, s === side && s !== 'right'));
        el.classList.toggle('label-off', !side);
        if (side) boxes.push(cand[side]);
      });
  }
  map.on('zoomend moveend', layoutPinLabels);
  window.addEventListener('resize', layoutPinLabels);

  /* ---------------- 视野控制（避开面板） ---------------- */

  function fitPadding() {
    if (mobile.matches) {
      const h = $('#panel').offsetHeight;
      return { paddingTopLeft: [36, 70], paddingBottomRight: [36, h + 36] };
    }
    const w = $('#panel').offsetWidth + 20;
    return { paddingTopLeft: [w + 60, 70], paddingBottomRight: [90, 70] };
  }

  function focusOffset() {
    if (mobile.matches) return L.point(0, $('#panel').offsetHeight / 2);
    return L.point(-($('#panel').offsetWidth + 20) / 2, 0);
  }

  function flyToPoint(latlng, zoom) {
    const p = map.project(latlng, zoom).add(focusOffset());
    map.flyTo(map.unproject(p, zoom), zoom, { duration: 0.9 });
  }

  function showAll(animate = true) {
    const pad = fitPadding();
    const opts = mobile.matches
      ? { ...pad, maxZoom: 3.25 }
      : { paddingTopLeft: pad.paddingTopLeft, paddingBottomRight: [240, 70], maxZoom: 3.25 };
    if (animate) map.flyToBounds(allBounds, { ...opts, duration: 1.1 });
    else map.fitBounds(allBounds, opts);
  }

  /* ---------------- 列表视图 ---------------- */

  function renderOverview() {
    const days = TRIPS.reduce((s, t) => s + t.days.length, 0);
    const km = TRIPS.reduce((s, t) => s + t.km, 0);
    $('#overview').innerHTML = [
      [TRIPS.length, '次旅行'],
      [visitedCountries.size, '国家/地区'],
      ...(provinces ? [[visitedProvinces.size, '国内省份']] : []),
      [days, '天在路上'],
      [`${(km / 1000).toFixed(1)}<small>k</small>`, '公里'],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  }

  function renderList() {
    const ul = $('#trip-list');
    let year = '';
    ul.innerHTML = TRIPS.map((t) => {
      const y = t.date.slice(0, 4);
      const head = y !== year ? `<li class="year-head">${(year = y)}</li>` : '';
      return `${head}
      <li class="trip-card" data-id="${t.id}">
        <div class="mini">${miniRoute(t)}</div>
        <div class="info">
          <div class="region">${esc(t.region)}</div>
          <h3>${esc(t.title)}</h3>
          <div class="sub">${esc(t.subtitle)}</div>
          <div class="meta">
            <span class="chip">${t.days.length} 天</span>
            ${t.km >= 1 ? `<span class="chip">约 ${fmtKm(t.km)} km</span>` : ''}
            <span class="chip">${esc(t.date)}</span>
          </div>
        </div>
      </li>`;
    }).join('');

    ul.querySelectorAll('.trip-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', () => selectTrip(id));
      card.addEventListener('mouseenter', () => hotTrip(id, true));
      card.addEventListener('mouseleave', () => hotTrip(id, false));
    });
  }

  function hotTrip(id, on) {
    const el = pins.get(id).getElement();
    if (el) el.classList.toggle('hot', on);
    if (!state.active) previews.get(id).setStyle({ weight: on ? 3.5 : 2, opacity: on ? 1 : 0.85 });
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  }

  /* ---------------- 详情视图 ---------------- */

  function renderDetail(trip) {
    const el = $('#view-detail');
    el.innerHTML = `
      <button type="button" class="back">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 5l-7 7 7 7"/></svg>
        全部旅行
      </button>
      <div class="hero">
        <div class="art">${miniRoute(trip, 170, 22)}</div>
        <div class="region">${esc(trip.region)}</div>
        <h2>${esc(trip.title)}</h2>
        <p class="sub">${esc(trip.subtitle)}</p>
        <div class="date">${esc(trip.date)}</div>
      </div>
      <div class="stats">
        <div class="stat"><b>${trip.days.length}<small>天</small></b><span>行程</span></div>
        <div class="stat"><b>${trip.km >= 1 ? fmtKm(trip.km) : '—'}</b><span>公里（约）</span></div>
        <div class="stat"><b>${trip.count.sight}</b><span>到访</span></div>
        <div class="stat"><b>${trip.count.pass}</b><span>途经</span></div>
      </div>
      <p class="summary">${esc(trip.summary)}</p>
      <div class="tags">${trip.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      ${trip.chain.length ? `<div class="chain">
        <span class="label">住宿路线</span>
        ${trip.chain.map((c) => `<b>${esc(c)}</b>`).join('<span class="arr">→</span>')}
      </div>` : ''}
      <ol class="timeline">
        ${trip.days.map((day, di) => `
          <li class="day" data-day="${day.no}" style="--dc:${trip.dayColors[di]}">
            <span class="day-no">${day.no}</span>
            <div class="day-head">
              <h4>${esc(day.title)}</h4>
              <div class="day-meta">
                <span>${day.modes.map(esc).join(' + ')}</span>
                ${day.km >= 1 ? `<span>约 ${fmtKm(day.km)} km</span>` : ''}
                ${day.stay ? `<span class="stay">宿 · ${esc(day.stay)}</span>` : ''}
              </div>
            </div>
            <p class="day-desc">${esc(day.desc)}</p>
            <ul class="stops">
              ${day.stops.map((s) => `
                <li class="stop ${s.t}" data-name="${esc(s.n)}">
                  <span class="ico"></span>
                  <span class="name">${esc(s.n)}</span>
                  <span class="type">${TYPE_LABEL[s.t]}${s.alt ? ` · ${s.alt}m` : ''}</span>
                  ${s.d ? `<span class="note">${esc(s.d)}</span>` : ''}
                </li>`).join('')}
            </ul>
          </li>`).join('')}
      </ol>
      <div class="detail-foot">路线为示意，里程按折线估算 · 边界数据 Natural Earth、DataV.GeoAtlas</div>`;

    el.scrollTop = 0;
    $('.back', el).addEventListener('click', () => backToList());

    el.querySelectorAll('.day').forEach((li) => {
      const no = Number(li.dataset.day);
      li.addEventListener('mouseenter', () => highlightDay(no));
      li.addEventListener('mouseleave', () => highlightDay(null));
      $('.day-head', li).addEventListener('click', () => {
        const day = trip.days[no - 1];
        map.flyToBounds(L.latLngBounds(day.coords), { ...fitPadding(), maxZoom: TRIP_MAX_ZOOM + 1, duration: 0.9 });
      });
    });

    el.querySelectorAll('.stop').forEach((li) => {
      li.addEventListener('click', () => focusPlace(li.dataset.name));
    });
  }

  /* ---------------- 选中某次旅行 ---------------- */

  function selectTrip(id) {
    const trip = TRIPS.find((t) => t.id === id);
    if (!trip) return;
    if (state.active === trip) return;

    const token = ++state.token;
    state.active = trip;
    clearActive();

    previews.forEach((pl, tid) => pl.setStyle({ opacity: tid === id ? 0 : 0.25, weight: 2 }));
    pins.forEach((pin, tid) => {
      const el = pin.getElement();
      if (el) el.style.display = tid === id ? 'none' : '';
    });

    renderDetail(trip);
    showView('detail');
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);

    let drawn = false;
    const draw = () => {
      if (drawn || token !== state.token) return;
      drawn = true;
      drawTrip(trip);
    };
    map.once('moveend', draw);
    setTimeout(draw, 1700);
    map.flyToBounds(trip.bounds, { ...fitPadding(), maxZoom: TRIP_MAX_ZOOM, duration: 1.2 });
  }

  function clearActive() {
    activeGroup.clearLayers();
    state.legLayers = [];
    state.markers.clear();
  }

  function backToList(fly = true) {
    state.token++;
    state.active = null;
    clearActive();
    previews.forEach((pl) => pl.setStyle({ opacity: 0.85, weight: 2 }));
    pins.forEach((pin) => {
      const el = pin.getElement();
      if (el) el.style.display = '';
    });
    showView('list');
    history.replaceState(null, '', location.pathname + location.search);
    map.closePopup();
    if (fly) showAll();
    else layoutPinLabels();
  }

  function drawIn(layer, delay, dur) {
    const el = layer.getElement();
    if (!el) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = `${len} ${len}`;
    el.style.strokeDashoffset = len;
    el.getBoundingClientRect();
    el.style.transition = `stroke-dashoffset ${dur}ms ease-in-out ${delay}ms`;
    el.style.strokeDashoffset = '0';
    setTimeout(() => {
      el.style.transition = '';
      el.style.strokeDasharray = '';
      el.style.strokeDashoffset = '';
    }, delay + dur + 60);
  }

  function fadeIn(layer, delay, dur) {
    const el = layer.getElement();
    if (!el) return;
    el.style.opacity = 0;
    el.getBoundingClientRect();
    el.style.transition = `opacity ${dur}ms ease ${delay}ms`;
    el.style.opacity = 1;
  }

  function drawTrip(trip) {
    const total = 2600;
    const totalKm = trip.km || 1;
    const dayStart = [];
    let t = 0;

    trip.days.forEach((day, di) => {
      dayStart.push(t);
      const color = trip.dayColors[di];
      day.legs.forEach((leg) => {
        const dur = Math.max(260, (leg.km / totalKm) * total);
        const dashed = leg.mode === 'flight' ? '1 9' : DASHED_MODES.has(leg.mode) ? '6 7' : null;

        const glow = L.polyline(leg.line, {
          pane: 'routes', color, weight: 11, opacity: 0.1, lineCap: 'round', lineJoin: 'round', interactive: false,
        }).addTo(activeGroup);
        const base = L.polyline(leg.line, {
          pane: 'routes', color, weight: leg.mode === 'flight' ? 2.6 : 3.2, opacity: 0.95,
          lineCap: 'round', lineJoin: 'round', dashArray: dashed,
        }).addTo(activeGroup);
        base.bindTooltip(
          `第 ${day.no} 天 · ${esc(leg.label || MODE_LABEL[leg.mode])} · 约 ${fmtKm(leg.km)} km`,
          { sticky: true, className: 'route-tip', direction: 'top', offset: [0, -8] }
        );
        base.on('click', () => scrollToDay(day.no));

        const layers = [{ layer: glow, opacity: 0.1 }, { layer: base, opacity: 0.95 }];
        if (leg.mode === 'train' || leg.mode === 'shinkansen') {
          const ties = L.polyline(leg.line, {
            pane: 'routes', color: '#0b1d17', weight: 1.2, opacity: 0.85, dashArray: '2 6', interactive: false,
          }).addTo(activeGroup);
          fadeIn(ties, t + dur, 300);
          layers.push({ layer: ties, opacity: 0.85 });
        }

        fadeIn(glow, t, dur);
        if (dashed) fadeIn(base, t, dur);
        else drawIn(base, t, dur);

        state.legLayers.push({ day: day.no, layers });
        t += dur;
      });
    });

    const sizes = { city: 16, sight: 11, pass: 8 };
    trip.places.forEach((p) => {
      const color = trip.dayColors[p.firstDay];
      const size = sizes[p.t];
      const delay = Math.round(dayStart[p.firstDay] + 200);
      const marker = L.marker(p.c, {
        icon: L.divIcon({
          className: `stop-ico stop-${p.t}`,
          html: `<i style="--dc:${color};animation-delay:${delay}ms"></i>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
          popupAnchor: [0, -size / 2 - 2],
        }),
        zIndexOffset: TYPE_RANK[p.t] * 100,
        riseOnHover: true,
        keyboard: false,
      }).addTo(activeGroup);

      marker.bindTooltip(esc(p.n), {
        permanent: true,
        direction: 'right',
        offset: [size / 2 + 3, 0],
        className: `lbl lbl-${p.t}`,
      });
      marker.bindPopup(
        `<div class="pp-type" style="color:${color}">${TYPE_LABEL[p.t]} · ${p.days.map((d) => `第 ${d} 天`).join('、')}</div>
         <div class="pp-name">${esc(p.n)}</div>
         ${p.alt ? `<div class="pp-alt">海拔 ${p.alt} m</div>` : ''}
         ${p.d ? `<p class="pp-note">${esc(p.d)}</p>` : ''}`,
        { className: 'stop-popup', closeButton: true, autoPanPaddingTopLeft: L.point(fitPadding().paddingTopLeft) }
      );
      marker.on('mouseover', () => toggleLabel(marker, true));
      marker.on('mouseout', () => toggleLabel(marker, false));
      marker.on('click', () => scrollToDay(p.days[0]));

      state.markers.set(p.n, { marker, place: p });
    });

    updateZoomClass();
  }

  function toggleLabel(marker, on) {
    const tip = marker.getTooltip();
    const el = tip && tip.getElement();
    if (el) el.classList.toggle('hover', on);
  }

  function highlightDay(no) {
    state.legLayers.forEach(({ day, layers }) => {
      const on = no == null || day === no;
      layers.forEach(({ layer, opacity }) => layer.setStyle({ opacity: on ? opacity : opacity * 0.15 }));
    });
    state.markers.forEach(({ marker, place }) => {
      const on = no == null || place.days.includes(no);
      const el = marker.getElement();
      if (el) el.classList.toggle('dim', !on);
      const tip = marker.getTooltip() && marker.getTooltip().getElement();
      if (tip) {
        tip.classList.toggle('dim', !on);
        tip.classList.toggle('hover', no != null && on && place.t !== 'pass');
      }
    });
  }

  function focusPlace(name) {
    const entry = state.markers.get(name);
    if (!entry) return;
    const zoom = Math.max(map.getZoom(), 9.5);
    map.closePopup();
    map.once('moveend', () => entry.marker.openPopup());
    flyToPoint(entry.marker.getLatLng(), zoom);
  }

  function scrollToDay(no) {
    const li = document.querySelector(`#view-detail .day[data-day="${no}"]`);
    if (li) li.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- 控件 & 启动 ---------------- */

  $('#zoom-in').addEventListener('click', () => map.zoomIn());
  $('#zoom-out').addEventListener('click', () => map.zoomOut());
  $('#zoom-all').addEventListener('click', () => {
    if (state.active) map.flyToBounds(state.active.bounds, { ...fitPadding(), maxZoom: TRIP_MAX_ZOOM, duration: 1 });
    else showAll();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.active) backToList();
  });

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && TRIPS.some((t) => t.id === id)) selectTrip(id);
  });

  renderOverview();
  renderList();
  showAll(false);
  updateZoomClass();
  layoutPinLabels();

  const initial = location.hash.slice(1);
  if (initial && TRIPS.some((t) => t.id === initial)) setTimeout(() => selectTrip(initial), 300);
})();
