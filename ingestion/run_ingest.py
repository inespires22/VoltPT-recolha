"""Runner de ingestão para GitHub Actions (ou cron local).

Exemplos:
  python -m ingestion.run_ingest --source ocm                     # Open Charge Map, 1x/dia
  python -m ingestion.run_ingest --source nap-infra               # inventário oficial (NAP), 1x/dia
  python -m ingestion.run_ingest --source nap-status              # estados em tempo real, a cada 10 min
  python -m ingestion.run_ingest --source fixture --fixture f.json --dry-run --out batch.json

Variáveis de ambiente:
  DATABASE_URL   string de ligação do Supabase (Session pooler, porta 5432, ou
                 Transaction pooler, porta 6543). Guardar como secret no GitHub.
  OCM_API_KEY    chave do Open Charge Map
  NAP_INFRA_URL / NAP_STATUS_URL   opcionais: outros endereços do NAP (ver sources/nap.py)
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("voltpt.run")
CHUNK = 1500            # locations por chamada a core.ingest_batch
STATUS_CHUNK = 5000     # estados por chamada a core.ingest_status
MIN_STATUS_ROWS = 100   # menos do que isto = ficheiro truncado: não gravar nada
VOLUME_DROP_ABORT = 0.9  # abortar se vierem <90% dos postos vistos nos últimos 3 dias


def build_adapter(args, http):
    if args.source == "ocm":
        from .sources.ocm import OpenChargeMapAdapter
        return OpenChargeMapAdapter(http)
    if args.source == "fixture":
        from .sources.fixture import FixtureAdapter
        return FixtureAdapter(args.fixture, source=args.fixture_source)
    if args.source == "nap-infra":
        from .sources.nap import NapInfraAdapter
        return NapInfraAdapter(http)
    sys.exit(f"fonte desconhecida: {args.source}")


def canonicalize(adapter, raws: list[dict]) -> tuple[list[dict], int]:
    batch, skipped = [], 0
    for raw in raws:
        try:
            batch.append(adapter.to_canonical(raw).to_batch_item())
        except (KeyError, ValueError, TypeError) as ex:
            skipped += 1
            log.debug("registo ignorado: %s", ex)
    return batch, skipped


def save_raw(raws: list[dict], source: str, folder: str = "raw") -> Path:
    p = Path(folder) / f"{source}-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}.json.gz"
    p.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(raws, f)
    return p


def write_to_db(source: str, batch: list[dict], skip_watches: bool, http) -> dict:
    import psycopg                                   # pip install "psycopg[binary]"
    from psycopg.types.json import Jsonb

    totals = {"locations_upserted": 0, "evses_new": 0, "connectors_upserted": 0, "status_changes": 0}
    # prepare_threshold=None: compatível com o Transaction pooler do Supabase (pgbouncer)
    with psycopg.connect(os.environ["DATABASE_URL"], prepare_threshold=None) as conn:
        cur = conn.cursor()
        seen = cur.execute(
            "SELECT count(*) FROM core.locations WHERE source = %s AND last_seen_at > now() - interval '3 days'",
            (source,)).fetchone()[0]
        if seen > 100 and len(batch) < seen * VOLUME_DROP_ABORT:
            raise RuntimeError(f"volume caiu de {seen} para {len(batch)} postos: formato da fonte mudou?")
        run_id = cur.execute("INSERT INTO core.ingest_runs (source, records_in) VALUES (%s, %s) "
                             "RETURNING ingest_run_id", (source, len(batch))).fetchone()[0]
        conn.commit()
        try:
            for i in range(0, len(batch), CHUNK):
                r = cur.execute("SELECT core.ingest_batch(%s::core.data_source, %s, %s)",
                                (source, run_id, Jsonb(batch[i:i + CHUNK]))).fetchone()[0]
                conn.commit()
                for k in totals:
                    totals[k] += r[k]
            cur.execute("UPDATE core.ingest_runs SET finished_at = now(), records_upserted = %s, "
                        "status_changes = %s WHERE ingest_run_id = %s",
                        (totals["locations_upserted"], totals["status_changes"], run_id))
            conn.commit()
        except Exception as ex:
            conn.rollback()
            cur.execute("UPDATE core.ingest_runs SET finished_at = now(), error = %s WHERE ingest_run_id = %s",
                        (repr(ex)[:2000], run_id))
            conn.commit()
            raise

        if not skip_watches:
            totals["pushes"] = notify_watches(conn, http)
    return totals


def write_status_to_db(rows: list[dict], skip_watches: bool, http) -> dict:
    """Estados do NAP: um só pedido por bloco a core.ingest_status (só grava mudanças)."""
    import psycopg
    from psycopg.types.json import Jsonb

    if len(rows) < MIN_STATUS_ROWS:
        raise RuntimeError(f"só {len(rows)} estados no ficheiro: feed incompleto ou formato mudou?")
    totals = {"matched": 0, "status_changes": 0, "history_events": 0}
    with psycopg.connect(os.environ["DATABASE_URL"], prepare_threshold=None) as conn:
        cur = conn.cursor()
        run_id = cur.execute("INSERT INTO core.ingest_runs (source, records_in) VALUES ('AFIR_NAP', %s) "
                             "RETURNING ingest_run_id", (len(rows),)).fetchone()[0]
        conn.commit()
        try:
            for i in range(0, len(rows), STATUS_CHUNK):
                r = cur.execute("SELECT core.ingest_status(%s, %s)",
                                (run_id, Jsonb(rows[i:i + STATUS_CHUNK]))).fetchone()[0]
                conn.commit()
                for k in totals:
                    totals[k] += r[k]
            cur.execute("UPDATE core.ingest_runs SET finished_at = now(), status_changes = %s "
                        "WHERE ingest_run_id = %s", (totals["status_changes"], run_id))
            conn.commit()
        except Exception as ex:
            conn.rollback()
            cur.execute("UPDATE core.ingest_runs SET finished_at = now(), error = %s WHERE ingest_run_id = %s",
                        (repr(ex)[:2000], run_id))
            conn.commit()
            raise
        if not skip_watches:
            totals["pushes"] = notify_watches(conn, http)
    return totals


def notify_watches(conn, http) -> int:
    """Fila virtual: corre em todas as execuções (não só quando há mudanças),
    para que o 2.º da fila seja acordado quando a janela do 1.º expirar.
    Avisa pela app gratuita ntfy: o token guardado em core.push_tokens é o nome do tópico."""
    sent = 0
    cur = conn.cursor()
    watches = cur.execute("SELECT watch_id, user_id, location_name FROM core.claim_fired_watches(NULL)").fetchall()
    conn.commit()
    for _watch_id, user_id, name in watches:
        topics = cur.execute("SELECT token FROM core.push_tokens WHERE user_id = %s AND platform = 'ntfy'",
                             (user_id,)).fetchall()
        for (topic,) in topics:
            http.post(f"https://ntfy.sh/{topic}",
                      data=f"{name or 'O posto'} está disponível. Tens 3 min de prioridade.".encode(),
                      headers={"Title": "Posto livre".encode(), "Priority": "high"}, timeout=10)
            sent += 1
    return sent


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, choices=["ocm", "nap-infra", "nap-status", "fixture"])
    ap.add_argument("--fixture")
    ap.add_argument("--fixture-source", default="MANUAL")
    ap.add_argument("--dry-run", action="store_true", help="não escreve na BD")
    ap.add_argument("--out", help="gravar o lote canónico em JSON")
    ap.add_argument("--skip-watches", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    import requests
    http = requests.Session()
    if args.source == "nap-status":
        from .sources.nap import fetch_status
        rows, pub = fetch_status(http)
        log.info("NAP: %d estados, publicado em %s; exemplo de IDs: %s", len(rows), pub,
                 [r["uid"] for r in rows[:3]])
        if args.out:
            Path(args.out).write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        if args.dry_run:
            print(json.dumps({"source": "AFIR_NAP", "status_rows": len(rows), "published": pub}))
            return 0
        print(json.dumps({"source": "AFIR_NAP", "published": pub,
                          **write_status_to_db(rows, args.skip_watches, http)}))
        return 0
    adapter = build_adapter(args, http)
    raws = list(adapter.fetch())
    if args.source == "ocm":
        log.info("raw guardado em %s", save_raw(raws, adapter.name))
    batch, skipped = canonicalize(adapter, raws)
    log.info("%s: %d registos, %d normalizados, %d ignorados", adapter.name, len(raws), len(batch), skipped)
    if args.out:
        Path(args.out).write_text(json.dumps(batch, ensure_ascii=False), encoding="utf-8")
    if args.dry_run:
        print(json.dumps({"source": adapter.name, "locations": len(batch), "skipped": skipped}))
        return 0
    totals = write_to_db(adapter.name, batch, args.skip_watches, http)
    print(json.dumps({"source": adapter.name, **totals}))
    return 0


def safe_main() -> int:
    """Em repositórios públicos (PUBLIC_LOGS=1), os erros de ligação à BD não mostram
    servidor nem utilizador nos registos, que qualquer pessoa pode ler."""
    if os.environ.get("PUBLIC_LOGS") != "1":
        return main()
    try:
        return main()
    except Exception as ex:                     # noqa: BLE001
        if type(ex).__module__.startswith("psycopg"):
            print(f"erro na base de dados ({type(ex).__name__}); confirmar o secret DATABASE_URL",
                  file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(safe_main())
