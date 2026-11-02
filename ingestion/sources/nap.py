"""Ponto de Acesso Nacional (NAP Portugal, IMT) — dados da rede MOBI.E em DATEX II 3.3.

Duas fontes públicas, de livre acesso (citar a fonte), sem registo:
  * inventário (postos, tomadas, potências), ~200 MB, muda pouco -> 1x/dia
  * estado de cada tomada (livre, ocupada, avariada…), ~40 MB, republicado a cada 5 min

Os ficheiros são grandes: são descarregados para disco e lidos em streaming (iterparse),
sem nunca carregar o XML inteiro em memória. A leitura não depende de prefixos de namespace.
"""
from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Iterator

from lxml import etree

from ..pipeline import ConnectorRec, EvseRec, LocationRec, normalize_status

log = logging.getLogger("voltpt.nap")

INFRA_URL = os.environ.get("NAP_INFRA_URL", "https://pgm.mobie.pt/integration/nap/evChargingInfra")
STATUS_URL = os.environ.get("NAP_STATUS_URL", "https://pgm.mobie.pt/integration/nap/evActualStatus")
USER_AGENT = "VoltPT/0.2 (uso pessoal; github.com)"


# ------------------------------------------------------------- utilitários XML
def _ln(el) -> str | None:
    try:
        return etree.QName(el).localname
    except (ValueError, TypeError):
        return None                         # comentários, instruções de processamento


def _child(el, name):
    if el is None:
        return None
    return next((c for c in el if _ln(c) == name), None)


def _desc(el, name):
    if el is None:
        return None
    return next((d for d in el.iter() if d is not el and _ln(d) == name), None)


def _text(el) -> str | None:
    if el is None or el.text is None:
        return None
    return el.text.strip() or None


def _value(el) -> str | None:
    """Texto multilingue (values/value) ou texto simples."""
    if el is None:
        return None
    v = _desc(el, "value")
    return _text(v) if v is not None else _text(el)


def _num(s) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ------------------------------------------------------------- mapeamentos DATEX II -> VoltPT
def connector_standard(connector_type: str | None) -> str:
    t = (connector_type or "").lower()
    if "combo" in t or "ccs" in t:
        return "IEC_62196_T2_COMBO"
    if "chademo" in t:
        return "CHADEMO"
    if "t2" in t or "type2" in t:
        return "IEC_62196_T2"
    if "domestic" in t or "schuko" in t:
        return "DOMESTIC_F"
    if "tesla" in t:
        return "TESLA"
    return "OTHER"


def power_type(charging_mode: str | None, standard: str) -> str:
    m = (charging_mode or "").lower()
    if "dc" in m or standard in ("IEC_62196_T2_COMBO", "CHADEMO"):
        return "DC"
    if "1p" in m:
        return "AC_1_PHASE"
    return "AC_3_PHASE"


def max_power_kw(raw: float | None) -> float | None:
    """maxPowerAtSocket vem em W (ex.: 22000); alguns operadores enviam kW (ex.: 22)."""
    if raw is None or raw <= 0:
        return None
    return round(raw / 1000, 2) if raw > 1000 else round(raw, 2)


# ------------------------------------------------------------- inventário
def parse_infra(src) -> Iterator[LocationRec]:
    """Um LocationRec por local (energyInfrastructureSite); uma tomada (EVSE) por refillPoint."""
    for _, el in etree.iterparse(src, events=("end",), huge_tree=True):
        if _ln(el) != "energyInfrastructureSite":
            continue
        try:
            rec = _site(el)
            if rec is not None:
                yield rec
        except (ValueError, TypeError) as ex:
            log.debug("local ignorado %s: %s", el.get("id"), ex)
        el.clear(keep_tail=True)
        while el.getprevious() is not None:          # liberta irmãos já lidos
            del el.getparent()[0]


def _site(el) -> LocationRec | None:
    lat, lon = _num(_text(_desc(el, "latitude"))), _num(_text(_desc(el, "longitude")))
    if lat is None or lon is None:
        return None
    op = _child(el, "operator")
    evses = []
    for rp in (d for d in el.iter() if _ln(d) == "refillPoint"):
        uid = rp.get("id")
        if not uid:
            continue
        conns = []
        for i, c in enumerate((c for c in rp if _ln(c) == "connector"), start=1):
            std = connector_standard(_text(_child(c, "connectorType")))
            kw = max_power_kw(_num(_text(_child(c, "maxPowerAtSocket"))))
            if kw is None:
                continue
            conns.append(ConnectorRec(ref=str(i), standard=std,
                                      power_type=power_type(_text(_child(c, "chargingMode")), std),
                                      max_power_kw=kw))
        if conns:
            evses.append(EvseRec(evse_uid=uid, status=None, status_ts=None, connectors=conns))
    if not evses:
        return None
    addr = _desc(el, "addressLine")
    return LocationRec(
        source="AFIR_NAP", external_id=el.get("id"),
        operator_code=f"NAP-{op.get('id')}" if op is not None and op.get("id") else None,
        name=_value(_child(el, "name")),
        address=_value(_desc(addr, "text")) if addr is not None else None,
        municipality=_value(_desc(el, "city")),
        lat=lat, lon=lon, evses=evses,
        raw={"operator_name": _value(_child(op, "name")), "postcode": _text(_desc(el, "postcode"))},
    )


# ------------------------------------------------------------- estado
def parse_status(src) -> tuple[list[dict], str | None]:
    """Devolve ([{site, uid, status, ts}], publicationTime).

    status já no vocabulário da BD (AVAILABLE, CHARGING…); 'UNKNOWN' é omitido.
    ts = lastUpdated da tomada (quando o estado mudou), ou a hora de publicação.
    """
    rows, pub, site = [], None, None
    for _, el in etree.iterparse(src, events=("end",), huge_tree=True):
        name = _ln(el)
        if pub is None and name == "publicationTime":
            pub = _text(el)
            continue
        if name == "reference":
            par = el.getparent()
            if par is not None and _ln(par) == "energyInfrastructureSiteStatus":
                site = el.get("id")
            continue
        if name != "refillPointStatus":
            continue
        ref = _child(el, "reference")
        uid = ref.get("id") if ref is not None else el.get("id")
        st_el = _child(el, "status")
        status = normalize_status(_text(st_el if st_el is not None else _desc(el, "status")))
        ts = _ts(_text(_child(el, "lastUpdated"))) or _ts(pub)
        if uid and status != "UNKNOWN":
            rows.append({"site": site, "uid": uid, "status": status,
                         "ts": ts.isoformat() if ts else None})
        el.clear(keep_tail=True)
    return rows, pub


# ------------------------------------------------------------- descarga
def download(http, url: str, timeout: int = 180) -> str:
    """Descarrega para um ficheiro temporário (em streaming) e confirma que é XML."""
    fd, path = tempfile.mkstemp(suffix=".xml")
    with http.get(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"},
                  stream=True, timeout=timeout) as r, os.fdopen(fd, "wb") as f:
        r.raise_for_status()
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    with open(path, "rb") as f:
        head = f.read(200).lstrip()
    if not head.startswith(b"<"):
        os.unlink(path)
        raise RuntimeError(f"{url} não devolveu XML: {head[:80]!r}")
    log.info("descarregado %s (%.1f MB)", url, os.path.getsize(path) / 1e6)
    return path


class NapInfraAdapter:
    """Inventário de postos. fetch() devolve os LocationRec já canónicos."""
    name = "AFIR_NAP"

    def __init__(self, http, url: str = INFRA_URL):
        self.http, self.url = http, url

    def fetch(self) -> Iterator[LocationRec]:
        path = download(self.http, self.url, timeout=600)
        try:
            yield from parse_infra(path)
        finally:
            os.unlink(path)

    def to_canonical(self, raw: LocationRec) -> LocationRec:
        return raw


def fetch_status(http, url: str = STATUS_URL) -> tuple[list[dict], str | None]:
    path = download(http, url)
    try:
        return parse_status(path)
    finally:
        os.unlink(path)
