import re
import json
import hashlib
from collections import defaultdict
from datetime import date
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urlunparse
from pathlib import Path
from typing import Dict, List, Optional

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

app = FastAPI(title="Data Connector View API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionInput(BaseModel):
    mygServer: str
    mygDatabase: str
    mygUser: str
    mygPassword: str
    dcBaseUrl: str


class QueryInput(ConnectionInput):
    metric: str = Field(pattern="^(distance|fuel)$")
    scope: str = Field(pattern="^(fleet|group)$")
    groupId: Optional[str] = None
    granularity: str = Field(pattern="^(daily|monthly)$")
    from_date: date = Field(alias="from")
    to_date: date = Field(alias="to")


METRIC_CANDIDATES = {
    "distance": ["GPS_Distance_Km", "Distance_Km"],
    "fuel": ["TotalFuel_Litres", "FuelUsed_Litres"],
}

TABLE_BY_GRANULARITY = {
    "daily": "VehicleKpi_Daily",
    "monthly": "VehicleKpi_Monthly",
}

DATE_COLUMN_BY_GRANULARITY = {
    "daily": "Local_Date",
    "monthly": "Local_MonthStartDate",
}

# In-memory cache foundation (single-process).
CACHE_TTL_SECONDS = 300
_CACHE: Dict[str, Dict] = {}


def _ensure(v: str, name: str):
    if not (v or "").strip():
        raise HTTPException(status_code=400, detail=f"Missing field: {name}")


def _myg_rpc(server: str, method: str, params: Dict) -> Dict:
    url = f"https://{server.strip()}/apiv1"
    try:
        res = requests.post(url, json={"method": method, "params": params}, timeout=40)
        res.raise_for_status()
        payload = res.json()
        if "error" in payload:
            raise HTTPException(status_code=502, detail=f"MyGeotab: {payload['error'].get('message', 'API error')}")
        return payload.get("result")
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"MyGeotab network error: {exc}") from exc


def _myg_credentials(inp: ConnectionInput) -> Dict:
    result = _myg_rpc(
        inp.mygServer,
        "Authenticate",
        {
            "database": inp.mygDatabase,
            "userName": inp.mygUser,
            "password": inp.mygPassword,
        },
    )
    credentials = result.get("credentials") if isinstance(result, dict) else result
    if not credentials:
        raise HTTPException(status_code=502, detail="MyGeotab authentication failed")
    return credentials


def _myg_groups(inp: ConnectionInput, credentials: Dict) -> List[Dict[str, str]]:
    result = _myg_rpc(
        inp.mygServer,
        "Get",
        {
            "typeName": "Group",
            "credentials": credentials,
        },
    )
    out: List[Dict[str, str]] = []
    for g in result or []:
        gid = g.get("id")
        name = g.get("name")
        if gid and name:
            out.append({"id": gid, "name": name})
    out.sort(key=lambda x: x["name"].lower())
    return out


def _myg_device_serials_by_group(credentials: Dict, server: str, group_id: str) -> List[str]:
    candidates = [
        {"groups": [{"id": group_id}]},
        {"groups": [group_id]},
        {"groups": [{"Id": group_id}]},
    ]

    for search in candidates:
        try:
            result = _myg_rpc(
                server,
                "Get",
                {
                    "typeName": "Device",
                    "credentials": credentials,
                    "search": search,
                },
            )
            serials = _normalize_serials([(d.get("serialNumber") or "").strip() for d in (result or []) if d.get("serialNumber")])
            if serials:
                return serials
        except HTTPException:
            continue
    return []


def _myg_device_name_map(credentials: Dict, server: str, serials: List[str]) -> Dict[str, str]:
    wanted = set(_normalize_serials(serials))
    if not wanted:
        return {}

    result = _myg_rpc(
        server,
        "Get",
        {
            "typeName": "Device",
            "credentials": credentials,
        },
    )

    out: Dict[str, str] = {}
    for d in result or []:
        serial = (d.get("serialNumber") or "").strip()
        if not serial or serial not in wanted:
            continue
        out[serial] = (d.get("name") or serial).strip()
    return out


def _myg_group_name_map(credentials: Dict, server: str) -> Dict[str, str]:
    result = _myg_rpc(
        server,
        "Get",
        {
            "typeName": "Group",
            "credentials": credentials,
        },
    )
    out: Dict[str, str] = {}
    for g in result or []:
        gid = g.get("id")
        name = g.get("name")
        if gid and name:
            out[str(gid)] = str(name).strip()
    return out


def _first_group_name_for_device(device: Dict, group_name_by_id: Dict[str, str]) -> str:
    groups = device.get("groups") or []
    # Prefer the first known non-company group to keep one stable grouping per vehicle.
    fallback: Optional[str] = None
    for g in groups:
        gid = str((g or {}).get("id") or (g or {}).get("Id") or "").strip()
        if not gid:
            continue
        name = (group_name_by_id.get(gid) or "").strip()
        if not name:
            continue
        if fallback is None:
            fallback = name
        if "company group" not in name.lower():
            return name
    return fallback or "Sin grupo"


def _myg_device_dimensions(credentials: Dict, server: str, serials: List[str]) -> Dict[str, Dict[str, str]]:
    wanted = set(_normalize_serials(serials))
    if not wanted:
        return {}

    group_name_by_id = _myg_group_name_map(credentials, server)
    result = _myg_rpc(
        server,
        "Get",
        {
            "typeName": "Device",
            "credentials": credentials,
        },
    )
    out: Dict[str, Dict[str, str]] = {}
    for d in result or []:
        serial = (d.get("serialNumber") or "").strip()
        if not serial or serial not in wanted:
            continue
        group_name = _first_group_name_for_device(d, group_name_by_id)
        out[serial] = {
            "group_name": group_name or "Sin grupo",
            # MyGeotab Device doesn't expose a stable fuel type for all tenants.
            "fuel_type": "Unknown",
        }
    return out


def _dc_device_serials_by_group(base_url: str, auth_header: str, group_id: str) -> List[str]:
    group_escaped = (group_id or "").replace("'", "''")
    table_candidates = ["DeviceGroups", "CurrentDeviceGroups"]
    group_col_candidates = ["GroupId", "GroupID", "Group"]
    serial_col_candidates = ["SerialNo", "SerialNumber", "DeviceSerialNo"]

    for table in table_candidates:
        for group_col in group_col_candidates:
            for serial_col in serial_col_candidates:
                try:
                    rows = _dc_query_with_fallback(
                        base_url,
                        auth_header,
                        table,
                        [group_col, serial_col],
                        f"{group_col} eq '{group_escaped}'",
                        None,
                    )
                    serials = _normalize_serials([(r.get(serial_col) or "").strip() for r in rows if r.get(serial_col)])
                    if serials:
                        return serials
                except HTTPException as exc:
                    detail = str(exc.detail)
                    # Keep probing known table/column combinations.
                    if exc.status_code == 502 and ("Invalid Parameter" in detail or "table" in detail.lower()):
                        continue
                    continue
    return []


def _dc_auth_header(database: str, user: str, password: str) -> str:
    import base64

    raw = f"{database}/{user}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _dc_fuel_type_map(
    base_url: str,
    auth_header: str,
    table: str,
    date_col: str,
    search_expr: str,
    allowed_serials: Optional[List[str]] = None,
) -> Dict[str, str]:
    candidates = ["FuelType", "EngineType"]
    fuel_rows: List[Dict] = []
    selected_col: Optional[str] = None
    for col in candidates:
        try:
            fuel_rows = _dc_query_with_fallback(
                base_url,
                auth_header,
                table,
                [date_col, "SerialNo", col],
                None,
                search_expr,
            )
            selected_col = col
            break
        except HTTPException as exc:
            detail = str(exc.detail)
            if exc.status_code == 502 and "Invalid Parameter" in detail:
                continue
            break
    if not selected_col:
        return {}

    allowed_set = set(_normalize_serials(allowed_serials or [])) if allowed_serials else None
    by_serial_counts: Dict[str, Dict[str, int]] = defaultdict(dict)
    for r in fuel_rows:
        serial = (r.get("SerialNo") or "").strip()
        if not serial:
            continue
        if allowed_set is not None and serial not in allowed_set:
            continue
        fuel = str(r.get(selected_col) or "").strip() or "Unknown"
        by_serial_counts.setdefault(serial, {})
        by_serial_counts[serial][fuel] = by_serial_counts[serial].get(fuel, 0) + 1

    out: Dict[str, str] = {}
    for serial, counts in by_serial_counts.items():
        best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))[0][0]
        out[serial] = best
    return out


def _dc_query(
    base_url: str,
    auth_header: str,
    table: str,
    select_cols: List[str],
    filter_expr: Optional[str],
    search_expr: Optional[str] = None,
) -> List[Dict]:
    base = base_url.strip().rstrip("/")
    parsed_base = urlparse(base)
    dc_host = parsed_base.netloc or base
    url = f"{base}/{table}"
    params = {
        "$select": ",".join(select_cols),
        "$top": "1000",
    }
    if filter_expr:
        params["$filter"] = filter_expr
    if search_expr:
        params["$search"] = search_expr

    out: List[Dict] = []
    headers = {"Accept": "application/json", "Authorization": auth_header}

    while url:
        try:
            res = requests.get(url, headers=headers, params=params, timeout=90)
            if not res.ok:
                body = (res.text or "")[:300]
                raise HTTPException(
                    status_code=502,
                    detail=f"Data Connector HTTP {res.status_code} on host {dc_host} for table {table}: {body}",
                )
            payload = res.json()
        except HTTPException:
            raise
        except requests.RequestException as exc:
            raise HTTPException(status_code=502, detail=f"Data Connector network error: {exc}") from exc

        out.extend(payload.get("value", []))
        url = payload.get("@odata.nextLink")
        params = None
        if len(out) >= 100000:
            break

    return out


def _dc_query_with_fallback(
    base_url: str,
    auth_header: str,
    table: str,
    select_cols: List[str],
    filter_expr: Optional[str],
    search_expr: Optional[str] = None,
) -> List[Dict]:
    candidates = _dc_candidate_base_urls(base_url)
    if not candidates:
        raise HTTPException(status_code=400, detail="Invalid Data Connector base URL")

    last_error: Optional[HTTPException] = None
    for idx, candidate in enumerate(candidates):
        try:
            return _dc_query(candidate, auth_header, table, select_cols, filter_expr, search_expr)
        except HTTPException as exc:
            last_error = exc
            detail = str(exc.detail)
            # Retry on 403 once using alternate known host.
            if exc.status_code == 502 and "HTTP 403" in detail and idx < len(candidates) - 1:
                continue
            raise

    raise last_error or HTTPException(status_code=502, detail=f"Data Connector failed for all hosts on table {table}")


def _dc_candidate_base_urls(base_url: str) -> List[str]:
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return []
    parsed = urlparse(base)
    host = parsed.netloc.lower()
    out = [base]

    if host == "odata-connector-1.geotab.com":
        alt = urlunparse((parsed.scheme, "data-connector.geotab.com", parsed.path, "", "", ""))
        if alt not in out:
            out.append(alt.rstrip("/"))
    elif host == "data-connector.geotab.com":
        alt = urlunparse((parsed.scheme, "odata-connector-1.geotab.com", parsed.path, "", "", ""))
        if alt not in out:
            out.append(alt.rstrip("/"))
    return out


def _serial_filter(serials: List[str]) -> str:
    escaped = [s.replace("'", "''") for s in serials]
    return "(" + " or ".join([f"SerialNo eq '{s}'" for s in escaped]) + ")"


def _chunk(values: List[str], n: int) -> List[List[str]]:
    return [values[i:i + n] for i in range(0, len(values), n)]


def _bucket(raw: str, granularity: str) -> str:
    if not raw:
        return ""
    return raw[:7] if granularity == "monthly" else raw[:10]


def _normalize_serials(serials: List[str]) -> List[str]:
    valid = []
    for s in serials:
        serial = (s or "").strip()
        if not serial:
            continue
        if serial == "000-000-0000":
            continue
        if not re.fullmatch(r"[A-Za-z0-9-]+", serial):
            continue
        valid.append(serial)
    return sorted(set(valid))


def _cache_key(prefix: str, payload: Dict) -> str:
    sanitized = dict(payload)
    if "mygPassword" in sanitized:
        raw = str(sanitized["mygPassword"]).encode("utf-8")
        sanitized["mygPassword"] = hashlib.sha256(raw).hexdigest()[:12]
    raw = json.dumps(sanitized, sort_keys=True, default=str)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"{prefix}:{digest}"


def _cache_get(key: str) -> Optional[Dict]:
    now = datetime.now(timezone.utc)
    hit = _CACHE.get(key)
    if not hit:
        return None
    if hit["expires_at"] < now:
        _CACHE.pop(key, None)
        return None
    return hit["value"]


def _cache_set(key: str, value: Dict, ttl_seconds: int = CACHE_TTL_SECONDS):
    now = datetime.now(timezone.utc)
    _CACHE[key] = {
        "value": value,
        "expires_at": now + timedelta(seconds=ttl_seconds),
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/connect")
def connect(inp: ConnectionInput):
    _ensure(inp.mygServer, "mygServer")
    _ensure(inp.mygDatabase, "mygDatabase")
    _ensure(inp.mygUser, "mygUser")
    _ensure(inp.mygPassword, "mygPassword")
    _ensure(inp.dcBaseUrl, "dcBaseUrl")

    key = _cache_key("connect", inp.model_dump())
    cached = _cache_get(key)
    if cached:
        return cached

    credentials = _myg_credentials(inp)
    groups = _myg_groups(inp, credentials)
    resp = {"status": "ok", "groups": groups}
    _cache_set(key, resp, ttl_seconds=600)
    return resp


def _run_query(inp: QueryInput) -> Dict:
    if inp.scope == "group" and not inp.groupId:
        raise HTTPException(status_code=400, detail="groupId required when scope=group")
    if inp.to_date < inp.from_date:
        raise HTTPException(status_code=400, detail="to must be >= from")

    credentials = _myg_credentials(inp)
    auth_header = _dc_auth_header(inp.mygDatabase, inp.mygUser, inp.mygPassword)

    allowed_serials: List[str] = []
    if inp.scope == "group":
        # First try Data Connector DeviceGroups mapping (planned v1 enhancement).
        allowed_serials = _dc_device_serials_by_group(inp.dcBaseUrl, auth_header, inp.groupId or "")
        # Fallback to MyGeotab group lookup if DC mapping is unavailable for this tenant.
        if not allowed_serials:
            allowed_serials = _myg_device_serials_by_group(credentials, inp.mygServer, inp.groupId or "")
        if not allowed_serials:
            return {"rows": [], "points": []}

    metric_candidates = METRIC_CANDIDATES[inp.metric]
    date_col = DATE_COLUMN_BY_GRANULARITY[inp.granularity]
    table = TABLE_BY_GRANULARITY[inp.granularity]

    # Data Connector supports date-range search pattern.
    search_expr = f"from_{inp.from_date.isoformat()}_to_{inp.to_date.isoformat()}"

    metric_rows: List[Dict] = []
    selected_metric_col: Optional[str] = None
    last_metric_error: Optional[Exception] = None
    for metric_col in metric_candidates:
        try:
            metric_rows = _dc_query_with_fallback(
                inp.dcBaseUrl,
                auth_header,
                table,
                [date_col, "SerialNo", metric_col],
                None,
                search_expr,
            )
            selected_metric_col = metric_col
            break
        except HTTPException as exc:
            last_metric_error = exc
            detail = str(exc.detail)
            if exc.status_code == 502 and "Invalid Parameter" in detail:
                continue
            raise

    if not selected_metric_col:
        if last_metric_error:
            raise last_metric_error
        raise HTTPException(status_code=502, detail=f"No valid metric column found for {inp.metric}")

    allowed_serial_set = set(_normalize_serials(allowed_serials)) if allowed_serials else None
    if allowed_serial_set is not None:
        metric_rows = [
            r for r in metric_rows
            if (r.get("SerialNo") or "").strip() in allowed_serial_set
        ]

    serial_set = _normalize_serials([(r.get("SerialNo") or "").strip() for r in metric_rows if r.get("SerialNo")])
    device_names = _myg_device_name_map(credentials, inp.mygServer, serial_set)
    device_dims = _myg_device_dimensions(credentials, inp.mygServer, serial_set)
    fuel_type_by_serial = _dc_fuel_type_map(
        inp.dcBaseUrl,
        auth_header,
        table,
        date_col,
        search_expr,
        serial_set,
    )

    rows: List[Dict] = []
    for r in metric_rows:
        serial = (r.get("SerialNo") or "").strip()
        if not serial:
            continue
        value = r.get(selected_metric_col)
        if value is None:
            continue
        bucket = _bucket(str(r.get(date_col) or ""), inp.granularity)
        if not bucket:
            continue
        rows.append(
            {
                "bucket": bucket,
                "device_name": device_names.get(serial, serial),
                "device_serial": serial,
                "group_name": (device_dims.get(serial) or {}).get("group_name", "Sin grupo"),
                "fuel_type": fuel_type_by_serial.get(
                    serial,
                    (device_dims.get(serial) or {}).get("fuel_type", "Unknown"),
                ),
                "value": float(value),
            }
        )

    rows.sort(key=lambda x: (x["bucket"], x["device_name"], x["device_serial"]))

    agg: Dict[str, float] = defaultdict(float)
    for r in rows:
        agg[r["bucket"]] += r["value"]
    points = [{"bucket": k, "value": round(v, 3)} for k, v in sorted(agg.items(), key=lambda x: x[0])]

    return {"rows": rows, "points": points}


@app.post("/api/query")
def query(inp: QueryInput):
    return _run_query(inp)


def _build_tab_payload(tab: str, metric: str, query_data: Dict, cache_hit: bool) -> Dict:
    rows = query_data.get("rows", [])
    points = query_data.get("points", [])
    serials = {r["device_serial"] for r in rows}
    total_value = sum(float(r.get("value") or 0) for r in rows)
    avg_per_vehicle = (total_value / len(serials)) if serials else 0.0

    return {
        "tab": tab,
        "metric": metric,
        "cache": {"hit": cache_hit, "ttl_seconds": CACHE_TTL_SECONDS},
        "kpis": {
            "vehicles_count": len(serials),
            "rows_count": len(rows),
            "total_value": round(total_value, 2),
            "avg_per_vehicle": round(avg_per_vehicle, 2),
        },
        "chart": {"points": points},
        "table": {"rows": rows},
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/tab/{tab_name}")
def query_tab(tab_name: str, inp: QueryInput):
    valid_tabs = {"main-data", "utilization", "fuel"}
    if tab_name not in valid_tabs:
        raise HTTPException(status_code=404, detail=f"Unknown tab '{tab_name}'")

    metric_by_tab = {
        "main-data": "distance",
        "utilization": "distance",
        "fuel": "fuel",
    }
    inp.metric = metric_by_tab.get(tab_name, inp.metric)

    payload_key = _cache_key(
        f"tab:{tab_name}",
        {
            **inp.model_dump(by_alias=True),
            "tab_name": tab_name,
            "metric": inp.metric,
        },
    )
    cached = _cache_get(payload_key)
    if cached:
        cached_resp = dict(cached)
        cached_resp["cache"] = dict(cached.get("cache") or {})
        cached_resp["cache"]["hit"] = True
        return cached_resp

    query_data = _run_query(inp)
    response = _build_tab_payload(tab_name, inp.metric, query_data, cache_hit=False)
    _cache_set(payload_key, response)
    return response


@app.get("/api/cache/stats")
def cache_stats():
    now = datetime.now(timezone.utc)
    active = 0
    expired = 0
    for v in _CACHE.values():
        if v["expires_at"] >= now:
            active += 1
        else:
            expired += 1
    return {"active": active, "expired": expired, "ttl_seconds": CACHE_TTL_SECONDS}


# Optional local static serving for dev/testing.
ADDIN_DIR = Path(__file__).resolve().parents[2] / "addin"
app.mount("/addin", StaticFiles(directory=str(ADDIN_DIR), html=True), name="addin")
