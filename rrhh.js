// Recursos humanos: empleados, nómina quincenal, novedades del mes y borrador de planilla (PILA).
// Todo se guarda cifrado en datos/rrhh.enc con la misma llave de la app. Cada cambio queda registrado
// (quién, cuándo, campo, antes y después). Lo pueden ver y editar todos los usuarios de la app
// (administradora y jefes); cerrar o reabrir una quincena es solo de la administradora.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmt, fmtDate, dtFmt, toast, mostrarError, msgGitHub, nuevoId, personName, parseMonto, todayISO } = A;
  const R_RRHH = 'datos/rrhh.enc';

  // Parámetros 2026 (se pueden ajustar en los datos; recargos según Ley 2466 de 2025: dominical 90 % desde jul-2026)
  const PARAM_DEF = {
    smmlv: 1750905, aux: 249095, horasMes: 210,
    rec: { hed: 25, hen: 75, rn: 35, rdf: 90, hedf: 115, henf: 165 },
    saludEmp: 4, pensionEmp: 4, pension: 16, saludEmpresa: 8.5, ccf: 4, sena: 2, icbf: 3, exonerado: true,
    arl: { 1: 0.522, 2: 1.044, 3: 2.436, 4: 4.35, 5: 6.96 }, incapacidadPct: 66.67,
  };
  const EMPRESA_DEF = 'ODESA CARIBE S.A.S.';
  // Campos editables de cada quincena
  const DIAS = [['dias', 'Días quincena'], ['inc', 'Incap.'], ['vac', 'Vacac.'], ['lr', 'Lic. rem.'], ['lnr', 'Lic. no rem.'], ['sus', 'Suspens.']];
  const HORAS = [['hed', 'HE diur.'], ['hen', 'HE noct.'], ['rn', 'Rec. noct.'], ['rdf', 'Rec. dom/fest'], ['hedf', 'HE dom diur.'], ['henf', 'HE dom noct.']];
  const DINERO = [['otros', 'Otros pagos (no salariales)'], ['prestamos', 'Préstamos'], ['otrasDed', 'Otras deducciones']];
  const NOMBRE_CAMPO = Object.fromEntries([...DIAS, ...HORAS, ...DINERO, ['nota', 'Nota']]);

  const R = { datos: null, sha: null, tab: 'emp', ver: 'activos', mes: '', q: 1, mesPla: '', cargando: false, empresa: '', leido: 0 };
  // Filtro por empresa (ambas, ODESA CARIBE u OBS) para empleados, nómina, planilla y sus Excel
  const deEmpresa = (e) => !R.empresa || (e.empresa || EMPRESA_DEF) === R.empresa;
  function selEmpresa() {
    const todas = [...new Set((R.datos.empleados || []).map((e) => e.empresa || EMPRESA_DEF))].sort();
    if (todas.length < 2) return '';
    if (R.empresa && !todas.includes(R.empresa)) R.empresa = '';
    return `<div class="quick" role="group" aria-label="Empresa"><button class="qbtn" type="button" data-rh-empresa="" aria-pressed="${!R.empresa}">Ambas</button>${todas.map((x) => `<button class="qbtn" type="button" data-rh-empresa="${esc(x)}" aria-pressed="${R.empresa === x}">${esc(x.replace(/ S\.A\.S\.?$/i, ''))}</button>`).join('')}</div>`;
  }
  const sufijoEmp = () => (R.empresa ? ' ' + R.empresa.replace(/ S\.A\.S\.?$/i, '') : '');

  // ---------- datos ----------
  function base() { return { param: { ...PARAM_DEF }, empleados: [], periodos: {}, cambios: [] }; }
  async function leer() {
    const f = await GH.leer(R_RRHH);
    R.sha = f ? f.sha : null;
    R.datos = f ? await Cripto.descifrarJSON(A.maestra, f.bytes) : base();
    const d = R.datos;
    d.param = { ...PARAM_DEF, ...(d.param || {}), rec: { ...PARAM_DEF.rec, ...((d.param || {}).rec || {}) }, arl: { ...PARAM_DEF.arl, ...((d.param || {}).arl || {}) } };
    d.empleados = d.empleados || []; d.periodos = d.periodos || {}; d.cambios = d.cambios || [];
    d.documentos = d.documentos || []; d.suspensiones = d.suspensiones || [];
    R.leido = Date.now();
  }
  async function mutar(fn) {
    for (let i = 0; i < 4; i++) {
      await leer();
      if (fn(R.datos) === false) return false;
      try { R.sha = await GH.escribir(R_RRHH, await Cripto.cifrarJSON(A.maestra, R.datos), R.sha); return true; }
      catch (e) { if (i === 3) throw e; await new Promise((ok) => setTimeout(ok, 700)); }
    }
  }
  const quien = (id) => (id === A.uid ? (((A.conf.usuarios || {})[id] || {}).nombre || 'Tú') : personName(id));
  function anotar(d, c) { d.cambios.push({ en: new Date().toISOString(), por: A.uid, ...c }); if (d.cambios.length > 3000) d.cambios = d.cambios.slice(-3000); }

  // ---------- fechas y quincenas ----------
  const hoy = () => todayISO();
  const mesActual = () => hoy().slice(0, 7);
  const claveQ = (mes, q) => `${mes}-Q${q}`;
  const nombreMes = (mes) => { const [y, m] = mes.split('-').map(Number); const s = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 15)); return s.charAt(0).toUpperCase() + s.slice(1); };
  const nombreQ = (mes, q) => `${q === 1 ? '1 al 15' : '16 al 30'} de ${nombreMes(mes).toLowerCase()}`;
  const activo = (e) => !e.retiro || e.retiro >= hoy();
  // Días de la quincena según ingreso y retiro (mes comercial de 30 días)
  function diasBase(e, mes, q) {
    const ini = q === 1 ? 1 : 16, fin = q === 1 ? 15 : 30;
    let desde = ini, hasta = fin;
    if (e.ingreso) { if (e.ingreso.slice(0, 7) > mes) return 0; if (e.ingreso.slice(0, 7) === mes) desde = Math.max(ini, Math.min(30, Number(e.ingreso.slice(8)))); }
    if (e.retiro) { if (e.retiro.slice(0, 7) < mes) return 0; if (e.retiro.slice(0, 7) === mes) hasta = Math.min(fin, Math.min(30, Number(e.retiro.slice(8)))); }
    return Math.max(0, hasta - desde + 1);
  }
  // Empleados de una quincena: si está cerrada, los que quedaron guardados; si no, los que tienen días
  function empleadosDe(mes, q) {
    const p = R.datos.periodos[claveQ(mes, q)];
    if (p && p.estado === 'cerrado' && p.snap) return Object.values(p.snap);
    return R.datos.empleados.filter((e) => diasBase(e, mes, q) > 0);
  }
  function filaDe(e, mes, q) {
    const p = R.datos.periodos[claveQ(mes, q)] || {};
    const f = (p.filas || {})[e.id] || {};
    const out = { dias: diasBase(e, mes, q) };
    for (const [k] of [...DIAS, ...HORAS, ...DINERO]) if (k !== 'dias') out[k] = 0;
    return { ...out, ...f };
  }

  // ---------- cálculo (igual al Excel de nómina) ----------
  function calcular(e, f) {
    const P = R.datos.param, sal = Number(e.salario) || 0;
    const n = (k) => Number(f[k]) || 0;
    const diasTrab = Math.max(0, n('dias') - n('inc') - n('vac') - n('lr') - n('lnr') - n('sus'));
    const dia = sal / 30, hora = sal / (P.horasMes || 210);
    const salario = dia * diasTrab, vac = dia * n('vac'), lr = dia * n('lr');
    const inc = Math.max(dia * P.incapacidadPct / 100, P.smmlv / 30) * n('inc');
    const he = hora * (n('hed') * (1 + P.rec.hed / 100) + n('hen') * (1 + P.rec.hen / 100) + n('hedf') * (1 + P.rec.hedf / 100) + n('henf') * (1 + P.rec.henf / 100))
      + hora * (n('rn') * P.rec.rn / 100 + n('rdf') * P.rec.rdf / 100);
    const aux = e.aux !== false && sal <= 2 * P.smmlv ? (P.aux / 30) * diasTrab : 0;
    const ibc = salario + vac + lr + inc + he;
    const devengado = ibc + aux + n('otros');
    const salud = Math.round(ibc * P.saludEmp / 100), pension = Math.round(ibc * P.pensionEmp / 100);
    const fsp = sal >= 4 * P.smmlv ? Math.round(ibc * 0.01) : 0;
    // Como en el Excel: el total se redondea una sola vez (no la suma de valores ya redondeados)
    const deducciones = Math.round(ibc * (P.saludEmp + P.pensionEmp) / 100 + (sal >= 4 * P.smmlv ? ibc * 0.01 : 0)) + n('prestamos') + n('otrasDed');
    return { diasTrab, salario: Math.round(salario), vac: Math.round(vac), lr: Math.round(lr), inc: Math.round(inc), he: Math.round(he), aux: Math.round(aux), otros: n('otros'),
      ibc: Math.round(ibc), devengado: Math.round(devengado), salud, pension, fsp, prestamos: n('prestamos'), otrasDed: n('otrasDed'), deducciones, neto: Math.round(devengado) - deducciones };
  }
  const arriba100 = (v) => Math.ceil(v / 100) * 100;
  // Planilla del mes: suma las dos quincenas
  function planillaMes(mes) {
    const P = R.datos.param, porEmp = new Map();
    for (const q of [1, 2]) for (const e of empleadosDe(mes, q)) {
      const f = filaDe(e, mes, q), c = calcular(e, f);
      const x = porEmp.get(e.cedula || e.id) || { e, dias: [0, 0], ibc: [0, 0], inc: 0, vac: 0, lr: 0, lnr: 0, sus: 0, he: 0 };
      x.dias[q - 1] = Math.max(0, (Number(f.dias) || 0) - (Number(f.lnr) || 0) - (Number(f.sus) || 0)); x.ibc[q - 1] = c.ibc;
      x.inc += Number(f.inc) || 0; x.vac += Number(f.vac) || 0; x.lr += Number(f.lr) || 0; x.lnr += Number(f.lnr) || 0; x.sus += Number(f.sus) || 0; x.he += c.he;
      porEmp.set(e.cedula || e.id, x);
    }
    return [...porEmp.values()].map((x) => {
      const e = x.e, sal = Number(e.salario) || 0, dias = Math.min(30, x.dias[0] + x.dias[1]);
      const ibc = Math.max(x.ibc[0] + x.ibc[1], Math.round(P.smmlv / 30 * dias));
      const exon = P.exonerado && sal < 10 * P.smmlv;
      const pension = arriba100(ibc * P.pension / 100);
      const salud = arriba100(ibc * (exon ? P.saludEmp : P.saludEmp + P.saludEmpresa) / 100);
      const arl = arriba100(ibc * (P.arl[e.riesgo || 1] || 0) / 100);
      const ccf = arriba100(ibc * P.ccf / 100);
      const sena = exon ? 0 : arriba100(ibc * P.sena / 100), icbf = exon ? 0 : arriba100(ibc * P.icbf / 100);
      const total = pension + salud + arl + ccf + sena + icbf;
      const descontado = Math.round(ibc * (P.pensionEmp + P.saludEmp) / 100);
      const ing = e.ingreso && e.ingreso.slice(0, 7) === mes ? e.ingreso : '', ret = e.retiro && e.retiro.slice(0, 7) === mes ? e.retiro : '';
      return { e, diasQ1: x.dias[0], diasQ2: x.dias[1], dias, ibcQ1: x.ibc[0], ibcQ2: x.ibc[1], ibc, pension, salud, arl, ccf, sena, icbf, total, descontado, empresa: total - descontado,
        inc: x.inc, vac: x.vac, lr: x.lr, lnr: x.lnr, sus: x.sus, he: x.he, ing, ret };
    });
  }

  // ---------- pantalla ----------
  async function abrir() {
    if (R.cargando) return;
    if (!R.mes) { const d = new Date(); R.mes = mesActual(); R.q = d.getDate() <= 15 ? 1 : 2; R.mesPla = mesActual(); }
    R.cargando = true;
    $('#rh-cuerpo').innerHTML = '<div class="empty"><h3>Cargando…</h3></div>';
    try { await leer(); render(); }
    catch (e) { $('#rh-cuerpo').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${esc(msgGitHub(e))}</p></div>`; }
    R.cargando = false;
  }
  function render() {
    document.querySelectorAll('[data-rh-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rhTab === R.tab)));
    if (!R.datos) return;
    if (R.tab === 'emp') renderEmpleados();
    else if (R.tab === 'nom') renderNomina();
    else if (R.tab === 'pla') renderPlanilla();
    else if (R.tab === 'doc') renderContratos();
    else renderCambios();
    pintarCampana();
  }
  function sinEmpleados() {
    return `<div class="empty"><h3>Aún no hay empleados</h3><p>${A.isAdmin ? 'Impórtalos desde el Excel de nómina o agrégalos uno por uno.' : 'Cuando la administradora cargue los empleados aparecerán aquí.'}</p>${A.isAdmin ? '<div class="top-actions"><button class="btn" type="button" data-rh="importar">Importar desde Excel</button><button class="btn primary" type="button" data-rh="nuevo">+ Agregar empleado</button></div>' : ''}</div>`;
  }

  // Empleados
  function renderEmpleados() {
    const d = R.datos, P = d.param;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const lista = d.empleados.filter(deEmpresa).filter((e) => R.ver === 'todos' || (R.ver === 'activos' ? activo(e) : !activo(e)))
      .sort((a, b) => String(a.empresa).localeCompare(String(b.empresa)) || String(a.nombre).localeCompare(String(b.nombre)));
    const todos = d.empleados.filter(deEmpresa), act = todos.filter(activo);
    const nomina = act.reduce((s, e) => s + (Number(e.salario) || 0) + (e.aux !== false && e.salario <= 2 * P.smmlv ? P.aux : 0), 0);
    const empresas = [...new Set(lista.map((e) => e.empresa || EMPRESA_DEF))];
    $('#rh-cuerpo').innerHTML = `
      <section class="rep-sum">
        <div class="tile main"><span class="lbl">Empleados activos</span><span class="val">${act.length}</span><span>${[...new Set(act.map((e) => e.empresa || EMPRESA_DEF))].map((x) => `${esc(x)}: ${act.filter((e) => (e.empresa || EMPRESA_DEF) === x).length}`).join(' · ')}</span></div>
        <div class="tile"><span class="lbl">Nómina mensual</span><span class="val">${fmt(nomina)}</span><span>Salarios + auxilio de transporte</span></div>
        <div class="tile"><span class="lbl">Retirados</span><span class="val">${todos.length - act.length}</span></div>
      </section>
      <div class="rh-barra"><div class="grupo">${selEmpresa()}
        <div class="quick"><button class="qbtn" type="button" data-rh-ver="activos" aria-pressed="${R.ver === 'activos'}">Activos</button><button class="qbtn" type="button" data-rh-ver="retirados" aria-pressed="${R.ver === 'retirados'}">Retirados</button><button class="qbtn" type="button" data-rh-ver="todos" aria-pressed="${R.ver === 'todos'}">Todos</button></div>
      </div><div class="grupo">${A.isAdmin ? '<button class="btn" type="button" data-rh="importar">Importar desde Excel</button>' : ''}<button class="btn" type="button" data-rh="xls-emp">Descargar Excel</button><button class="btn primary" type="button" data-rh="nuevo">+ Agregar empleado</button></div></div>
      ${empresas.map((emp) => {
        const es = lista.filter((e) => (e.empresa || EMPRESA_DEF) === emp);
        return `<h3 class="rh-empresa">${esc(emp)} · ${es.length}</h3><div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th>Cargo</th><th class="n">Salario</th><th>Riesgo ARL</th><th>Ingreso</th><th>EPS / Pensión</th><th>Estado</th><th></th></tr></thead><tbody>
          ${es.map((e) => { const nd = d.documentos.filter((x) => x.empId === e.id).length; return `<tr class="click" data-rh-emp="${esc(e.id)}"><td><span class="emp">${esc(e.nombre)}</span><br><span class="sub">C.C. ${esc(e.cedula)}${e.contrato ? ' · ' + esc(e.contrato) : ''}${e.contratoFin && tipoDe(e) === 'fijo' ? ' hasta ' + esc(fmtDate(e.contratoFin)) : ''}</span></td><td>${esc(e.cargo || '—')}</td><td class="n">${fmt(e.salario)}</td><td>${['', 'I', 'II', 'III', 'IV', 'V'][e.riesgo || 1]}</td><td>${e.ingreso ? esc(fmtDate(e.ingreso)) : '—'}</td><td>${esc([e.eps, e.afp].filter(Boolean).join(' / ') || '—')}</td><td>${activo(e) ? '<span class="chip sg-ok">Activo</span>' : `<span class="chip sg-no">Retirado ${esc(fmtDate(e.retiro))}</span>`}</td><td class="acc"><button class="btn" type="button" data-rh-docs="${esc(e.id)}">Documentos${nd ? ` (${nd})` : ''}</button></td></tr>`; }).join('')}
          <tr class="tot"><td>Total</td><td></td><td class="n">${fmt(es.reduce((s, e) => s + (Number(e.salario) || 0), 0))}</td><td colspan="5"></td></tr>
        </tbody></table></div>`;
      }).join('') || '<div class="empty"><p>No hay empleados en esta lista.</p></div>'}`;
  }

  // Nómina quincenal
  function renderNomina() {
    const d = R.datos;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const p = d.periodos[claveQ(R.mes, R.q)] || {};
    const cerrado = p.estado === 'cerrado';
    const emps = empleadosDe(R.mes, R.q).filter(deEmpresa);
    const empresas = [...new Set(emps.map((e) => e.empresa || EMPRESA_DEF))];
    const dis = cerrado ? ' disabled' : '';
    const modificados = new Set(d.cambios.filter((c) => c.periodo === claveQ(R.mes, R.q)).map((c) => c.empId + '|' + c.campo));
    const inp = (e, f, k, cls) => `<input class="rh-in ${cls || ''}${modificados.has(e.id + '|' + k) ? ' mod' : ''}" data-rh-in="${k}" data-rh-e="${esc(e.id)}" value="${esc(k === 'nota' ? (f.nota || '') : (Number(f[k]) || 0) ? (cls === 'din' ? Math.round(f[k]).toLocaleString('es-CO') : String(f[k]).replace('.', ',')) : '')}" inputmode="${k === 'nota' ? 'text' : 'decimal'}" placeholder="${k === 'nota' ? '' : '0'}" title="${esc(NOMBRE_CAMPO[k])}"${dis}>`;
    let granTotal = { devengado: 0, deducciones: 0, neto: 0 };
    const bloques = empresas.map((emp) => {
      const es = emps.filter((e) => (e.empresa || EMPRESA_DEF) === emp).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
      const tot = { salario: 0, aux: 0, he: 0, otros: 0, devengado: 0, salud: 0, pension: 0, deducciones: 0, neto: 0, nov: 0 };
      const filas = es.map((e) => {
        const f = filaDe(e, R.mes, R.q), c = calcular(e, f);
        for (const k of Object.keys(tot)) if (k !== 'nov') tot[k] += c[k] || 0;
        tot.nov += c.vac + c.lr + c.inc;
        return `<tr><td><span class="emp">${esc(e.nombre)}</span><br><span class="sub">${esc(e.cargo || '')} · ${fmt(e.salario)}</span></td>
          ${DIAS.map(([k]) => `<td class="n">${inp(e, f, k)}</td>`).join('')}<td class="n"><b>${c.diasTrab}</b></td>
          ${HORAS.map(([k]) => `<td class="n">${inp(e, f, k)}</td>`).join('')}
          <td class="n">${inp(e, f, 'otros', 'din')}</td>
          <td class="n">${fmt(c.salario)}</td><td class="n">${fmt(c.vac + c.lr + c.inc)}</td><td class="n">${fmt(c.he)}</td><td class="n">${fmt(c.aux)}</td><td class="n"><b>${fmt(c.devengado)}</b></td>
          <td class="n">${fmt(c.salud)}</td><td class="n">${fmt(c.pension + c.fsp)}</td><td class="n">${inp(e, f, 'prestamos', 'din')}</td><td class="n">${inp(e, f, 'otrasDed', 'din')}</td><td class="n"><b>${fmt(c.neto)}</b></td>
          <td>${inp(e, f, 'nota', 'nota')}</td></tr>`;
      }).join('');
      granTotal.devengado += tot.devengado; granTotal.deducciones += tot.deducciones; granTotal.neto += tot.neto;
      return `<h3 class="rh-empresa">${esc(emp)} · ${es.length} ${es.length === 1 ? 'empleado' : 'empleados'}</h3><div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th>
        ${DIAS.map(([, l]) => `<th class="n">${l}</th>`).join('')}<th class="n">Días trab.</th>${HORAS.map(([, l]) => `<th class="n">${l}</th>`).join('')}<th class="n">Otros pagos</th>
        <th class="n">Salario</th><th class="n">Vac/Lic/Inc</th><th class="n">Horas extra</th><th class="n">Aux. transp.</th><th class="n">Devengado</th><th class="n">Salud 4%</th><th class="n">Pensión 4%</th><th class="n">Préstamos</th><th class="n">Otras deduc.</th><th class="n">Neto a pagar</th><th>Nota</th></tr></thead><tbody>${filas}
        <tr class="tot"><td>Total</td><td colspan="${DIAS.length + 1 + HORAS.length}"></td><td class="n">${fmt(tot.otros)}</td><td class="n">${fmt(tot.salario)}</td><td class="n">${fmt(tot.nov)}</td><td class="n">${fmt(tot.he)}</td><td class="n">${fmt(tot.aux)}</td><td class="n">${fmt(tot.devengado)}</td><td class="n">${fmt(tot.salud)}</td><td class="n">${fmt(tot.pension)}</td><td colspan="2"></td><td class="n">${fmt(tot.neto)}</td><td></td></tr>
        </tbody></table></div>`;
    }).join('');
    $('#rh-cuerpo').innerHTML = `
      <div class="rh-barra"><div class="grupo">${selEmpresa()}
        <div class="field"><label for="rh-mes">Mes</label><input type="month" id="rh-mes" value="${esc(R.mes)}"></div>
        <div class="quick"><button class="qbtn" type="button" data-rh-q="1" aria-pressed="${R.q === 1}">1 al 15</button><button class="qbtn" type="button" data-rh-q="2" aria-pressed="${R.q === 2}">16 al 30</button></div>
        <span class="rh-estado ${cerrado ? 'cerrado' : 'borrador'}">${cerrado ? `Cerrada${p.cerradoPor ? ' por ' + esc(quien(p.cerradoPor)) : ''}` : 'Borrador · se puede modificar'}</span>
      </div><div class="grupo"><button class="btn" type="button" data-rh="xls-nom">Descargar Excel</button>${A.isAdmin ? (cerrado ? '<button class="btn" type="button" data-rh="reabrir">Reabrir quincena</button>' : '<button class="btn primary" type="button" data-rh="cerrar">Cerrar quincena</button>') : ''}</div></div>
      <p class="rep-note" style="margin-top:0">Quincena del ${esc(nombreQ(R.mes, R.q))}. Escribe los días, horas y valores en las casillas; cada cambio se guarda solo y queda en <b>Cambios</b> con tu nombre. Las casillas en amarillo fueron modificadas. Días trabajados = días de la quincena − incapacidad − vacaciones − licencias − suspensión. Al marcar días de <b>suspensión</b> la app te pide la fecha inicial y hace el memorando.</p>
      ${bloques || '<div class="empty"><p>No hay empleados con días en esta quincena.</p></div>'}
      <section class="rep-sum"><div class="tile main"><span class="lbl">Neto a pagar quincena</span><span class="val">${fmt(granTotal.neto)}</span><span>Devengado ${fmt(granTotal.devengado)} − deducciones ${fmt(granTotal.deducciones)}</span></div></section>`;
  }

  // Novedades del mes y planilla
  function renderPlanilla() {
    const d = R.datos;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const filas = planillaMes(R.mesPla).filter((x) => deEmpresa(x.e));
    const empresas = [...new Set(filas.map((x) => x.e.empresa || EMPRESA_DEF))];
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
    const novedad = (x) => [x.ing && `Ingreso ${fmtDate(x.ing)}`, x.ret && `Retiro ${fmtDate(x.ret)}`, x.inc && `Incapacidad ${x.inc} d`, x.vac && `Vacaciones ${x.vac} d`, x.lr && `Lic. remunerada ${x.lr} d`, x.lnr && `Lic. no remunerada ${x.lnr} d`, x.sus && `Suspensión ${x.sus} d`, x.he && `Horas extra ${fmt(x.he)}`].filter(Boolean).join(' · ');
    const qs = [1, 2].map((q) => (d.periodos[claveQ(R.mesPla, q)] || {}).estado === 'cerrado');
    $('#rh-cuerpo').innerHTML = `
      <div class="rh-barra"><div class="grupo">${selEmpresa()}<div class="field"><label for="rh-mespla">Mes</label><input type="month" id="rh-mespla" value="${esc(R.mesPla)}"></div>
        <span class="rh-estado ${qs[0] && qs[1] ? 'cerrado' : 'borrador'}">${qs[0] && qs[1] ? 'Las dos quincenas cerradas' : 'Borrador: falta cerrar ' + (qs[0] ? 'la 2.ª quincena' : qs[1] ? 'la 1.ª quincena' : 'las quincenas')}</span></div>
        <div class="grupo"><button class="btn" type="button" data-rh="xls-nov">Reporte de novedades</button><button class="btn primary" type="button" data-rh="xls-pla">Borrador de planilla</button></div></div>
      <section class="rep-sum">
        <div class="tile main"><span class="lbl">Total planilla ${esc(nombreMes(R.mesPla).toLowerCase())}</span><span class="val">${fmt(sum(filas, 'total'))}</span><span>Descontado a empleados ${fmt(sum(filas, 'descontado'))}</span></div>
        <div class="tile"><span class="lbl">Costo empresa</span><span class="val">${fmt(sum(filas, 'empresa'))}</span></div>
        <div class="tile"><span class="lbl">Cotizantes</span><span class="val">${filas.length}</span></div>
      </section>
      ${empresas.map((emp) => {
        const fs = filas.filter((x) => (x.e.empresa || EMPRESA_DEF) === emp).sort((a, b) => String(a.e.nombre).localeCompare(String(b.e.nombre)));
        return `<h3 class="rh-empresa">${esc(emp)}</h3><div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th class="n">Riesgo</th><th class="n">Días Q1</th><th class="n">Días Q2</th><th class="n">Días cot.</th><th class="n">IBC mes</th><th class="n">Pensión 16%</th><th class="n">Salud</th><th class="n">ARL</th><th class="n">Caja 4%</th><th class="n">SENA/ICBF</th><th class="n">Total</th><th class="n">Descontado</th><th class="n">Empresa</th><th>Novedades</th></tr></thead><tbody>
          ${fs.map((x) => `<tr><td><span class="emp">${esc(x.e.nombre)}</span><br><span class="sub">C.C. ${esc(x.e.cedula)}</span></td><td class="n">${['', 'I', 'II', 'III', 'IV', 'V'][x.e.riesgo || 1]}</td><td class="n">${x.diasQ1}</td><td class="n">${x.diasQ2}</td><td class="n">${x.dias}</td><td class="n">${fmt(x.ibc)}</td><td class="n">${fmt(x.pension)}</td><td class="n">${fmt(x.salud)}</td><td class="n">${fmt(x.arl)}</td><td class="n">${fmt(x.ccf)}</td><td class="n">${fmt(x.sena + x.icbf)}</td><td class="n"><b>${fmt(x.total)}</b></td><td class="n">${fmt(x.descontado)}</td><td class="n">${fmt(x.empresa)}</td><td>${esc(novedad(x)) || '—'}</td></tr>`).join('')}
          <tr class="tot"><td>Subtotal</td><td colspan="4"></td><td class="n">${fmt(sum(fs, 'ibc'))}</td><td class="n">${fmt(sum(fs, 'pension'))}</td><td class="n">${fmt(sum(fs, 'salud'))}</td><td class="n">${fmt(sum(fs, 'arl'))}</td><td class="n">${fmt(sum(fs, 'ccf'))}</td><td class="n">${fmt(sum(fs, 'sena') + sum(fs, 'icbf'))}</td><td class="n">${fmt(sum(fs, 'total'))}</td><td class="n">${fmt(sum(fs, 'descontado'))}</td><td class="n">${fmt(sum(fs, 'empresa'))}</td><td></td></tr>
        </tbody></table></div>`;
      }).join('')}
      <p class="rep-note">Cálculo como en tu Excel: IBC = salario de los días + vacaciones, licencias, incapacidades y horas extra (sin auxilio ni otros pagos); aportes redondeados a la centena; empresa exonerada de salud 8,5 %, SENA e ICBF (art. 114-1 E.T.) para quienes ganan menos de 10 salarios mínimos. Es un <b>borrador</b>: revísalo antes de pagar la planilla.</p>`;
  }

  // Cambios
  function renderCambios() {
    const d = R.datos;
    const emp = new Map(d.empleados.map((e) => [e.id, e.nombre]));
    const lista = d.cambios.slice().reverse().slice(0, 400);
    const texto = (c) => {
      if (c.tipo === 'empleado') return `${c.accion === 'nuevo' ? 'Agregó al empleado' : c.accion === 'importar' ? 'Importó desde Excel a' : 'Modificó al empleado'} <b>${esc(emp.get(c.empId) || c.nombre || '')}</b>${c.campo ? `: ${esc(c.campo)} de <b>${esc(String(c.antes ?? '—'))}</b> a <b>${esc(String(c.despues ?? '—'))}</b>` : ''}`;
      if (c.tipo === 'documento') return `Generó <b>${esc(c.titulo || '')}</b> de <b>${esc(emp.get(c.empId) || c.nombre || '')}</b>`;
      if (c.tipo === 'firmado') return `Subió firmado: <b>${esc(c.titulo || '')}</b> de <b>${esc(emp.get(c.empId) || '')}</b>`;
      if (c.tipo === 'prorroga') return `Registró que <b>${esc(emp.get(c.empId) || '')}</b> continúa: contrato prorrogado del ${esc(fmtDate(c.antes))} al <b>${esc(fmtDate(c.despues))}</b>`;
      if (c.tipo === 'suspension') return `Registró suspensión de <b>${esc(emp.get(c.empId) || '')}</b>: ${esc(c.texto || '')}`;
      if (c.tipo === 'periodo') return `${c.accion === 'cerrar' ? 'Cerró' : 'Reabrió'} la quincena del ${esc(nombreQ(c.periodo.slice(0, 7), Number(c.periodo.slice(-1))))}`;
      const v = (x) => (DINERO.some(([k]) => k === c.campo) ? fmt(x) : c.campo === 'nota' ? `“${x || ''}”` : String(x || 0));
      return `Quincena del ${esc(nombreQ(c.periodo.slice(0, 7), Number(c.periodo.slice(-1))))} · <b>${esc(emp.get(c.empId) || '')}</b>: ${esc(NOMBRE_CAMPO[c.campo] || c.campo)} de <b>${esc(v(c.antes))}</b> a <b>${esc(v(c.despues))}</b>`;
    };
    $('#rh-cuerpo').innerHTML = lista.length
      ? `<p class="rep-note" style="margin-top:14px">Todo cambio en empleados o en la nómina queda aquí con quién lo hizo y cuándo. Últimos ${lista.length}.</p><ul class="rh-log">${lista.map((c) => `<li>${texto(c)}${c.nota ? ` — <i>${esc(c.nota)}</i>` : ''}<small>${esc(quien(c.por))} · ${esc(dtFmt.format(new Date(c.en)))}</small></li>`).join('')}</ul>`
      : '<div class="empty"><h3>Sin cambios todavía</h3><p>Cuando alguien modifique un empleado o la nómina, quedará registrado aquí.</p></div>';
  }

  // ---------- edición de la quincena ----------
  async function guardarCampo(empId, campo, valorTxt, el) {
    const clave = claveQ(R.mes, R.q);
    const valor = campo === 'nota' ? String(valorTxt || '').trim() : (DINERO.some(([k]) => k === campo) ? (parseMonto(valorTxt) || 0) : (Number(String(valorTxt || '0').replace(',', '.')) || 0));
    if (campo !== 'nota' && (!isFinite(valor) || valor < 0)) { toast('Escribe un número válido.'); render(); return; }
    if (DIAS.some(([k]) => k === campo) && valor > 15) { toast('Una quincena tiene máximo 15 días.'); render(); return; }
    if (campo === 'sus' && !Number.isInteger(valor)) { toast('Los días de suspensión van en números enteros.'); render(); return; }
    el.disabled = true;
    let previo = null;
    try {
      let msg = '';
      await mutar((d) => {
        previo = null;
        const p = d.periodos[clave] = d.periodos[clave] || { estado: 'borrador', filas: {} };
        if (p.estado === 'cerrado') { msg = 'Esta quincena ya fue cerrada.'; return false; }
        const e = d.empleados.find((x) => x.id === empId);
        if (!e) { msg = 'El empleado ya no existe.'; return false; }
        p.filas = p.filas || {};
        const antes = filaDe(e, R.mes, R.q)[campo];
        if (String(antes ?? '') === String(valor)) return false;
        p.filas[empId] = { ...(p.filas[empId] || {}), [campo]: valor };
        anotar(d, { tipo: 'nomina', periodo: clave, empId, campo, antes: antes ?? '', despues: valor });
        previo = Number(antes) || 0;
      });
      if (msg) toast(msg);
    } catch (e) { toast('No se guardó: ' + msgGitHub(e)); }
    render();
    // Primera vez que se marcan días de suspensión en esta quincena: pedir datos y hacer el memorando
    if (campo === 'sus' && valor > 0 && previo === 0) abrirSuspension(empId, valor, clave);
  }
  async function cerrarQuincena(cerrar) {
    const clave = claveQ(R.mes, R.q);
    try {
      await mutar((d) => {
        const p = d.periodos[clave] = d.periodos[clave] || { estado: 'borrador', filas: {} };
        if (cerrar) {
          // Se guarda una copia de los empleados para que la quincena no cambie si después cambia un salario
          p.snap = Object.fromEntries(empleadosDe(R.mes, R.q).map((e) => [e.id, { ...e }]));
          p.estado = 'cerrado'; p.cerradoPor = A.uid; p.cerradoEn = new Date().toISOString();
        } else { p.estado = 'borrador'; delete p.snap; }
        anotar(d, { tipo: 'periodo', periodo: clave, accion: cerrar ? 'cerrar' : 'reabrir' });
      });
      toast(cerrar ? 'Quincena cerrada.' : 'Quincena reabierta: ya se puede modificar.');
    } catch (e) { toast(msgGitHub(e)); }
    render();
  }

  // ---------- empleado: agregar / editar ----------
  let editando = null;
  const CAMPOS_EMP = { nombre: 'Nombre', cedula: 'Cédula', empresa: 'Empresa', cargo: 'Cargo', contrato: 'Tipo de contrato', salario: 'Salario', riesgo: 'Riesgo ARL', aux: 'Auxilio de transporte', ingreso: 'Ingreso', cc: 'Centro de costo', eps: 'EPS', afp: 'Pensión', retiro: 'Retiro', motivoRetiro: 'Motivo del retiro',
    sexo: 'Sexo', expedida: 'Cédula expedida en', telefono: 'Teléfono', direccion: 'Dirección', contratoFin: 'Fin del contrato', obra: 'Obra o labor', prueba: 'Período de prueba (días)', horario: 'Horario', lugar: 'Lugar de trabajo', funciones: 'Funciones', arl: 'ARL', ccf: 'Caja de compensación', cesantias: 'Fondo de cesantías' };
  const TEXTOS_EMP = ['sexo', 'expedida', 'telefono', 'direccion', 'contratoFin', 'obra', 'prueba', 'horario', 'lugar', 'funciones', 'arl', 'ccf', 'cesantias'];
  const ID_CAMPO = { contratoFin: 'emp-fin' };
  function mostrarCamposContrato() {
    const t = Docs().tipoContrato({ contrato: $('#emp-contrato').value });
    $('#emp-fin-wrap').hidden = t !== 'fijo'; $('#emp-obra-wrap').hidden = t !== 'obra';
  }
  function abrirEmpleado(id) {
    const e = id ? R.datos.empleados.find((x) => x.id === id) : null;
    editando = e ? e.id : null;
    for (const k of TEXTOS_EMP) $('#' + (ID_CAMPO[k] || 'emp-' + k)).value = e ? e[k] || '' : '';
    $('#emp-gen-wrap').hidden = !!e; $('#emp-gen').checked = true; $('#emp-docs').hidden = !e;
    $('#emp-titulo').textContent = e ? e.nombre : 'Agregar empleado';
    $('#emp-nombre').value = e ? e.nombre : ''; $('#emp-cedula').value = e ? e.cedula : '';
    $('#emp-empresa').value = e ? e.empresa || '' : EMPRESA_DEF; $('#emp-cargo').value = e ? e.cargo || '' : '';
    $('#emp-contrato').value = e ? e.contrato || '' : ''; $('#emp-salario').value = e ? Math.round(e.salario).toLocaleString('es-CO') : '';
    $('#emp-riesgo').value = String(e ? e.riesgo || 1 : 1); $('#emp-aux').checked = e ? e.aux !== false : true;
    $('#emp-ingreso').value = e ? e.ingreso || '' : ''; $('#emp-cc').value = e ? e.cc || '' : '';
    $('#emp-eps').value = e ? e.eps || '' : ''; $('#emp-afp').value = e ? e.afp || '' : '';
    $('#emp-retiro').value = e ? e.retiro || '' : ''; $('#emp-motivo').value = e ? e.motivoRetiro || '' : ''; $('#emp-nota').value = '';
    $('#emp-empresas').innerHTML = [...new Set([EMPRESA_DEF, 'OBS', ...R.datos.empleados.map((x) => x.empresa).filter(Boolean)])].map((x) => `<option value="${esc(x)}"></option>`).join('');
    mostrarError('#emp-err', '');
    mostrarCamposContrato();
    $('#dlg-emp').showModal();
  }
  $('#emp-contrato').addEventListener('change', mostrarCamposContrato);
  $('#emp-docs').addEventListener('click', () => { const id = editando; $('#dlg-emp').close(); abrirDocs(id); });
  $('#emp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nuevo = {
      nombre: $('#emp-nombre').value.trim().toUpperCase(), cedula: $('#emp-cedula').value.replace(/\D/g, ''), empresa: $('#emp-empresa').value.trim() || EMPRESA_DEF,
      cargo: $('#emp-cargo').value.trim(), contrato: $('#emp-contrato').value, salario: Math.round(parseMonto($('#emp-salario').value) || 0), riesgo: Number($('#emp-riesgo').value) || 1,
      aux: $('#emp-aux').checked, ingreso: $('#emp-ingreso').value, cc: $('#emp-cc').value.trim(), eps: $('#emp-eps').value.trim(), afp: $('#emp-afp').value.trim(),
      retiro: $('#emp-retiro').value, motivoRetiro: $('#emp-motivo').value.trim(),
    };
    for (const k of TEXTOS_EMP) nuevo[k] = $('#' + (ID_CAMPO[k] || 'emp-' + k)).value.trim();
    nuevo.prueba = nuevo.prueba ? String(Number(nuevo.prueba.replace(/\D/g, '')) || '') : '';
    const tipo = Docs().tipoContrato(nuevo);
    if (tipo !== 'fijo') nuevo.contratoFin = '';
    if (tipo !== 'obra') nuevo.obra = '';
    const nota = $('#emp-nota').value.trim();
    const generar = !editando && $('#emp-gen').checked;
    if (!nuevo.nombre) return mostrarError('#emp-err', 'Escribe el nombre.');
    if (!nuevo.cedula) return mostrarError('#emp-err', 'Escribe la cédula.');
    if (!(nuevo.salario > 0)) return mostrarError('#emp-err', 'Escribe el salario mensual.');
    if (nuevo.retiro && nuevo.ingreso && nuevo.retiro < nuevo.ingreso) return mostrarError('#emp-err', 'La fecha de retiro no puede ser antes del ingreso.');
    if (nuevo.contratoFin && nuevo.ingreso && nuevo.contratoFin <= nuevo.ingreso) return mostrarError('#emp-err', 'La fecha de terminación del contrato debe ser después del ingreso.');
    if (generar) {
      if (!tipo) return mostrarError('#emp-err', 'Para generar el contrato escoge el tipo: término indefinido, término fijo u obra o labor. (O quita el visto de “Generar el contrato”.)');
      if (!nuevo.ingreso) return mostrarError('#emp-err', 'Para el contrato falta la fecha de ingreso.');
      if (tipo === 'fijo' && !nuevo.contratoFin) return mostrarError('#emp-err', 'Para el contrato a término fijo falta la fecha de terminación.');
      if (tipo === 'obra' && !nuevo.obra) return mostrarError('#emp-err', 'Para el contrato por obra o labor describe la obra o labor contratada.');
      if (!nuevo.sexo) return mostrarError('#emp-err', 'Escoge el sexo: el contrato dice “EL TRABAJADOR” o “LA TRABAJADORA”.');
    }
    const b = $('#emp-guardar'); b.disabled = true;
    let idGuardado = editando, retiroNuevo = false;
    try {
      let msg = '';
      await mutar((d) => {
        retiroNuevo = false;
        if (d.empleados.some((x) => x.cedula === nuevo.cedula && x.id !== editando)) { msg = 'Ya hay un empleado con esa cédula.'; return false; }
        if (editando) {
          const e = d.empleados.find((x) => x.id === editando);
          if (!e) { msg = 'El empleado ya no existe.'; return false; }
          let hubo = false;
          for (const k of Object.keys(CAMPOS_EMP)) {
            const a = e[k] ?? '', n = nuevo[k] ?? '';
            if (String(a) !== String(n)) { anotar(d, { tipo: 'empleado', accion: 'editar', empId: e.id, campo: CAMPOS_EMP[k], antes: k === 'salario' ? fmt(a) : a, despues: k === 'salario' ? fmt(n) : n, nota }); hubo = true; }
          }
          if (!hubo) return false;
          retiroNuevo = !!nuevo.retiro && nuevo.retiro !== (e.retiro || '');
          Object.assign(e, nuevo, { modificado: new Date().toISOString() });
        } else {
          const e = { id: idGuardado || nuevoId(), ...nuevo, creado: new Date().toISOString() };
          idGuardado = e.id;
          d.empleados.push(e);
          anotar(d, { tipo: 'empleado', accion: 'nuevo', empId: e.id, nombre: e.nombre, nota });
        }
      });
      if (msg) { mostrarError('#emp-err', msg); b.disabled = false; return; }
      $('#dlg-emp').close(); toast('Empleado guardado.'); render();
      if (generar) await generarDoc(idGuardado, 'contrato', { tipo });
      if (retiroNuevo) abrirRetiro(idGuardado);
    } catch (e) { mostrarError('#emp-err', msgGitHub(e)); }
    b.disabled = false;
  });

  // ---------- documentos (Word) ----------
  const Docs = () => window.RRHHDocs;
  const URL_DOCX = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js';
  let cargaDocx = null;
  function cargarDocx() {
    if (window.docx) return Promise.resolve();
    if (!cargaDocx) cargaDocx = new Promise((ok, mal) => { const s = document.createElement('script'); s.src = URL_DOCX; s.onload = () => ok(); s.onerror = () => { cargaDocx = null; mal(new Error('No cargó el generador de Word. Revisa el internet y vuelve a intentar.')); }; document.head.appendChild(s); });
    return cargaDocx;
  }
  function bajar(blob, nombre) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre.replace(/[\\/:*?"<>|]/g, '-'); document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  const tipoDe = (e) => Docs().tipoContrato(e);
  const TITULO_DOC = () => Object.fromEntries(Object.entries(Docs().TIPOS).map(([k, t]) => [k, t.titulo]));
  // Genera el documento, lo guarda en el expediente del empleado (los datos con que se hizo) y lo descarga.
  // alGuardar(d, e, docId) permite guardar en la misma escritura la suspensión, el retiro o el preaviso.
  async function generarDoc(empId, tipo, extra, alGuardar) {
    try {
      await cargarDocx();
      const e0 = R.datos.empleados.find((x) => x.id === empId);
      if (!e0) throw new Error('No encontré al empleado.');
      const { documentos, prorrogas, ...copia } = e0;
      const datos = { fechaDoc: hoy(), smmlv: R.datos.param.smmlv, aux: R.datos.param.aux, ...(extra || {}), e: { ...copia, ...((extra || {}).e || {}) } };
      const { nombre, blob } = await Docs().blob(tipo, datos);
      const id = nuevoId();
      await mutar((d) => {
        const e = d.empleados.find((x) => x.id === empId);
        d.documentos.push({ id, empId, tipo, titulo: nombre, en: new Date().toISOString(), por: A.uid, datos });
        anotar(d, { tipo: 'documento', empId, titulo: nombre });
        if (alGuardar && e) alGuardar(d, e, id);
      });
      bajar(blob, nombre + '.docx');
      toast(`Listo: ${nombre}. Quedó guardado en Documentos.`);
      render();
      return id;
    } catch (err) { toast('No se generó el documento: ' + (err && err.message ? err.message : msgGitHub(err))); return null; }
  }
  async function bajarDoc(docId) {
    const doc = R.datos.documentos.find((x) => x.id === docId); if (!doc) return;
    try { await cargarDocx(); const { nombre, blob } = await Docs().blob(doc.tipo, doc.datos); bajar(blob, nombre + '.docx'); }
    catch (err) { toast(err.message || 'No se pudo descargar.'); }
  }

  // Expediente del empleado
  let docsDe = null, firmandoDoc = null;
  const rutaFirmado = (docId) => `datos/rrhh-firmados/${docId}.enc`;
  function abrirDocs(empId) {
    docsDe = empId; pintarDocs(); mostrarError('#docs-err', ''); $('#dlg-docs').showModal();
  }
  function pintarDocs() {
    const e = R.datos.empleados.find((x) => x.id === docsDe); if (!e) return;
    $('#docs-titulo').textContent = `Documentos · ${e.nombre}`;
    const lista = R.datos.documentos.filter((x) => x.empId === docsDe).sort((a, b) => String(b.en).localeCompare(String(a.en)));
    $('#docs-lista').innerHTML = lista.length
      ? `<ul class="rh-docs">${lista.map((x) => `<li><div><div class="tit">${esc(x.titulo)}</div><div class="sub">${esc(dtFmt.format(new Date(x.en)))} · ${esc(quien(x.por))}${x.firmado ? ' · <span class="chip sg-ok">Firmado</span>' : ' · <span class="chip sg-no">Sin firmar</span>'}</div></div>
          <div class="acc"><button class="btn" type="button" data-doc-bajar="${esc(x.id)}">Descargar Word</button>${x.firmado ? `<button class="btn" type="button" data-doc-ver="${esc(x.id)}">Ver firmado</button>` : `<button class="btn" type="button" data-doc-subir="${esc(x.id)}">Subir firmado</button>`}</div></li>`).join('')}</ul>`
      : '<p class="rep-note" style="margin:0">Aún no hay documentos de este empleado. Genera el primero abajo.</p>';
    const t = tipoDe(e);
    $('#docs-tipo').value = t ? 'contrato' : $('#docs-tipo').value;
  }
  $('#dlg-docs').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-doc-bajar], [data-doc-ver], [data-doc-subir]'); if (!b) return;
    if (b.dataset.docBajar) bajarDoc(b.dataset.docBajar);
    else if (b.dataset.docSubir) { firmandoDoc = b.dataset.docSubir; $('#docs-firmado').value = ''; $('#docs-firmado').click(); }
    else if (b.dataset.docVer) {
      const doc = R.datos.documentos.find((x) => x.id === b.dataset.docVer); if (!doc || !doc.firmado) return;
      const w = window.open('', '_blank');
      try {
        const f = await GH.leer(doc.firmado.ruta); if (!f) throw new Error('No encontré el archivo.');
        const url = URL.createObjectURL(new Blob([await Cripto.descifrar(A.maestra, f.bytes)], { type: doc.firmado.tipo || 'application/pdf' }));
        if (w) w.location.href = url; else bajar(new Blob([await Cripto.descifrar(A.maestra, f.bytes)], { type: doc.firmado.tipo }), doc.firmado.nombre || 'firmado.pdf');
      } catch (err) { if (w) w.close(); mostrarError('#docs-err', 'No se pudo abrir: ' + (err.message || msgGitHub(err))); }
    }
  });
  $('#docs-firmado').addEventListener('change', async () => {
    const f = $('#docs-firmado').files[0]; if (!f || !firmandoDoc) return;
    if (f.size > 15 * 1024 * 1024) return mostrarError('#docs-err', 'El archivo pesa más de 15 MB. Escanéalo con menos resolución.');
    mostrarError('#docs-err', '');
    const docId = firmandoDoc; firmandoDoc = null;
    try {
      toast('Subiendo el documento firmado…');
      const ruta = rutaFirmado(docId);
      const prev = await GH.leer(ruta).catch(() => null);
      await GH.escribir(ruta, await Cripto.cifrar(A.maestra, new Uint8Array(await f.arrayBuffer())), prev && prev.sha);
      await mutar((d) => {
        const doc = d.documentos.find((x) => x.id === docId); if (!doc) return false;
        doc.firmado = { ruta, nombre: f.name, tipo: f.type || 'application/pdf', en: new Date().toISOString(), por: A.uid };
        anotar(d, { tipo: 'firmado', empId: doc.empId, titulo: doc.titulo });
      });
      toast('Documento firmado guardado.'); pintarDocs(); render();
    } catch (err) { mostrarError('#docs-err', 'No se subió: ' + msgGitHub(err)); }
  });
  $('#docs-generar').addEventListener('click', async () => {
    const tipo = $('#docs-tipo').value, e = R.datos.empleados.find((x) => x.id === docsDe); if (!e) return;
    mostrarError('#docs-err', '');
    if (tipo === 'suspension') { $('#dlg-docs').close(); abrirSuspension(e.id, 0, null); return; }
    if (tipo === 'terminacion') { $('#dlg-docs').close(); abrirRetiro(e.id); return; }
    if (tipo === 'contrato' && !tipoDe(e)) return mostrarError('#docs-err', 'Primero escoge el tipo de contrato del empleado (tócalo en la lista y edítalo).');
    if (tipo === 'noprorroga') { if (tipoDe(e) !== 'fijo' || !e.contratoFin) return mostrarError('#docs-err', 'El preaviso de no prórroga es para contratos a término fijo con fecha de terminación.'); await notificarNoProrroga(e.id); pintarDocs(); return; }
    let extra = {};
    if (tipo === 'citacion' || tipo === 'acta') {
      const s = R.datos.suspensiones.filter((x) => x.empId === e.id).slice(-1)[0];
      extra = { susp: s && !s.docId ? s : {} };
    }
    const b = $('#docs-generar'); b.disabled = true;
    await generarDoc(e.id, tipo, extra);
    b.disabled = false; pintarDocs();
  });

  // ---------- suspensión ----------
  let susp = null; // { empId, clave, dias }
  const inicioQ = (clave) => (clave ? `${clave.slice(0, 7)}-${clave.endsWith('Q1') ? '01' : '16'}` : hoy());
  function abrirSuspension(empId, dias, clave) {
    const e = R.datos.empleados.find((x) => x.id === empId); if (!e) return;
    susp = { empId, clave, dias };
    const previas = R.datos.suspensiones.filter((x) => x.empId === empId && x.docId).sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
    const ultima = previas[previas.length - 1];
    $('#susp-intro').innerHTML = clave
      ? `Marcaste <b>${dias} ${dias === 1 ? 'día' : 'días'}</b> de suspensión a <b>${esc(e.nombre)}</b> en la quincena del ${esc(nombreQ(clave.slice(0, 7), Number(clave.slice(-1))))}.`
      : `Memorando de suspensión para <b>${esc(e.nombre)}</b>.`;
    // Si ya tiene una suspensión, preguntar si es la misma (no se hace otro memorando) o una nueva
    const pareceMisma = ultima && clave && Docs().sumarDias(ultima.fin, 1) >= inicioQ(clave);
    $('#susp-cual').innerHTML = ultima && clave ? `<div class="rh-cual">
        <label><input type="radio" name="susp-cual" value="misma"${pareceMisma ? ' checked' : ''}> <span><b>Es la misma suspensión</b> del ${esc(fmtDate(ultima.inicio))} al ${esc(fmtDate(ultima.fin))} (${ultima.dias} días). No se hace otro memorando.</span></label>
        <label><input type="radio" name="susp-cual" value="nueva"${pareceMisma ? '' : ' checked'}> <span><b>Es una suspensión nueva.</b> Se hace un memorando nuevo.</span></label></div>` : '';
    $('#susp-inicio').value = clave ? (pareceMisma ? '' : inicioQ(clave)) : hoy();
    $('#susp-dias').value = dias ? String(dias) : '';
    $('#susp-hechos').value = ''; $('#susp-falta').value = ''; $('#susp-descargos').value = '';
    const pend = R.datos.suspensiones.filter((x) => x.empId === empId && !x.docId).slice(-1)[0];
    if (pend) { $('#susp-hechos').value = pend.hechos || ''; $('#susp-falta').value = pend.falta || ''; $('#susp-descargos').value = pend.descargosFecha || ''; }
    mostrarError('#susp-err', '');
    pintarSusp(); $('#dlg-susp').showModal();
  }
  function pintarSusp() {
    const misma = (document.querySelector('input[name="susp-cual"]:checked') || {}).value === 'misma';
    $('#susp-form').querySelectorAll('.field').forEach((f) => { f.hidden = misma; });
    $('#susp-go').textContent = misma ? 'Guardar (sin memorando nuevo)' : 'Guardar y generar memorando';
    const ini = $('#susp-inicio').value, n = Number($('#susp-dias').value) || 0;
    $('#susp-fin').textContent = ini && n ? `Termina el ${fmtDate(Docs().sumarDias(ini, n - 1))}; regresa el ${fmtDate(Docs().sumarDias(ini, n))}.` : 'Primera vez: máximo 8 días; si reincide, hasta 2 meses (art. 112 CST).';
  }
  $('#dlg-susp').addEventListener('change', pintarSusp);
  $('#dlg-susp').addEventListener('input', (ev) => { if (ev.target.id === 'susp-dias' || ev.target.id === 'susp-inicio') pintarSusp(); });
  $('#dlg-susp').addEventListener('close', () => { if (susp && susp.clave && !susp.listo) toast('Quedaron los días de suspensión, pero sin memorando. Lo puedes hacer desde Documentos del empleado.'); susp = null; });
  $('#susp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); if (!susp) return;
    const s = susp, b = $('#susp-go');
    const misma = (document.querySelector('input[name="susp-cual"]:checked') || {}).value === 'misma';
    if (misma) {
      const ultima = R.datos.suspensiones.filter((x) => x.empId === s.empId && x.docId).sort((a, b) => String(a.inicio).localeCompare(String(b.inicio))).slice(-1)[0];
      b.disabled = true;
      try {
        await mutar((d) => { const x = d.suspensiones.find((y) => y.id === ultima.id); if (!x) return false; x.periodos = [...new Set([...(x.periodos || []), s.clave])]; anotar(d, { tipo: 'suspension', empId: s.empId, texto: `continúa la suspensión del ${fmtDate(x.inicio)} en la quincena del ${nombreQ(s.clave.slice(0, 7), Number(s.clave.slice(-1)))}` }); });
        s.listo = true; $('#dlg-susp').close(); toast('Anotado: es la misma suspensión.');
      } catch (err) { mostrarError('#susp-err', msgGitHub(err)); }
      b.disabled = false; return;
    }
    const inicio = $('#susp-inicio').value, dias = Number($('#susp-dias').value) || 0;
    if (!inicio) return mostrarError('#susp-err', 'Escribe la fecha inicial de la suspensión.');
    if (!(dias > 0 && dias <= 60)) return mostrarError('#susp-err', 'Escribe los días de suspensión (máximo 60).');
    const reg = { id: nuevoId(), empId: s.empId, inicio, dias, fin: Docs().sumarDias(inicio, dias - 1), hechos: $('#susp-hechos').value.trim(), falta: $('#susp-falta').value.trim(), descargosFecha: $('#susp-descargos').value, periodos: s.clave ? [s.clave] : [], en: new Date().toISOString(), por: A.uid };
    b.disabled = true;
    const id = await generarDoc(s.empId, 'suspension', { susp: reg }, (d, e, docId) => {
      d.suspensiones = d.suspensiones.filter((x) => !(x.empId === s.empId && !x.docId));
      d.suspensiones.push({ ...reg, docId });
      anotar(d, { tipo: 'suspension', empId: s.empId, texto: `${dias} días desde el ${fmtDate(inicio)}` });
    });
    b.disabled = false;
    if (id) { s.listo = true; $('#dlg-susp').close(); }
  });

  // ---------- retiro ----------
  let retirando = null;
  function abrirRetiro(empId) {
    const e = R.datos.empleados.find((x) => x.id === empId); if (!e) return;
    retirando = empId;
    const t = tipoDe(e);
    $('#ret-titulo').textContent = `Retiro · ${e.nombre}`;
    $('#ret-motivo').innerHTML = Object.entries(Docs().MOTIVOS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    $('#ret-motivo').value = e.motivoRetiroCod || (t === 'fijo' ? 'vencimiento' : t === 'obra' ? 'obra' : 'renuncia');
    $('#ret-fecha').value = e.retiro || (t === 'fijo' && e.contratoFin) || '';
    $('#ret-preaviso').value = (e.preaviso && e.preaviso.fecha) || '';
    $('#ret-renuncia').value = ''; $('#ret-hechos').value = ''; $('#ret-causal').value = ''; $('#ret-descargos').value = '';
    const [y, m] = hoy().split('-').map(Number), ant = new Date(y, m - 2, 15);
    $('#ret-aportes').value = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(ant).replace(' de ', ' de ');
    $('#ret-cert').checked = true;
    mostrarError('#ret-err', ''); pintarRetiro(); $('#dlg-retiro').showModal();
  }
  function pintarRetiro() {
    const m = $('#ret-motivo').value, e = R.datos.empleados.find((x) => x.id === retirando) || {};
    $('#ret-form').querySelectorAll('[data-ret]').forEach((f) => { f.hidden = f.dataset.ret !== m; });
    let nota = '';
    if (m === 'vencimiento' && !(e.preaviso && e.preaviso.fin === ($('#ret-fecha').value || e.contratoFin))) nota = 'No hay preaviso de no prórroga registrado para esta fecha. Si no se le avisó por escrito con 30 días de anticipación, el contrato ya se prorrogó solo: revisa antes de entregar la carta.';
    if (m === 'justa') nota = 'Antes del despido con justa causa debe hacerse la diligencia de descargos (citación y acta en Documentos).';
    if (m === 'sinjusta') nota = 'El despido sin justa causa genera indemnización (art. 64 CST). Confírmalo con gerencia.';
    if (m === 'mutuo') nota = 'La carta sale para que la firmen la empresa y el trabajador.';
    $('#ret-nota').textContent = nota;
  }
  $('#ret-motivo').addEventListener('change', pintarRetiro);
  $('#ret-fecha').addEventListener('change', pintarRetiro);
  $('#ret-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const empId = retirando, fecha = $('#ret-fecha').value, motivo = $('#ret-motivo').value;
    const e = R.datos.empleados.find((x) => x.id === empId); if (!e) return;
    if (!fecha) return mostrarError('#ret-err', 'Escribe la fecha de retiro.');
    if (e.ingreso && fecha < e.ingreso) return mostrarError('#ret-err', 'La fecha de retiro no puede ser antes del ingreso.');
    const retiro = { fecha, motivo, fechaRenuncia: $('#ret-renuncia').value, preaviso: $('#ret-preaviso').value, hechos: $('#ret-hechos').value.trim(), causal: $('#ret-causal').value.trim(), descargosFecha: $('#ret-descargos').value, aportesHasta: $('#ret-aportes').value.trim() };
    const b = $('#ret-go'); b.disabled = true;
    const id = await generarDoc(empId, 'terminacion', { retiro, e: { retiro: fecha } }, (d, x) => {
      const motivoTxt = Docs().MOTIVOS[motivo];
      if (x.retiro !== fecha) anotar(d, { tipo: 'empleado', accion: 'editar', empId, campo: 'Retiro', antes: x.retiro || '', despues: fecha });
      if (x.motivoRetiro !== motivoTxt) anotar(d, { tipo: 'empleado', accion: 'editar', empId, campo: 'Motivo del retiro', antes: x.motivoRetiro || '', despues: motivoTxt });
      x.retiro = fecha; x.motivoRetiro = motivoTxt; x.motivoRetiroCod = motivo;
    });
    if (id && $('#ret-cert').checked) await generarDoc(empId, 'certificado', { fechaDoc: fecha < hoy() ? hoy() : fecha });
    b.disabled = false;
    if (id) $('#dlg-retiro').close();
  });

  // ---------- contratos por vencer y campana ----------
  const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 864e5);
  function vencimientos() {
    if (!R.datos || !Docs()) return [];
    const h = hoy();
    return R.datos.empleados.filter((e) => activo(e) && tipoDe(e) === 'fijo' && e.contratoFin).map((e) => {
      const fin = e.contratoFin, limite = Docs().sumarDias(fin, -30);
      const notificado = !!(e.preaviso && e.preaviso.fin === fin);
      const faltan = diasEntre(h, limite);
      let estado = 'ok';
      if (notificado) estado = 'notificado';
      else if (h > fin) estado = 'vencido';
      else if (faltan < 0) estado = 'tarde';
      else if (faltan <= 15) estado = 'pronto';
      return { e, fin, limite, faltan, notificado, estado };
    }).sort((a, b) => a.fin.localeCompare(b.fin));
  }
  const alertas = () => vencimientos().filter((v) => ['pronto', 'tarde', 'vencido'].includes(v.estado));
  function pintarCampana() {
    const b = $('#rh-campana'); if (!b) return;
    const al = alertas();
    b.hidden = !al.length;
    if (al.length) {
      const urg = al.some((v) => v.estado !== 'pronto');
      b.classList.toggle('aviso', !urg);
      b.querySelector('span').textContent = al.length === 1 ? '1 contrato por notificar' : `${al.length} contratos por notificar`;
      b.title = al.map((v) => `${v.e.nombre}: notificar a más tardar el ${fmtDate(v.limite)} (vence ${fmtDate(v.fin)})`).join('\n');
    }
    const dato = $('#i-rh-dato');
    if (dato) dato.textContent = R.datos ? `${R.datos.empleados.filter(activo).length} empleados activos${al.length ? ` · 🔔 ${al.length} por notificar` : ''}` : '';
  }
  // Avisa al celular de los jefes una vez por contrato (sin nombres)
  async function avisarCelular() {
    if (!A.isAdmin || typeof A.avisar !== 'function') return;
    const nuevos = alertas().filter((v) => v.estado === 'pronto' && v.e.avisoPush !== v.fin);
    if (!nuevos.length) return;
    try {
      const primero = nuevos[0];
      const ok = await A.avisar('Contratos por vencer', `${nuevos.length === 1 ? 'Hay 1 contrato a término fijo' : `Hay ${nuevos.length} contratos a término fijo`} por notificar (a más tardar el ${fmtDate(primero.limite)}). Si no se avisa, se prorroga solo. Toca para abrir la app.`);
      if (!ok) return;
      const ids = new Map(nuevos.map((v) => [v.e.id, v.fin]));
      await mutar((d) => { for (const e of d.empleados) if (ids.has(e.id)) e.avisoPush = ids.get(e.id); });
    } catch (err) { /* se reintenta luego */ }
  }
  let revisando = false;
  async function revisarCampana() {
    if (revisando || !A.maestra || !Docs()) return;
    if (R.datos && Date.now() - R.leido < 10 * 60 * 1000) { pintarCampana(); return; }
    revisando = true;
    try { await leer(); pintarCampana(); avisarCelular(); } catch (err) { /* sin conexión: se intenta luego */ }
    revisando = false;
  }
  setInterval(revisarCampana, 60 * 1000);
  setTimeout(revisarCampana, 4000);
  $('#rh-campana').addEventListener('click', () => { R.tab = 'doc'; A.setView('rrhh'); });

  async function notificarNoProrroga(empId) {
    const e = R.datos.empleados.find((x) => x.id === empId); if (!e) return;
    const fin = e.contratoFin;
    await generarDoc(empId, 'noprorroga', { fin }, (d, x, docId) => { x.preaviso = { fin, fecha: hoy(), docId, por: A.uid }; });
  }
  async function continuaContrato(empId) {
    const e = R.datos.empleados.find((x) => x.id === empId); if (!e || !e.contratoFin) return;
    // Art. 46 CST: contratos menores a un año se prorrogan por períodos iguales hasta 3 veces; luego, mínimo un año
    const pr = e.prorrogas || [];
    const desde = pr.length ? pr[pr.length - 1].desde : e.ingreso;
    const duracion = desde ? diasEntre(desde, e.contratoFin) + 1 : 365;
    const nuevoIni = Docs().sumarDias(e.contratoFin, 1);
    const nuevoFin = pr.length >= 3 || duracion >= 360 ? Docs().sumarDias(Docs().sumarMeses(nuevoIni, 12), 0) : Docs().sumarDias(nuevoIni, duracion - 1);
    try {
      await mutar((d) => {
        const x = d.empleados.find((y) => y.id === empId); if (!x || x.contratoFin !== e.contratoFin) return false;
        x.prorrogas = [...(x.prorrogas || []), { desde: nuevoIni, hasta: nuevoFin, anterior: x.contratoFin, en: new Date().toISOString(), por: A.uid }];
        anotar(d, { tipo: 'prorroga', empId, antes: x.contratoFin, despues: nuevoFin });
        x.contratoFin = nuevoFin; delete x.preaviso;
      });
      toast(`Contrato prorrogado hasta el ${fmtDate(nuevoFin)}${pr.length >= 3 ? ' (desde la cuarta prórroga es mínimo un año)' : ''}.`);
    } catch (err) { toast(msgGitHub(err)); }
    render();
  }
  function renderContratos() {
    const d = R.datos;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const venc = vencimientos().filter((v) => deEmpresa(v.e));
    const obras = d.empleados.filter((e) => activo(e) && deEmpresa(e) && tipoDe(e) === 'obra');
    const chip = (v) => {
      if (v.estado === 'notificado') return `<span class="chip sg-ok">Notificado el ${esc(fmtDate(v.e.preaviso.fecha))}</span>`;
      if (v.estado === 'vencido') return '<span class="chip sg-mal">Ya venció sin preaviso: se prorrogó solo</span>';
      if (v.estado === 'tarde') return '<span class="chip sg-mal">Pasó la fecha para notificar: se prorroga solo</span>';
      if (v.estado === 'pronto') return `<span class="chip sg-no">🔔 ${v.faltan === 0 ? 'Notificar hoy' : `Notificar en ${v.faltan} ${v.faltan === 1 ? 'día' : 'días'}`}</span>`;
      return `<span class="chip sg-va">Faltan ${v.faltan} días para notificar</span>`;
    };
    const docs = d.documentos.filter((x) => { const e = d.empleados.find((y) => y.id === x.empId); return e && deEmpresa(e); }).sort((a, b) => String(b.en).localeCompare(String(a.en))).slice(0, 60);
    const nom = new Map(d.empleados.map((e) => [e.id, e.nombre]));
    $('#rh-cuerpo').innerHTML = `
      <div class="rh-barra"><div class="grupo">${selEmpresa()}</div></div>
      <h3 class="rh-empresa">Contratos a término fijo · ${venc.length}</h3>
      <p class="rep-note" style="margin-top:0">El preaviso de no prórroga debe entregarse por escrito <b>mínimo 30 días antes</b> del vencimiento. Si no se entrega, el contrato se prorroga solo por el mismo tiempo (art. 46 CST). La campana 🔔 avisa desde 15 días antes de la fecha límite.</p>
      ${venc.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th>Inicio</th><th>Vence</th><th>Notificar a más tardar</th><th>Estado</th><th></th></tr></thead><tbody>
        ${venc.map((v) => `<tr><td><span class="emp">${esc(v.e.nombre)}</span><br><span class="sub">${esc(v.e.empresa || EMPRESA_DEF)} · ${esc(v.e.cargo || '')}${(v.e.prorrogas || []).length ? ` · ${(v.e.prorrogas || []).length} prórroga(s)` : ''}</span></td><td>${esc(fmtDate(v.e.ingreso))}</td><td><b>${esc(fmtDate(v.fin))}</b></td><td>${esc(fmtDate(v.limite))}</td><td>${chip(v)}</td>
          <td class="acc">${v.notificado ? `<button class="btn" type="button" data-rh-retiro="${esc(v.e.id)}">Registrar retiro</button>` : `<button class="btn" type="button" data-rh-noprorroga="${esc(v.e.id)}">Notificar terminación</button> <button class="btn" type="button" data-rh-continua="${esc(v.e.id)}">Continúa</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty"><p>No hay contratos a término fijo activos con fecha de terminación.</p></div>'}
      ${obras.length ? `<h3 class="rh-empresa">Contratos por obra o labor · ${obras.length}</h3><p class="rep-note" style="margin-top:0">Terminan cuando acaba la obra o la labor; no necesitan preaviso. Cuando termine, registra el retiro y sale la carta.</p>
        <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th>Obra o labor</th><th>Inicio</th><th></th></tr></thead><tbody>
        ${obras.map((e) => `<tr><td><span class="emp">${esc(e.nombre)}</span><br><span class="sub">${esc(e.empresa || EMPRESA_DEF)}</span></td><td>${esc(e.obra || '—')}</td><td>${esc(fmtDate(e.ingreso))}</td><td class="acc"><button class="btn" type="button" data-rh-retiro="${esc(e.id)}">Terminó la obra</button></td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <h3 class="rh-empresa">Documentos generados · ${docs.length}</h3>
      ${docs.length ? `<ul class="rh-docs">${docs.map((x) => `<li><div><div class="tit">${esc(x.titulo)}</div><div class="sub">${esc(nom.get(x.empId) || '')} · ${esc(dtFmt.format(new Date(x.en)))} · ${esc(quien(x.por))}${x.firmado ? ' · <span class="chip sg-ok">Firmado</span>' : ' · <span class="chip sg-no">Sin firmar</span>'}</div></div><div class="acc"><button class="btn" type="button" data-doc-bajar="${esc(x.id)}">Descargar Word</button><button class="btn" type="button" data-rh-docs="${esc(x.empId)}">Expediente</button></div></li>`).join('')}</ul>`
        : '<div class="empty"><p>Aún no se han generado documentos. Se generan al agregar un empleado, al marcar una suspensión o un retiro, o desde el botón Documentos de cada empleado.</p></div>'}`;
  }

  // ---------- importar desde el Excel de nómina ----------
  let importados = [];
  const num = (v) => (typeof v === 'number' ? v : Number(String(v || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0);
  const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  function leerExcelNomina(wb) {
    const ultimas = new Map(); // empresa → última hoja de quincena
    const riesgos = new Map(), cargos = new Map();
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, blankrows: false });
      const h = rows.findIndex((r) => norm(r[0]) === 'NOMBRE' && norm(r[1]).startsWith('IDENTIFICACION') && norm(r[3]).startsWith('SALARIO'));
      if (h >= 0) { ultimas.set(/OBS/i.test(n) ? 'OBS' : EMPRESA_DEF, { hoja: n, rows, h }); continue; }
      // Planilla: No. | EMPRESA | NOMBRE | IDENTIFICACIÓN | CARGO | CLASE RIESGO
      const hp = rows.findIndex((r) => norm(r[1]) === 'EMPRESA' && norm(r[2]) === 'NOMBRE' && norm(r[5]).startsWith('CLASE RIESGO'));
      if (hp >= 0) for (const r of rows.slice(hp + 1)) { const ced = String(r[3] || '').replace(/\D/g, ''); if (!ced) continue; if (Number(r[5])) riesgos.set(ced, Number(r[5])); if (r[4]) cargos.set(ced, String(r[4]).trim()); }
    }
    const out = [];
    for (const [empresa, { hoja, rows, h }] of ultimas) {
      for (const r of rows.slice(h + 1)) {
        const nombre = String(r[0] || '').trim(), ced = String(r[1] || '').replace(/\D/g, '');
        if (!nombre || /^TOTAL/i.test(nombre) || !ced) { if (/^TOTAL/i.test(nombre)) break; continue; }
        out.push({ nombre: nombre.toUpperCase(), cedula: ced, empresa, cargo: String(r[2] || cargos.get(ced) || '').trim(), salario: Math.round(num(r[3])), riesgo: riesgos.get(ced) || 1, aux: num(r[4]) > 0, hoja });
      }
    }
    return out;
  }
  $('#emp-imp-file').addEventListener('change', async () => {
    const f = $('#emp-imp-file').files[0];
    importados = []; $('#emp-imp-go').disabled = true; mostrarError('#emp-imp-err', ''); $('#emp-imp-res').innerHTML = '';
    if (!f) return;
    if (!window.XLSX) return mostrarError('#emp-imp-err', 'No cargó el lector de Excel. Recarga la página.');
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      importados = leerExcelNomina(wb);
      if (!importados.length) return mostrarError('#emp-imp-err', 'No encontré hojas de quincena con NOMBRE, IDENTIFICACIÓN y SALARIO MENSUAL.');
      const existentes = new Set(R.datos.empleados.map((e) => e.cedula));
      $('#emp-imp-res').innerHTML = `<p style="margin:8px 0">Encontré <b>${importados.length}</b> empleados (${[...new Set(importados.map((x) => `${x.empresa}: hoja “${x.hoja}”`))].map(esc).join(' · ')}). ${importados.filter((x) => existentes.has(x.cedula)).length} ya existen y se actualizan.</p>
        <div class="rh-tabla-wrap" style="max-height:300px;overflow:auto"><table class="rh-tabla"><thead><tr><th>Empleado</th><th>Empresa</th><th>Cargo</th><th class="n">Salario</th><th class="n">Riesgo</th></tr></thead><tbody>${importados.map((x) => `<tr><td>${esc(x.nombre)}<br><span class="sub">C.C. ${esc(x.cedula)}${existentes.has(x.cedula) ? ' · ya existe' : ''}</span></td><td>${esc(x.empresa)}</td><td>${esc(x.cargo || '—')}</td><td class="n">${fmt(x.salario)}</td><td class="n">${x.riesgo}</td></tr>`).join('')}</tbody></table></div>`;
      $('#emp-imp-go').disabled = false;
    } catch (e) { mostrarError('#emp-imp-err', 'No pude leer ese Excel.'); }
  });
  $('#emp-imp-go').addEventListener('click', async () => {
    if (!importados.length) return;
    const b = $('#emp-imp-go'); b.disabled = true; b.textContent = 'Importando…';
    try {
      let nuevos = 0, act = 0;
      await mutar((d) => {
        nuevos = 0; act = 0;
        for (const x of importados) {
          const { hoja, ...dat } = x;
          const e = d.empleados.find((y) => y.cedula === x.cedula);
          if (e) {
            for (const k of ['salario', 'cargo', 'riesgo', 'empresa']) if (dat[k] && String(e[k] ?? '') !== String(dat[k])) { anotar(d, { tipo: 'empleado', accion: 'importar', empId: e.id, campo: CAMPOS_EMP[k], antes: k === 'salario' ? fmt(e[k]) : e[k], despues: k === 'salario' ? fmt(dat[k]) : dat[k], nota: `Excel, hoja ${hoja}` }); e[k] = dat[k]; }
            act++;
          } else {
            const n = { id: nuevoId(), ...dat, creado: new Date().toISOString() };
            d.empleados.push(n); nuevos++;
            anotar(d, { tipo: 'empleado', accion: 'importar', empId: n.id, nombre: n.nombre, nota: `Excel, hoja ${hoja}` });
          }
        }
      });
      $('#dlg-emp-import').close(); toast(`Listo: ${nuevos} empleados nuevos, ${act} actualizados.`); render();
    } catch (e) { mostrarError('#emp-imp-err', msgGitHub(e)); }
    b.disabled = false; b.textContent = 'Importar';
  });

  // ---------- Excel ----------
  function libro(hojas, nombre) {
    if (!window.XLSX) { toast('No cargó el generador de Excel. Recarga la página.'); return; }
    const wb = XLSX.utils.book_new();
    for (const { titulo, filas, anchos, pesos } of hojas) {
      const ws = XLSX.utils.aoa_to_sheet(filas);
      ws['!cols'] = (anchos || []).map((w) => ({ wch: w }));
      const rango = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let r = 0; r <= rango.e.r; r++) for (const c of pesos || []) { const x = ws[XLSX.utils.encode_cell({ r, c })]; if (x && typeof x.v === 'number') x.z = '"$"#,##0'; }
      XLSX.utils.book_append_sheet(wb, ws, titulo.slice(0, 31));
    }
    XLSX.writeFile(wb, nombre);
  }
  function excelEmpleados() {
    const filas = [['Nombre', 'Cédula', 'Empresa', 'Cargo', 'Tipo de contrato', 'Salario', 'Auxilio transporte', 'Riesgo ARL', 'Ingreso', 'EPS', 'Pensión', 'Centro de costo', 'Estado', 'Retiro', 'Motivo retiro']];
    filas[0].push('Fin del contrato', 'ARL', 'Caja', 'Cesantías', 'Teléfono', 'Dirección');
    for (const e of R.datos.empleados.filter(deEmpresa)) filas.push([e.nombre, e.cedula, e.empresa || EMPRESA_DEF, e.cargo || '', e.contrato || '', Number(e.salario) || 0, e.aux !== false ? 'Sí' : 'No', e.riesgo || 1, e.ingreso || '', e.eps || '', e.afp || '', e.cc || '', activo(e) ? 'Activo' : 'Retirado', e.retiro || '', e.motivoRetiro || '', e.contratoFin || '', e.arl || '', e.ccf || '', e.cesantias || '', e.telefono || '', e.direccion || '']);
    libro([{ titulo: 'Empleados', filas, anchos: [32, 14, 22, 22, 18, 14, 10, 8, 12, 16, 16, 16, 10, 12, 24, 12, 14, 14, 14, 14, 26], pesos: [5] }], `Empleados${sufijoEmp() || ' ODESA'} ${hoy()}.xlsx`);
  }
  function excelNomina() {
    const cab = ['Nombre', 'Cédula', 'Cargo', 'Salario mensual', 'Días quincena', 'Incapacidad', 'Vacaciones', 'Lic. remunerada', 'Lic. no remunerada', 'Suspensión', 'Días trabajados', 'HE diurnas (h)', 'HE nocturnas (h)', 'Recargo nocturno (h)', 'Recargo dom/fest (h)', 'HE dom diurnas (h)', 'HE dom nocturnas (h)', 'Salario quincena', 'Vac/Lic/Incap', 'Horas extra', 'Aux. transporte', 'Otros pagos (no constitutivos)', 'Total devengado', 'Salud 4%', 'Pensión 4%', 'Fondo solidaridad', 'Préstamos', 'Otras deducciones', 'Total deducciones', 'Neto a pagar', 'Nota'];
    const emps = empleadosDe(R.mes, R.q).filter(deEmpresa);
    const hojas = [...new Set(emps.map((e) => e.empresa || EMPRESA_DEF))].map((emp) => {
      const filas = [[`NÓMINA ${nombreQ(R.mes, R.q).toUpperCase()}`], [`Empresa: ${emp}`], [], cab];
      for (const e of emps.filter((x) => (x.empresa || EMPRESA_DEF) === emp)) {
        const f = filaDe(e, R.mes, R.q), c = calcular(e, f), n = (k) => Number(f[k]) || 0;
        filas.push([e.nombre, e.cedula, e.cargo || '', Number(e.salario) || 0, n('dias'), n('inc'), n('vac'), n('lr'), n('lnr'), n('sus'), c.diasTrab, n('hed'), n('hen'), n('rn'), n('rdf'), n('hedf'), n('henf'), c.salario, c.vac + c.lr + c.inc, c.he, c.aux, c.otros, c.devengado, c.salud, c.pension, c.fsp, c.prestamos, c.otrasDed, c.deducciones, c.neto, f.nota || '']);
      }
      return { titulo: `${R.q === 1 ? '1-15' : '16-30'} ${emp}`, filas, anchos: [30, 13, 18, 14, ...Array(13).fill(9), ...Array(13).fill(14), 30], pesos: [3, ...Array.from({ length: 13 }, (_, i) => 17 + i)] };
    });
    libro(hojas, `Nómina ${R.mes} quincena ${R.q}${sufijoEmp()}.xlsx`);
  }
  function excelNovedades() {
    const mes = R.mesPla;
    const cab = ['Empresa', 'Nombre', 'Cédula', 'Cargo', 'Salario', 'Días Q1', 'Días Q2', 'Incapacidad (días)', 'Vacaciones (días)', 'Lic. remunerada (días)', 'Lic. no remunerada (días)', 'Suspensión (días)', 'HE diurnas (h)', 'HE nocturnas (h)', 'Recargo nocturno (h)', 'Recargo dom/fest (h)', 'HE dom diurnas (h)', 'HE dom nocturnas (h)', 'Otros pagos', 'Préstamos', 'Otras deducciones', 'Ingreso', 'Retiro', 'Motivo retiro', 'Notas', 'Modificaciones registradas'];
    const filas = [[`REPORTE DE NOVEDADES · ${nombreMes(mes).toUpperCase()}`], [], cab];
    const vistos = new Map();
    for (const q of [1, 2]) for (const e of empleadosDe(mes, q).filter(deEmpresa)) { const k = e.cedula || e.id; if (!vistos.has(k)) vistos.set(k, { e, f: [null, null] }); vistos.get(k).f[q - 1] = filaDe(e, mes, q); }
    const cambiosMes = R.datos.cambios.filter((c) => String(c.periodo || '').startsWith(mes));
    for (const { e, f } of [...vistos.values()].sort((a, b) => String(a.e.empresa).localeCompare(String(b.e.empresa)) || String(a.e.nombre).localeCompare(String(b.e.nombre)))) {
      const s = (k) => (Number((f[0] || {})[k]) || 0) + (Number((f[1] || {})[k]) || 0);
      const mods = cambiosMes.filter((c) => c.empId === e.id).map((c) => `${quien(c.por)}: ${NOMBRE_CAMPO[c.campo] || c.campo} ${c.antes || 0}→${c.despues || 0}`).join('; ');
      filas.push([e.empresa || EMPRESA_DEF, e.nombre, e.cedula, e.cargo || '', Number(e.salario) || 0, f[0] ? Number(f[0].dias) || 0 : 0, f[1] ? Number(f[1].dias) || 0 : 0, s('inc'), s('vac'), s('lr'), s('lnr'), s('sus'), s('hed'), s('hen'), s('rn'), s('rdf'), s('hedf'), s('henf'), s('otros'), s('prestamos'), s('otrasDed'),
        e.ingreso && e.ingreso.slice(0, 7) === mes ? e.ingreso : '', e.retiro && e.retiro.slice(0, 7) === mes ? e.retiro : '', e.retiro && e.retiro.slice(0, 7) === mes ? e.motivoRetiro || '' : '', [f[0] && f[0].nota, f[1] && f[1].nota].filter(Boolean).join(' / '), mods]);
    }
    libro([{ titulo: 'Novedades', filas, anchos: [20, 30, 13, 18, 13, ...Array(16).fill(10), 12, 12, 20, 30, 60], pesos: [4, 18, 19, 20] }], `Novedades nómina ${mes}${sufijoEmp()}.xlsx`);
  }
  function excelPlanilla() {
    const mes = R.mesPla, P = R.datos.param, filas = planillaMes(mes).filter((x) => deEmpresa(x.e));
    const empresas = [...new Set(filas.map((x) => x.e.empresa || EMPRESA_DEF))];
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
    const out = [[`PLANILLA CONSOLIDADA DE SEGURIDAD SOCIAL · ${nombreMes(mes).toUpperCase()} (BORRADOR)`], [],
      ['RESUMEN', ...empresas, 'TOTAL'],
      ...[['Pensión', 'pension'], ['Salud', 'salud'], ['ARL', 'arl'], ['Caja de compensación', 'ccf'], ['SENA', 'sena'], ['ICBF', 'icbf'], ['TOTAL A PAGAR PLANILLA', 'total'], ['(-) Descontado a empleados', 'descontado'], ['COSTO NETO EMPRESA', 'empresa']]
        .map(([l, k]) => [l, ...empresas.map((emp) => sum(filas.filter((x) => (x.e.empresa || EMPRESA_DEF) === emp), k)), sum(filas, k)]),
      [], ['No.', 'EMPRESA', 'NOMBRE', 'IDENTIFICACIÓN', 'CARGO', 'CLASE RIESGO ARL', 'TARIFA ARL %', 'SALARIO MENSUAL', 'DÍAS Q1', 'DÍAS Q2', 'DÍAS COTIZADOS', 'IBC Q1', 'IBC Q2', 'IBC MES', 'PENSIÓN 16%', 'SALUD', 'ARL', 'CCF 4%', 'SENA', 'ICBF', 'TOTAL APORTES', 'DESCONTADO AL EMPLEADO', 'APORTE EMPRESA', 'ING', 'RET', 'IGE (días)', 'VAC (días)', 'LR (días)', 'SLN (días)']];
    let i = 0;
    for (const emp of empresas) for (const x of filas.filter((y) => (y.e.empresa || EMPRESA_DEF) === emp).sort((a, b) => String(a.e.nombre).localeCompare(String(b.e.nombre)))) {
      out.push([++i, emp, x.e.nombre, x.e.cedula, x.e.cargo || '', x.e.riesgo || 1, P.arl[x.e.riesgo || 1], Number(x.e.salario) || 0, x.diasQ1, x.diasQ2, x.dias, x.ibcQ1, x.ibcQ2, x.ibc, x.pension, x.salud, x.arl, x.ccf, x.sena, x.icbf, x.total, x.descontado, x.empresa, x.ing ? 'X' : '', x.ret ? 'X' : '', x.inc || '', x.vac || '', x.lr || '', (x.lnr + x.sus) || '']);
    }
    out.push([], ['Notas: borrador calculado por la app. IBC = salario de los días + vacaciones, licencias, incapacidades y horas extra (sin auxilio de transporte ni pagos no constitutivos). Aportes redondeados a la centena. Exonerado de salud empleador, SENA e ICBF (art. 114-1 E.T.) para salarios menores a 10 SMMLV.']);
    libro([{ titulo: `Planilla ${mes}`, filas: out, anchos: [6, 22, 30, 14, 18, 8, 8, 14, 7, 7, 8, 13, 13, 13, 13, 12, 12, 12, 10, 10, 14, 14, 14, 5, 5, 8, 8, 8, 8], pesos: [1, 2, 3, 4, 7, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] }], `Borrador planilla ${mes}${sufijoEmp()}.xlsx`);
  }

  // ---------- eventos ----------
  $('#view-rrhh').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-rh-tab], [data-rh], [data-rh-ver], [data-rh-q], [data-rh-empresa], [data-rh-docs], [data-rh-retiro], [data-rh-noprorroga], [data-rh-continua], [data-doc-bajar], [data-rh-emp]');
    if (!t) return;
    if (t.dataset.rhTab) { R.tab = t.dataset.rhTab; render(); return; }
    if ('rhEmpresa' in t.dataset) { R.empresa = t.dataset.rhEmpresa; render(); return; }
    if (t.dataset.rhDocs) { abrirDocs(t.dataset.rhDocs); return; }
    if (t.dataset.rhRetiro) { abrirRetiro(t.dataset.rhRetiro); return; }
    if (t.dataset.docBajar) { bajarDoc(t.dataset.docBajar); return; }
    if (t.dataset.rhNoprorroga) {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = '¿Generar la carta de no prórroga? Toca de nuevo'; return; }
      t.disabled = true; notificarNoProrroga(t.dataset.rhNoprorroga); return;
    }
    if (t.dataset.rhContinua) {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = '¿Prorrogar el contrato? Toca de nuevo'; return; }
      t.disabled = true; continuaContrato(t.dataset.rhContinua); return;
    }
    if (t.dataset.rhVer) { R.ver = t.dataset.rhVer; render(); return; }
    if (t.dataset.rhQ) { R.q = Number(t.dataset.rhQ); render(); return; }
    if (t.dataset.rhEmp) { abrirEmpleado(t.dataset.rhEmp); return; }
    const a = t.dataset.rh;
    if (a === 'nuevo') abrirEmpleado(null);
    else if (a === 'importar') { $('#emp-imp-file').value = ''; $('#emp-imp-res').innerHTML = ''; mostrarError('#emp-imp-err', ''); $('#emp-imp-go').disabled = true; $('#dlg-emp-import').showModal(); }
    else if (a === 'xls-emp') excelEmpleados();
    else if (a === 'xls-nom') excelNomina();
    else if (a === 'xls-nov') excelNovedades();
    else if (a === 'xls-pla') excelPlanilla();
    else if (a === 'cerrar' || a === 'reabrir') {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = a === 'cerrar' ? '¿Cerrar? Ya no se podrá modificar. Toca de nuevo' : '¿Reabrir? Toca de nuevo'; return; }
      cerrarQuincena(a === 'cerrar');
    }
  });
  $('#view-rrhh').addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'rh-mes') { R.mes = t.value || mesActual(); render(); return; }
    if (t.id === 'rh-mespla') { R.mesPla = t.value || mesActual(); render(); return; }
    if (t.dataset.rhIn) guardarCampo(t.dataset.rhE, t.dataset.rhIn, t.value, t);
  });

  window.RRHH = { abrir };
})();
