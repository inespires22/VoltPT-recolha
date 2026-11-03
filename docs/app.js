/* VoltPT — página do telemóvel. Fala com o Supabase só por HTTPS (login + funções voltpt_*). */
(function () {
  "use strict";
  const CFG = window.VOLTPT_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  const DIAS_LONGOS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

  // ------------------------------------------------------------------ armazenamento local
  const store = {
    get(k, d) { try { const v = localStorage.getItem("voltpt." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("voltpt." + k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
    del(k) { try { localStorage.removeItem("voltpt." + k); } catch { /* idem */ } },
  };

  // ------------------------------------------------------------------ formatos
  const nf = (d) => new Intl.NumberFormat("pt-PT", { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v) => v == null ? "—" : nf(2).format(v) + " €";
  const num = (v, d = 0) => v == null || isNaN(v) ? "—" : nf(d).format(v);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function haQuanto(iso) {
    if (!iso) return "";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "agora";
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.floor(h / 24);
    return d === 1 ? "há 1 dia" : `há ${d} dias`;
  }
  const dataCurta = (iso) => new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
  const horaCurta = (iso) => new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  const duracao = (min) => min == null ? "—" : `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, "0")}`;
  const estadoClasse = (e) => ["Livre", "Ocupado", "Avariado", "Reservado", "Bloqueado"].includes(e) ? e : "Sem";
  const estadoTexto = (e) => e === "Sem dados" || !e ? "Sem dados" : e;
  function toast(msg, ms = 2600) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  // ------------------------------------------------------------------ Supabase (login + funções)
  let sessao = store.get("sessao", null);

  async function login(email, password) {
    const r = await fetch(`${CFG.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: CFG.supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || "Não foi possível entrar");
    guardarSessao(j);
  }
  function guardarSessao(j) {
    sessao = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, email: j.user?.email || sessao?.email };
    store.set("sessao", sessao);
  }
  async function renovar() {
    if (!sessao?.refresh) throw new Error("sem sessão");
    const r = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: CFG.supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: sessao.refresh }),
    });
    if (!r.ok) { sair(); throw new Error("A sessão expirou. Entra outra vez."); }
    guardarSessao(await r.json());
  }
  async function rpc(fn, args = {}, tentou = false) {
    if (!sessao) throw new Error("sem sessão");
    if (Date.now() > sessao.exp - 60000) await renovar();
    const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: CFG.supabaseKey, Authorization: `Bearer ${sessao.access}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (r.status === 401 && !tentou) { await renovar(); return rpc(fn, args, true); }
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = j?.message || `Erro ${r.status}`;
      if (msg.includes("sem acesso")) throw new Error("Este e-mail não está autorizado (sql/06_app.sql).");
      throw new Error(msg);
    }
    return j;
  }
  function sair() {
    store.del("sessao"); sessao = null; dados = {};
    $("#app").hidden = true; $("#login").hidden = false;
  }

  // ------------------------------------------------------------------ estado da página
  let dados = {};            // inicio, historico
  let vista = store.get("vista", "inicio");

  function mostrar(v) {
    vista = v; store.set("vista", v);
    $$(".view").forEach((s) => (s.hidden = s.id !== "v-" + v));
    $$(".tabbar button").forEach((b) => b.setAttribute("aria-current", b.dataset.v === v ? "page" : "false"));
    document.body.classList.toggle("no-mapa", v !== "mapa");
    if (v === "mapa") abrirMapa();
    if (v === "calc") abrirCalc();
    if (v === "hist") abrirHist();
    if (v === "mais") abrirMais();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ início
  async function carregarInicio() {
    dados.inicio = await rpc("voltpt_inicio");
    desenharFrescura(); desenharInicio();
  }
  function desenharFrescura() {
    const i = dados.inicio; if (!i) return;
    const btn = $("#frescura");
    const min = i.dados_em ? (Date.now() - new Date(i.dados_em).getTime()) / 60000 : 999;
    btn.classList.toggle("velho", min > 25);
    $("#frescura-txt").textContent = i.dados_em ? `estado ${haQuanto(i.dados_em)}` : "sem dados";
  }
  function cartaoPosto(p) {
    const cls = estadoClasse(p.estado);
    const livres = p.tomadas ? `${p.livres ?? 0}/${p.tomadas} livres` : "";
    return `<button class="posto-card" data-posto="${esc(p.id)}">
      <span class="nome">${esc(p.posto)}</span>
      <span class="pill ${cls}">${esc(estadoTexto(p.estado))}</span>
      <span class="sub">${esc(livres)}${p.kw ? ` · ${num(p.kw)} kW ${esc(p.tipo || "")}` : ""}${p.desde ? ` · mudou ${haQuanto(p.desde)}` : ""}</span>
    </button>`;
  }
  function desenharInicio() {
    const i = dados.inicio;
    const mp = i.meus_postos || [];
    $("#meus-postos").innerHTML = mp.length ? mp.map(cartaoPosto).join("")
      : `<div class="vazio-msg">Ainda não há postos teus. Carrega as faturas para aparecerem aqui.</div>`;
    const alertas = (i.alertas || []).filter((a) => !a.disparado && new Date(a.expira) > new Date());
    $("#alertas-box").innerHTML = alertas.map((a) => `<div class="alerta"><span>🔔 À espera de <b>${esc(a.posto)}</b> até ${horaCurta(a.expira)}</span>
      <button class="btn" data-cancelar="${esc(a.id)}">Cancelar</button></div>`).join("");
    const m = i.mes || {};
    $("#mes").innerHTML = kpi(eur(m.custo), "gasto") + kpi(num(m.kwh, 1) + " kWh", "carregados") +
      kpi(num(m.carregamentos), "carregamentos") + kpi(m.kwh ? nf(3).format(m.custo / m.kwh) + " €" : "—", "por kWh");
    const semEstado = mp.length && mp.every((p) => p.estado === "Sem dados");
    $("#nota-estado").textContent = semEstado ? "Sem estado em tempo real: confirma que o workflow 'estado' está a correr." : "";
  }
  const kpi = (v, l, cls = "") => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;

  // ------------------------------------------------------------------ mapa
  let mapa, camada, filtros = store.get("filtros", {}), pedidoMapa = 0, ultimoMapa = [];
  const COR = () => {
    const cs = getComputedStyle(document.documentElement);
    return { Livre: cs.getPropertyValue("--livre").trim(), Ocupado: cs.getPropertyValue("--ocupado").trim(),
             Avariado: cs.getPropertyValue("--avariado").trim(), Sem: cs.getPropertyValue("--sem").trim(),
             borda: cs.getPropertyValue("--surface").trim(), meu: cs.getPropertyValue("--text").trim() };
  };
  function abrirMapa() {
    if (!mapa) {
      const escuro = matchMedia("(prefers-color-scheme: dark)").matches;
      const centro = store.get("mapa", { lat: 38.706, lon: -8.962, z: 14 });
      mapa = L.map("map", { zoomControl: false, attributionControl: true }).setView([centro.lat, centro.lon], centro.z);
      // OpenStreetMap: gratuito, sem chave (uso pessoal, com atribuição). No modo escuro, a página escurece-o.
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(mapa);
      document.getElementById("map").classList.toggle("escuro", escuro);
      camada = L.layerGroup().addTo(mapa);
      let t; mapa.on("moveend", () => {
        const c = mapa.getCenter(); store.set("mapa", { lat: c.lat, lon: c.lng, z: mapa.getZoom() });
        clearTimeout(t); t = setTimeout(carregarMapa, 350);
      });
      $$(".map-chips .chip").forEach((b) => {
        b.setAttribute("aria-pressed", filtros[b.dataset.f] ? "true" : "false");
        b.addEventListener("click", () => {
          filtros[b.dataset.f] = !filtros[b.dataset.f];
          if (b.dataset.f === "dc" && filtros.dc) filtros.ac = false;
          if (b.dataset.f === "ac" && filtros.ac) filtros.dc = false;
          store.set("filtros", filtros);
          $$(".map-chips .chip").forEach((x) => x.setAttribute("aria-pressed", filtros[x.dataset.f] ? "true" : "false"));
          desenharMapa();
        });
      });
      $("#btn-gps").addEventListener("click", () => {
        if (!navigator.geolocation) return toast("O browser não dá a localização.");
        navigator.geolocation.getCurrentPosition(
          (p) => { mapa.setView([p.coords.latitude, p.coords.longitude], 14); },
          () => toast("Sem acesso à localização."), { enableHighAccuracy: true, timeout: 10000 });
      });
    }
    setTimeout(() => { mapa.invalidateSize(); carregarMapa(); }, 50);
  }
  async function carregarMapa() {
    if (!mapa || vista !== "mapa") return;
    const aviso = $("#map-aviso");
    if (mapa.getZoom() < 9) { camada.clearLayers(); aviso.textContent = "Aproxima o mapa para ver os postos"; aviso.hidden = false; return; }
    const b = mapa.getBounds(), id = ++pedidoMapa;
    try {
      const r = await rpc("voltpt_postos", { p_min_lat: b.getSouth(), p_min_lon: b.getWest(), p_max_lat: b.getNorth(), p_max_lon: b.getEast() });
      if (id !== pedidoMapa) return;
      ultimoMapa = r.postos || [];
      aviso.hidden = !r.demasiado_grande && ultimoMapa.length < 1500;
      aviso.textContent = r.demasiado_grande ? "Aproxima o mapa para ver os postos" : "Há mais postos: aproxima para ver todos";
      desenharMapa();
    } catch (e) { toast(e.message); }
  }
  function desenharMapa() {
    if (!camada) return;
    camada.clearLayers();
    const cor = COR();
    // [id, nome, lat, lon, estado, livres, tomadas, kW, tipo, operador, tem_preco, meu]
    const lista = ultimoMapa.filter((p) =>
      (!filtros.livres || p[4] === "Livre") &&
      (!filtros.dc || /DC/.test(p[8]) && p[7] >= 40) &&
      (!filtros.ac || /AC/.test(p[8])) &&
      (!filtros.meus || p[11]));
    for (const p of lista.slice().reverse()) {
      const kw = p[7] || 0, raio = kw >= 150 ? 10 : kw >= 50 ? 8.5 : 7;
      const m = L.circleMarker([p[2], p[3]], {
        radius: p[11] ? raio + 2 : raio, weight: p[11] ? 3 : 1.5, color: p[11] ? cor.meu : cor.borda,
        fillColor: cor[estadoClasse(p[4])], fillOpacity: 0.95,
      });
      m.on("click", () => abrirPosto(p[0]));
      m.bindTooltip(`${esc(p[1])} · ${esc(estadoTexto(p[4]))}`, { direction: "top", offset: [0, -6] });
      camada.addLayer(m);
    }
  }

  // ------------------------------------------------------------------ detalhe do posto (folha)
  let postoAberto = null;
  async function abrirPosto(id) {
    postoAberto = id;
    $("#sheet-body").innerHTML = `<p class="nota">A carregar…</p>`;
    $("#sheet").hidden = false; $("#sheet-bg").hidden = false;
    try {
      const p = await rpc("voltpt_posto", { p_posto: id });
      if (postoAberto !== id || !p) return;
      desenharPosto(p);
    } catch (e) { $("#sheet-body").innerHTML = `<p class="erro">${esc(e.message)}</p>`; }
  }
  function fecharPosto() { $("#sheet").hidden = true; $("#sheet-bg").hidden = true; postoAberto = null; }
  function desenharPosto(p) {
    const cls = estadoClasse(p.estado);
    const tom = (p.tomadas || []).map((t) => `<div class="tomada">
        <div><div class="t1">${esc(t.tomada)} · ${num(t.kw_real || t.kw)} kW ${esc(t.tipo)}</div>
             <div class="t2">${esc(t.evse)}${t.desde ? " · mudou " + haQuanto(t.desde) : ""}</div></div>
        <span class="pill ${estadoClasse(t.estado)}">${esc(estadoTexto(t.estado))}</span></div>`).join("");
    const meus = p.os_meus && p.os_meus.n ? `<p class="nota">Já carregaste aqui ${p.os_meus.n}× · em média ${eur(p.os_meus.custo_medio)} · última ${dataCurta(p.os_meus.ultimo)}</p>` : "";
    const alerta = p.alerta && !p.alerta.disparado
      ? `<button class="btn full" data-cancelar="${esc(p.alerta.id)}">🔕 Cancelar aviso (até ${horaCurta(p.alerta.expira)})</button>`
      : `<button class="btn primary full" data-acao="avisar">🔔 Avisa-me quando ficar livre</button>`;
    const navegar = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
    $("#sheet-body").innerHTML = `
      <div class="linha-topo"><div><h3 id="s-nome">${esc(p.posto)}</h3>
        <p class="nota" style="margin:4px 0 0">${esc([p.operador, p.morada, p.municipio].filter(Boolean).join(" · "))}</p></div>
        <span class="pill ${cls}">${esc(estadoTexto(p.estado))}</span></div>
      <div class="tomadas">${tom || '<p class="nota">Sem tomadas registadas.</p>'}</div>
      ${meus}
      <div class="acoes">
        ${alerta}
        <a class="btn" href="${navegar}" target="_blank" rel="noopener">🧭 Ir para lá</a>
        ${p.com_grelha ? `<button class="btn" data-acao="calcular">💶 Quanto custa</button>` : `<button class="btn" disabled title="Sem preço conhecido">💶 Sem preço</button>`}
        <button class="btn full danger" data-acao="denunciar">🚫 Lugar ocupado por quem não carrega</button>
      </div>
      <div id="s-extra"></div>
      <h3 class="sec2" style="margin-top:18px">Costuma estar ocupado?</h3>
      ${grelhaOcupacao(p.ocupacao)}`;
    $("#sheet-body").dataset.id = p.id;
  }
  function grelhaOcupacao(oc) {
    if (!oc || !oc.length) return `<p class="nota">Ainda sem histórico neste posto (guarda-se num raio de 30 km do Montijo e nos teus postos; enche dia a dia).</p>`;
    const mapa = new Map(oc.map(([d, h, v]) => [d * 100 + h, v]));
    let html = `<div class="grelha"><span></span>${Array.from({ length: 24 }, (_, h) => `<span class="h">${h % 3 === 0 ? h : ""}</span>`).join("")}`;
    for (let d = 1; d <= 7; d++) {
      html += `<span class="d">${DIAS[d - 1]}</span>`;
      for (let h = 0; h < 24; h++) {
        const v = mapa.get(d * 100 + h);
        html += v == null ? `<span class="c vazio"></span>` : `<span class="c" style="background:${corEscala(v / 100)}" title="${DIAS[d - 1]} ${h}h: ${v}% ocupado"></span>`;
      }
    }
    return html + `</div><p class="nota">Verde = costuma estar livre; vermelho = costuma estar ocupado (últimos 14 dias).</p>`;
  }
  async function avisar(minutos) {
    const id = $("#sheet-body").dataset.id;
    try {
      const r = await rpc("voltpt_alerta_criar", { p_posto: id, p_minutos: minutos });
      toast(r.ntfy ? `Aviso ligado (${r.lugar}.º na fila).` : "Aviso ligado. Configura o ntfy em Mais para o receberes.", 3500);
      abrirPosto(id); carregarInicio().catch(() => {});
    } catch (e) { toast(e.message); }
  }
  async function cancelarAviso(id) {
    try { await rpc("voltpt_alerta_cancelar", { p_alerta: id }); toast("Aviso cancelado."); }
    catch (e) { toast(e.message); }
    if (postoAberto) abrirPosto(postoAberto);
    carregarInicio().catch(() => {});
  }
  async function denunciar(motivo) {
    const id = $("#sheet-body").dataset.id;
    try {
      const r = await rpc("voltpt_denunciar", { p_posto: id, p_motivo: motivo });
      const semEmail = !r.email_link || r.email_link.startsWith("mailto:?");
      $("#s-extra").innerHTML = `<p class="nota">Denúncia registada${r.autoridade ? " para " + esc(r.autoridade) : ""}.
        ${semEmail ? "Não há e-mail da autoridade deste município: o e-mail abre sem destinatário." : ""}</p>
        <a class="btn primary" href="${esc(r.email_link)}">✉️ Abrir e-mail já escrito</a>`;
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------------ calculadora
  let calc = store.get("calc", {}), grelha = null;
  function abrirCalc() {
    const i = dados.inicio; if (!i) return;
    const sel = $("#c-posto");
    const postos = i.postos_com_preco || [];
    if (!postos.length) {
      $("#c-res").innerHTML = `<div class="vazio-msg">Ainda não há grelha de custos. Corre o workflow "cost-grid" no GitHub.</div>`;
      return;
    }
    sel.innerHTML = postos.map((p) => `<option value="${esc(p.id)}">${esc(p.posto)}</option>`).join("");
    if (!postos.some((p) => p.id === calc.posto)) calc.posto = postos[0].id;
    sel.value = calc.posto;
    $("#c-dia").innerHTML = DIAS_LONGOS.map((d, k) => `<option value="${k + 1}">${d[0].toUpperCase() + d.slice(1)}</option>`).join("");
    $("#c-hora").innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}h</option>`).join("");
    const agora = new Date();
    if (!calc.dia) { calc.dia = ((agora.getDay() + 6) % 7) + 1; calc.hora = agora.getHours(); }
    $("#c-dia").value = calc.dia; $("#c-hora").value = calc.hora;
    carregarGrelha();
  }
  async function carregarGrelha() {
    try {
      grelha = await rpc("voltpt_custos", { p_posto: calc.posto, p_soc_inicio: calc.si ?? null, p_soc_alvo: calc.sa ?? null });
      calc.si = grelha.soc_inicio; calc.sa = grelha.soc_alvo; store.set("calc", calc);
      const pares = (grelha.pares || []).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      $("#c-socs").innerHTML = pares.map(([a, b]) =>
        `<button class="chip" data-soc="${a}-${b}" aria-pressed="${a === calc.si && b === calc.sa}">${a}→${b}%</button>`).join("");
      desenharCalc();
    } catch (e) { toast(e.message); }
  }
  function desenharCalc() {
    const linhas = grelha?.linhas || [];
    if (!linhas.length) { $("#c-res").innerHTML = `<div class="vazio-msg">Sem custos para este posto.</div>`; $("#c-grelha").innerHTML = ""; $("#c-melhor").innerHTML = ""; return; }
    const por = new Map(linhas.map((l) => [l[0] * 100 + l[1], l]));
    const l = por.get(calc.dia * 100 + calc.hora);
    const custos = linhas.map((x) => x[2]), min = Math.min(...custos), max = Math.max(...custos);
    $("#c-res").innerHTML = l ? `
      <div class="muted" style="font-size:13px">${DIAS_LONGOS[calc.dia - 1]} às ${String(calc.hora).padStart(2, "0")}h · ${calc.si}% → ${calc.sa}%</div>
      <div class="grande">${eur(l[2])}</div>
      <div class="det"><div>Duração<b>${duracao(l[3])}</b></div><div>Energia<b>${num(l[4], 1)} kWh</b></div>
        <div>Autonomia ganha<b>${num(l[5])} km</b></div><div>Pago ao minuto<b>${eur(l[6])}</b></div>
        <div>Por kWh<b>${l[4] ? nf(3).format(l[2] / l[4]) + " €" : "—"}</b></div><div>Por 100 km<b>${l[5] ? eur(l[2] / l[5] * 100) : "—"}</b></div></div>`
      : `<div class="vazio-msg">Sem valor para essa hora.</div>`;
    // melhor hora a partir de agora (próxima ocorrência da hora mais barata)
    const agora = new Date(); let melhor = null;
    for (let k = 0; k < 168; k++) {
      const t = new Date(agora.getTime() + k * 3600000), d = ((t.getDay() + 6) % 7) + 1, h = t.getHours();
      const x = por.get(d * 100 + h);
      if (x && x[2] <= min + 0.005) { melhor = { k, d, h, x }; break; }
    }
    if (melhor && l) {
      const quando = melhor.k === 0 ? "agora" : melhor.k < 24 && melhor.d === ((agora.getDay() + 6) % 7) + 1 ? `hoje às ${String(melhor.h).padStart(2, "0")}h`
        : melhor.k < 48 && melhor.d === ((agora.getDay() + 7) % 7) + 1 ? `amanhã às ${String(melhor.h).padStart(2, "0")}h`
        : `${DIAS_LONGOS[melhor.d - 1]} às ${String(melhor.h).padStart(2, "0")}h`;
      const poup = l[2] - min;
      $("#c-melhor").innerHTML = poup > 0.004
        ? `Mais barato: <b>${quando}</b>, ${eur(min)} — poupas <b>${eur(poup)}</b>.`
        : `✓ Esta já é das horas mais baratas (${eur(min)}). Próxima: ${quando}.`;
    } else $("#c-melhor").innerHTML = "";
    let html = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="h">${h % 3 === 0 ? h : ""}</span>`).join("")}`;
    for (let d = 1; d <= 7; d++) {
      html += `<span class="d">${DIAS[d - 1]}</span>`;
      for (let h = 0; h < 24; h++) {
        const x = por.get(d * 100 + h);
        if (!x) { html += `<span class="c vazio"></span>`; continue; }
        const f = max > min ? (x[2] - min) / (max - min) : 0;
        html += `<button class="c${d === calc.dia && h === calc.hora ? " sel" : ""}" data-dh="${d}-${h}" style="background:${corEscala(f)}" aria-label="${DIAS[d - 1]} ${h}h: ${eur(x[2])}"></button>`;
      }
    }
    $("#c-grelha").innerHTML = html;
    $("#c-nota").textContent = `Verde ${eur(min)} · vermelho ${eur(max)}. Calculado ${grelha.regime === "ADHOC" ? "com o preço único do posto" : "com a tarifa do operador + MyAtlante"}${dados.inicio?.grelha_em ? ", atualizado " + haQuanto(dados.inicio.grelha_em) : ""}.`;
  }
  function corEscala(f) {
    const cs = getComputedStyle(document.documentElement);
    const cores = ["--g0", "--g1", "--g2", "--g3", "--g4"].map((v) => cs.getPropertyValue(v).trim());
    return cores[Math.min(4, Math.max(0, Math.round(f * 4)))];
  }

  // ------------------------------------------------------------------ histórico
  const PAR_DEF = { consumo: 6.5, preco: 1.70, co2: 2.31, rede: 0 };
  let par = Object.assign({}, PAR_DEF, store.get("param", {}));
  async function abrirHist() {
    for (const k of Object.keys(PAR_DEF)) $("#p-" + k).value = par[k];
    try { dados.hist = await rpc("voltpt_historico"); desenharHist(); } catch (e) { toast(e.message); }
  }
  function desenharHist() {
    const h = dados.hist; if (!h) return;
    const t = h.totais || {};
    const combustao = (t.km || 0) / 100 * par.consumo * par.preco;
    const co2 = (t.km || 0) / 100 * par.consumo * par.co2 - (t.kwh || 0) * par.rede;
    $("#h-kpis").innerHTML =
      kpi(eur(t.custo), `${num(t.carregamentos)} carregamentos`) + kpi(num(t.kwh, 1) + " kWh", `≈ ${num(t.km)} km`) +
      kpi(t.kwh ? nf(3).format(t.custo / t.kwh) + " €" : "—", "por kWh") + kpi(t.km ? eur(t.custo / t.km * 100) : "—", "por 100 km") +
      kpi(eur(combustao - (t.custo || 0)), "poupado vs combustão", "destaque") + kpi(num(co2) + " kg", "CO2 evitado", "destaque") +
      kpi(t.custo ? num(100 * (t.tempo || 0) / t.custo) + " %" : "—", "pago ao minuto") +
      kpi(eur((t.tar_fora_vazio || 0) * 0.78), "poupavas só em vazio");
    const meses = h.meses || [];
    $("#h-meses").innerHTML = meses.length ? meses.slice().reverse().map((m) => {
      const tot = (m.fixo + m.tempo + m.energia + m.taxas) || 1;
      const seg = (v, c) => `<i class="${c}" style="width:${(100 * v / tot).toFixed(1)}%"></i>`;
      const [a, mm] = m.mes.split("-");
      const nome = new Date(+a, +mm - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
      return `<div class="mes"><div class="topo"><span>${esc(nome)}</span><span>${eur(m.custo)}</span></div>
        <div class="barra">${seg(m.fixo, "c-fixo")}${seg(m.tempo, "c-tempo")}${seg(m.energia, "c-energia")}${seg(m.taxas, "c-taxas")}</div>
        <div class="leg"><span><i class="c-energia"></i>Energia+TAR ${eur(m.energia)}</span><span><i class="c-tempo"></i>Minutos ${eur(m.tempo)}</span>
        <span><i class="c-fixo"></i>Ativação ${eur(m.fixo)}</span><span><i class="c-taxas"></i>Taxas ${eur(m.taxas)}</span></div>
        <div class="nota" style="margin:6px 0 0">${num(m.n)} carregamentos · ${num(m.kwh, 1)} kWh · ≈ ${num(m.km)} km</div></div>`;
    }).join("") : `<div class="vazio-msg">Ainda sem carregamentos.</div>`;
    $("#h-lista").innerHTML = (h.carregamentos || []).map((c) => `<div class="sessao">
        <div class="s1">${esc(c.posto)}${c.so_vazio ? '<span class="tag">vazio</span>' : ""}${c.tipo === "DC" ? '<span class="tag">DC</span>' : ""}</div>
        <div class="s3">${eur(c.custo)}</div>
        <div class="s2">${dataCurta(c.inicio)} ${horaCurta(c.inicio)} · ${num(c.kwh, 1)} kWh · ${duracao(c.min)} · ≈ ${num(c.km)} km</div>
        <div class="s2" style="text-align:right">${c.kwh ? nf(3).format(c.custo / c.kwh) + " €/kWh" : ""}</div></div>`).join("");
  }

  // ------------------------------------------------------------------ mais: viagem, ntfy, conta
  function abrirMais() {
    calcularViagem();
    const i = dados.inicio || {};
    $("#ntfy-topico").value = i.ntfy || store.get("ntfy_rascunho", "");
    atualizarLinkNtfy();
    $("#conta-info").textContent = sessao?.email ? `Entraste como ${sessao.email}.` : "";
  }
  function calcularViagem() {
    const c = dados.inicio?.carro || { bateria_kwh: 65, consumo: 19 };
    const dist = +$("#v-dist").value || 0, soc = +$("#v-soc").value || 0, kw = +$("#v-kw").value || 1, preco = +$("#v-preco").value || 0;
    const energia = dist * c.consumo / 100;
    const disponivel = c.bateria_kwh * Math.max(0, soc - 10) / 100;
    const carregar = Math.max(0, energia - disponivel);
    const paragens = Math.ceil(carregar / (c.bateria_kwh * 0.7));
    const minutos = carregar / 0.95 / kw * 60;
    $("#v-res").innerHTML = kpi(num(energia, 1) + " kWh", "a viagem gasta") + kpi(num(paragens), paragens === 1 ? "paragem" : "paragens") +
      kpi(carregar ? duracao(minutos) : "0h00", "a carregar") + kpi(eur(carregar / 0.95 * preco), "custo das paragens");
  }
  function atualizarLinkNtfy() {
    const t = $("#ntfy-topico").value.trim();
    const a = $("#ntfy-abrir");
    if (t) { a.href = `https://ntfy.sh/${encodeURIComponent(t)}`; a.removeAttribute("aria-disabled"); }
    else { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); }
  }
  function gerarTopico() {
    const a = new Uint8Array(9); crypto.getRandomValues(a);
    return "voltpt-" + Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  }

  function mensagemLogin(m) {
    if (/api key|apikey|jwt/i.test(m)) return "A chave pública no config.js está errada ou incompleta (" + m + ").";
    if (/secret/i.test(m)) return "No config.js está a chave secreta: usa a Publishable key.";
    if (/invalid login credentials/i.test(m)) return "E-mail ou password errados.";
    if (/not confirmed/i.test(m)) return "Esta conta ainda não está confirmada no Supabase (Users → a conta → Confirm).";
    if (/failed to fetch|networkerror|load failed/i.test(m)) return "Sem ligação ao Supabase: confirma o endereço no config.js e a internet.";
    return m;
  }

  // ------------------------------------------------------------------ eventos
  function ligarEventos() {
    $("#login-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = ev.submitter || $("#login-form button"); btn.disabled = true; $("#login-erro").textContent = "";
      try {
        await login($("#login-email").value.trim(), $("#login-pass").value);
        await arrancar();
      } catch (e) {
        $("#login-erro").textContent = mensagemLogin(e.message);
      } finally { btn.disabled = false; }
    });
    $$(".tabbar button").forEach((b) => b.addEventListener("click", () => { fecharPosto(); mostrar(b.dataset.v); }));
    $("#frescura").addEventListener("click", () => atualizarTudo(true));
    $("#sheet-bg").addEventListener("click", fecharPosto);
    $("#sheet-fechar").addEventListener("click", fecharPosto);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPosto(); });
    document.addEventListener("click", (e) => {
      const card = e.target.closest("[data-posto]"); if (card) return abrirPosto(card.dataset.posto);
      const canc = e.target.closest("[data-cancelar]"); if (canc) return cancelarAviso(canc.dataset.cancelar);
      const ac = e.target.closest("[data-acao]"); if (!ac) return;
      if (ac.dataset.acao === "avisar") {
        $("#s-extra").innerHTML = `<p class="nota">Durante quanto tempo?</p><div class="escolha">
          ${[30, 60, 120, 240].map((m) => `<button class="btn" data-acao="avisar-${m}">${m < 60 ? m + " min" : m / 60 + " h"}</button>`).join("")}</div>`;
      } else if (ac.dataset.acao.startsWith("avisar-")) avisar(+ac.dataset.acao.slice(7));
      else if (ac.dataset.acao === "calcular") { calc.posto = $("#sheet-body").dataset.id; calc.si = calc.sa = undefined; store.set("calc", calc); fecharPosto(); mostrar("calc"); }
      else if (ac.dataset.acao === "denunciar") {
        $("#s-extra").innerHTML = `<p class="nota">O que se passa?</p><div class="escolha">
          <button class="btn" data-acao="den-ICE_PARKED">Carro a combustão</button>
          <button class="btn" data-acao="den-EV_NOT_CHARGING">Elétrico sem carregar</button>
          <button class="btn" data-acao="den-BLOCKED_ACCESS">Acesso bloqueado</button></div>`;
      } else if (ac.dataset.acao.startsWith("den-")) denunciar(ac.dataset.acao.slice(4));
    });
    // calculadora
    $("#c-posto").addEventListener("change", (e) => { calc.posto = e.target.value; calc.si = calc.sa = undefined; carregarGrelha(); });
    $("#c-dia").addEventListener("change", (e) => { calc.dia = +e.target.value; store.set("calc", calc); desenharCalc(); });
    $("#c-hora").addEventListener("change", (e) => { calc.hora = +e.target.value; store.set("calc", calc); desenharCalc(); });
    $("#c-socs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-soc]"); if (!b) return;
      [calc.si, calc.sa] = b.dataset.soc.split("-").map(Number); carregarGrelha();
    });
    $("#c-grelha").addEventListener("click", (e) => {
      const b = e.target.closest("[data-dh]"); if (!b) return;
      [calc.dia, calc.hora] = b.dataset.dh.split("-").map(Number);
      $("#c-dia").value = calc.dia; $("#c-hora").value = calc.hora; store.set("calc", calc); desenharCalc();
    });
    // histórico
    for (const k of Object.keys(PAR_DEF)) $("#p-" + k).addEventListener("input", (e) => {
      const v = parseFloat(String(e.target.value).replace(",", ".")); if (isNaN(v)) return;
      par[k] = v; store.set("param", par); desenharHist();
    });
    // viagem
    ["#v-dist", "#v-soc", "#v-kw", "#v-preco"].forEach((s) => $(s).addEventListener("input", calcularViagem));
    // ntfy
    $("#ntfy-topico").addEventListener("input", () => { store.set("ntfy_rascunho", $("#ntfy-topico").value.trim()); atualizarLinkNtfy(); });
    $("#ntfy-gerar").addEventListener("click", () => { $("#ntfy-topico").value = gerarTopico(); store.set("ntfy_rascunho", $("#ntfy-topico").value); atualizarLinkNtfy(); });
    $("#ntfy-gravar").addEventListener("click", async () => {
      try {
        await rpc("voltpt_ntfy", { p_topico: $("#ntfy-topico").value.trim() });
        $("#ntfy-msg").textContent = "Gravado. Na app ntfy, carrega em + e subscreve este mesmo tópico.";
        carregarInicio().catch(() => {});
      } catch (e) { $("#ntfy-msg").textContent = e.message; }
    });
    $("#btn-sair").addEventListener("click", sair);
    // voltar à página: atualiza
    document.addEventListener("visibilitychange", () => { if (!document.hidden && sessao) atualizarTudo(false); });
  }

  let ultimaAtualizacao = 0;
  async function atualizarTudo(forcar) {
    if (!forcar && Date.now() - ultimaAtualizacao < 60000) return;
    ultimaAtualizacao = Date.now();
    try {
      await carregarInicio();
      if (vista === "mapa") carregarMapa();
      if (vista === "hist") abrirHist();
      if (postoAberto) abrirPosto(postoAberto);
      if (forcar) toast("Atualizado.");
    } catch (e) { toast(e.message); }
  }

  async function arrancar() {
    $("#login").hidden = true; $("#app").hidden = false;
    try { await carregarInicio(); ultimaAtualizacao = Date.now(); }
    catch (e) { if (!sessao) return; toast(e.message, 5000); }
    mostrar(vista);
    clearInterval(arrancar._i);
    arrancar._i = setInterval(() => { if (!document.hidden && sessao) atualizarTudo(false); }, 120000);
  }

  ligarEventos();
  if (!CFG.supabaseKey || CFG.supabaseKey.startsWith("COLA_")) {
    $("#login").hidden = false;
    $("#login-erro").textContent = "Falta a chave pública do Supabase no config.js.";
  } else if (sessao) arrancar();
  else $("#login").hidden = false;
})();
