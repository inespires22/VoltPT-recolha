/* VoltPT — simulador de custos no browser.
 * Réplica do motor backend/app/pricing/engine.py (mesma física e mesmas regras de tarifa),
 * para estimar qualquer posto sem grelha pré-calculada. Validado contra o motor em
 * tools/teste_calc (diferença máxima 0,01 €).
 */
(function (root) {
  "use strict";
  const DT_S = 10, MAX_S = 24 * 3600, EFF_DC = 0.95, EFF_AC = 0.90;

  // ---------- hora de Lisboa (offset em cache por hora UTC)
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const cacheOffset = new Map();
  function offsetMin(ms) {
    const k = Math.floor(ms / 3600000);
    let o = cacheOffset.get(k);
    if (o === undefined) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(k * 3600000)).map((x) => [x.type, x.value]));
      o = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - k * 3600000) / 60000);
      cacheOffset.set(k, o);
    }
    return o;
  }
  function lisboa(ms) {                       // {dia ISO 1..7, seg (segundos desde a meia-noite local)}
    const d = new Date(ms + offsetMin(ms) * 60000);
    return { dia: ((d.getUTCDay() + 6) % 7) + 1, seg: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
  }
  // instante UTC de "dia ISO d, hora h" na semana que começa na segunda-feira `segunda` (Lisboa)
  function inicioSemana(agora) {
    const l = lisboa(agora);
    const meiaNoite = agora - l.seg * 1000;
    return meiaNoite - (l.dia - 1) * 86400000;            // segunda 00:00 (aprox. em mudança de hora)
  }
  function instante(segunda, dia, hora) {
    let t = segunda + ((dia - 1) * 24 + hora) * 3600000;
    // corrige a mudança de hora: procura o instante cuja hora local é `hora`
    for (let i = 0; i < 2; i++) {
      const l = lisboa(t);
      const delta = hora * 3600 - l.seg;
      if (delta === 0 || Math.abs(delta) > 7200) break;
      t += delta * 1000;
    }
    return t;
  }

  // ---------- física (igual ao engine.simulate)
  function interp(curva, soc) {
    if (soc <= curva[0][0]) return curva[0][1];
    for (let i = 1; i < curva.length; i++) {
      const a = curva[i - 1], b = curva[i];
      if (soc <= b[0]) return a[1] + (soc - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
    }
    return curva[curva.length - 1][1];
  }
  function aceita(carro, dc, soc) {
    if (dc) return Math.min(carro.max_dc_kw, interp(carro.curva, soc));
    if (soc < 95) return carro.max_ac_kw;
    return Math.max(1.4, carro.max_ac_kw * (100 - soc) / 5);
  }
  function simular(carro, tomada, si, sa, t0) {
    const dc = tomada.tipo === "DC", eff = dc ? EFF_DC : EFF_AC;
    const cap = carro.bateria_kwh, kwPosto = tomada.kw_util;
    const passos = [];
    let soc = si, el = 0;
    while (soc < sa && el < MAX_S) {
      const p = Math.min(kwPosto, aceita(carro, dc, soc));
      let grid = p * DT_S / 3600, dsoc = grid * eff / cap * 100, dt = DT_S;
      if (soc + dsoc > sa) {
        const f = (sa - soc) / dsoc;
        grid *= f; dt = Math.max(1, Math.round(DT_S * f)); dsoc = sa - soc;
      }
      passos.push({ el, dt, grid, l: lisboa(t0 + el * 1000) });
      soc += dsoc; el += dt;
    }
    return passos;
  }

  // ---------- tarifas (igual ao engine.price_tariff)
  const hms = (s) => { if (s == null) return null; const [h, m, x] = String(s).split(":").map(Number); return h * 3600 + (m || 0) * 60 + (x || 0); };
  function prepara(tarifa) {
    return (tarifa.elements || []).map((e) => ({
      ini: hms(e.start_time), fim: hms(e.end_time), dias: e.day_of_week && e.day_of_week.length ? e.day_of_week : null,
      dmin: e.min_duration_s ?? null, dmax: e.max_duration_s ?? null,
      comp: (e.components || []).map((c) => ({ dim: c.dimension, preco: +c.price, passo: +(c.step_size || 1) })),
    }));
  }
  function serve(e, ps) {
    if (e.dias && !e.dias.includes(ps.l.dia)) return false;
    if (e.ini != null && e.fim != null) {
      const t = ps.l.seg;
      if (e.ini <= e.fim) { if (!(t >= e.ini && t < e.fim)) return false; }
      else if (!(t >= e.ini || t < e.fim)) return false;
    }
    if (e.dmin != null && ps.el < e.dmin) return false;
    if (e.dmax != null && ps.el >= e.dmax) return false;
    return true;
  }
  /** Devolve o custo SEM IVA da tarifa e a parte paga ao tempo (sem IVA). */
  function custoTarifa(els, passos, inclIva, iva) {
    const baldes = new Map();
    for (const dim of ["ENERGY", "TIME"]) {
      for (const ps of passos) {
        for (let ei = 0; ei < els.length; ei++) {
          const ci = els[ei].comp.findIndex((c) => c.dim === dim);
          if (ci < 0 || !serve(els[ei], ps)) continue;
          const k = ei + ":" + ci;
          baldes.set(k, (baldes.get(k) || 0) + (dim === "ENERGY" ? ps.grid * 1000 : ps.dt));
          break;
        }
      }
    }
    if (passos.length) {
      for (let ei = 0; ei < els.length; ei++) {
        const ci = els[ei].comp.findIndex((c) => c.dim === "FLAT");
        if (ci >= 0 && serve(els[ei], passos[0])) { baldes.set(ei + ":" + ci, 1); break; }
      }
    }
    const fator = inclIva ? 1 / (1 + iva / 100) : 1;
    let total = 0, tempo = 0;
    for (const [k, bruto] of baldes) {
      const [ei, ci] = k.split(":").map(Number), c = els[ei].comp[ci];
      const preco = Math.round(c.preco * fator * 1e5) / 1e5;
      let v;
      if (c.dim === "ENERGY") v = Math.ceil(Math.round(bruto * 1e6) / 1e6 / c.passo) * c.passo / 1000 * preco;
      else if (c.dim === "TIME") { v = Math.ceil(bruto / c.passo) * c.passo / 60 * preco; tempo += Math.round(v * 1e4) / 1e4; }
      else v = preco;
      total += Math.round(v * 1e4) / 1e4;
    }
    return { total, tempo };
  }

  /**
   * Estima uma carga.
   * p = {carro:{bateria_kwh,max_ac_kw,max_dc_kw,consumo,curva:[[soc,kW]]}, tomada:{tipo,kw_util},
   *      opc:{elements, prices_include_vat}, regime:"MOBIE"|"ADHOC", ceme:{elements}|null,
   *      taxas:{egme,iec,iva}, si, sa, inicio (ms)}
   */
  function estimar(p) {
    const passos = simular(p.carro, p.tomada, p.si, p.sa, p.inicio);
    const iva = p.taxas.iva, energia = passos.reduce((a, x) => a + x.grid, 0);
    const dur = passos.reduce((a, x) => a + x.dt, 0);
    const opc = custoTarifa(prepara(p.opc), passos, !!p.opc.prices_include_vat, iva);
    let sub = opc.total;
    if (p.regime !== "ADHOC" && p.ceme) {
      sub += custoTarifa(prepara(p.ceme), passos, !!p.ceme.prices_include_vat, iva).total;
      sub += p.taxas.egme + Math.round(Math.round(energia * 1e4) / 1e4 * p.taxas.iec * 1e4) / 1e4;
    }
    const vat = Math.round(sub * iva / 100 * 1e4) / 1e4;
    const total = Math.round((sub + vat) * 100) / 100;
    const eff = p.tomada.tipo === "DC" ? EFF_DC : EFF_AC;
    return { custo: total, dur_min: Math.round(dur / 6) / 10, kwh: Math.round(energia * 100) / 100,
             km: Math.round(energia * eff / p.carro.consumo * 100),
             tempo: Math.round(opc.tempo * (1 + iva / 100) * 100) / 100 };
  }

  /** Grelha da semana (168 linhas [dia, hora, custo, min, kWh, km, tempo]) a partir de agora. */
  function semana(p, agora) {
    const seg = inicioSemana(agora || Date.now()), linhas = [];
    for (let d = 1; d <= 7; d++) for (let h = 0; h < 24; h++) {
      const r = estimar(Object.assign({}, p, { inicio: instante(seg, d, h) }));
      linhas.push([d, h, r.custo, Math.round(r.dur_min), Math.round(r.kwh * 10) / 10, r.km, r.tempo]);
    }
    return linhas;
  }

  /** Tarifa OPC a partir dos preços do NAP (sem IVA). */
  function tarifaNap(pr) {
    const c = [];
    if (pr.sessao) c.push({ dimension: "FLAT", price: pr.sessao });
    if (pr.min) c.push({ dimension: "TIME", price: pr.min, step_size: 1 });
    if (pr.kwh) c.push({ dimension: "ENERGY", price: pr.kwh, step_size: 1 });
    return { elements: [{ components: c }], prices_include_vat: false };
  }

  root.VoltCalc = { estimar, semana, tarifaNap, lisboa, instante, inicioSemana };
})(typeof window !== "undefined" ? window : globalThis);
