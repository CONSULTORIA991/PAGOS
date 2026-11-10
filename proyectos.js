// Informes de proyectos: PyG por centro de costo (o grupo de centros) con los movimientos de Siigo.
// Los datos los sube el computador (proyectos-siigo.js) a datos/proyectos.enc, cifrados con la llave de la app.
// La configuración (clasificación de cuentas, grupos, m² y valor vendido, personal asignado) está en
// datos/proyectos-conf.enc: la ven todos los usuarios; solo la administradora la modifica.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmt, fmtDate, toast, mostrarError, msgGitHub, nuevoId, todayISO } = A;
  const R_DATOS = 'datos/proyectos.enc', R_CONF = 'datos/proyectos-conf.enc', R_RRHH = 'datos/rrhh.enc';

  // Estructura del PyG (modelo de gerencia)
  const ING = ['FACTURACION TOTAL', 'DESCUENTOS'];
  const COSTO = ['MANO DE OBRA DIRECTA', 'SEGURIDAD SOCIAL OPERATIVA DIRECTA', 'PREOPERATIVOS', 'ESTRUCTURAS', 'IMPERMEABILIZACIONES', 'REVOQUES Y ENCHAPES', 'PARTE ELECTRICA', 'TUBERIA', 'COMPRA DE EQUIPOS', 'GARANTIAS'];
  const GASTO = ['SALARIOS OPERATIVOS COMPARTIDOS', 'TRANSPORTES Y VIATICOS', 'SALARIOS OPERATIVOS PROYECTO', 'SEGURIDAD SOCIAL', 'GASTOS ADMINISTRATIVOS'];
  const SIN = 'SIN CLASIFICAR', NO = 'NO INCLUIR'; // NO INCLUIR: cuentas que no van al PyG del proyecto (renta, ingresos no operacionales)
  const RUBROS = [...ING, ...COSTO, ...GASTO];
  const ACENTOS = { electrica: 'eléctrica', tuberia: 'tubería', garantias: 'garantías', viaticos: 'viáticos', facturacion: 'facturación' };
  const titulo = (r) => { let s = String(r).toLowerCase(); for (const [a, b] of Object.entries(ACENTOS)) s = s.replace(a, b); return s.charAt(0).toUpperCase() + s.slice(1); };

  // periodo: 'rango' (fecha de inicio a fecha de corte, las escoge la usuaria) o 'mes'
  const P = { datos: null, conf: null, sha: null, rrhh: null, sel: '', sub: '', periodo: 'rango', desde: '', hasta: '', mes: '', q: '', cargando: false, leido: 0 };
  const isAdmin = () => !!A.isAdmin;
  const confBase = () => ({ mapa: {}, grupos: [], obras: {}, personal: [] });

  // ---------- datos ----------
  async function leerTodo(forzar) {
    if (P.datos && !forzar && Date.now() - P.leido < 10 * 60e3) return;
    const [fd, fc, fr] = await Promise.all([GH.leer(R_DATOS), GH.leer(R_CONF), GH.leer(R_RRHH)]);
    P.datos = fd ? await Cripto.descifrarJSON(A.maestra, fd.bytes) : null;
    P.sha = fc ? fc.sha : null;
    P.conf = Object.assign(confBase(), fc ? await Cripto.descifrarJSON(A.maestra, fc.bytes) : {});
    P.rrhh = fr ? await Cripto.descifrarJSON(A.maestra, fr.bytes) : { empleados: [], param: {} };
    P.leido = Date.now();
    prepararIndices();
  }
  async function mutarConf(fn) {
    for (let i = 0; i < 4; i++) {
      const fc = await GH.leer(R_CONF);
      const c = Object.assign(confBase(), fc ? await Cripto.descifrarJSON(A.maestra, fc.bytes) : {});
      if (fn(c) === false) return false;
      c.editado = { en: new Date().toISOString(), por: A.uid };
      try { P.sha = await GH.escribir(R_CONF, await Cripto.cifrarJSON(A.maestra, c), fc ? fc.sha : null); P.conf = c; return true; }
      catch (e) { if (i === 3 || !e.conflicto) throw e; await new Promise((ok) => setTimeout(ok, 700)); }
    }
  }

  // Índices: nombre de centros, terceros y rubro de cada clave
  let CENTROS = new Map(), TER = [];
  function prepararIndices() {
    if (!P.datos) return;
    CENTROS = new Map(P.datos.centros.map((c) => [c.code, c]));
    TER = P.datos.terceros;
  }
  const nombreCC = (code) => (CENTROS.get(code) || {}).name || code;
  const nombreCuenta = (k) => {
    if (k.startsWith('P:')) return (P.datos.productos || {})[k.slice(2)] || 'Producto ' + k.slice(2);
    if (k.startsWith('N:')) return { 'N:sal': 'Salario y auxilio de transporte', 'N:pre': 'Prestaciones sociales', 'N:ss': 'Seguridad social (empresa)', 'N:via': 'Viáticos' }[k] || k;
    return (P.datos.nombresBase || {})[k] || 'Cuenta ' + k;
  };
  // Rubro sugerido para cuentas que aún no están en el mapeo
  function sugerido(k) {
    if (/^4175/.test(k)) return 'DESCUENTOS';
    if (/^41/.test(k)) return 'FACTURACION TOTAL';
    if (/^7205(68|69|70|72)/.test(k)) return 'SEGURIDAD SOCIAL OPERATIVA DIRECTA';
    if (/^72/.test(k)) return 'SALARIOS OPERATIVOS PROYECTO';
    return SIN;
  }
  function rubroDe(k, comp) {
    // Personal agregado a mano = personal compartido (como la cuenta 72050501 Nómina Personal Odesa)
    if (k.startsWith('N:')) return { 'N:sal': 'SALARIOS OPERATIVOS COMPARTIDOS', 'N:pre': 'SALARIOS OPERATIVOS COMPARTIDOS', 'N:ss': 'SEGURIDAD SOCIAL', 'N:via': 'TRANSPORTES Y VIATICOS' }[k];
    if (k.startsWith('P:')) return /^NC/.test(comp) ? 'DESCUENTOS' : 'FACTURACION TOTAL';
    return P.conf.mapa[k] || (P.datos.mapaBase || {})[k] || sugerido(k);
  }
  const clasificada = (k) => k.startsWith('P:') || k.startsWith('N:') || !!(P.conf.mapa[k] || (P.datos.mapaBase || {})[k]);

  // ---------- proyectos (centros y grupos) ----------
  const grupos = () => P.conf.grupos || [];
  function ccsDe(sel) {
    if (sel.startsWith('g:')) return ((grupos().find((g) => g.id === sel.slice(2)) || {}).ccs) || [];
    return [sel.slice(2)];
  }
  const nombreSel = (sel) => (sel.startsWith('g:') ? ((grupos().find((g) => g.id === sel.slice(2)) || {}).nombre || 'Grupo') : nombreCC(sel.slice(2)));

  // ---------- personal asignado: costo mensual con seguridad social y prestaciones ----------
  function costoMensual(e) {
    const p = Object.assign({ smmlv: 1750905, aux: 249095, pension: 16, pensionEmp: 4, saludEmpresa: 8.5, ccf: 4, sena: 2, icbf: 3, exonerado: true, arl: { 1: 0.522, 2: 1.044, 3: 2.436, 4: 4.35, 5: 6.96 } }, (P.rrhh && P.rrhh.param) || {});
    const S = Number(e.salario) || 0;
    const aux = e.aux !== false && S <= 2 * p.smmlv ? p.aux : 0;
    const exon = p.exonerado && S < 10 * p.smmlv;
    const pensionEmpresa = (p.pension - p.pensionEmp) / 100; // 12 %
    const ss = S * (pensionEmpresa + (p.arl[e.riesgo || 1] || 0) / 100 + p.ccf / 100 + (exon ? 0 : (p.saludEmpresa + p.sena + p.icbf) / 100));
    const pre = (S + aux) * (0.0833 + 0.0833 + 0.01) + S * 0.0417; // prima, cesantías, intereses, vacaciones
    return { sal: S + aux, pre, ss, S, aux };
  }
  const mesMas = (mes, n) => { const [y, m] = mes.split('-').map(Number); const d = new Date(y, m - 1 + n, 15); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  // Reparte los meses asignados: meses enteros y la fracción en el último
  function repartoMeses(a) {
    const out = []; let resta = Number(a.meses) || 0;
    for (let i = 0; resta > 0.0001 && i < 60; i++) { const f = Math.min(1, resta); out.push([mesMas(a.desde, i), f]); resta -= f; }
    return out;
  }
  function filasPersonal(ccs) {
    const out = [];
    for (const a of P.conf.personal || []) {
      if (!ccs.includes(a.cc)) continue;
      const e = ((P.rrhh && P.rrhh.empleados) || []).find((x) => x.id === a.empId) || a.snap || {};
      const c = costoMensual(e);
      for (const [mes, f] of repartoMeses(a)) {
        const fecha = mes + '-28', comp = 'Personal asignado', t = -1, nombre = e.nombre || a.nombre;
        out.push([fecha, comp, 'N:sal', a.cc, t, c.sal * f, `${nombre}: ${f < 1 ? f.toFixed(2).replace('.', ',') + ' mes' : '1 mes'} de salario y auxilio`, nombre, e.cedula]);
        out.push([fecha, comp, 'N:pre', a.cc, t, c.pre * f, `${nombre}: prima, cesantías, intereses y vacaciones`, nombre, e.cedula]);
        out.push([fecha, comp, 'N:ss', a.cc, t, c.ss * f, `${nombre}: pensión, ARL y caja`, nombre, e.cedula]);
        if (Number(a.viaticoDia) > 0) out.push([fecha, comp, 'N:via', a.cc, t, Number(a.viaticoDia) * 30 * f, `${nombre}: viáticos`, nombre, e.cedula]);
      }
    }
    return out;
  }
  // Nómina que Siigo ya cargó al proyecto para esa persona (para no contarla dos veces)
  function nominaSiigo(cedula, ccs) {
    const meses = new Set();
    if (!cedula) return meses;
    for (const f of P.datos.filas) if (/^(72|5105)/.test(f[2]) && ccs.includes(f[3]) && TER[f[4]] && String(TER[f[4]][0]) === String(cedula)) meses.add(f[0].slice(0, 7));
    return meses;
  }

  // ---------- cálculo del informe ----------
  const enPeriodo = (fecha) => (P.periodo === 'mes' ? fecha.slice(0, 7) === P.mes : (!P.desde || fecha >= P.desde) && (!P.hasta || fecha <= P.hasta));
  // Al abrir un proyecto: desde su primer movimiento hasta hoy (la usuaria lo cambia)
  function rangoInicial() {
    const ccs = new Set(P.sub ? [P.sub] : ccsDe(P.sel));
    let min = '';
    for (const f of P.datos.filas) if (ccs.has(f[3]) && (!min || f[0] < min)) min = f[0];
    for (const a of P.conf.personal || []) if (ccs.has(a.cc) && (!min || a.desde + '-01' < min)) min = a.desde + '-01';
    P.desde = min ? min.slice(0, 7) + '-01' : todayISO().slice(0, 4) + '-01-01';
    P.hasta = todayISO();
  }
  function filasDe(ccs) {
    const set = new Set(ccs);
    return P.datos.filas.filter((f) => set.has(f[3])).concat(filasPersonal(ccs));
  }
  function calcular(ccs) {
    const filas = filasDe(ccs).filter((f) => enPeriodo(f[0]));
    const r = {}; for (const x of [...RUBROS, SIN]) r[x] = 0;
    const porProv = new Map(), porMes = new Map(), sinCl = new Map();
    for (const f of filas) {
      const rub = rubroDe(f[2], f[1]);
      if (rub === NO) continue;
      r[rub] = (r[rub] || 0) + f[5];
      const m = f[0].slice(0, 7), pm = porMes.get(m) || { ing: 0, costo: 0 };
      if (ING.includes(rub)) pm.ing -= f[5]; else pm.costo += f[5];
      porMes.set(m, pm);
      if (!ING.includes(rub)) { const nom = f[4] >= 0 ? (TER[f[4]] || [])[1] || 'Sin tercero' : f[7]; porProv.set(nom, (porProv.get(nom) || 0) + f[5]); }
      if (!clasificada(f[2])) sinCl.set(f[2], (sinCl.get(f[2]) || 0) + f[5]);
    }
    const fact = -r['FACTURACION TOTAL'], desc = r.DESCUENTOS;
    const ventas = fact - desc;
    const costoVentas = COSTO.reduce((s, x) => s + r[x], 0);
    const gastos = GASTO.reduce((s, x) => s + r[x], 0) + r[SIN];
    const bruta = ventas - costoVentas, operativa = bruta - gastos;
    return { r, fact, desc, ventas, costoVentas, gastos, costo: costoVentas + gastos, bruta, operativa, porProv, porMes, sinCl, n: filas.length };
  }

  // ---------- formato ----------
  const pct = (x) => (isFinite(x) ? (x * 100).toFixed(1).replace('.', ',') + ' %' : '—');
  const millones = (v) => (Math.abs(v) >= 1e6 ? '$ ' + (v / 1e6).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' M' : fmt(v));
  const nombreMes = (mes) => { const [y, m] = mes.split('-').map(Number); const s = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 15)); return s.charAt(0).toUpperCase() + s.slice(1); };
  const mesCorto = (mes) => { const [y, m] = mes.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { month: 'short' }).format(new Date(y, m - 1, 15)).replace('.', '') + ' ' + String(y).slice(2); };
  const fechaLarga = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d)); };
  const textoPeriodo = () => (P.periodo === 'mes' ? nombreMes(P.mes) : `Del ${fechaLarga(P.desde)} al corte del ${fechaLarga(P.hasta)}`);
  const guia = (html) => `<p class="rh-guia">${html}</p>`;

  // ---------- pantalla ----------
  async function abrir() {
    if (P.cargando) return;
    P.cargando = true;
    if (!P.mes) P.mes = todayISO().slice(0, 7);
    $('#proy-cuerpo').innerHTML = '<div class="empty"><h3>Cargando los datos de Siigo…</h3></div>';
    try { await leerTodo(); render(); }
    catch (e) { $('#proy-cuerpo').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${esc(msgGitHub(e))}</p></div>`; }
    P.cargando = false;
  }
  function render() {
    $('#proy-volver-inicio').hidden = !!P.sel; $('#proy-volver-lista').hidden = !P.sel;
    $('#proy-titulo').textContent = P.sel ? nombreSel(P.sel) : 'Informes de proyectos';
    if (!P.datos) { $('#proy-cuerpo').innerHTML = '<div class="empty"><h3>Aún no hay datos de Siigo</h3><p>El computador de contabilidad los sube automáticamente varias veces al día. Vuelve a intentarlo más tarde.</p></div>'; return; }
    if (P.sel) renderInforme(); else renderLista();
  }

  // Lista de proyectos: grupos y centros de costo con movimiento
  function renderLista() {
    const acum = new Map();
    for (const f of P.datos.filas) { const a = acum.get(f[3]) || { ing: 0, costo: 0, ult: '' }; const rub = rubroDe(f[2], f[1]); if (rub === NO) continue; if (ING.includes(rub)) a.ing -= f[5]; else a.costo += f[5]; if (f[0] > a.ult) a.ult = f[0]; acum.set(f[3], a); }
    const q = P.q.trim().toLowerCase();
    const coincide = (txt) => !q || txt.toLowerCase().includes(q);
    const tarjeta = (sel, nombre, sub, a) => `<button class="proy-card" type="button" data-proy-sel="${esc(sel)}">
        <span class="proy-card-nom">${esc(nombre)}</span><span class="proy-card-sub">${esc(sub)}</span>
        <span class="proy-card-num"><span>Ventas <b>${millones(a.ing)}</b></span><span>Costos <b>${millones(a.costo)}</b></span><span class="${a.ing - a.costo < 0 ? 'neg' : 'pos'}">Resultado <b>${millones(a.ing - a.costo)}</b></span></span></button>`;
    const gs = grupos().filter((g) => coincide(g.nombre + ' ' + g.ccs.map(nombreCC).join(' '))).map((g) => {
      const a = g.ccs.reduce((s, c) => { const x = acum.get(c) || { ing: 0, costo: 0 }; return { ing: s.ing + x.ing, costo: s.costo + x.costo }; }, { ing: 0, costo: 0 });
      return tarjeta('g:' + g.id, g.nombre, `Grupo de ${g.ccs.length} centros de costo`, a);
    }).join('');
    const ccs = [...acum.keys()].filter((c) => coincide(c + ' ' + nombreCC(c))).sort((a, b) => (acum.get(b).ult).localeCompare(acum.get(a).ult));
    const fecha = P.datos.actualizado ? new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(P.datos.actualizado)) : '';
    $('#proy-cuerpo').innerHTML = `
      ${guia(`💡 Toca un proyecto para ver su informe: indicadores, PyG por rubro y los proveedores de cada rubro. Los datos vienen de Siigo (actualizados el ${esc(fecha)}). ${isAdmin() ? 'Con <b>Agrupar centros</b> juntas varios contratos (por ejemplo, todo Cóndor) en un solo informe.' : ''}`)}
      <div class="rh-barra"><div class="grupo"><div class="field"><label for="proy-buscar">Buscar proyecto</label><input id="proy-buscar" value="${esc(P.q)}" placeholder="Nombre o código del centro de costo" autocomplete="off"></div></div>
        <div class="grupo">${isAdmin() ? '<button class="btn primary" type="button" data-proy="grupo">+ Agrupar centros</button>' : ''}${isAdmin() && sinClasificarTotal() ? `<button class="btn" type="button" data-proy="clasificar">Clasificar cuentas <span class="rh-alerta">(${sinClasificarTotal()})</span></button>` : ''}</div></div>
      ${gs ? `<h3 class="rh-empresa">Grupos de proyectos</h3><div class="proy-grid">${gs}</div>` : ''}
      <h3 class="rh-empresa">Centros de costo con movimiento · ${ccs.length}</h3>
      <div class="proy-grid">${ccs.map((c) => tarjeta('c:' + c, nombreCC(c), `Centro de costo ${c} · último movimiento ${fmtDate(acum.get(c).ult)}`, acum.get(c))).join('') || '<div class="empty"><p>No hay proyectos con ese nombre.</p></div>'}</div>`;
  }
  function sinClasificarTotal() {
    const s = new Set(); for (const f of P.datos.filas) if (!clasificada(f[2])) s.add(f[2]); return s.size;
  }

  // Informe de un proyecto
  function renderInforme() {
    const todos = ccsDe(P.sel);
    const ccs = P.sub ? [P.sub] : todos;
    const c = calcular(ccs);
    const claveObra = P.sub ? 'c:' + P.sub : P.sel;
    const obra = (P.conf.obras || {})[claveObra] || {};
    const m2 = Number(obra.m2) || 0, vendido = Number(obra.valorVenta) || 0;
    // Indicadores por m²: con el acumulado escogido (inicio a corte); si se mira un mes, con todo el proyecto
    const cTot = P.periodo === 'mes' ? (() => { const s = [P.periodo, P.desde, P.hasta]; P.periodo = 'rango'; P.desde = ''; P.hasta = ''; const x = calcular(ccs); [P.periodo, P.desde, P.hasta] = s; return x; })() : c;
    const tiles = [
      ['main', 'Ventas netas', millones(c.ventas), `Facturado ${millones(c.fact)}${c.desc ? ` − notas crédito ${millones(c.desc)}` : ''}`],
      ['', 'Costos y gastos', millones(c.costo), `Costo de ventas ${millones(c.costoVentas)} · gastos ${millones(c.gastos)}`],
      [c.operativa < 0 ? 'neg' : 'pos', 'Utilidad operativa', millones(c.operativa), `Margen ${pct(c.ventas ? c.operativa / c.ventas : NaN)}`],
      ['', 'Margen bruto', pct(c.ventas ? c.bruta / c.ventas : NaN), `Utilidad bruta ${millones(c.bruta)}`],
    ];
    if (m2) {
      tiles.push(['', 'Costo por m²', fmt(cTot.costo / m2), `${m2.toLocaleString('es-CO')} m² · costo total ${millones(cTot.costo)}`]);
      if (vendido) tiles.push(['', 'Vendido por m²', fmt(vendido / m2), `Utilidad esperada por m² ${fmt((vendido - cTot.costo) / m2)}`]);
    }
    if (vendido) tiles.push(['', 'Facturado del contrato', pct(cTot.ventas / vendido), `${millones(cTot.ventas)} de ${millones(vendido)} vendidos`]);
    const subChips = P.sel.startsWith('g:') ? `<div class="quick" role="group" aria-label="Contrato"><button class="qbtn" type="button" data-proy-sub="" aria-pressed="${!P.sub}">Todo el grupo</button>${todos.map((x) => `<button class="qbtn" type="button" data-proy-sub="${esc(x)}" aria-pressed="${P.sub === x}">${esc(x)} · ${esc(nombreCC(x).slice(0, 34))}</button>`).join('')}</div>` : '';
    $('#proy-cuerpo').innerHTML = `
      <div class="rh-barra"><div class="grupo">
        <div class="quick" role="group" aria-label="Periodo"><button class="qbtn" type="button" data-proy-per="rango" aria-pressed="${P.periodo === 'rango'}">Acumulado (inicio y corte)</button><button class="qbtn" type="button" data-proy-per="mes" aria-pressed="${P.periodo === 'mes'}">Un mes</button></div>
        ${P.periodo === 'mes' ? `<div class="field"><label for="proy-mes">Mes</label><input type="month" id="proy-mes" value="${esc(P.mes)}"></div>`
    : `<div class="field"><label for="proy-desde">Fecha de inicio</label><input type="date" id="proy-desde" value="${esc(P.desde)}" max="${esc(P.hasta)}"></div><div class="field"><label for="proy-hasta">Fecha de corte</label><input type="date" id="proy-hasta" value="${esc(P.hasta)}" min="${esc(P.desde)}"></div><button class="rh-link" type="button" data-proy="rango-todo" title="Desde el primer movimiento del proyecto hasta hoy">Todo el proyecto</button>`}
      </div><div class="grupo">${isAdmin() && P.sel.startsWith('g:') ? '<button class="btn" type="button" data-proy="grupo">Editar grupo</button>' : ''}<button class="btn" type="button" data-proy="excel">Descargar Excel</button></div></div>
      ${subChips}
      <p class="proy-periodo">${esc(textoPeriodo())} · ${esc(P.sub ? `Centro de costo ${P.sub}` : P.sel.startsWith('g:') ? `Grupo: ${todos.join(', ')}` : `Centro de costo ${P.sel.slice(2)}`)}</p>
      ${c.sinCl.size ? `<div class="proy-aviso">⚠ Hay ${c.sinCl.size} ${c.sinCl.size === 1 ? 'cuenta' : 'cuentas'} sin rubro por ${fmt([...c.sinCl.values()].reduce((s, v) => s + v, 0))}: salen en "Sin clasificar". ${isAdmin() ? '<button class="rh-link" type="button" data-proy="clasificar">Clasificarlas</button>' : 'La administradora debe clasificarlas.'}</div>` : ''}
      <section class="rep-sum proy-tiles">${tiles.map(([cl, l, v, s]) => `<div class="tile ${cl}"><span class="lbl">${l}</span><span class="val">${v}</span><span>${s}</span></div>`).join('')}</section>
      ${!m2 || !vendido ? guia(`💡 ${isAdmin() ? 'Escribe los <b>m²</b> y el <b>valor vendido</b> de la obra en "Datos de la obra" (abajo) para ver el costo por m².' : 'Cuando la administradora registre los m² y el valor vendido, aquí verás el costo por m².'}`) : ''}
      <div class="proy-graficas">
        <section class="proy-caja"><h3>¿En qué se fue la plata?</h3><p class="proy-nota">Costos y gastos por rubro. Toca una barra para ver los proveedores.</p>${barrasRubros(c)}</section>
        <section class="proy-caja"><h3>Mes a mes</h3><p class="proy-nota">Ventas y costos de cada mes.</p>${graficaMeses(ccs)}</section>
      </div>
      <section class="proy-caja"><h3>Estado de resultados (PyG)</h3><p class="proy-nota">Toca un rubro para ver qué proveedores y documentos lo forman.</p>${tablaPyG(c)}</section>
      <section class="proy-caja"><h3>Proveedores principales</h3>${topProv(c)}</section>
      ${seccionObra(claveObra, obra, todos)}`;
  }

  function barrasRubros(c) {
    const items = [...COSTO, ...GASTO, SIN].map((r) => [r, c.r[r]]).filter(([, v]) => Math.abs(v) >= 1).sort((a, b) => b[1] - a[1]);
    if (!items.length) return '<p class="proy-nota">Sin costos en este periodo.</p>';
    const max = Math.max(...items.map(([, v]) => Math.abs(v)));
    return `<div class="proy-barras">${items.map(([r, v]) => `<button class="proy-barra" type="button" data-proy-rubro="${esc(r)}"><span class="proy-barra-l">${esc(titulo(r))}</span><span class="proy-barra-t"><span class="proy-barra-f${r === SIN ? ' sin' : ''}" style="width:${Math.max(1, Math.abs(v) / max * 100).toFixed(1)}%"></span></span><span class="proy-barra-v">${millones(v)}<small>${pct(c.costo ? v / c.costo : NaN)}</small></span></button>`).join('')}</div>`;
  }
  function graficaMeses(ccs) {
    if (P.periodo === 'mes') {
      // En un mes: los 12 meses anteriores para dar contexto
      const meses = Array.from({ length: 12 }, (_, i) => mesMas(P.mes, i - 11));
      return dibujarMeses(ccs, meses, P.mes);
    }
    // Acumulado: los meses entre la fecha de inicio y la de corte (máximo los últimos 36)
    const ini = (P.desde || todayISO()).slice(0, 7), fin = (P.hasta || todayISO()).slice(0, 7);
    const meses = []; for (let m = ini; m <= fin && meses.length < 400; m = mesMas(m, 1)) meses.push(m);
    if (!meses.length) return '<p class="proy-nota">Sin movimientos.</p>';
    return dibujarMeses(ccs, meses.slice(-36), '');
  }
  function dibujarMeses(ccs, meses, marcado) {
    const pm = new Map(); for (const f of filasDe(ccs)) { const rb = rubroDe(f[2], f[1]); if (rb === NO) continue; const m = f[0].slice(0, 7); const x = pm.get(m) || { ing: 0, costo: 0 }; if (ING.includes(rb)) x.ing -= f[5]; else x.costo += f[5]; pm.set(m, x); }
    const vals = meses.map((m) => pm.get(m) || { ing: 0, costo: 0 });
    const max = Math.max(1, ...vals.map((v) => Math.max(v.ing, v.costo)));
    const W = 640, H = 220, pad = 28, bw = (W - pad) / meses.length;
    const y = (v) => H - 24 - Math.max(0, v) / max * (H - 44);
    const barras = vals.map((v, i) => {
      const x = pad + i * bw;
      return `<g${meses[i] === marcado ? ' class="marcado"' : ''}><title>${esc(nombreMes(meses[i]))}: ventas ${fmt(v.ing)} · costos ${fmt(v.costo)}</title><rect x="${(x + bw * 0.12).toFixed(1)}" y="${y(v.ing).toFixed(1)}" width="${(bw * 0.36).toFixed(1)}" height="${(H - 24 - y(v.ing)).toFixed(1)}" class="b-ing"/><rect x="${(x + bw * 0.5).toFixed(1)}" y="${y(v.costo).toFixed(1)}" width="${(bw * 0.36).toFixed(1)}" height="${(H - 24 - y(v.costo)).toFixed(1)}" class="b-costo"/>${i % Math.ceil(meses.length / 12) === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(mesCorto(meses[i]))}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="proy-meses" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ventas y costos por mes"><line x1="${pad}" x2="${W}" y1="${H - 24}" y2="${H - 24}" class="eje"/><text x="2" y="14" class="max">${esc(millones(max))}</text>${barras}</svg>
      <p class="proy-ley"><span class="l-ing"></span> Ventas <span class="l-costo"></span> Costos y gastos</p>`;
  }
  function tablaPyG(c) {
    const fila = (r, v, cl) => `<tr class="click ${cl || ''}" data-proy-rubro="${esc(r)}"><td>${esc(titulo(r))}</td><td class="n">${fmt(v)}</td><td class="n">${pct(c.ventas ? v / c.ventas : NaN)}</td></tr>`;
    const tot = (n, v, cl) => `<tr class="tot ${cl || ''}"><td>${n}</td><td class="n">${fmt(v)}</td><td class="n">${pct(c.ventas ? v / c.ventas : NaN)}</td></tr>`;
    const sec = (n) => `<tr class="sec"><td colspan="3">${n}</td></tr>`;
    return `<div class="rh-tabla-wrap"><table class="rh-tabla proy-pyg"><thead><tr><th>Rubro</th><th class="n">Valor</th><th class="n">% de ventas</th></tr></thead><tbody>
      ${sec('Ventas')}${fila('FACTURACION TOTAL', c.fact)}${fila('DESCUENTOS', -c.desc)}${tot('Ventas netas', c.ventas)}
      ${sec('Costo de ventas')}${COSTO.map((r) => fila(r, c.r[r])).join('')}${tot('Total costo de ventas', c.costoVentas)}
      ${tot('Utilidad bruta', c.bruta, c.bruta < 0 ? 'neg' : 'pos')}
      ${sec('Gastos operativos')}${GASTO.map((r) => fila(r, c.r[r])).join('')}${Math.abs(c.r[SIN]) >= 1 ? fila(SIN, c.r[SIN], 'sin') : ''}${tot('Total gastos operativos', c.gastos)}
      ${tot('Utilidad operativa', c.operativa, c.operativa < 0 ? 'neg' : 'pos')}
    </tbody></table></div>`;
  }
  function topProv(c) {
    const l = [...c.porProv.entries()].filter(([, v]) => Math.abs(v) >= 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!l.length) return '<p class="proy-nota">Sin costos en este periodo.</p>';
    return `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Proveedor o tercero</th><th class="n">Valor</th><th class="n">% del costo</th></tr></thead><tbody>${l.map(([n, v]) => `<tr class="click" data-proy-prov="${esc(n)}"><td>${esc(n)}</td><td class="n">${fmt(v)}</td><td class="n">${pct(c.costo ? v / c.costo : NaN)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Datos de la obra (m², valor vendido) y personal asignado
  function seccionObra(claveObra, obra, todos) {
    const ccs = P.sub ? [P.sub] : todos;
    const pers = (P.conf.personal || []).filter((a) => ccs.includes(a.cc));
    const emp = (id) => ((P.rrhh && P.rrhh.empleados) || []).find((x) => x.id === id);
    const filas = pers.map((a) => {
      const e = emp(a.empId) || a.snap || {};
      const c = costoMensual(e); const total = (c.sal + c.pre + c.ss + (Number(a.viaticoDia) || 0) * 30) * (Number(a.meses) || 0);
      const hasta = mesMas(a.desde, Math.max(0, Math.ceil(Number(a.meses) || 0) - 1));
      return `<tr><td><span class="emp">${esc(e.nombre || a.nombre)}</span><br><span class="sub">${esc(e.cargo || '')} · salario ${fmt(c.S)}</span></td><td>${esc(a.cc)}</td><td>${esc(nombreMes(a.desde))}${hasta !== a.desde ? ' a ' + esc(nombreMes(hasta).toLowerCase()) : ''}</td><td class="n">${String(a.meses).replace('.', ',')}</td><td class="n">${fmt(c.sal + c.pre + c.ss + (Number(a.viaticoDia) || 0) * 30)}</td><td class="n"><b>${fmt(total)}</b></td><td>${isAdmin() ? `<button class="btn sm" type="button" data-proy-quitar="${esc(a.id)}">Quitar</button>` : ''}</td></tr>`;
    }).join('');
    return `<section class="proy-caja"><h3>Datos de la obra</h3>
        <p class="proy-nota">${claveObra.startsWith('g:') ? 'Del grupo completo.' : 'De este centro de costo.'} Sirven para el costo por m² y para saber cuánto del contrato se ha facturado.</p>
        <div class="proy-obra"><div><span class="lbl">Metros cuadrados</span><b>${obra.m2 ? Number(obra.m2).toLocaleString('es-CO') + ' m²' : '—'}</b></div><div><span class="lbl">Valor vendido (sin IVA)</span><b>${obra.valorVenta ? fmt(obra.valorVenta) : '—'}</b></div>${obra.nota ? `<div><span class="lbl">Nota</span><span>${esc(obra.nota)}</span></div>` : ''}
        ${isAdmin() ? `<button class="btn" type="button" data-proy="obra">${obra.m2 || obra.valorVenta ? 'Cambiar' : 'Escribir m² y valor vendido'}</button>` : ''}</div>
      </section>
      <section class="proy-caja"><h3>Personal operativo asignado</h3>
        <p class="proy-nota">Personal compartido que no tiene centro de costo en Siigo y que se carga a este proyecto por meses: va a <b>Salarios operativos compartidos</b> y su seguridad social a <b>Seguridad social</b>. El costo incluye salario, auxilio de transporte, prestaciones sociales (prima, cesantías, intereses y vacaciones) y la seguridad social que paga la empresa (pensión 12 %, ARL según el riesgo y caja 4 %).</p>
        ${filas ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Trabajador</th><th>Centro</th><th>Meses</th><th class="n">Cantidad</th><th class="n">Costo por mes</th><th class="n">Total</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>` : '<p class="proy-nota"><i>No hay personal asignado.</i></p>'}
        ${isAdmin() ? '<button class="btn primary" type="button" data-proy="personal">+ Asignar trabajador</button>' : ''}
      </section>`;
  }

  // ---------- detalle: proveedores de un rubro y documentos ----------
  function abrirDetalle(rubro, prov) {
    const ccs = P.sub ? [P.sub] : ccsDe(P.sel);
    const filas = filasDe(ccs).filter((f) => enPeriodo(f[0]) && (rubro ? rubroDe(f[2], f[1]) === rubro : rubroDe(f[2], f[1]) !== NO));
    const terc = (f) => (f[4] >= 0 ? (TER[f[4]] || [])[1] || 'Sin tercero' : f[7]);
    const signo = rubro && ING.includes(rubro) && rubro !== 'DESCUENTOS' ? -1 : 1;
    let html;
    if (!prov) {
      const m = new Map(); for (const f of filas) { const n = terc(f); const x = m.get(n) || { v: 0, n: 0 }; x.v += f[5] * signo; x.n++; m.set(n, x); }
      const l = [...m.entries()].sort((a, b) => b[1].v - a[1].v);
      const total = l.reduce((s, [, x]) => s + x.v, 0);
      // Cuentas que forman el rubro
      const cu = new Map(); for (const f of filas) cu.set(f[2], (cu.get(f[2]) || 0) + f[5] * signo);
      html = `<p class="proy-nota">${esc(textoPeriodo())} · ${l.length} ${l.length === 1 ? 'tercero' : 'terceros'} · total <b>${fmt(total)}</b>. Toca uno para ver sus documentos.</p>
        <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Proveedor o tercero</th><th class="n">Docs.</th><th class="n">Valor</th><th class="n">%</th></tr></thead><tbody>${l.map(([n, x]) => `<tr class="click" data-det-prov="${esc(n)}"><td>${esc(n)}</td><td class="n">${x.n}</td><td class="n">${fmt(x.v)}</td><td class="n">${pct(total ? x.v / total : NaN)}</td></tr>`).join('')}</tbody></table></div>
        <h4 style="margin:14px 0 4px">Cuentas contables del rubro</h4>
        <ul class="proy-cuentas">${[...cu.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><span>${esc(k.startsWith('P:') || k.startsWith('N:') ? '' : k + ' · ')}${esc(nombreCuenta(k))}</span><b>${fmt(v)}</b></li>`).join('')}</ul>`;
    } else {
      const docs = filas.filter((f) => terc(f) === prov).sort((a, b) => b[0].localeCompare(a[0]));
      const total = docs.reduce((s, f) => s + f[5] * signo, 0);
      html = `<p class="proy-nota"><button class="rh-link" type="button" data-det-volver>← Volver a los proveedores</button> · ${docs.length} ${docs.length === 1 ? 'renglón' : 'renglones'} · total <b>${fmt(total)}</b></p>
        <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Documento</th><th>Cuenta</th><th>Detalle</th><th class="n">Valor</th></tr></thead><tbody>${docs.slice(0, 400).map((f) => `<tr><td>${esc(fmtDate(f[0]))}</td><td>${esc(f[1])}</td><td>${esc(f[2].startsWith('P:') || f[2].startsWith('N:') ? nombreCuenta(f[2]) : f[2] + ' ' + nombreCuenta(f[2]))}</td><td>${esc(f[6])}</td><td class="n">${fmt(f[5] * signo)}</td></tr>`).join('')}</tbody></table></div>${docs.length > 400 ? '<p class="proy-nota">Se muestran los 400 más recientes.</p>' : ''}`;
    }
    $('#proy-det-titulo').textContent = prov ? prov : rubro ? titulo(rubro) : 'Detalle';
    $('#proy-det-res').innerHTML = html;
    $('#dlg-proy-det').dataset.rubro = rubro || '';
    if (!$('#dlg-proy-det').open) $('#dlg-proy-det').showModal();
  }

  // ---------- configuración (solo administradora) ----------
  function abrirObra() {
    const ccs = ccsDe(P.sel); const clave = P.sub ? 'c:' + P.sub : P.sel;
    const o = (P.conf.obras || {})[clave] || {};
    abrirForm(`Datos de la obra · ${P.sub ? nombreCC(P.sub) : nombreSel(P.sel)}`, `
      <div class="field"><label for="po-m2">Metros cuadrados de la obra</label><input id="po-m2" inputmode="decimal" value="${esc(o.m2 ? String(o.m2).replace('.', ',') : '')}" placeholder="Ej. 300"></div>
      <div class="field"><label for="po-valor">Valor vendido, sin IVA</label><input id="po-valor" inputmode="numeric" value="${esc(o.valorVenta ? Math.round(o.valorVenta).toLocaleString('es-CO') : '')}" placeholder="Ej. 1.000.000"></div>
      <div class="field full"><label for="po-nota">Nota (opcional)</label><input id="po-nota" value="${esc(o.nota || '')}" placeholder="Ej. Piscina de 300 m² con zona húmeda"></div>
      <p class="hint full">${ccs.length > 1 && !P.sub ? 'Estos datos son del grupo completo. Para un solo contrato, escógelo arriba y vuelve a tocar el botón.' : ''}</p>`,
    async () => {
      const m2 = Number(String($('#po-m2').value).replace(/\./g, '').replace(',', '.')) || 0;
      const valor = A.parseMonto($('#po-valor').value) || 0;
      if (m2 < 0 || valor < 0) throw new Error('Escribe valores positivos.');
      await mutarConf((c) => { c.obras = c.obras || {}; c.obras[clave] = { m2, valorVenta: valor, nota: $('#po-nota').value.trim() }; });
    });
  }
  function abrirGrupo(id) {
    const g = grupos().find((x) => x.id === id) || { id: nuevoId(), nombre: '', ccs: [] };
    const conMov = [...new Set(P.datos.filas.map((f) => f[3]))];
    const lista = P.datos.centros.filter((c) => conMov.includes(c.code) || g.ccs.includes(c.code)).sort((a, b) => a.code.localeCompare(b.code));
    abrirForm(id ? `Grupo · ${g.nombre}` : 'Agrupar centros de costo', `
      <div class="field full"><label for="pg-nombre">Nombre del grupo</label><input id="pg-nombre" value="${esc(g.nombre)}" placeholder="Ej. CÓNDOR"></div>
      <div class="field full"><label for="pg-filtro">Marca los centros de costo que forman el grupo</label><input id="pg-filtro" placeholder="Filtrar, ej. condor" autocomplete="off"></div>
      <div class="full proy-checks" id="pg-lista">${lista.map((c) => `<label data-txt="${esc((c.code + ' ' + c.name).toLowerCase())}"><input type="checkbox" value="${esc(c.code)}"${g.ccs.includes(c.code) ? ' checked' : ''}> <span><b>${esc(c.code)}</b> ${esc(c.name)}</span></label>`).join('')}</div>
      ${id ? '<div class="full"><button class="btn danger sm" type="button" data-pg-borrar>Borrar este grupo</button></div>' : ''}`,
    async () => {
      const nombre = $('#pg-nombre').value.trim(), ccs = [...document.querySelectorAll('#pg-lista input:checked')].map((x) => x.value);
      if (!nombre) throw new Error('Escribe el nombre del grupo.');
      if (ccs.length < 2) throw new Error('Marca al menos dos centros de costo.');
      await mutarConf((c) => { c.grupos = (c.grupos || []).filter((x) => x.id !== g.id); c.grupos.push({ id: g.id, nombre, ccs }); });
      P.sel = 'g:' + g.id; P.sub = '';
    });
    // Sugerencia: al escribir el nombre, filtra la lista
    $('#pg-filtro').addEventListener('input', (ev) => { const q = ev.target.value.trim().toLowerCase(); document.querySelectorAll('#pg-lista label').forEach((l) => { l.hidden = q && !l.dataset.txt.includes(q) && !l.querySelector('input').checked; }); });
    const b = document.querySelector('[data-pg-borrar]');
    if (b) b.addEventListener('click', async () => {
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '¿Borrar el grupo? Los centros de costo no se borran. Toca de nuevo'; return; }
      try { await mutarConf((c) => { c.grupos = (c.grupos || []).filter((x) => x.id !== g.id); }); $('#dlg-proy-form').close(); P.sel = ''; render(); toast('Grupo borrado.'); } catch (e) { mostrarError('#pf-err', msgGitHub(e)); }
    });
  }
  function abrirPersonal() {
    const todos = ccsDe(P.sel); const ccDef = P.sub || todos[0];
    const emps = ((P.rrhh && P.rrhh.empleados) || []).slice().sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    const hoyMes = todayISO().slice(0, 7);
    abrirForm('Asignar trabajador al proyecto', `
      <div class="field full"><label for="pp-emp">Trabajador</label><input id="pp-emp" list="pp-emps" placeholder="Escribe el nombre" autocomplete="off"><datalist id="pp-emps">${emps.map((e) => `<option value="${esc(e.nombre)}">${esc(e.cargo || '')}${e.retiro ? ' · retirado' : ''}</option>`).join('')}</datalist><span class="hint">Se toma el salario, el auxilio y el riesgo ARL de Recursos humanos.</span></div>
      ${todos.length > 1 ? `<div class="field full"><label for="pp-cc">Centro de costo</label><select id="pp-cc">${todos.map((c) => `<option value="${esc(c)}"${c === ccDef ? ' selected' : ''}>${esc(c)} · ${esc(nombreCC(c))}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="pp-desde">Desde (mes)</label><input type="month" id="pp-desde" value="${esc(hoyMes)}"></div>
      <div class="field"><label for="pp-meses">¿Cuántos meses?</label><input id="pp-meses" inputmode="decimal" placeholder="Ej. 6 o 2,5"><span class="hint">Medio mes = 0,5</span></div>
      <div class="field"><label for="pp-via">Viático por día (opcional)</label><input id="pp-via" inputmode="numeric" placeholder="Ej. 14.000"></div>
      <div class="full" id="pp-res"></div>`,
    async () => {
      const x = previewPersonal(true);
      if (!x) throw new Error(document.querySelector('#pp-res .rh-asis-falta') ? document.querySelector('#pp-res .rh-asis-falta').textContent : 'Revisa los datos.');
      await mutarConf((c) => {
        c.personal = c.personal || [];
        // Último chequeo con los datos guardados: no repetir meses del mismo trabajador en el mismo centro
        const choca = c.personal.some((a) => a.empId === x.e.id && a.cc === x.cc && repartoMeses(a).some(([m]) => x.meses.includes(m)));
        if (choca) throw new Error(`${x.e.nombre} ya está asignado a este centro de costo en alguno de esos meses.`);
        c.personal.push({ id: nuevoId(), empId: x.e.id, nombre: x.e.nombre, cc: x.cc, desde: x.desde, meses: x.n, viaticoDia: x.via, snap: { nombre: x.e.nombre, cedula: x.e.cedula, cargo: x.e.cargo, salario: x.e.salario, aux: x.e.aux, riesgo: x.e.riesgo }, en: new Date().toISOString(), por: A.uid });
      });
    });
    const dlg = $('#dlg-proy-form');
    const f = () => previewPersonal(false);
    dlg.querySelectorAll('#pp-emp, #pp-cc, #pp-desde, #pp-meses, #pp-via').forEach((el) => el && el.addEventListener('input', f));
    f();
  }
  function previewPersonal(final) {
    const res = $('#pp-res'); const todos = ccsDe(P.sel);
    const nombre = $('#pp-emp').value.trim().toLowerCase();
    const e = ((P.rrhh && P.rrhh.empleados) || []).find((x) => String(x.nombre).toLowerCase() === nombre);
    const cc = $('#pp-cc') ? $('#pp-cc').value : (P.sub || todos[0]);
    const desde = $('#pp-desde').value, n = Number(String($('#pp-meses').value).replace(',', '.')) || 0;
    const via = A.parseMonto($('#pp-via').value) || 0;
    const falta = (t) => { res.innerHTML = `<p class="rh-asis-falta">${esc(t)}</p>`; $('#pf-go').disabled = true; return null; };
    if (!e) return falta(nombre ? 'Escoge el trabajador de la lista (como está en Recursos humanos).' : 'Escribe el nombre del trabajador.');
    if (!desde) return falta('Escoge el mes inicial.');
    if (!(n > 0 && n <= 36)) return falta('Escribe cuántos meses (por ejemplo 6).');
    const meses = repartoMeses({ desde, meses: n }).map(([m]) => m);
    // Bloqueo: nómina que Siigo ya cargó a este proyecto para esa persona
    const enSiigo = nominaSiigo(e.cedula, todos);
    const cruce = meses.filter((m) => enSiigo.has(m));
    if (cruce.length) return falta(`${e.nombre} ya tiene su nómina cargada en Siigo en este proyecto en ${cruce.map((m) => nombreMes(m).toLowerCase()).join(', ')}. No se puede asignar esos meses para no contarla dos veces.`);
    const yaApp = (P.conf.personal || []).filter((a) => a.empId === e.id && a.cc === cc && repartoMeses(a).some(([m]) => meses.includes(m)));
    if (yaApp.length) return falta(`${e.nombre} ya está asignado a este centro de costo en alguno de esos meses.`);
    // Aviso (no bloquea): asignado en otro proyecto en los mismos meses
    const otros = (P.conf.personal || []).filter((a) => a.empId === e.id && a.cc !== cc && repartoMeses(a).some(([m]) => meses.includes(m)));
    const c = costoMensual(e), mes = c.sal + c.pre + c.ss + via * 30;
    res.innerHTML = `<div class="rh-asis-res"><table class="rh-tabla"><tbody>
        <tr><td>Salario${c.aux ? ' + auxilio de transporte' : ''}</td><td class="n">${fmt(c.sal)}</td></tr>
        <tr><td>Prestaciones (prima, cesantías, intereses, vacaciones)</td><td class="n">${fmt(c.pre)}</td></tr>
        <tr><td>Seguridad social de la empresa (pensión 12 %, ARL riesgo ${['', 'I', 'II', 'III', 'IV', 'V'][e.riesgo || 1]}, caja 4 %)</td><td class="n">${fmt(c.ss)}</td></tr>
        ${via ? `<tr><td>Viáticos (${fmt(via)} × 30 días)</td><td class="n">${fmt(via * 30)}</td></tr>` : ''}
        <tr class="tot"><td>Costo por mes</td><td class="n">${fmt(mes)}</td></tr></tbody></table>
      <p class="rh-asis-resumen">✔ <b>${esc(e.nombre)}</b> en ${esc(cc)} · ${esc(nombreCC(cc))}: ${String(n).replace('.', ',')} ${n === 1 ? 'mes' : 'meses'} desde ${esc(nombreMes(desde).toLowerCase())} → <b>${fmt(mes * n)}</b>.${enSiigo.size ? ` <br>Ojo: en Siigo ya tiene nómina en este proyecto en ${[...enSiigo].sort().map((m) => nombreMes(m).toLowerCase()).join(', ')} (otros meses, no se cruzan).` : ''}${otros.length ? `<br>Ojo: también está asignado a ${otros.map((a) => esc(a.cc)).join(', ')} en esos meses.` : ''}</p></div>`;
    $('#pf-go').disabled = false;
    return { e, cc, desde, n, via, meses };
  }
  function abrirClasificar() {
    const m = new Map();
    for (const f of P.datos.filas) if (!clasificada(f[2])) { const x = m.get(f[2]) || { v: 0, n: 0, desc: f[6], ccs: new Set() }; x.v += f[5]; x.n++; x.ccs.add(f[3]); m.set(f[2], x); }
    const l = [...m.entries()].sort((a, b) => Math.abs(b[1].v) - Math.abs(a[1].v));
    abrirForm('Clasificar cuentas en el PyG', `
      <p class="full proy-nota" style="margin:0">Cuentas de Siigo que todavía no están en tu modelo de PyG. Escoge el rubro de cada una; se guarda para todos los proyectos. Algunas ya traen una sugerencia.</p>
      <div class="full rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Cuenta</th><th class="n">Valor</th><th>Rubro</th></tr></thead><tbody>
      ${l.map(([k, x]) => `<tr><td><b>${esc(k)}</b> ${esc(nombreCuenta(k).startsWith('Cuenta ') ? '' : nombreCuenta(k))}<br><span class="sub">${x.n} renglones · ej. ${esc(x.desc)}</span></td><td class="n">${fmt(x.v)}</td><td><select data-pc="${esc(k)}"><option value="">${esc(titulo(sugerido(k)))}${sugerido(k) !== SIN ? ' (sugerido)' : ''}</option>${RUBROS.map((r) => `<option value="${esc(r)}">${esc(titulo(r))}</option>`).join('')}<option value="${NO}">No incluir en el PyG</option></select></td></tr>`).join('')}
      </tbody></table></div>`,
    async () => {
      const cambios = {}; document.querySelectorAll('[data-pc]').forEach((s) => { cambios[s.dataset.pc] = s.value || sugerido(s.dataset.pc); });
      const validos = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v && v !== SIN));
      if (!Object.keys(validos).length) throw new Error('Escoge el rubro de al menos una cuenta.');
      await mutarConf((c) => { c.mapa = Object.assign(c.mapa || {}, validos); });
    }, 'Guardar clasificación');
  }

  // Formulario genérico
  let formOk = null;
  function abrirForm(tituloTxt, html, ok, boton) {
    $('#pf-titulo').textContent = tituloTxt;
    $('#pf-campos').innerHTML = html;
    $('#pf-go').textContent = boton || 'Guardar'; $('#pf-go').disabled = false;
    mostrarError('#pf-err', '');
    formOk = ok;
    $('#dlg-proy-form').showModal();
  }

  // ---------- Excel ----------
  function excel() {
    if (!window.XLSX) return toast('No cargó el generador de Excel. Recarga la página.');
    const ccs = P.sub ? [P.sub] : ccsDe(P.sel), c = calcular(ccs);
    const pyg = [[`INFORME DE PROYECTO · ${P.sub ? nombreCC(P.sub) : nombreSel(P.sel)}`], [textoPeriodo()], [], ['Rubro', 'Valor', '% de ventas'],
      ['Facturación total', c.fact], ['Descuentos', -c.desc], ['VENTAS NETAS', c.ventas], [],
      ...COSTO.map((r) => [titulo(r), c.r[r]]), ['TOTAL COSTO DE VENTAS', c.costoVentas], ['UTILIDAD BRUTA', c.bruta], [],
      ...GASTO.map((r) => [titulo(r), c.r[r]]), ...(Math.abs(c.r[SIN]) >= 1 ? [['Sin clasificar', c.r[SIN]]] : []), ['TOTAL GASTOS OPERATIVOS', c.gastos], ['UTILIDAD OPERATIVA', c.operativa]];
    pyg.forEach((f) => { if (typeof f[1] === 'number' && c.ventas) f[2] = f[1] / c.ventas; });
    const det = [['Fecha', 'Documento', 'Centro de costo', 'Cuenta / concepto', 'Rubro', 'Tercero', 'Detalle', 'Valor']].concat(
      filasDe(ccs).filter((f) => enPeriodo(f[0]) && rubroDe(f[2], f[1]) !== NO).map((f) => [f[0], f[1], f[3], (f[2].startsWith('P:') || f[2].startsWith('N:') ? '' : f[2] + ' ') + nombreCuenta(f[2]), titulo(rubroDe(f[2], f[1])), f[4] >= 0 ? (TER[f[4]] || [])[1] : f[7], f[6], Math.round(f[5])]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pyg), 'PyG');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(det), 'Movimientos');
    XLSX.writeFile(wb, `Informe proyecto ${(P.sub || nombreSel(P.sel)).replace(/[\\/:*?"<>|]/g, '').slice(0, 40)} ${P.periodo === 'mes' ? P.mes : `${P.desde} a ${P.hasta}`}.xlsx`);
  }

  // ---------- eventos ----------
  $('#view-proy').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-proy-sel], [data-proy-sub], [data-proy-per], [data-proy], [data-proy-rubro], [data-proy-prov], [data-proy-quitar], #proy-volver-lista');
    if (!t) return;
    if (t.id === 'proy-volver-lista') { P.sel = ''; P.sub = ''; render(); window.scrollTo({ top: 0 }); return; }
    if (t.dataset.proySel) { P.sel = t.dataset.proySel; P.sub = ''; rangoInicial(); render(); window.scrollTo({ top: 0 }); return; }
    if ('proySub' in t.dataset) { P.sub = t.dataset.proySub; render(); return; }
    if (t.dataset.proyPer) { P.periodo = t.dataset.proyPer; render(); return; }
    if (t.dataset.proyRubro) { abrirDetalle(t.dataset.proyRubro, null); return; }
    if (t.dataset.proyProv) { abrirDetalle('', t.dataset.proyProv); return; }
    if (t.dataset.proyQuitar) {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = '¿Quitar? Toca de nuevo'; return; }
      mutarConf((c) => { c.personal = (c.personal || []).filter((a) => a.id !== t.dataset.proyQuitar); }).then(() => { render(); toast('Trabajador quitado del proyecto.'); }).catch((e) => toast(msgGitHub(e)));
      return;
    }
    const a = t.dataset.proy;
    if (a === 'grupo') abrirGrupo(P.sel.startsWith('g:') ? P.sel.slice(2) : null);
    else if (a === 'obra') abrirObra();
    else if (a === 'personal') abrirPersonal();
    else if (a === 'clasificar') abrirClasificar();
    else if (a === 'excel') excel();
    else if (a === 'rango-todo') { rangoInicial(); render(); }
  });
  $('#view-proy').addEventListener('input', (ev) => { if (ev.target.id === 'proy-buscar') { P.q = ev.target.value; const pos = ev.target.selectionStart; renderLista(); const i = $('#proy-buscar'); i.focus(); i.setSelectionRange(pos, pos); } });
  $('#view-proy').addEventListener('change', (ev) => {
    const id = ev.target.id, v = ev.target.value;
    if (id === 'proy-mes') { P.mes = v || todayISO().slice(0, 7); render(); }
    else if (id === 'proy-desde' || id === 'proy-hasta') {
      if (!v) return;
      if (id === 'proy-desde') P.desde = v; else P.hasta = v;
      if (P.desde > P.hasta) { toast('La fecha de inicio no puede ser después de la fecha de corte.'); if (id === 'proy-desde') P.hasta = P.desde; else P.desde = P.hasta; }
      render();
    }
  });
  $('#dlg-proy-det').addEventListener('click', (ev) => {
    const p = ev.target.closest('[data-det-prov]'); if (p) { abrirDetalle($('#dlg-proy-det').dataset.rubro || '', p.dataset.detProv); return; }
    if (ev.target.closest('[data-det-volver]')) abrirDetalle($('#dlg-proy-det').dataset.rubro || '', null);
  });
  $('#pf-form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); if (!formOk) return;
    const b = $('#pf-go'); b.disabled = true;
    try { await formOk(); $('#dlg-proy-form').close(); toast('Guardado.'); render(); }
    catch (e) { mostrarError('#pf-err', e.message && !e.status ? e.message : msgGitHub(e)); }
    b.disabled = false;
  });
  // En la vista de grupo, el botón "Agrupar" permite editar el grupo
  window.PROY = { abrir, recargar: () => leerTodo(true).then(render) };
})();
