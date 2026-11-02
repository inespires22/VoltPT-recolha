"""Pipeline de ingestão de postos e estados (esqueleto de produção).

Arquitetura: Source adapters -> Raw landing (Blob, imutável) -> Normalize (modelo
canónico OCPI-like) -> Diff (content_hash + estados) -> Upsert core.* + eventos
-> Publish (Service Bus: 'evse.status.changed') -> consumidores (fila virtual,
push, agregados horários do DW).

Fontes por ordem de preferência:
  1. AFIR_NAP      — Ponto de Acesso Nacional (dados estáticos + dinâmicos exigidos
                     pelo Reg. (UE) 2023/1804; em PT agregados pela MOBI.E como EADME).
                     Implementado em sources/nap.py (DATEX II 3.3).
  2. OCPI_PARTNER  — ligação OCPI 2.2.1 direta com CPOs (quando houver parceria).
  3. MOBIE_PUBLIC  — endpoints JSON que alimentam o mapa público mobie.pt
                     (não oficial: descobrir via DevTools, respeitar ToS, rate-limit,
                     User-Agent identificado; pedir autorização formal à MOBI.E).
  4. OPENCHARGEMAP — fallback estático (licença CC-BY-SA: atribuição obrigatória).
  5. COMMUNITY     — check-ins dos utilizadores ("está livre", "potência real").
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Protocol

log = logging.getLogger("voltpt.ingest")

# Mapeamento de estados heterogéneos -> core.evse_status
STATUS_MAP = {
    "available": "AVAILABLE", "disponivel": "AVAILABLE", "disponível": "AVAILABLE", "livre": "AVAILABLE",
    "charging": "CHARGING", "occupied": "CHARGING", "em uso": "CHARGING", "ocupado": "CHARGING",
    "reserved": "RESERVED", "blocked": "BLOCKED",
    "outoforder": "OUTOFORDER", "out_of_order": "OUTOFORDER", "avariado": "OUTOFORDER", "faulted": "OUTOFORDER",
    "inoperative": "INOPERATIVE", "fora de serviço": "INOPERATIVE", "offline": "INOPERATIVE",
    "outofservice": "INOPERATIVE", "notavailable": "INOPERATIVE", "closed": "INOPERATIVE",
    "planned": "PLANNED", "removed": "REMOVED",
}
# Precedência quando fontes discordam (maior = mais confiável para ESTADO)
SOURCE_TRUST = {"OCPI_PARTNER": 5, "AFIR_NAP": 4, "MOBIE_PUBLIC": 3, "COMMUNITY": 2, "OPENCHARGEMAP": 1}
STALE_AFTER_S = 15 * 60   # estado sem atualização há >15 min -> UNKNOWN na UI


# ------------------------------------------------------------- modelo canónico
@dataclass
class ConnectorRec:
    ref: str
    standard: str          # IEC_62196_T2 | IEC_62196_T2_COMBO | CHADEMO ...
    power_type: str        # AC_3_PHASE | DC ...
    max_power_kw: float


@dataclass
class EvseRec:
    evse_uid: str
    status: str | None          # None = fonte sem estado em tempo real (ex.: OCM)
    status_ts: datetime | None
    connectors: list[ConnectorRec] = field(default_factory=list)


@dataclass
class LocationRec:
    source: str
    external_id: str
    operator_code: str | None
    name: str | None
    address: str | None
    municipality: str | None
    lat: float
    lon: float
    evses: list[EvseRec]
    raw: dict

    def static_hash(self) -> str:
        """Hash só dos atributos ESTÁTICOS -> evita reescrever a location a cada poll."""
        static = {
            "op": self.operator_code, "n": self.name, "a": self.address,
            "lat": round(self.lat, 6), "lon": round(self.lon, 6),
            "e": sorted((e.evse_uid, sorted((c.ref, c.standard, c.power_type, c.max_power_kw)
                                            for c in e.connectors)) for e in self.evses),
        }
        return hashlib.sha256(json.dumps(static, sort_keys=True, default=str).encode()).hexdigest()


    def to_batch_item(self) -> dict:
        """Formato aceite por core.ingest_batch (ver sql/02_funcoes.sql)."""
        return {
            "external_id": self.external_id, "operator_code": self.operator_code,
            "name": self.name, "address": self.address, "municipality": self.municipality,
            "lat": round(self.lat, 6), "lon": round(self.lon, 6), "static_hash": self.static_hash(),
            "evses": [{
                "evse_uid": e.evse_uid, "status": e.status,
                "status_ts": e.status_ts.isoformat() if e.status_ts else None,
                "connectors": [c.__dict__ for c in e.connectors],
            } for e in self.evses],
        }


def normalize_status(raw: str | None) -> str:
    return STATUS_MAP.get((raw or "").strip().lower(), "UNKNOWN")


# ------------------------------------------------------------- adapters
class SourceAdapter(Protocol):
    name: str
    def fetch(self) -> Iterable[dict]: ...           # payloads brutos
    def to_canonical(self, raw: dict) -> LocationRec: ...


class OcpiLocationsAdapter:
    """Serve AFIR_NAP e OCPI_PARTNER (ambos falam OCPI 2.2.1 /locations).
    Paginação via header Link; incremental com ?date_from=<último sync>."""
    def __init__(self, name: str, base_url: str, token: str, http):
        self.name, self.base_url, self.token, self.http = name, base_url, token, http

    def fetch(self) -> Iterable[dict]:
        url = f"{self.base_url}/locations?limit=500"
        while url:
            r = self.http.get(url, headers={"Authorization": f"Token {self.token}"}, timeout=30)
            r.raise_for_status()
            yield from r.json()["data"]
            url = r.links.get("next", {}).get("url")

    def to_canonical(self, raw: dict) -> LocationRec:
        c = raw["coordinates"]
        return LocationRec(
            source=self.name, external_id=raw["id"],
            operator_code=f'{raw.get("country_code")}-{raw.get("party_id")}',
            name=raw.get("name"), address=raw.get("address"), municipality=raw.get("city"),
            lat=float(c["latitude"]), lon=float(c["longitude"]),
            evses=[EvseRec(
                evse_uid=e["uid"], status=normalize_status(e.get("status")),
                status_ts=datetime.fromisoformat(e["last_updated"].replace("Z", "+00:00")),
                connectors=[ConnectorRec(
                    ref=k["id"], standard=k["standard"], power_type=k["power_type"],
                    max_power_kw=(k.get("max_electric_power") or k["max_voltage"] * k["max_amperage"]) / 1000,
                ) for k in e.get("connectors", [])],
            ) for e in raw.get("evses", [])],
            raw=raw,
        )


class MobiePublicMapAdapter:
    """Endpoints do mapa público (não oficial). O formato DEVE ser confirmado via
    DevTools; isolado aqui para que uma mudança no site só parta este adapter.
    Guardas: 1 pedido / 60-120 s, backoff exponencial, circuit breaker, alerta
    se o volume de postos cair >10% (sinal de mudança de formato)."""
    name = "MOBIE_PUBLIC"

    def __init__(self, url: str, http):
        self.url, self.http = url, http

    def fetch(self) -> Iterable[dict]:
        r = self.http.get(self.url, headers={"User-Agent": "VoltPT/0.1 (contacto@voltpt.app)"}, timeout=30)
        r.raise_for_status()
        yield from r.json()   # ajustar ao envelope real

    def to_canonical(self, raw: dict) -> LocationRec:
        raise NotImplementedError("Mapear campos após inspeção do payload real")


# ------------------------------------------------------------- diff de estados
@dataclass(frozen=True)
class StatusChange:
    evse_uid: str
    prev: str | None
    new: str
    observed_at: datetime
    source: str


def diff_statuses(current: dict[str, tuple[str, str]], incoming: list[LocationRec]) -> list[StatusChange]:
    """current: evse_uid -> (status, source). Só emite mudança se o estado mudou E a
    fonte que o reporta tem confiança >= à fonte que fixou o estado atual
    (ou o estado atual está obsoleto — tratado no job de staleness)."""
    changes: list[StatusChange] = []
    for loc in incoming:
        for e in loc.evses:
            prev = current.get(e.evse_uid)
            if prev and prev[0] == e.status:
                continue
            if prev and SOURCE_TRUST.get(loc.source, 0) < SOURCE_TRUST.get(prev[1], 0):
                continue
            changes.append(StatusChange(e.evse_uid, prev[0] if prev else None, e.status, e.status_ts, loc.source))
    return changes


# ------------------------------------------------------------- orquestração
def run_once(adapter: SourceAdapter, repo, bus, blob) -> dict:
    """Um ciclo de ingestão. Idempotente: pode ser re-executado sem duplicar."""
    run_id = repo.start_run(adapter.name)
    stats = {"in": 0, "upserted": 0, "changes": 0}
    try:
        raws = list(adapter.fetch())
        blob.put(f"raw/{adapter.name}/{datetime.now(timezone.utc):%Y/%m/%d/%H%M%S}.json", raws)
        recs = []
        for raw in raws:
            try:
                recs.append(adapter.to_canonical(raw))
            except (KeyError, ValueError, TypeError) as ex:      # registo mau não para o lote
                log.warning("skip %s: %s", adapter.name, ex)
        stats["in"] = len(recs)
        known = repo.location_hashes(adapter.name)           # external_id -> hash
        dirty = [r for r in recs if known.get(r.external_id) != r.static_hash()]
        stats["upserted"] = repo.upsert_locations(dirty)     # INSERT ... ON CONFLICT (source, external_id)
        repo.touch_last_seen(adapter.name, [r.external_id for r in recs])
        changes = diff_statuses(repo.current_statuses(), recs)
        repo.insert_status_events(changes, run_id)           # + UPDATE core.evses.current_status
        for ch in changes:
            bus.publish("evse.status.changed", ch.__dict__)  # -> fila virtual / push
        stats["changes"] = len(changes)
        repo.finish_run(run_id, stats)
    except Exception as ex:
        repo.finish_run(run_id, stats, error=repr(ex))
        raise
    return stats


if __name__ == "__main__":
    # Auto-verificação offline do diff com dados sintéticos
    t = datetime(2026, 10, 16, 22, 0, tzinfo=timezone.utc)
    loc = LocationRec("MOBIE_PUBLIC", "LSB-00123", "PT-EDP", "Posto X", None, "Lisboa", 38.72, -9.14,
                      [EvseRec("PT-EDP-ELSB-00123-1", normalize_status("Disponível"), t),
                       EvseRec("PT-EDP-ELSB-00123-2", normalize_status("ocupado"), t)], {})
    current = {"PT-EDP-ELSB-00123-1": ("CHARGING", "MOBIE_PUBLIC"),
               "PT-EDP-ELSB-00123-2": ("AVAILABLE", "OCPI_PARTNER")}   # fonte mais confiável
    out = diff_statuses(current, [loc])
    assert [(c.evse_uid, c.prev, c.new) for c in out] == [("PT-EDP-ELSB-00123-1", "CHARGING", "AVAILABLE")], out
    assert len(loc.static_hash()) == 64
    print("diff OK ->", out[0])
