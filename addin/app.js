const metricEl = document.getElementById("metric");
const scopeEl = document.getElementById("scope");
const groupEl = document.getElementById("groupId");
const granularityEl = document.getElementById("granularity");
const fromEl = document.getElementById("from");
const toEl = document.getElementById("to");
const chartAggModeEl = document.getElementById("chartAggMode");
const refreshBtn = document.getElementById("refreshBtn");
const exportBtn = document.getElementById("exportBtn");
const connectBtn = document.getElementById("connectBtn");
const rememberPasswordEl = document.getElementById("rememberPassword");
const statusEl = document.getElementById("statusText");
const tabMetaEl = document.getElementById("tabMeta");
const chartEl = document.getElementById("chartPlaceholder");
const kpiGridEl = document.getElementById("kpiGrid");
const topVehiclesChartEl = document.getElementById("topVehiclesChart");
const byGroupChartEl = document.getElementById("byGroupChart");
const byFuelTypeChartEl = document.getElementById("byFuelTypeChart");
const drilldownActiveEl = document.getElementById("drilldownActive");
const clearDrilldownBtn = document.getElementById("clearDrilldownBtn");
const tableHead = document.getElementById("dataTableHead");
const tableBody = document.querySelector("#dataTable tbody");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));

const mygServerEl = document.getElementById("mygServer");
const mygDatabaseEl = document.getElementById("mygDatabase");
const mygUserEl = document.getElementById("mygUser");
const mygPasswordEl = document.getElementById("mygPassword");
const dcBaseUrlEl = document.getElementById("dcBaseUrl");
const DEFAULT_DC_BASE_URL = "https://data-connector.geotab.com/odata/v4/svc/";

const state = {
  groups: [],
  connected: false,
  lastRows: [],
  lastPivot: null,
  selectedVehicleKeys: new Set(),
  activeTab: "main-data",
  tabCache: {},
  drillFilters: {
    groupName: null,
    fuelType: null,
    bucket: null,
  },
};

const TAB_METRIC = {
  "main-data": "distance",
  "utilization": "distance",
  "fuel": "fuel",
};

function defaultDates() {
  const to = new Date();
  const from = new Date();
  from.setMonth(to.getMonth() - 3);
  fromEl.value = from.toISOString().slice(0, 10);
  toEl.value = to.toISOString().slice(0, 10);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
}

function tabTitle(tab) {
  if (tab === "utilization") return "Utilization";
  if (tab === "fuel") return "Fuel Consumption";
  return "Main Data";
}

function updateTabUI() {
  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === state.activeTab);
  }
  tabMetaEl.textContent = `Tab activa: ${tabTitle(state.activeTab)}`;
  const metric = TAB_METRIC[state.activeTab] || "distance";
  metricEl.value = metric;
  metricEl.disabled = true;
}

function toggleGroup() {
  groupEl.disabled = scopeEl.value !== "group";
}

function getConnectionPayload() {
  return {
    mygServer: mygServerEl.value.trim(),
    mygDatabase: mygDatabaseEl.value.trim(),
    mygUser: mygUserEl.value.trim(),
    mygPassword: mygPasswordEl.value,
    dcBaseUrl: dcBaseUrlEl.value.trim(),
  };
}

function saveConfig() {
  const payload = getConnectionPayload();
  const rememberPassword = !!rememberPasswordEl.checked;
  const local = {
    ...payload,
    mygPassword: rememberPassword ? payload.mygPassword : "",
    rememberPassword,
  };
  localStorage.setItem("dcv_config", JSON.stringify(local));
}

function loadConfig() {
  const raw = localStorage.getItem("dcv_config");
  if (!raw) {
    dcBaseUrlEl.value = DEFAULT_DC_BASE_URL;
    return;
  }
  try {
    const cfg = JSON.parse(raw);
    mygServerEl.value = cfg.mygServer || "my.geotab.com";
    mygDatabaseEl.value = cfg.mygDatabase || "";
    mygUserEl.value = cfg.mygUser || "";
    rememberPasswordEl.checked = !!cfg.rememberPassword;
    mygPasswordEl.value = cfg.rememberPassword ? (cfg.mygPassword || "") : "";
    dcBaseUrlEl.value = cfg.dcBaseUrl || DEFAULT_DC_BASE_URL;
  } catch (_err) {
    dcBaseUrlEl.value = DEFAULT_DC_BASE_URL;
  }
}

function handleRememberPasswordToggle() {
  if (!rememberPasswordEl.checked) {
    const raw = localStorage.getItem("dcv_config");
    if (!raw) return;
    try {
      const cfg = JSON.parse(raw);
      cfg.rememberPassword = false;
      cfg.mygPassword = "";
      localStorage.setItem("dcv_config", JSON.stringify(cfg));
    } catch (_err) {
      // ignore malformed storage
    }
  }
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (str.includes("\"") || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exportPivotToCsv() {
  if (!state.lastPivot || !state.lastPivot.vehicles.length) {
    throw new Error("No hay tabla para exportar");
  }

  const { buckets, vehicles } = state.lastPivot;
  const header = ["device_name", "device_serial", ...buckets];
  const lines = [header.map(csvEscape).join(",")];

  for (const v of vehicles) {
    const row = [v.device_name, v.device_serial];
    for (const b of buckets) {
      const value = v.values.get(b);
      row.push(value === undefined ? "" : Number(value).toFixed(2));
    }
    lines.push(row.map(csvEscape).join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `datatable_${metricEl.value}_${granularityEl.value}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatAxisLabel(bucket) {
  if (!bucket) return "";
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const [y, m] = bucket.split("-");
    return `${m}/${y.slice(2)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const [y, m, d] = bucket.split("-");
    return `${d}/${m}`;
  }
  return bucket;
}

function applyDrillFilters(rows) {
  return rows.filter((r) => {
    if (state.drillFilters.groupName && (r.group_name || "Sin grupo") !== state.drillFilters.groupName) {
      return false;
    }
    if (state.drillFilters.fuelType && (r.fuel_type || "Unknown") !== state.drillFilters.fuelType) {
      return false;
    }
    if (state.drillFilters.bucket && r.bucket !== state.drillFilters.bucket) {
      return false;
    }
    return true;
  });
}

function buildSeries(rows, mode, selectedKeys) {
  const fullMap = new Map();
  const selectedMap = new Map();

  for (const r of rows) {
    const key = `${r.device_name}|||${r.device_serial}`;
    const bucket = r.bucket;
    const value = Number(r.value) || 0;

    if (!fullMap.has(bucket)) fullMap.set(bucket, { sum: 0, count: 0 });
    const full = fullMap.get(bucket);
    full.sum += value;
    full.count += 1;

    if (selectedKeys && selectedKeys.size > 0 && selectedKeys.has(key)) {
      if (!selectedMap.has(bucket)) selectedMap.set(bucket, { sum: 0, count: 0 });
      const sel = selectedMap.get(bucket);
      sel.sum += value;
      sel.count += 1;
    }
  }

  const toPoints = (m) => Array.from(m.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, acc]) => ({
      bucket,
      value: mode === "average" ? (acc.count ? acc.sum / acc.count : 0) : acc.sum,
    }));

  const fullPoints = toPoints(fullMap);
  const selectedPoints = selectedKeys && selectedKeys.size > 0 ? toPoints(selectedMap) : [];

  return { fullPoints, selectedPoints };
}

function renderChart(lines) {
  const allPoints = lines.flatMap((l) => l.points);
  if (!allPoints.length) {
    chartEl.textContent = "Sin datos para el filtro seleccionado";
    return;
  }

  const width = 1020;
  const height = 300;
  const pad = 38;
  const values = allPoints.map((p) => Number(p.value));
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const span = Math.max(maxVal - minVal, 1);

  const buckets = lines[0].points.map((p) => p.bucket);
  const idxMap = new Map(buckets.map((b, i) => [b, i]));

  const toX = (bucket) => {
    const i = idxMap.get(bucket) ?? 0;
    return pad + (i * (width - pad * 2)) / Math.max(buckets.length - 1, 1);
  };
  const toY = (v) => height - pad - ((v - minVal) / span) * (height - pad * 2);

  const maxTicks = 7;
  const step = Math.max(1, Math.floor((buckets.length - 1) / Math.max(1, maxTicks - 1)));
  const tickIndexes = [];
  for (let i = 0; i < buckets.length; i += step) tickIndexes.push(i);
  if (tickIndexes[tickIndexes.length - 1] !== buckets.length - 1) tickIndexes.push(buckets.length - 1);

  const tickMarks = tickIndexes.map((idx) => {
    const bucket = buckets[idx];
    const x = toX(bucket).toFixed(2);
    return `
      <line x1="${x}" y1="${height - pad}" x2="${x}" y2="${height - pad + 5}" stroke="#94a3b8" stroke-width="1" />
      <text x="${x}" y="${height - 10}" text-anchor="middle" font-size="10" fill="#475569">${formatAxisLabel(bucket)}</text>
    `;
  }).join("");

  const linePaths = lines.map((line) => {
    const polyline = line.points
      .map((p) => `${toX(p.bucket).toFixed(2)},${toY(Number(p.value)).toFixed(2)}`)
      .join(" ");

    const circles = line.points.map((p) => {
      const x = toX(p.bucket).toFixed(2);
      const y = toY(Number(p.value)).toFixed(2);
      const selectedBucket = state.drillFilters.bucket === p.bucket;
      const encodedBucket = encodeURIComponent(p.bucket);
      return `
        <circle cx="${x}" cy="${y}" r="${selectedBucket ? "5.2" : "3.2"}" fill="${line.color}" data-bucket="${encodedBucket}" style="cursor:pointer"
          stroke="${selectedBucket ? "#0f172a" : "none"}" stroke-width="${selectedBucket ? "1.5" : "0"}">
          <title>${line.name}\n${p.bucket}: ${Number(p.value).toFixed(2)}</title>
        </circle>
      `;
    }).join("");

    return `
      <polyline fill="none" stroke="${line.color}" stroke-width="2.5" points="${polyline}" />
      ${circles}
    `;
  }).join("");

  const legend = lines.map((line, idx) => `
    <g transform="translate(${pad + idx * 180}, ${pad - 16})">
      <rect x="0" y="-8" width="14" height="4" fill="${line.color}"></rect>
      <text x="20" y="-4" font-size="11" fill="#334155">${line.name}</text>
    </g>
  `).join("");

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="Evolución temporal">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#94a3b8" stroke-width="1" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#94a3b8" stroke-width="1" />
      ${tickMarks}
      ${linePaths}
      ${legend}
    </svg>
  `;
}

function renderKpis(rows) {
  if (!rows.length) {
    kpiGridEl.innerHTML = "";
    return;
  }
  const serials = new Set(rows.map((r) => r.device_serial));
  const total = rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0);
  const avgVehicle = serials.size ? total / serials.size : 0;
  const avgRow = rows.length ? total / rows.length : 0;
  const selected = state.selectedVehicleKeys.size;

  const cards = [
    { label: "Vehículos", value: serials.size.toString() },
    { label: "Valor total", value: total.toFixed(2) },
    { label: "Media por vehículo", value: avgVehicle.toFixed(2) },
    { label: "Media por fila", value: avgRow.toFixed(2) },
    { label: "Seleccionados", value: selected.toString() },
  ];

  kpiGridEl.innerHTML = cards.map((c) => `
    <div class="kpi-card">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
    </div>
  `).join("");
}

function renderTopVehiclesChart(rows) {
  if (!rows.length) {
    topVehiclesChartEl.textContent = "Sin datos";
    return;
  }
  const byVehicle = new Map();
  for (const r of rows) {
    const key = `${r.device_name}|||${r.device_serial}`;
    byVehicle.set(key, (byVehicle.get(key) || 0) + (Number(r.value) || 0));
  }
  const data = Array.from(byVehicle.entries())
    .map(([key, total]) => {
      const [name, serial] = key.split("|||");
      return { key, name, serial, total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  const max = Math.max(...data.map((d) => d.total), 1);
  topVehiclesChartEl.innerHTML = data.map((d) => {
    const pct = Math.max(2, (d.total / max) * 100);
    const selected = state.selectedVehicleKeys.has(d.key);
    return `
      <div class="top-row ${selected ? "selected" : ""}" data-key="${d.key}" title="${d.name} | ${d.serial} | ${d.total.toFixed(2)}">
        <div class="top-label">${d.name} <span>${d.serial}</span></div>
        <div class="top-bar-wrap">
          <div class="top-bar" style="width:${pct}%"></div>
        </div>
        <div class="top-value">${d.total.toFixed(2)}</div>
      </div>
    `;
  }).join("");
}

function renderGroupChart(rows) {
  if (!rows.length) {
    byGroupChartEl.textContent = "Sin datos";
    return;
  }
  const byGroup = new Map();
  for (const r of rows) {
    const group = r.group_name || "Sin grupo";
    if (!byGroup.has(group)) byGroup.set(group, new Set());
    byGroup.get(group).add(r.device_serial);
  }
  const data = Array.from(byGroup.entries())
    .map(([group, serials]) => ({ group, count: serials.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  const max = Math.max(...data.map((d) => d.count), 1);
  byGroupChartEl.innerHTML = data.map((d) => {
    const pct = Math.max(4, (d.count / max) * 100);
    const selected = state.drillFilters.groupName === d.group;
    const encodedGroup = encodeURIComponent(d.group);
    return `
      <div class="top-row ${selected ? "selected" : ""}" data-group="${encodedGroup}" title="${escapeHtml(d.group)} | ${d.count} vehículos">
        <div class="top-label">${escapeHtml(d.group)}</div>
        <div class="top-bar-wrap">
          <div class="top-bar group" style="width:${pct}%"></div>
        </div>
        <div class="top-value">${d.count}</div>
      </div>
    `;
  }).join("");
}

function renderFuelTypeChart(rows) {
  if (!rows.length) {
    byFuelTypeChartEl.textContent = "Sin datos";
    return;
  }
  const byFuel = new Map();
  for (const r of rows) {
    const fuel = r.fuel_type || "Unknown";
    if (!byFuel.has(fuel)) byFuel.set(fuel, new Set());
    byFuel.get(fuel).add(r.device_serial);
  }
  const data = Array.from(byFuel.entries())
    .map(([fuel, serials]) => ({ fuel, count: serials.size }))
    .sort((a, b) => b.count - a.count);
  const total = data.reduce((acc, d) => acc + d.count, 0) || 1;
  const colors = ["#0f766e", "#2563eb", "#ea580c", "#7c3aed", "#9333ea", "#475569"];

  let acc = 0;
  const segments = data.map((d, idx) => {
    const start = acc / total;
    acc += d.count;
    const end = acc / total;
    return { ...d, color: colors[idx % colors.length], start, end };
  });

  const cx = 74;
  const cy = 74;
  const r = 56;
  const stroke = 24;
  const c = 2 * Math.PI * r;

  const arcs = segments.map((s) => {
    const dash = Math.max(1, (s.end - s.start) * c);
    const offset = (1 - s.start) * c;
    const selected = state.drillFilters.fuelType === s.fuel;
    const encodedFuel = encodeURIComponent(s.fuel);
    return `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${selected ? stroke + 4 : stroke}"
        stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${offset}" data-fuel="${encodedFuel}" class="fuel-segment"></circle>
    `;
  }).join("");

  const legend = segments.map((s) => {
    const selected = state.drillFilters.fuelType === s.fuel;
    const encodedFuel = encodeURIComponent(s.fuel);
    return `
      <div class="fuel-legend-row ${selected ? "selected" : ""}" data-fuel="${encodedFuel}">
        <span class="dot" style="background:${s.color}"></span>
        <span>${escapeHtml(s.fuel)}</span>
        <span>${s.count}</span>
      </div>
    `;
  }).join("");

  byFuelTypeChartEl.innerHTML = `
    <div class="fuel-wrap">
      <svg viewBox="0 0 148 148" width="148" height="148" role="img" aria-label="Vehículos por tipo de fuel">
        ${arcs}
        <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${total}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="#64748b">vehículos</text>
      </svg>
      <div class="fuel-legend">${legend}</div>
    </div>
  `;
}

function buildVehicleIndex(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.device_name}|||${r.device_serial}`;
    if (!map.has(key)) {
      map.set(key, { key, device_name: r.device_name, device_serial: r.device_serial });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const nameCmp = a.device_name.localeCompare(b.device_name);
    if (nameCmp !== 0) return nameCmp;
    return a.device_serial.localeCompare(b.device_serial);
  });
}

function renderPivotTable(rows) {
  if (!rows.length) {
    tableHead.innerHTML = "<tr><th></th><th>Nombre vehículo</th><th>Serial</th></tr>";
    tableBody.innerHTML = "";
    state.lastPivot = { buckets: [], vehicles: [] };
    return;
  }

  const buckets = Array.from(new Set(rows.map((r) => r.bucket))).sort((a, b) => a.localeCompare(b));
  const byVehicle = new Map();

  for (const r of rows) {
    const key = `${r.device_name}|||${r.device_serial}`;
    if (!byVehicle.has(key)) {
      byVehicle.set(key, {
        key,
        device_name: r.device_name,
        device_serial: r.device_serial,
        values: new Map(),
      });
    }
    const entry = byVehicle.get(key);
    const prev = entry.values.get(r.bucket) || 0;
    entry.values.set(r.bucket, prev + Number(r.value));
  }

  const vehicles = Array.from(byVehicle.values()).sort((a, b) => {
    const nameCmp = a.device_name.localeCompare(b.device_name);
    if (nameCmp !== 0) return nameCmp;
    return a.device_serial.localeCompare(b.device_serial);
  });

  tableHead.innerHTML = `
    <tr>
      <th><input id="selectAllVehicles" type="checkbox" /></th>
      <th>Nombre vehículo</th>
      <th>Serial</th>
      ${buckets.map((b) => `<th>${b}</th>`).join("")}
    </tr>
  `;

  tableBody.innerHTML = vehicles.map((v) => `
    <tr>
      <td><input class="vehicle-check" type="checkbox" data-key="${v.key}" ${state.selectedVehicleKeys.has(v.key) ? "checked" : ""}></td>
      <td>${v.device_name}</td>
      <td>${v.device_serial}</td>
      ${buckets.map((b) => {
        const value = v.values.get(b);
        return `<td>${value === undefined ? "-" : Number(value).toFixed(2)}</td>`;
      }).join("")}
    </tr>
  `).join("");

  state.lastPivot = { buckets, vehicles };
  const selectAll = document.getElementById("selectAllVehicles");
  if (selectAll) {
    selectAll.checked = vehicles.length > 0 && vehicles.every((v) => state.selectedVehicleKeys.has(v.key));
  }
}

function refreshVisualsFromRows() {
  const allRows = state.lastRows || [];
  const rows = applyDrillFilters(allRows);
  const selected = state.selectedVehicleKeys;
  const mode = chartAggModeEl.value;

  const { fullPoints, selectedPoints } = buildSeries(rows, mode, selected);
  const lines = [
    {
      name: mode === "average" ? "Lista completa (promedio)" : "Lista completa (total)",
      color: "#0f766e",
      points: fullPoints,
    },
  ];
  if (selectedPoints.length) {
    lines.push({
      name: mode === "average" ? "Seleccionados (promedio)" : "Seleccionados (total)",
      color: "#2563eb",
      points: selectedPoints,
    });
  }

  renderChart(lines);
  renderKpis(rows);
  renderTopVehiclesChart(rows);
  renderGroupChart(allRows);
  renderFuelTypeChart(allRows);
  renderPivotTable(rows);
  const filters = [];
  if (state.drillFilters.groupName) filters.push(`Grupo: ${state.drillFilters.groupName}`);
  if (state.drillFilters.fuelType) filters.push(`Fuel: ${state.drillFilters.fuelType}`);
  if (state.drillFilters.bucket) filters.push(`Periodo: ${state.drillFilters.bucket}`);
  drilldownActiveEl.textContent = filters.length ? filters.join(" | ") : "Sin filtros de drilldown";
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return data;
}

async function connect() {
  try {
    const payload = getConnectionPayload();
    setStatus("Conectando...");
    const data = await apiPost("/api/connect", payload);
    state.groups = data.groups || [];
    groupEl.innerHTML = '<option value="">Seleccione grupo</option>' +
      state.groups.map((g) => `<option value="${g.id}">${g.name}</option>`).join("");
    state.connected = true;
    saveConfig();
    setStatus(`Conectado. Grupos: ${state.groups.length}`);
  } catch (err) {
    state.connected = false;
    setStatus(err.message, true);
  }
}

async function loadAndRender() {
  if (!state.connected) throw new Error("Conecta primero");
  if (scopeEl.value === "group" && !groupEl.value) {
    throw new Error("Selecciona grupo");
  }

  const metric = TAB_METRIC[state.activeTab] || "distance";

  const payload = {
    ...getConnectionPayload(),
    metric,
    scope: scopeEl.value,
    groupId: groupEl.value || null,
    granularity: granularityEl.value,
    from: fromEl.value,
    to: toEl.value,
  };

  const data = await apiPost(`/api/tab/${state.activeTab}`, payload);
  state.tabCache[state.activeTab] = data;
  state.lastRows = data.table?.rows || data.rows || [];
  const availableKeys = new Set(buildVehicleIndex(state.lastRows).map((v) => v.key));
  state.selectedVehicleKeys = new Set(
    Array.from(state.selectedVehicleKeys).filter((k) => availableKeys.has(k)),
  );
  refreshVisualsFromRows();
  const hitText = data.cache?.hit ? "cache hit" : "fresh";
  setStatus(`Tab ${tabTitle(state.activeTab)} cargada (${hitText}). Filas: ${state.lastRows.length}`);
}

scopeEl.addEventListener("change", () => {
  toggleGroup();
  if (scopeEl.value === "fleet") {
    groupEl.value = "";
  }
});
refreshBtn.addEventListener("click", async () => {
  try {
    setStatus("Consultando...");
    await loadAndRender();
  } catch (err) {
    setStatus(err.message, true);
  }
});
exportBtn.addEventListener("click", () => {
  try {
    exportPivotToCsv();
    setStatus("Tabla exportada a CSV");
  } catch (err) {
    setStatus(err.message, true);
  }
});
connectBtn.addEventListener("click", connect);
rememberPasswordEl.addEventListener("change", handleRememberPasswordToggle);
chartAggModeEl.addEventListener("change", refreshVisualsFromRows);
for (const btn of tabButtons) {
  btn.addEventListener("click", async () => {
    const tab = btn.dataset.tab;
    if (!tab || tab === state.activeTab) return;
    state.activeTab = tab;
    state.selectedVehicleKeys.clear();
    state.drillFilters.groupName = null;
    state.drillFilters.fuelType = null;
    state.drillFilters.bucket = null;
    updateTabUI();
    if (!state.connected) return;
    try {
      setStatus(`Cargando ${tabTitle(tab)}...`);
      await loadAndRender();
    } catch (err) {
      setStatus(err.message, true);
    }
  });
}
tableBody.addEventListener("change", (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (!t.classList.contains("vehicle-check")) return;
  const key = t.dataset.key || "";
  if (!key) return;
  if (t.checked) state.selectedVehicleKeys.add(key);
  else state.selectedVehicleKeys.delete(key);
  refreshVisualsFromRows();
});
tableHead.addEventListener("change", (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.id !== "selectAllVehicles") return;
  const vehicles = state.lastPivot?.vehicles || [];
  if (t.checked) {
    state.selectedVehicleKeys = new Set(vehicles.map((v) => v.key));
  } else {
    state.selectedVehicleKeys.clear();
  }
  refreshVisualsFromRows();
});
topVehiclesChartEl.addEventListener("click", (ev) => {
  const target = ev.target instanceof HTMLElement ? ev.target.closest(".top-row") : null;
  if (!target) return;
  const key = target.dataset.key || "";
  if (!key) return;
  state.selectedVehicleKeys = new Set([key]);
  refreshVisualsFromRows();
});
clearDrilldownBtn.addEventListener("click", () => {
  state.selectedVehicleKeys.clear();
  state.drillFilters.groupName = null;
  state.drillFilters.fuelType = null;
  state.drillFilters.bucket = null;
  refreshVisualsFromRows();
});
chartEl.addEventListener("click", (ev) => {
  const target = ev.target instanceof Element ? ev.target.closest("circle[data-bucket]") : null;
  if (!target) return;
  const bucket = target.getAttribute("data-bucket") ? decodeURIComponent(target.getAttribute("data-bucket")) : null;
  state.drillFilters.bucket = state.drillFilters.bucket === bucket ? null : bucket;
  refreshVisualsFromRows();
});
byGroupChartEl.addEventListener("click", (ev) => {
  const target = ev.target instanceof HTMLElement ? ev.target.closest("[data-group]") : null;
  if (!target) return;
  const group = target.dataset.group ? decodeURIComponent(target.dataset.group) : null;
  state.drillFilters.groupName = state.drillFilters.groupName === group ? null : group;
  refreshVisualsFromRows();
});
byFuelTypeChartEl.addEventListener("click", (ev) => {
  const target = ev.target instanceof HTMLElement ? ev.target.closest("[data-fuel]") : null;
  if (!target) return;
  const fuel = target.dataset.fuel ? decodeURIComponent(target.dataset.fuel) : null;
  state.drillFilters.fuelType = state.drillFilters.fuelType === fuel ? null : fuel;
  refreshVisualsFromRows();
});

loadConfig();
defaultDates();
toggleGroup();
updateTabUI();
