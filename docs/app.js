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
    store.del("sessao"); store.del("cache"); sessao = null; dados = {};
    $("#app").hidden = true; $("#login").hidden = false;
  }

  // ------------------------------------------------------------------ estado da página
  let dados = {};            // inicio, historico
  let vista = store.get("vista", "inicio");
  if (!["inicio", "mapa", "viagem", "hist", "mais"].includes(vista)) vista = "inicio";

  function mostrar(v) {
    vista = v; store.set("vista", v);
    $$(".view").forEach((s) => (s.hidden = s.id !== "v-" + v));
    $$(".tabbar button").forEach((b) => b.setAttribute("aria-current", b.dataset.v === v ? "page" : "false"));
    document.body.classList.toggle("no-mapa", v !== "mapa");
    if (v === "mapa") abrirMapa();
    if (v === "hist") abrirHist();
    if (v === "viagem") abrirViagem();
    if (v === "mais") abrirMais();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ início
  // Os últimos dados ficam guardados no telemóvel: a página abre logo com eles e atualiza a seguir.
  const guardarCache = () => store.set("cache", { inicio: dados.inicio || null, hist: dados.hist || null });
  let histEm = 0;
  function carregarHistorico() {
    return rpc("voltpt_historico").then((h) => {
      dados.hist = h; histEm = Date.now(); guardarCache();
      if (dados.inicio) desenharInicio();
      if (vista === "hist") desenharHist();
    });
  }
  async function carregarInicio() {
    const h = carregarHistorico().catch(() => {});      // em paralelo; não atrasa o Início
    dados.inicio = await rpc("voltpt_inicio"); guardarCache();
    desenharFrescura(); desenharInicio();
    return h;
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
    const livres = p.tomadas ? `${p.livres ?? 0} de ${p.tomadas} livre${(p.livres ?? 0) === 1 ? "" : "s"}` : "";
    return `<button class="posto-card pc-${cls}" data-posto="${esc(p.id)}">
      <span class="ic-posto" aria-hidden="true">⚡</span>
      <span class="corpo"><span class="nome">${esc(p.posto)}</span>
      <span class="sub">${p.kw ? `${num(p.kw)} kW ${esc(p.tipo || "")}` : ""}${p.desde ? ` · mudou ${haQuanto(p.desde)}` : ""}</span></span>
      <span class="lado"><span class="pill ${cls}">${esc(estadoTexto(p.estado))}</span>
      <span class="livres">${esc(livres)}</span></span>
    </button>`;
  }
  // totais de um conjunto de carregamentos (o Início e o Histórico contam da mesma forma)
  function somar(lista) {
    const t = { n: lista.length, custo: 0, kwh: 0, km: 0, tempo: 0, tar_fv: 0 };
    for (const c of lista) for (const k of ["custo", "kwh", "km", "tempo", "tar_fv"]) t[k] += +c[k] || 0;
    return t;
  }
  // o mesmo percurso num carro a combustão
  function vsCombustao(t) {
    const litros = t.km / 100 * par.consumo;
    const custo = litros * par.preco;
    return { litros, custo, poupado: custo - t.custo, co2: litros * (par.tipo === "gasoleo" ? 2.68 : 2.31),
             nome: par.tipo === "gasoleo" ? "gasóleo" : "gasolina" };
  }
  const nomeMes = (k, ano) => { const [a, m] = k.split("-"); return new Date(+a, +m - 1, 1).toLocaleDateString("pt-PT", ano ? { month: "long", year: "numeric" } : { month: "long" }); };

  let mesInicio = null;
  function desenharInicio() {
    const i = dados.inicio, h = dados.hist; if (!i) return;
    $("#hero").classList.remove("esqueleto");
    const todos = h?.carregamentos || [];
    const mesAtual = diaLisboa(new Date().toISOString()).slice(0, 7);
    const mesVer = mesInicio || mesAtual;                 // mês escolhido nas barras (por omissão, o atual)
    const doMes = todos.filter((c) => diaLisboa(c.inicio).startsWith(mesVer));
    const t = h ? somar(doMes) : { n: i.mes?.carregamentos || 0, custo: +i.mes?.custo || 0, kwh: +i.mes?.kwh || 0, km: 0 };
    const meses = [];
    const primeiro = todos.length ? diaLisboa(todos[todos.length - 1].inicio).slice(0, 7) : mesAtual;
    for (let k = 5; k >= 0; k--) {   // últimos 6 meses, a começar no 1.º carregamento
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k);
      const m = isoDia(d).slice(0, 7); if (m >= primeiro || k === 0) meses.push(m);
    }
    const porMes = meses.map((m) => todos.filter((c) => diaLisboa(c.inicio).startsWith(m)).reduce((a, c) => a + (+c.custo || 0), 0));
    const max = Math.max(...porMes, 1);
    const cmp = vsCombustao(t);
    const titulo = nomeMes(mesVer, mesVer.slice(0, 4) !== mesAtual.slice(0, 4));
    $("#hero").innerHTML = `
      <div class="h-top"><span>${esc(titulo[0].toUpperCase() + titulo.slice(1))}</span>${i.carro ? `<span class="h-carro">🚗 ${esc(i.carro.nome)}</span>` : ""}</div>
      <div class="h-val">${eur(t.custo)}</div>
      <div class="h-sub">${t.n ? `${num(t.n)} carregamento${t.n === 1 ? "" : "s"} · ${num(t.kwh, 1)} kWh${t.km ? ` · ≈ ${num(t.km)} km` : ""}` : mesVer === mesAtual ? "Ainda não carregaste este mês" : "Sem carregamentos neste mês"}</div>
      ${t.n ? `<div class="h-chips">
        ${t.kwh ? `<span class="h-chip">${nf(3).format(t.custo / t.kwh)} €/kWh</span>` : ""}
      </div>` : ""}
      ${t.n && t.km ? `<button class="h-comb" data-ir="comb">
        <span class="h-comb-v">⛽ ${cmp.poupado >= 0 ? `Poupaste <b>${eur(cmp.poupado)}</b>` : `Gastaste mais <b>${eur(-cmp.poupado)}</b>`} vs um carro a ${cmp.nome}</span>
        <span class="h-comb-c">Carro que gasta ${nf(1).format(par.consumo)} L/100 km, ${cmp.nome} a ${nf(2).format(par.preco)} €/L · ${num(cmp.litros)} L para os mesmos ${num(t.km)} km · mudar ›</span>
      </button>` : ""}
      ${h ? `<div class="h-barras" style="grid-template-columns:repeat(${Math.max(meses.length, 3)},1fr)" aria-label="Gasto nos últimos 6 meses">${meses.map((m, k) => `
        <button class="h-b${m === mesVer ? " atual" : ""}" data-mes="${m}" aria-pressed="${m === mesVer}" aria-label="${esc(nomeMes(m, true))}: ${eur(porMes[k])}">
          <span class="h-bv">${porMes[k] ? Math.round(porMes[k]) + "€" : ""}</span>
          <i style="height:${Math.max(4, 100 * porMes[k] / max).toFixed(0)}%"></i>
          <span class="h-bl">${esc(nomeMes(m).slice(0, 3))}</span></button>`).join("")}</div>
` : ""}`;

    const mp = i.meus_postos || [];
    $("#meus-postos").innerHTML = mp.length ? mp.map(cartaoPosto).join("")
      : `<div class="vazio-msg">Ainda não tens favoritos. No Mapa, abre um posto e toca na ☆ ao lado do ✕.</div>`;
    const alertas = (i.alertas || []).filter((a) => !a.disparado && new Date(a.expira) > new Date());
    $("#alertas-box").innerHTML = alertas.map((a) => `<div class="alerta"><span>🔔 À espera de <b>${esc(a.posto)}</b> até ${horaCurta(a.expira)}</span>
      <button class="btn" data-cancelar="${esc(a.id)}">Cancelar</button></div>`).join("");
    const u = todos[0];
    $("#ultimo-box").innerHTML = u ? `<h2 class="sec">Último carregamento</h2>
      <div class="ultimo">
        <div class="u-ic" aria-hidden="true">${u.tipo === "DC" ? "⚡" : "🔌"}</div>
        <div class="u-corpo"><div class="u-nome">${esc(u.posto)}</div>
          <div class="u-sub">${haQuanto(u.inicio)} · ${num(u.kwh, 1)} kWh · ${duracao(u.min)}${u.so_vazio ? " · em vazio" : ""}</div></div>
        <div class="u-val">${eur(u.custo)}<small>${u.kwh ? nf(3).format(u.custo / u.kwh) + " €/kWh" : ""}</small></div>
      </div>` : "";
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
      $("#btn-gps").addEventListener("click", () => localizar(true, true));
      localizar(true, false);              // abre onde estás (se deres acesso à localização)
    }
    setTimeout(() => { mapa.invalidateSize(); carregarMapa(); }, 50);
  }
  let eu = null, ultimaPos = null;
  function localizar(centrar, avisar) {
    if (!navigator.geolocation) { if (avisar) toast("O browser não dá a localização."); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      ultimaPos = ll;
      if (!eu) {
        eu = L.layerGroup([
          L.circle(ll, { radius: Math.min(p.coords.accuracy || 50, 300), color: "#2563eb", weight: 0, fillOpacity: 0.12, interactive: false }),
          L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2.5, fillColor: "#2563eb", fillOpacity: 1, interactive: false }),
        ]).addTo(mapa);
      } else eu.eachLayer((l) => l.setLatLng(ll));
      if (centrar) mapa.setView(ll, Math.max(mapa.getZoom(), 14));
    }, () => { if (avisar) toast("Sem acesso à localização: autoriza-a nas definições do browser."); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
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
    // [id, nome, lat, lon, estado, livres, tomadas, kW, tipo, operador, tem_preco, favorito]
    const lista = ultimoMapa.filter((p) =>
      (!filtros.livres || p[4] === "Livre") &&
      (!filtros.dc || /DC/.test(p[8]) && p[7] >= 40) &&
      (!filtros.ac || /AC/.test(p[8])) &&
      (!filtros.fav || p[11]));
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
    const livres = lista.filter((p) => p[4] === "Livre").length, rapidos = lista.filter((p) => /DC/.test(p[8]) && p[7] >= 40).length;
    $("#map-resumo").innerHTML = lista.length
      ? `<b>${num(lista.length)}</b> posto${lista.length === 1 ? "" : "s"} aqui · <b class="t-livre">${num(livres)}</b> livre${livres === 1 ? "" : "s"}${rapidos ? ` · ${num(rapidos)} rápido${rapidos === 1 ? "" : "s"}` : ""}`
      : "Nenhum posto aqui com estes filtros";
    $("#map-resumo").hidden = false;
  }

  // ------------------------------------------------------------------ detalhe do posto (folha)
  let postoAberto = null;
  async function abrirPosto(id) {
    postoAberto = id;
    $("#sheet-body").innerHTML = `<p class="nota">A carregar…</p>`;
    $("#sheet-fav").hidden = true;
    if (!(history.state && history.state.folha)) { try { history.pushState({ folha: 1 }, ""); } catch (_) {} }
    $("#sheet").hidden = false; $("#sheet-bg").hidden = false; $("#sheet").scrollTop = 0;
    try {
      const p = await rpc("voltpt_posto", { p_posto: id });
      if (postoAberto !== id || !p) return;
      desenharPosto(p);
    } catch (e) { $("#sheet-body").innerHTML = `<p class="erro">${esc(e.message)}</p>`; }
  }
  // o gesto/botão "voltar" do telemóvel também fecha a folha (popstate), em vez de sair da página
  function fecharPosto() { $("#sheet").hidden = true; $("#sheet-bg").hidden = true; postoAberto = null; tarifaPosto = null; }
  function desenharPosto(p) {
    $("#sheet-body").innerHTML = `
      <div id="s-topo">${htmlTopoPosto(p)}</div>
      <div id="s-extra"></div>
      ${htmlCalc()}
      <div id="s-ocup">${htmlOcupacao(p)}</div>`;
    $("#sheet-body").dataset.id = p.id;
    desenharFav(p);
    iniciarCalc(p.id);
  }
  function htmlOcupacao(p) {
    return `<h3 class="sec2" style="margin-top:18px">Costuma estar ocupado?</h3>${grelhaOcupacao(p.ocupacao)}`;
  }
  function desenharFav(p) {
    const fav = $("#sheet-fav");
    fav.hidden = false; fav.dataset.id = p.id;
    fav.setAttribute("aria-pressed", p.favorito ? "true" : "false");
    fav.textContent = p.favorito ? "★" : "☆";
    fav.setAttribute("aria-label", p.favorito ? "Tirar dos favoritos" : "Marcar como favorito");
  }
  // Atualização automática / depois de uma ação: só o estado, as tomadas e os botões.
  // A calculadora (o que estás a escrever) fica como está.
  async function atualizarFolha(id) {
    try {
      const p = await rpc("voltpt_posto", { p_posto: id });
      if (postoAberto !== id || !p || !$("#s-topo")) return;
      $("#s-topo").innerHTML = htmlTopoPosto(p);
      $("#s-ocup").innerHTML = htmlOcupacao(p);
      desenharFav(p);
    } catch (_) { /* fica o que estava */ }
  }
  function htmlTopoPosto(p) {
    const cls = estadoClasse(p.estado);
    const tom = (p.tomadas || []).map((t) => `<div class="tomada">
        <div><div class="t1">${esc(t.tomada)} · ${num(t.kw_real || t.kw)} kW ${esc(t.tipo)}</div>
             <div class="t2">${esc(t.evse)}${t.desde ? " · mudou " + haQuanto(t.desde) : ""}</div>
             ${t.nap ? `<div class="t2">Operador: ${precoTexto(t.nap)} (sem IVA)</div>` : ""}</div>
        <span class="pill ${estadoClasse(t.estado)}">${esc(estadoTexto(t.estado))}</span></div>`).join("");
    const meus = p.os_meus && p.os_meus.n ? `<p class="nota">Já carregaste aqui ${p.os_meus.n}× · em média ${eur(p.os_meus.custo_medio)} · última ${dataCurta(p.os_meus.ultimo)}</p>` : "";
    const alerta = p.alerta && !p.alerta.disparado
      ? `<button class="btn full" data-cancelar="${esc(p.alerta.id)}">🔕 Cancelar aviso (até ${horaCurta(p.alerta.expira)})</button>`
      : `<button class="btn primary full" data-acao="avisar">🔔 Avisa-me quando ficar livre</button>`;
    const navegar = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
    return `
      <div class="linha-topo"><div><h3 id="s-nome">${esc(p.posto)}</h3>
        <p class="nota" style="margin:4px 0 0">${esc([p.operador, p.morada, p.municipio].filter(Boolean).join(" · "))}</p></div>
        <span class="pill ${cls}">${esc(estadoTexto(p.estado))}</span></div>
      <div class="tomadas">${tom || '<p class="nota">Sem tomadas registadas.</p>'}</div>
      ${meus}
      <div class="acoes">
        ${alerta}
        <a class="btn" href="${navegar}" target="_blank" rel="noopener">🧭 Ir para lá</a>
        <button class="btn full danger" data-acao="denunciar">🚫 Lugar ocupado por quem não carrega</button>
      </div>`;
  }
  async function alternarFavorito() {
    const b = $("#sheet-fav"), id = b.dataset.id, novo = b.getAttribute("aria-pressed") !== "true";
    try {
      await rpc("voltpt_favorito", { p_posto: id, p_favorito: novo });
      b.setAttribute("aria-pressed", novo ? "true" : "false"); b.textContent = novo ? "★" : "☆";
      b.setAttribute("aria-label", novo ? "Tirar dos favoritos" : "Marcar como favorito");
      toast(novo ? "Adicionado aos favoritos." : "Tirado dos favoritos.");
      const m = ultimoMapa.find((x) => x[0] === id); if (m) { m[11] = novo; desenharMapa(); }
      carregarInicio().catch(() => {});
    } catch (e) { toast(e.message); }
  }
  function precoTexto(n) {
    const partes = [];
    if (+n.sessao) partes.push(nf(2).format(n.sessao) + " €/sessão");
    if (+n.kwh) partes.push(nf(3).format(n.kwh) + " €/kWh");
    if (+n.min) partes.push(nf(4).format(n.min) + " €/min");
    return partes.join(" + ") || "grátis";
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
      toast(`Aviso ligado (${r.lugar}.º na fila).`, 3000);
      atualizarFolha(id); carregarInicio().catch(() => {});
      $("#s-extra").innerHTML = r.ntfy ? "" : `<div class="melhor" style="margin-top:12px">
        <b>Falta um passo para o aviso te chegar ao telemóvel.</b> O VoltPT avisa através da app gratuita ntfy (é só para receber notificações).
        <button class="btn primary full" style="margin-top:10px" data-ir="avisos">Ligar avisos (1 minuto)</button></div>`;
    } catch (e) { toast(e.message); }
  }
  async function cancelarAviso(id) {
    try { await rpc("voltpt_alerta_cancelar", { p_alerta: id }); toast("Aviso cancelado."); }
    catch (e) { toast(e.message); }
    if (postoAberto) atualizarFolha(postoAberto);
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

  // ------------------------------------------------------------------ calculadora (dentro da folha do posto)
  let kc = Object.assign({ si: 20, sa: 80 }, store.get("kc", {}));   // bateria agora / até onde (lembradas)
  let tarifaPosto = null, linhasCalc = null, selCalc = null, tCalc = null;
  const horaAgora = () => { const l = VoltCalc.lisboa(Date.now()); return { dia: l.dia, hora: Math.floor(l.seg / 3600), min: Math.floor(l.seg / 60) }; };
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  function htmlCalc() {
    const a = horaAgora();
    return `<div class="calc-box" id="calc-box">
      <h3>💶 Quanto vai custar?</h3>
      <div id="k-corpo">
        <div class="soc-seta">
          <label class="campo">Bateria agora (%)<input id="k-si" type="number" inputmode="numeric" min="0" max="99" step="1" value="${kc.si}"></label>
          <span class="seta">→</span>
          <label class="campo">Carregar até (%)<input id="k-sa" type="number" inputmode="numeric" min="1" max="100" step="1" value="${kc.sa}"></label>
        </div>
        <p id="k-erro" class="calc-erro" role="alert"></p>
        <div class="campo" id="k-tomadas-box" hidden><span>Tomada</span><div id="k-tomadas" class="chips-wrap" role="group" aria-label="Tomada"></div></div>
        <div class="linha2">
          <label class="campo">Dia<select id="k-dia">${DIAS_LONGOS.map((d, k) => `<option value="${k + 1}">${k + 1 === a.dia ? "Hoje" : d[0].toUpperCase() + d.slice(1)}</option>`).join("")}</select></label>
          <label class="campo">Hora de início<input id="k-hora" type="time" step="60" value="${hhmm(a.min)}"></label>
        </div>
        <div id="k-res" class="resultado"><p class="nota">A calcular…</p></div>
        <div id="k-melhor" class="melhor" hidden></div>
        <h3 class="sec2">Semana inteira <span class="muted">(toca numa hora)</span></h3>
        <div id="k-grelha" class="grelha" role="grid" aria-label="Custo por dia e hora"></div>
        <p class="nota" id="k-nota"></p>
      </div>
    </div>`;
  }
  async function iniciarCalc(id) {
    const a = horaAgora();
    selCalc = { dia: a.dia, min: a.min, agora: true, tomada: 0 };   // "agora" até mudares o dia ou a hora
    $("#k-dia").value = selCalc.dia; $("#k-hora").value = hhmm(selCalc.min);
    try {
      const t = await rpc("voltpt_tarifa", { p_posto: id });
      if (postoAberto !== id) return;
      tarifaPosto = t; calcular();
    } catch (e) { $("#k-res").innerHTML = `<p class="erro">${esc(e.message)}</p>`; }
  }
  function opcoesTomada(t) {
    const comPreco = (t.tomadas || []).filter((x) => x.manual || x.nap);
    const distintas = [];
    for (const x of comPreco) if (!distintas.some((d) => d.tipo === x.tipo && +d.kw_util === +x.kw_util)) distintas.push(x);
    return distintas;
  }
  function lerSoc() {
    const si = Math.round(+$("#k-si").value), sa = Math.round(+$("#k-sa").value);
    const erro = $("#k-si").value === "" || $("#k-sa").value === "" ? "Escreve as duas percentagens."
      : si < 0 || si > 99 ? "A bateria agora tem de estar entre 0 e 99 %."
      : sa < 1 || sa > 100 ? "O carregamento vai até 100 % no máximo."
      : sa <= si ? "O \"até\" tem de ser maior do que a bateria agora." : "";
    $("#k-erro").textContent = erro;
    return erro ? null : { si, sa };
  }
  function agendarCalculo() { clearTimeout(tCalc); tCalc = setTimeout(calcular, 300); }
  function calcular() {
    const t = tarifaPosto; if (!t || !$("#calc-box")) return;
    const tomadas = opcoesTomada(t);
    if (!tomadas.length || !t.carro) {
      $("#k-corpo").innerHTML = `<p class="nota">Este posto não publica preço no NAP: não dá para estimar o custo.</p>`;
      return;
    }
    const soc = lerSoc(); if (!soc) return;
    kc = soc; store.set("kc", kc);
    if (selCalc.tomada >= tomadas.length) selCalc.tomada = 0;
    $("#k-tomadas-box").hidden = tomadas.length < 2;
    $("#k-tomadas").innerHTML = tomadas.map((x, k) =>
      `<button class="chip" data-tomada="${k}" aria-pressed="${k === selCalc.tomada}">${esc(x.tipo)} ${num(x.kw_util)} kW</button>`).join("");
    const tm = tomadas[selCalc.tomada], manual = tm.manual, adhoc = !!(manual && manual.party === "ADHOC");
    const params = {
      carro: { curva: t.carro.curva.map(([a, b]) => [+a, +b]), bateria_kwh: +t.carro.bateria_kwh,
               max_ac_kw: +t.carro.max_ac_kw, max_dc_kw: +t.carro.max_dc_kw, consumo: +t.carro.consumo, eff_ac: +t.carro.eff_ac || 0.9 },
      tomada: { tipo: tm.tipo, kw_util: +tm.kw_util }, opc: manual || VoltCalc.tarifaNap(tm.nap),
      regime: adhoc ? "ADHOC" : "MOBIE", ceme: t.ceme, taxas: t.taxas, si: soc.si, sa: soc.sa,
    };
    linhasCalc = { linhas: VoltCalc.semana(params), params, adhoc, manual: !!manual, nap: tm.nap };
    desenharCalc();
  }
  function desenharCalc() {
    const L_ = linhasCalc; if (!L_ || !$("#calc-box")) return;
    const linhas = L_.linhas, por = new Map(linhas.map((l) => [l[0] * 100 + l[1], l]));
    const agora = horaAgora(), eAgora = selCalc.agora;
    const segunda = VoltCalc.inicioSemana(Date.now());
    const inicio = eAgora ? Date.now() : VoltCalc.instante(segunda, selCalc.dia, selCalc.min / 60);
    const r = VoltCalc.estimar(Object.assign({}, L_.params, { inicio }));
    const l = [selCalc.dia, Math.floor(selCalc.min / 60), r.custo, Math.round(r.dur_min), Math.round(r.kwh * 10) / 10, r.km, r.tempo];
    const custos = linhas.map((x) => x[2]), min = Math.min(...custos), max = Math.max(...custos);
    const p = L_.params;
    const fim = new Date(inicio + r.dur_min * 60000);
    // energia em vazio / fora de vazio (preço de energia + TAR do teu contrato)
    const ceme = !L_.adhoc && p.ceme ? p.ceme : null;
    const precosCeme = ceme ? [...new Set((ceme.elements || []).flatMap((e) => (e.components || [])
      .filter((c) => c.dimension === "ENERGY").map((c) => +c.price)))].sort((a, b) => a - b) : [];
    const doisPeriodos = precosCeme.length >= 2, pVazio = precosCeme[0];
    const nomeP = (preco) => preco === pVazio ? "em vazio" : "fora de vazio";
    let periodosHtml = "";
    if (doisPeriodos) {
      const partes = (r.energiaPorPreco || []).filter((x) => x.kwh >= 0.05);
      const div = partes.length > 1
        ? partes.map((x) => `<b>${num(x.kwh, 1)} kWh</b> ${nomeP(x.preco)}`).join(" + ")
        : partes.length ? `Tudo <b>${nomeP(partes[0].preco)}</b>` : "";
      // horário do dia escolhido
      const t0 = VoltCalc.instante(segunda, selCalc.dia, 0);
      const vaz = VoltCalc.periodosDia(ceme, t0).filter((x) => x.preco === pVazio);
      const fmtS = (sg) => hhmm(Math.round(sg / 60));
      const lista = vaz.map((x) => `${fmtS(x.ini)}–${x.fim >= 86400 ? "24:00" : fmtS(x.fim)}`);
      const juntar = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " e " + a[a.length - 1] : a[0] || "";
      const diaNome = DIAS_LONGOS[selCalc.dia - 1];
      const horario = !vaz.length ? `Ao ${diaNome} não há vazio.`
        : vaz.length === 1 && vaz[0].ini === 0 && vaz[0].fim >= 86400 ? `Ao ${diaNome} é vazio o dia todo.`
        : `Vazio ao ${diaNome}: ${juntar(lista)}${selCalc.dia === 6 ? ` (horário de ${VoltCalc.lisboa(t0 + 12 * 3600000).ver ? "verão" : "inverno"})` : ""}. O preço muda a essa hora certa.`;
      periodosHtml = `<div class="periodos">${div ? `<div>⚡ ${div}</div>` : ""}<div class="muted">${horario}</div></div>`;
    }
    $("#k-res").innerHTML = `
      <div class="muted" style="font-size:13px">${eAgora ? "Se começares agora" : `${DIAS_LONGOS[selCalc.dia - 1]} às ${hhmm(selCalc.min)}`} · ${p.si}% → ${p.sa}%</div>
      <div class="grande">${eur(l[2])}</div>
      <div class="det"><div>Duração<b>${duracao(l[3])}</b></div><div>Pronto às<b>${horaCurta(fim)}</b></div>
        <div>Energia<b>${num(l[4], 1)} kWh</b></div><div>Autonomia ganha<b>${num(l[5])} km</b></div>
        <div>Pago ao minuto<b>${eur(l[6])}</b></div><div>Média por kWh<b>${l[4] ? nf(3).format(l[2] / l[4]) + " €" : "—"}</b></div></div>
      ${periodosHtml}`;
    // próxima ocorrência da hora mais barata, a partir de agora
    let melhor = null;
    for (let k = 0; k < 168; k++) {
      const x = VoltCalc.lisboa(Date.now() + k * 3600000), d = x.dia, h = Math.floor(x.seg / 3600), y = por.get(d * 100 + h);
      if (y && y[2] <= min + 0.005) { melhor = { k, d, h }; break; }
    }
    const mel = $("#k-melhor");
    if (melhor) {
      const hh = String(melhor.h).padStart(2, "0") + "h";
      const quando = melhor.k === 0 ? "agora" : melhor.d === agora.dia && melhor.k < 24 ? `hoje às ${hh}`
        : melhor.d === (agora.dia % 7) + 1 && melhor.k < 48 ? `amanhã às ${hh}` : `${DIAS_LONGOS[melhor.d - 1]} às ${hh}`;
      const poup = l[2] - min;
      mel.innerHTML = poup > 0.004 ? `Mais barato: <b>${quando}</b>, ${eur(min)} — poupas <b>${eur(poup)}</b>.`
        : `✓ Esta já é das horas mais baratas (${eur(min)}).`;
      mel.hidden = false;
    } else mel.hidden = true;
    let html = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="h">${h % 3 === 0 ? h : ""}</span>`).join("")}`;
    for (let d = 1; d <= 7; d++) {
      html += `<span class="d">${DIAS[d - 1]}</span>`;
      for (let h = 0; h < 24; h++) {
        const x = por.get(d * 100 + h), f = max > min ? (x[2] - min) / (max - min) : 0;
        html += `<button class="c${d === selCalc.dia && h === Math.floor(selCalc.min / 60) ? " sel" : ""}" data-dh="${d}-${h}" style="background:${corEscala(f)}" aria-label="${DIAS[d - 1]} ${h}h: ${eur(x[2])}"></button>`;
      }
    }
    $("#k-grelha").innerHTML = html;
    const origem = L_.manual ? `Com a tarifa que registaste para este posto${L_.adhoc ? " (preço único)" : " + MyAtlante"}.`
      : `Com o preço publicado pelo operador no NAP (${precoTexto(L_.nap)}, sem IVA) + o teu contrato MyAtlante + taxas e IVA.`;
    $("#k-nota").textContent = `Verde ${eur(min)} · vermelho ${eur(max)}. ${origem} É uma estimativa: a fatura pode variar alguns cêntimos.`;
  }
  function corEscala(f) {
    const cs = getComputedStyle(document.documentElement);
    const cores = ["--g0", "--g1", "--g2", "--g3", "--g4"].map((v) => cs.getPropertyValue(v).trim());
    return cores[Math.min(4, Math.max(0, Math.round(f * 4)))];
  }

  // ------------------------------------------------------------------ histórico
  const PAR_DEF = { tipo: "gasolina", consumo: 6.5, preco: 1.70 };
  let par = Object.assign({}, PAR_DEF, store.get("param", {}));
  let filtroH = { per: "mes", de: "", ate: "" };   // abre sempre no mês atual
  const diaLisboa = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });   // AAAA-MM-DD
  const isoDia = (d) => d.toLocaleDateString("en-CA");
  function intervalo(per) {
    const h = new Date(), y = h.getFullYear(), m = h.getMonth();
    if (per === "mes") return [isoDia(new Date(y, m, 1)), isoDia(h)];
    if (per === "mes-1") return [isoDia(new Date(y, m - 1, 1)), isoDia(new Date(y, m, 0))];
    if (per === "3m") return [isoDia(new Date(y, m - 3, h.getDate())), isoDia(h)];
    if (per === "ano") return [isoDia(new Date(y, 0, 1)), isoDia(h)];
    return ["", ""];
  }
  async function abrirHist() {
    for (const k of Object.keys(PAR_DEF)) $("#p-" + k).value = par[k];
    desenharHist();                                        // já com o que há (ou "a carregar")
    if (!dados.hist || Date.now() - histEm > 60000) {
      try { await carregarHistorico(); } catch (e) { if (!dados.hist) toast(e.message); }
    }
  }
  function escolherPeriodo(per) {
    filtroH.per = per;
    if (per !== "custom") [filtroH.de, filtroH.ate] = intervalo(per);
    desenharHist();
  }
  function desenharHist() {
    const h = dados.hist;
    if (!h) { $("#h-hero").innerHTML = ""; $("#h-hero").classList.add("esqueleto"); $("#h-kpis").innerHTML = `<div class="kpi esqueleto"></div>`.repeat(2); return; }
    $("#h-hero").classList.remove("esqueleto");
    if (filtroH.per !== "custom") [filtroH.de, filtroH.ate] = intervalo(filtroH.per);
    $$(".filtro-datas [data-per]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.per === filtroH.per ? "true" : "false"));
    $("#h-de").value = filtroH.de; $("#h-ate").value = filtroH.ate;
    const todos = h.carregamentos || [];
    const lista = todos.filter((c) => { const d = diaLisboa(c.inicio); return (!filtroH.de || d >= filtroH.de) && (!filtroH.ate || d <= filtroH.ate); });
    const t = somar(lista);
    const fmtD = (s) => new Date(s + "T12:00:00").toLocaleDateString("pt-PT", { day: "numeric", month: "short", year: "numeric" });
    $("#h-titulo").textContent = !filtroH.de && !filtroH.ate ? "Desde que tenho o carro"
      : `${filtroH.de ? fmtD(filtroH.de) : "início"} → ${filtroH.ate ? fmtD(filtroH.ate) : "hoje"}`;
    const cmp = vsCombustao(t);
    $("#h-hero").innerHTML = `
      <div class="h-top"><span>${esc($("#h-titulo").textContent)}</span></div>
      <div class="h-val">${eur(t.custo)}</div>
      <div class="h-sub">${t.n ? `${num(t.n)} carregamento${t.n === 1 ? "" : "s"} · ${num(t.kwh, 1)} kWh · ≈ ${num(t.km)} km` : "Sem carregamentos neste período"}</div>
      ${t.n ? `<div class="h-chips">${t.kwh ? `<span class="h-chip">${nf(3).format(t.custo / t.kwh)} €/kWh</span>` : ""}
        ${t.km ? `<span class="h-chip">${eur(t.custo / t.km * 100)} / 100 km</span>` : ""}</div>` : ""}`;
    $("#h-kpis").innerHTML = !t.n ? "" :
      kpi(t.custo ? num(100 * t.tempo / t.custo) + " %" : "—", "do custo foi tempo (ao minuto)") +
      kpi(eur(t.tar_fv * 0.78), "a menos se carregasses só em vazio");
    const maior = Math.max(cmp.custo, t.custo, 0.01);
    $("#h-comb").innerHTML = !t.n || !t.km ? `<p class="nota" style="margin:0">Sem quilómetros neste período para comparar.</p>` : `
      <div class="comb-tit">E se fosse um carro a ${esc(cmp.nome)}?</div>
      <div class="comb-big ${cmp.poupado >= 0 ? "bom" : "mau"}">${cmp.poupado >= 0 ? "Poupaste" : "Gastaste mais"} ${eur(Math.abs(cmp.poupado))}</div>
      <div class="comb-barras">
        <div class="cb"><span>⛽ A ${esc(cmp.nome)}</span><i style="width:${(100 * cmp.custo / maior).toFixed(1)}%" class="cb-comb"></i><b>${eur(cmp.custo)}</b></div>
        <div class="cb"><span>⚡ Elétrico</span><i style="width:${(100 * t.custo / maior).toFixed(1)}%" class="cb-ev"></i><b>${eur(t.custo)}</b></div>
      </div>
      <p class="comb-txt">Para fazer os mesmos ≈ ${num(t.km)} km, um carro a ${esc(cmp.nome)} gastava ≈ ${num(cmp.litros)} L.</p>
      <p class="comb-txt">🌱 Esse carro teria deitado <b>≈ ${num(cmp.co2)} kg de CO₂</b> para o ar; o teu não deitou nenhum pelo escape.</p>
      <p class="nota" style="margin:8px 0 0">Conta feita com ${nf(1).format(par.consumo)} L/100 km e ${esc(cmp.nome)} a ${nf(2).format(par.preco)} €/L.</p>`;
    // por mês (dentro do período)
    const meses = new Map();
    for (const c of lista) {
      const k = diaLisboa(c.inicio).slice(0, 7);
      const m = meses.get(k) || { n: 0, custo: 0, kwh: 0, km: 0, fixo: 0, tempo: 0, energia: 0, taxas: 0 };
      m.n++; for (const f of ["custo", "kwh", "km", "fixo", "tempo", "energia", "taxas"]) m[f] += +c[f] || 0;
      meses.set(k, m);
    }
    $("#h-meses").innerHTML = meses.size ? [...meses.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, m]) => {
      const tot = (m.fixo + m.tempo + m.energia + m.taxas) || 1;
      const seg = (v, c) => `<i class="${c}" style="width:${(100 * v / tot).toFixed(1)}%"></i>`;
      const [a, mm] = k.split("-");
      const nome = new Date(+a, +mm - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
      return `<div class="mes"><div class="topo"><span>${esc(nome)}</span><span>${eur(m.custo)}</span></div>
        <div class="barra">${seg(m.fixo, "c-fixo")}${seg(m.tempo, "c-tempo")}${seg(m.energia, "c-energia")}${seg(m.taxas, "c-taxas")}</div>
        <div class="leg"><span><i class="c-energia"></i>Energia+TAR ${eur(m.energia)}</span><span><i class="c-tempo"></i>Minutos ${eur(m.tempo)}</span>
        <span><i class="c-fixo"></i>Ativação ${eur(m.fixo)}</span><span><i class="c-taxas"></i>Taxas ${eur(m.taxas)}</span></div>
        <div class="nota" style="margin:6px 0 0">${num(m.n)} carregamentos · ${num(m.kwh, 1)} kWh · ≈ ${num(m.km)} km</div></div>`;
    }).join("") : `<div class="vazio-msg">Sem carregamentos neste período.</div>`;
    $("#h-lista").innerHTML = lista.length ? lista.map((c) => `<div class="sessao">
        <span class="s-ic${c.tipo === "DC" ? " dc" : ""}" aria-hidden="true">${c.tipo === "DC" ? "⚡" : "🔌"}</span>
        <div class="s-corpo"><div class="s1">${esc(c.posto)}${c.so_vazio ? '<span class="tag">vazio</span>' : ""}</div>
          <div class="s2">${dataCurta(c.inicio)} ${horaCurta(c.inicio)} · ${num(c.kwh, 1)} kWh · ${duracao(c.min)} · ≈ ${num(c.km)} km</div></div>
        <div class="s-val">${eur(c.custo)}<small>${c.kwh ? nf(3).format(c.custo / c.kwh) + " €/kWh" : ""}</small></div></div>`).join("")
      : `<div class="vazio-msg">Sem carregamentos neste período.</div>`;
  }

  // ------------------------------------------------------------------ mais: viagem, avisos, conta
  let viag = store.get("viagem", {}), mapaV = null, camadaV = null, pedidoViagem = 0;
  if (viag.origem !== undefined || viag.destino !== undefined) { delete viag.origem; delete viag.destino; store.set("viagem", viag); }
  function abrirMais() {
    desenharNtfy();
    $("#conta-info").textContent = sessao?.email ? `Entraste como ${sessao.email}.` : "";
  }
  // "AAAA-MM-DDTHH:MM" na hora de Lisboa, para o campo da hora de saída
  const localInput = (ms) => {
    const d = new Date(ms), f = (o) => d.toLocaleString("en-CA", Object.assign({ timeZone: "Europe/Lisbon", hourCycle: "h23" }, o));
    return `${f({ year: "numeric", month: "2-digit", day: "2-digit" })}T${f({ hour: "2-digit", minute: "2-digit" })}`;
  };
  function abrirViagem() {
    const c = dados.inicio?.carro;
    if (!$("#v-cons").value) $("#v-cons").value = viag.cons || (c ? nf(1).format(+c.consumo).replace(",", ".") : "19");
    if (viag.soc && $("#v-soc").value === "90") $("#v-soc").value = viag.soc;
    if (viag.fim && $("#v-fim").value === "20") $("#v-fim").value = viag.fim;
    if (viag.vel && !$("#v-vel").value) $("#v-vel").value = viag.vel;
    // hora de saída: agora (arredondada aos 5 min), se ainda não foi escolhida ou já passou
    const h = $("#v-hora"), agora = Math.ceil(Date.now() / 300000) * 300000;
    if (!h.value || h.value < localInput(Date.now() - 60000)) h.value = localInput(agora);
    // cada vez que entras: "De" volta à tua localização (campo vazio) e "Para" fica em branco
    for (const id of ["#v-origem", "#v-destino"]) { const el = $(id); el.value = ""; delete el.dataset.lat; delete el.dataset.lon; }
    $("#sug-origem").hidden = true; $("#sug-destino").hidden = true;
    $("#v-out").hidden = true; $("#v-erro").textContent = "";
    if (mapaV) setTimeout(() => mapaV.invalidateSize(), 50);
  }
  // instante (ms) do "AAAA-MM-DDTHH:MM" escrito, em hora de Lisboa
  function msDeLocal(v) {
    const [d, t] = v.split("T"), [Y, M, D] = d.split("-").map(Number), [h, m] = t.split(":").map(Number);
    let ms = Date.UTC(Y, M - 1, D, h, m);
    for (let i = 0; i < 2; i++) { const l = localInput(ms).split("T")[1].split(":").map(Number); ms -= ((l[0] - h) * 60 + (l[1] - m)) * 60000; }
    return ms;
  }
  const distKm = (a, b) => {   // [lat, lon]
    const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  // moradas: Photon (OpenStreetMap), feito para sugerir enquanto se escreve
  const FOTON = "https://photon.komoot.io/api/";
  function textoSugestao(f) {
    const p = f.properties || {};
    const rua = p.street ? `${p.street}${p.housenumber ? " " + p.housenumber : ""}` : "";
    const l1 = p.name || rua || p.city || "";
    const l2 = [p.name && rua ? rua : "", p.city && p.city !== l1 ? p.city : "", !p.city ? p.county || p.state : "", p.country !== "Portugal" ? p.country : ""]
      .filter((x, k, arr) => x && x !== l1 && arr.indexOf(x) === k).join(", ");
    return { l1, l2, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  }
  async function procurarMoradas(q, sinal) {
    const perto = ultimaPos ? `&lat=${ultimaPos[0].toFixed(3)}&lon=${ultimaPos[1].toFixed(3)}` : "&lat=38.72&lon=-9.14";
    const r = await fetch(`${FOTON}?q=${encodeURIComponent(q)}&limit=6&lang=default&bbox=-10,35.9,3.4,43.9${perto}`, { signal: sinal });
    if (!r.ok) throw new Error("O serviço de moradas não respondeu. Tenta daqui a pouco.");
    const j = await r.json(), vistos = new Set();
    return (j.features || []).map(textoSugestao).filter((x) => x.l1 && !vistos.has(x.l1 + x.l2) && vistos.add(x.l1 + x.l2));
  }
  async function geocodificar(q) {
    let lista;
    try { lista = await procurarMoradas(q); } catch (e) { throw new Error(e.message.startsWith("O serviço") ? e.message : "Sem ligação ao serviço de moradas. Tenta outra vez."); }
    if (!lista.length) throw new Error(`Não encontrei "${q}". Escreve a rua e a localidade, ou escolhe uma das sugestões.`);
    const x = lista[0];
    return { lat: x.lat, lon: x.lon, nome: x.l2 ? `${x.l1}, ${x.l2.split(",")[0]}` : x.l1 };
  }
  // lista de sugestões por baixo dos campos De / Para
  function ligarSugestoes(input, lista, comLocalizacao) {
    let t = null, ctl = null, itens = [], ativo = -1;
    const fechar = () => { lista.hidden = true; input.setAttribute("aria-expanded", "false"); ativo = -1; };
    const mostrarLista = (xs) => {
      itens = xs;
      lista.innerHTML = xs.map((x, k) => `<li role="option" data-k="${k}" class="${x.eu ? "eu" : ""}"><b>${esc(x.l1)}</b>${x.l2 ? `<span>${esc(x.l2)}</span>` : ""}</li>`).join("");
      lista.hidden = !xs.length; input.setAttribute("aria-expanded", xs.length ? "true" : "false");
    };
    const escolher = (k) => {
      const x = itens[k]; if (!x) return;
      if (x.eu) { input.value = ""; delete input.dataset.lat; delete input.dataset.lon; }
      else { input.value = x.l2 ? `${x.l1}, ${x.l2.split(",")[0]}` : x.l1; input.dataset.lat = x.lat; input.dataset.lon = x.lon; }
      fechar();
      if (input.id === "v-origem") $("#v-destino").focus(); else input.blur();
    };
    const euItem = { eu: true, l1: "📍 A minha localização", l2: "" };
    input.addEventListener("input", () => {
      delete input.dataset.lat; delete input.dataset.lon;
      clearTimeout(t); if (ctl) ctl.abort();
      const q = input.value.trim();
      if (q.length < 3) { mostrarLista(comLocalizacao ? [euItem] : []); return; }
      t = setTimeout(async () => {
        ctl = new AbortController();
        try { const xs = await procurarMoradas(q, ctl.signal); if (input.value.trim() === q) mostrarLista(xs); }
        catch (e) { if (e.name !== "AbortError") fechar(); }
      }, 250);
    });
    input.addEventListener("focus", () => { if (comLocalizacao && !input.value.trim()) mostrarLista([euItem]); });
    input.addEventListener("blur", () => setTimeout(fechar, 150));
    input.addEventListener("keydown", (e) => {
      if (lista.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); ativo = (ativo + (e.key === "ArrowDown" ? 1 : itens.length - 1)) % itens.length;
        [...lista.children].forEach((li, k) => li.classList.toggle("ativo", k === ativo));
      } else if (e.key === "Enter" && ativo >= 0) { e.preventDefault(); escolher(ativo); }
      else if (e.key === "Escape") fechar();
    });
    lista.addEventListener("pointerdown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); escolher(+li.dataset.k); } });
  }
  function minhaPosicao() {
    return new Promise((ok, ko) => {
      if (!navigator.geolocation) return ko(new Error("O browser não dá a localização: escreve de onde sais."));
      navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, nome: "A minha localização" }),
        () => ko(new Error("Sem acesso à localização: escreve de onde sais.")), { timeout: 10000, maximumAge: 300000 });
    });
  }
  async function rotaCarro(a, b) {
    const u = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    let r;
    try { r = await fetch(u); } catch { throw new Error("Sem ligação ao serviço de rotas. Tenta outra vez."); }
    const j = r.ok ? await r.json() : null;
    if (!j || j.code !== "Ok" || !j.routes?.length) throw new Error("Não consegui calcular a rota entre esses dois sítios.");
    const rt = j.routes[0];
    return { km: rt.distance / 1000, min: rt.duration / 60, coords: rt.geometry.coordinates.map(([lo, la]) => [la, lo]) };
  }
  function amostrarRota(coords, total) {
    const passo = Math.max(2, total / 1400), out = [];
    let acc = 0, prox = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i) acc += distKm(coords[i - 1], coords[i]);
      if (acc >= prox || i === coords.length - 1) { out.push([+coords[i][0].toFixed(5), +coords[i][1].toFixed(5), +acc.toFixed(1)]); prox = acc + passo; }
    }
    return out;
  }
  // Paragens: o posto rápido mais longe que ainda alcanças (chegando com >= 12 %), carregando
  // só o preciso para o resto da viagem (no máximo 80 %, onde a carga rápida abranda).
  function planearParagens(postos, total, soc0, cap, cons, fim = 12) {
    const RES = 12, ALVO = 80, kmPorPct = cap / cons;          // km por 1 % de bateria
    let pos = 0, soc = soc0, desvioAnt = 0;
    const paragens = [];
    for (let g = 0; g < 12; g++) {
      if (soc - (total - pos + desvioAnt) / kmPorPct >= fim) break;   // chega ao destino com a % pedida
      const alcance = pos + (soc - RES) / 1 * kmPorPct;
      const cand = postos.filter((p) => p.km > pos + 10 && p.km + p.desvio <= alcance);
      if (!cand.length) return { paragens, falha: true, pos, soc };
      const longe = Math.max(...cand.map((p) => p.km));
      const nota = (p) => Math.min(p.kw, 150) / 150 * 30 + (p.livres > 0 ? 12 : 0) + (p.tem_preco ? 8 : 0) + (p.km - longe + 40) / 40 * 25;
      const p = cand.filter((x) => x.km >= longe - 40).sort((a, b) => nota(b) - nota(a))[0];
      const chegada = soc - (p.km - pos + p.desvio + desvioAnt) / kmPorPct;
      const precisa = fim + (total - p.km + p.desvio) / kmPorPct + 3;
      // até 80 % (a carga rápida abranda depois); só passa disso se for a última paragem
      const ultima = total - p.km + p.desvio <= (ALVO - RES) * kmPorPct;
      const teto = precisa > ALVO && ultima && (total - p.km + p.desvio) / kmPorPct + fim <= 100 ? 100 : ALVO;
      const sai = Math.min(teto, Math.max(Math.ceil(precisa), Math.ceil(chegada) + 5));
      paragens.push(Object.assign({}, p, { chegada: Math.max(0, Math.round(chegada)), sai }));
      pos = p.km; soc = sai; desvioAnt = p.desvio;
    }
    return { paragens, chegadaFinal: Math.round(soc - (total - pos + desvioAnt) / kmPorPct) };
  }
  async function custoParagem(p, inicio) {
    try {
      const t = await rpc("voltpt_tarifa", { p_posto: p.id });
      const dc = opcoesTomada(t).filter((x) => x.tipo === "DC").sort((a, b) => b.kw_util - a.kw_util)[0];
      const car = t.carro;
      const carro = { curva: car.curva.map(([a, b]) => [+a, +b]), bateria_kwh: +car.bateria_kwh, max_ac_kw: +car.max_ac_kw,
                      max_dc_kw: +car.max_dc_kw, consumo: +car.consumo, eff_ac: +car.eff_ac || 0.9 };
      const tomada = { tipo: "DC", kw_util: dc ? +dc.kw_util : +p.kw };
      const opc = dc ? (dc.manual || VoltCalc.tarifaNap(dc.nap)) : { elements: [], prices_include_vat: false };
      const adhoc = !!(dc && dc.manual && dc.manual.party === "ADHOC");
      const r = VoltCalc.estimar({ carro, tomada, opc, regime: adhoc ? "ADHOC" : "MOBIE", ceme: t.ceme, taxas: t.taxas,
                                   si: p.chegada, sa: p.sai, inicio });
      return { min: r.dur_min, custo: dc ? r.custo : null, kwh: r.kwh };
    } catch { return { min: null, custo: null }; }
  }
  async function calcularViagem() {
    const meu = ++pedidoViagem, erro = $("#v-erro");
    erro.textContent = "";
    const oEl = $("#v-origem"), dEl = $("#v-destino");
    const destinoTxt = dEl.value.trim(), origemTxt = oEl.value.trim();
    const soc = Math.round(+$("#v-soc").value), fim = Math.round(+$("#v-fim").value);
    const cons = parseFloat(String($("#v-cons").value).replace(",", "."));
    const velTxt = $("#v-vel").value.trim(), vel = velTxt ? +velTxt : null, horaTxt = $("#v-hora").value;
    if (!destinoTxt) { erro.textContent = "Escreve para onde vais."; return; }
    if (!(soc >= 10 && soc <= 100)) { erro.textContent = "A bateria à saída tem de estar entre 10 e 100 %."; return; }
    if (!(fim >= 5 && fim <= 80)) { erro.textContent = "A bateria à chegada tem de estar entre 5 e 80 %."; return; }
    if (!(cons >= 10 && cons <= 35)) { erro.textContent = "A média tem de estar entre 10 e 35 kWh/100 km."; return; }
    if (vel != null && !(vel >= 40 && vel <= 140)) { erro.textContent = "A velocidade média tem de estar entre 40 e 140 km/h (ou deixa vazio)."; return; }
    const saida = horaTxt ? msDeLocal(horaTxt) : Date.now();
    const ponto = (el, txt) => el.dataset.lat ? { lat: +el.dataset.lat, lon: +el.dataset.lon, nome: txt } : null;
    viag = { soc, fim, cons, vel };          // os locais não ficam guardados
    store.set("viagem", viag);
    const btn = $("#v-calcular"); btn.disabled = true; btn.textContent = "A calcular…";
    try {
      const [a, b] = await Promise.all([!origemTxt ? minhaPosicao() : ponto(oEl, origemTxt) || geocodificar(origemTxt),
                                        ponto(dEl, destinoTxt) || geocodificar(destinoTxt)]);
      const rota = await rotaCarro(a, b);
      if (vel) rota.min = rota.km / vel * 60;                  // a tua velocidade em vez da prevista
      rota.vel = vel || rota.km / rota.min * 60;
      if (meu !== pedidoViagem) return;
      const postos = await rpc("voltpt_postos_rota", { p_pontos: amostrarRota(rota.coords, rota.km) });
      const cap = +(dados.inicio?.carro?.bateria_kwh || 65);
      const plano = planearParagens(postos || [], rota.km, soc, cap, cons, fim);
      // tempo e custo de cada paragem (à hora a que lá chegas)
      let relogio = saida, kmAnt = 0;
      for (const p of plano.paragens) {
        relogio += (p.km - kmAnt) / rota.km * rota.min * 60000; kmAnt = p.km;
        Object.assign(p, await custoParagem(p, relogio));
        relogio += (p.min || 0) * 60000;
      }
      plano.chegaAs = relogio + (rota.km - kmAnt) / rota.km * rota.min * 60000;
      plano.saida = saida;
      if (meu !== pedidoViagem) return;
      desenharViagem(a, b, rota, plano);
    } catch (e) { erro.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = "Calcular paragens"; }
  }
  function desenharViagem(a, b, rota, plano) {
    $("#v-out").hidden = false;
    const ps = plano.paragens, minCarga = ps.reduce((s, p) => s + (p.min || 0), 0);
    const custos = ps.map((p) => p.custo), semPreco = custos.some((c) => c == null);
    const total = custos.reduce((s, c) => s + (c || 0), 0);
    $("#v-res").innerHTML = kpi(`${num(rota.km)} km`, `${duracao(rota.min)} a conduzir (${num(rota.vel)} km/h)`) +
      kpi(plano.falha ? "—" : num(ps.length), plano.falha ? "não dá para planear" : ps.length === 1 ? "paragem" : ps.length ? "paragens" : "paragens: não precisas") +
      kpi(ps.length ? duracao(minCarga) : "0h00", "a carregar") +
      kpi(ps.length ? (semPreco ? "≈ " : "") + eur(total) : "0,00 €", semPreco ? "a carregar (há postos sem preço)" : "a carregar, com IVA");
    // lista
    const quando = (ms) => new Date(ms).toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const linhas = [`<div class="pg pg-ponta"><span class="pg-ic">🏠</span><div><b>${esc(a.nome)}</b><div class="muted">Saída ${quando(plano.saida)} com ${viag.soc} %</div></div></div>`];
    ps.forEach((p, k) => {
      const est = !p.com_estado ? `<span class="pill Sem">Sem dados</span>` : p.livres > 0 ? `<span class="pill Livre">${p.livres} livre${p.livres > 1 ? "s" : ""}</span>` : `<span class="pill Ocupado">Ocupado</span>`;
      linhas.push(`<button class="pg pg-posto" data-posto="${esc(p.id)}"><span class="pg-ic n">${k + 1}</span>
        <div class="pg-corpo"><div class="pg-nome">${esc(p.posto)}${p.terra && !String(p.posto).includes(p.terra) ? ` <span class="muted">· ${esc(p.terra)}</span>` : ""}</div>
          <div class="muted">km ${num(p.km)}${p.desvio >= 0.5 ? ` · desvio ${nf(1).format(p.desvio)} km` : ""} · até ${num(p.kw)} kW${p.operador ? ` · ${esc(p.operador)}` : ""}</div>
          <div class="pg-carga">Chegas com <b>${p.chegada} %</b> → carregas até <b>${p.sai} %</b>${p.min ? ` · ${duracao(p.min)}` : ""} · ${p.custo != null ? `<b>${eur(p.custo)}</b>` : "sem preço publicado"}</div></div>
        ${est}</button>`);
    });
    if (plano.falha) linhas.push(`<div class="pg aviso">⚠️ Não encontrei posto rápido (≥ 50 kW) ao alcance depois do km ${num(plano.pos)}. Sai com mais bateria ou escolhe outro caminho.</div>`);
    linhas.push(`<div class="pg pg-ponta"><span class="pg-ic">🏁</span><div><b>${esc(b.nome)}</b><div class="muted">${plano.falha ? "" : `Chegas ${quando(plano.chegaAs)} com ≈ ${plano.chegadaFinal} %`}</div></div></div>`);
    $("#v-paragens").innerHTML = linhas.join("");
    $("#v-nota").textContent = "Paragens em postos rápidos (≥ 50 kW) a menos de 3 km da rota, chegando a cada um com pelo menos 12 % e carregando no máximo até 80 %. Custo com o preço do operador + o teu contrato + taxas, à hora a que lá chegas. Toca num posto para ver o estado e a calculadora.";
    const ll = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)}`;
    $("#v-gmaps").href = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${ll(a)}&destination=${ll(b)}` +
      (ps.length ? `&waypoints=${encodeURIComponent(ps.map(ll).join("|"))}` : "");
    // mapa
    if (!mapaV) {
      mapaV = L.map("viagem-mapa", { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapaV);
      camadaV = L.layerGroup().addTo(mapaV);
    }
    camadaV.clearLayers();
    const linha = L.polyline(rota.coords, { color: "#0f766e", weight: 5, opacity: .85 }).addTo(camadaV);
    const pino = (txt, cls) => L.divIcon({ className: "", html: `<span class="pino ${cls}">${txt}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([a.lat, a.lon], { icon: pino("🏠", "ponta") }).addTo(camadaV);
    L.marker([b.lat, b.lon], { icon: pino("🏁", "ponta") }).addTo(camadaV);
    ps.forEach((p, k) => L.marker([p.lat, p.lon], { icon: pino(k + 1, "num") }).on("click", () => abrirPosto(p.id)).addTo(camadaV));
    setTimeout(() => { mapaV.invalidateSize(); mapaV.fitBounds(linha.getBounds(), { padding: [24, 24] }); }, 60);
    $("#v-res").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // avisos (ntfy)
  function gerarTopico() {
    const a = new Uint8Array(9); crypto.getRandomValues(a);
    return "voltpt-" + Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  }
  function desenharNtfy(msg) {
    const t = dados.inicio?.ntfy;
    const passosApp = `<ol class="passos">
        <li>Instala a app gratuita <b>ntfy</b>: <a href="https://apps.apple.com/app/id1625396347" target="_blank" rel="noopener">App Store</a> · <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Google Play</a>. Quando ela pedir, deixa-a enviar notificações.</li>
        <li>Na app, toca em <b>+</b>, escreve o nome do canal ${t ? `(<code>${esc(t)}</code>)` : ""} e toca em <b>Subscribe</b>.</li>
        <li>Volta aqui e toca em <b>Enviar teste</b>: deve chegar uma notificação.</li></ol>`;
    $("#ntfy-box").innerHTML = !t ? `
      <p class="nota" style="margin-top:0">Quando tocas em <b>“Avisa-me quando ficar livre”</b>, o VoltPT vigia o posto e manda-te uma notificação mal fique livre.
        Uma página da internet não consegue pôr notificações no iPhone sozinha, por isso usa uma app gratuita, a <b>ntfy</b>, que só serve para as receber (não pede conta nem dados).</p>
      <button id="ntfy-criar" class="btn primary full" type="button">Ligar avisos (cria o teu canal)</button>
      <p id="ntfy-msg" class="nota" role="status">${esc(msg || "")}</p>` : `
      <div class="ntfy-ok">✅ <div><b>Avisos ligados.</b> Chegam à app ntfy, no canal
        <div class="canal"><code>${esc(t)}</code><button id="ntfy-copiar" class="btn mini" type="button">Copiar</button></div></div></div>
      <details class="como" ${msg ? "open" : ""}><summary>Como pôr a app ntfy a receber</summary>${passosApp}</details>
      <div class="linha2" style="margin-top:10px">
        <button id="ntfy-teste" class="btn" type="button">Enviar teste</button>
        <button id="ntfy-novo" class="btn" type="button">Mudar de canal</button></div>
      <p id="ntfy-msg" class="nota" role="status">${esc(msg || "")}</p>`;
  }
  async function gravarCanal(t, msg) {
    try {
      await rpc("voltpt_ntfy", { p_topico: t });
      if (dados.inicio) dados.inicio.ntfy = t;
      desenharNtfy(msg); carregarInicio().catch(() => {});
    } catch (e) { $("#ntfy-msg").textContent = e.message; }
  }
  async function testeNtfy() {
    const t = dados.inicio?.ntfy; if (!t) return;
    try {
      const r = await fetch(`https://ntfy.sh/${encodeURIComponent(t)}?title=${encodeURIComponent("VoltPT")}`,
        { method: "POST", body: "Teste: os avisos de posto livre vão chegar assim. ⚡" });
      $("#ntfy-msg").textContent = r.ok ? "Enviado. Se não chegou, confirma o passo 2 (o canal na app ntfy) e as notificações da app." : "O ntfy não aceitou o envio. Tenta daqui a pouco.";
    } catch { $("#ntfy-msg").textContent = "Sem ligação ao ntfy. Tenta outra vez."; }
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
    $$(".tabbar button").forEach((b) => b.addEventListener("click", () => {
      fecharPosto();
      // entrar no Histórico (vindo de outro menu) começa sempre no mês atual
      if (b.dataset.v === "hist" && vista !== "hist") filtroH = { per: "mes", de: "", ate: "" };
      mostrar(b.dataset.v);
    }));
    $("#frescura").addEventListener("click", () => atualizarTudo(true));
    $("#sheet-bg").addEventListener("click", fecharPosto);
    $("#sheet-fechar").addEventListener("click", fecharPosto);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharPosto(); });
    window.addEventListener("popstate", () => { if (!$("#sheet").hidden) fecharPosto(); });
    document.addEventListener("click", (e) => {
      const card = e.target.closest("[data-posto]"); if (card) return abrirPosto(card.dataset.posto);
      const bm = e.target.closest("[data-mes]");
      if (bm) { mesInicio = bm.dataset.mes; desenharInicio(); return; }   // barra do Início: muda os números ali mesmo
      const ir = e.target.closest("[data-ir]");
      if (ir) {
        const d = ir.dataset.ir;
        if (d === "favs") { filtros.fav = true; store.set("filtros", filtros); $$(".map-chips .chip").forEach((x) => x.setAttribute("aria-pressed", filtros[x.dataset.f] ? "true" : "false")); }
        if (d === "avisos") {
          fecharPosto(); mostrar("mais");
          setTimeout(() => $("#ntfy-box").scrollIntoView({ behavior: "smooth", block: "center" }), 80);
          return;
        }
        if (d === "comb") {
          mostrar("hist");
          setTimeout(() => { const aj = $(".comb-aj"); aj.open = true; $(".comb").scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
          return;
        }
        if (d === "hist") filtroH = { per: "mes", de: "", ate: "" };
        mostrar(d === "favs" ? "mapa" : d);
        if (d === "mapa") setTimeout(() => localizar(true, true), 120);
        return;
      }
      const canc = e.target.closest("[data-cancelar]"); if (canc) return cancelarAviso(canc.dataset.cancelar);
      const ac = e.target.closest("[data-acao]"); if (!ac) return;
      if (ac.dataset.acao === "avisar") {
        $("#s-extra").innerHTML = `<p class="nota">Durante quanto tempo?</p><div class="escolha">
          ${[30, 60, 120, 240].map((m) => `<button class="btn" data-acao="avisar-${m}">${m < 60 ? m + " min" : m / 60 + " h"}</button>`).join("")}</div>`;
      } else if (ac.dataset.acao.startsWith("avisar-")) avisar(+ac.dataset.acao.slice(7));
      else if (ac.dataset.acao === "denunciar") {
        $("#s-extra").innerHTML = `<p class="nota">O que se passa?</p><div class="escolha">
          <button class="btn" data-acao="den-ICE_PARKED">Carro a combustão</button>
          <button class="btn" data-acao="den-EV_NOT_CHARGING">Elétrico sem carregar</button>
          <button class="btn" data-acao="den-BLOCKED_ACCESS">Acesso bloqueado</button></div>`;
      } else if (ac.dataset.acao.startsWith("den-")) denunciar(ac.dataset.acao.slice(4));
    });
    // calculadora dentro da folha do posto
    $("#sheet-fav").addEventListener("click", alternarFavorito);
    $("#sheet-body").addEventListener("input", (e) => { if (e.target.id === "k-si" || e.target.id === "k-sa") agendarCalculo(); });
    $("#sheet-body").addEventListener("change", (e) => {
      if (e.target.id === "k-dia") { selCalc.dia = +e.target.value; selCalc.agora = false; desenharCalc(); }
      if (e.target.id === "k-hora") {
        const [h, m] = String(e.target.value).split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) { selCalc.min = h * 60 + m; selCalc.agora = false; desenharCalc(); }
      }
    });
    $("#sheet-body").addEventListener("click", (e) => {
      const tb = e.target.closest("[data-tomada]"); if (tb) { selCalc.tomada = +tb.dataset.tomada; calcular(); return; }
      const c = e.target.closest("[data-dh]"); if (!c) return;
      const [d, h] = c.dataset.dh.split("-").map(Number);
      Object.assign(selCalc, { dia: d, min: h * 60, agora: false });
      $("#k-dia").value = selCalc.dia; $("#k-hora").value = hhmm(selCalc.min); desenharCalc();
    });
    // histórico: período
    $$(".filtro-datas [data-per]").forEach((b) => b.addEventListener("click", () => escolherPeriodo(b.dataset.per)));
    ["#h-de", "#h-ate"].forEach((sel) => $(sel).addEventListener("change", () => {
      filtroH.per = "custom"; filtroH.de = $("#h-de").value; filtroH.ate = $("#h-ate").value;
      desenharHist();
    }));
    // histórico
    for (const k of Object.keys(PAR_DEF)) $("#p-" + k).addEventListener(k === "tipo" ? "change" : "input", (e) => {
      const v = k === "tipo" ? e.target.value : parseFloat(String(e.target.value).replace(",", ".")); if (v === "" || Number.isNaN(v)) return;
      par[k] = v; store.set("param", { tipo: par.tipo, consumo: par.consumo, preco: par.preco }); desenharHist(); if (dados.inicio) desenharInicio();
    });
    // viagem
    $("#v-calcular").addEventListener("click", calcularViagem);
    ligarSugestoes($("#v-origem"), $("#sug-origem"), true);
    ligarSugestoes($("#v-destino"), $("#sug-destino"), false);
    $("#v-destino").addEventListener("keydown", (e) => { if (e.key === "Enter" && $("#sug-destino").hidden) { e.preventDefault(); e.target.blur(); calcularViagem(); } });
    // avisos (ntfy)
    $("#ntfy-box").addEventListener("click", (e) => {
      const id = e.target.id;
      if (id === "ntfy-criar") gravarCanal(gerarTopico(), "Canal criado. Agora faz os passos abaixo na app ntfy.");
      if (id === "ntfy-novo") gravarCanal(gerarTopico(), "Canal novo criado: subscreve-o na app ntfy (e apaga o antigo).");
      if (id === "ntfy-teste") testeNtfy();
      if (id === "ntfy-copiar") { navigator.clipboard?.writeText(dados.inicio?.ntfy || "").then(() => toast("Copiado.")).catch(() => {}); }
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
      if (postoAberto) atualizarFolha(postoAberto);
      if (forcar) toast("Atualizado.");
    } catch (e) { toast(e.message); }
  }

  async function arrancar() {
    $("#login").hidden = true; $("#app").hidden = false;
    const c = store.get("cache", null);
    if (c && c.inicio) { dados.inicio = c.inicio; dados.hist = c.hist || null; desenharFrescura(); desenharInicio(); }
    mostrar(vista);
    try { await carregarInicio(); ultimaAtualizacao = Date.now(); }
    catch (e) { if (!sessao) return; toast(e.message, 5000); }
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
