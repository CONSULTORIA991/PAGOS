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
  const DIAS = [['dias', 'Días quincena'], ['inc', 'Incap.'], ['vac', 'Vacac.'], ['lr', 'Lic. rem.'], ['lnr', 'Lic. no rem.']];
  const HORAS = [['hed', 'HE diur.'], ['hen', 'HE noct.'], ['rn', 'Rec. noct.'], ['rdf', 'Rec. dom/fest'], ['hedf', 'HE dom diur.'], ['henf', 'HE dom noct.']];
  const DINERO = [['otros', 'Otros pagos (no salariales)'], ['prestamos', 'Préstamos'], ['otrasDed', 'Otras deducciones']];
  const NOMBRE_CAMPO = Object.fromEntries([...DIAS, ...HORAS, ...DINERO, ['nota', 'Nota']]);

  const R = { datos: null, sha: null, tab: 'emp', ver: 'activos', mes: '', q: 1, mesPla: '', cargando: false };

  // ---------- datos ----------
  function base() { return { param: { ...PARAM_DEF }, empleados: [], periodos: {}, cambios: [] }; }
  async function leer() {
    const f = await GH.leer(R_RRHH);
    R.sha = f ? f.sha : null;
    R.datos = f ? await Cripto.descifrarJSON(A.maestra, f.bytes) : base();
    const d = R.datos;
    d.param = { ...PARAM_DEF, ...(d.param || {}), rec: { ...PARAM_DEF.rec, ...((d.param || {}).rec || {}) }, arl: { ...PARAM_DEF.arl, ...((d.param || {}).arl || {}) } };
    d.empleados = d.empleados || []; d.periodos = d.periodos || {}; d.cambios = d.cambios || [];
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
    const diasTrab = Math.max(0, n('dias') - n('inc') - n('vac') - n('lr') - n('lnr'));
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
      const x = porEmp.get(e.cedula || e.id) || { e, dias: [0, 0], ibc: [0, 0], inc: 0, vac: 0, lr: 0, lnr: 0, he: 0 };
      x.dias[q - 1] = Math.max(0, (Number(f.dias) || 0) - (Number(f.lnr) || 0)); x.ibc[q - 1] = c.ibc;
      x.inc += Number(f.inc) || 0; x.vac += Number(f.vac) || 0; x.lr += Number(f.lr) || 0; x.lnr += Number(f.lnr) || 0; x.he += c.he;
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
        inc: x.inc, vac: x.vac, lr: x.lr, lnr: x.lnr, he: x.he, ing, ret };
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
    else renderCambios();
  }
  function sinEmpleados() {
    return `<div class="empty"><h3>Aún no hay empleados</h3><p>${A.isAdmin ? 'Impórtalos desde el Excel de nómina o agrégalos uno por uno.' : 'Cuando la administradora cargue los empleados aparecerán aquí.'}</p>${A.isAdmin ? '<div class="top-actions"><button class="btn" type="button" data-rh="importar">Importar desde Excel</button><button class="btn primary" type="button" data-rh="nuevo">+ Agregar empleado</button></div>' : ''}</div>`;
  }

  // Empleados
  function renderEmpleados() {
    const d = R.datos, P = d.param;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const lista = d.empleados.filter((e) => R.ver === 'todos' || (R.ver === 'activos' ? activo(e) : !activo(e)))
      .sort((a, b) => String(a.empresa).localeCompare(String(b.empresa)) || String(a.nombre).localeCompare(String(b.nombre)));
    const act = d.empleados.filter(activo);
    const nomina = act.reduce((s, e) => s + (Number(e.salario) || 0) + (e.aux !== false && e.salario <= 2 * P.smmlv ? P.aux : 0), 0);
    const empresas = [...new Set(lista.map((e) => e.empresa || EMPRESA_DEF))];
    $('#rh-cuerpo').innerHTML = `
      <section class="rep-sum">
        <div class="tile main"><span class="lbl">Empleados activos</span><span class="val">${act.length}</span><span>${[...new Set(act.map((e) => e.empresa || EMPRESA_DEF))].map((x) => `${esc(x)}: ${act.filter((e) => (e.empresa || EMPRESA_DEF) === x).length}`).join(' · ')}</span></div>
        <div class="tile"><span class="lbl">Nómina mensual</span><span class="val">${fmt(nomina)}</span><span>Salarios + auxilio de transporte</span></div>
        <div class="tile"><span class="lbl">Retirados</span><span class="val">${d.empleados.length - act.length}</span></div>
      </section>
      <div class="rh-barra"><div class="grupo">
        <div class="quick"><button class="qbtn" type="button" data-rh-ver="activos" aria-pressed="${R.ver === 'activos'}">Activos</button><button class="qbtn" type="button" data-rh-ver="retirados" aria-pressed="${R.ver === 'retirados'}">Retirados</button><button class="qbtn" type="button" data-rh-ver="todos" aria-pressed="${R.ver === 'todos'}">Todos</button></div>
      </div><div class="grupo">${A.isAdmin ? '<button class="btn" type="button" data-rh="importar">Importar desde Excel</button>' : ''}<button class="btn" type="button" data-rh="xls-emp">Descargar Excel</button><button class="btn primary" type="button" data-rh="nuevo">+ Agregar empleado</button></div></div>
      ${empresas.map((emp) => {
        const es = lista.filter((e) => (e.empresa || EMPRESA_DEF) === emp);
        return `<h3 class="rh-empresa">${esc(emp)} · ${es.length}</h3><div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th>Cargo</th><th class="n">Salario</th><th>Riesgo ARL</th><th>Ingreso</th><th>EPS / Pensión</th><th>Estado</th></tr></thead><tbody>
          ${es.map((e) => `<tr class="click" data-rh-emp="${esc(e.id)}"><td><span class="emp">${esc(e.nombre)}</span><br><span class="sub">C.C. ${esc(e.cedula)}${e.contrato ? ' · ' + esc(e.contrato) : ''}</span></td><td>${esc(e.cargo || '—')}</td><td class="n">${fmt(e.salario)}</td><td>${['', 'I', 'II', 'III', 'IV', 'V'][e.riesgo || 1]}</td><td>${e.ingreso ? esc(fmtDate(e.ingreso)) : '—'}</td><td>${esc([e.eps, e.afp].filter(Boolean).join(' / ') || '—')}</td><td>${activo(e) ? '<span class="chip sg-ok">Activo</span>' : `<span class="chip sg-no">Retirado ${esc(fmtDate(e.retiro))}</span>`}</td></tr>`).join('')}
          <tr class="tot"><td>Total</td><td></td><td class="n">${fmt(es.reduce((s, e) => s + (Number(e.salario) || 0), 0))}</td><td colspan="4"></td></tr>
        </tbody></table></div>`;
      }).join('') || '<div class="empty"><p>No hay empleados en esta lista.</p></div>'}`;
  }

  // Nómina quincenal
  function renderNomina() {
    const d = R.datos;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const p = d.periodos[claveQ(R.mes, R.q)] || {};
    const cerrado = p.estado === 'cerrado';
    const emps = empleadosDe(R.mes, R.q);
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
      <div class="rh-barra"><div class="grupo">
        <div class="field"><label for="rh-mes">Mes</label><input type="month" id="rh-mes" value="${esc(R.mes)}"></div>
        <div class="quick"><button class="qbtn" type="button" data-rh-q="1" aria-pressed="${R.q === 1}">1 al 15</button><button class="qbtn" type="button" data-rh-q="2" aria-pressed="${R.q === 2}">16 al 30</button></div>
        <span class="rh-estado ${cerrado ? 'cerrado' : 'borrador'}">${cerrado ? `Cerrada${p.cerradoPor ? ' por ' + esc(quien(p.cerradoPor)) : ''}` : 'Borrador · se puede modificar'}</span>
      </div><div class="grupo"><button class="btn" type="button" data-rh="xls-nom">Descargar Excel</button>${A.isAdmin ? (cerrado ? '<button class="btn" type="button" data-rh="reabrir">Reabrir quincena</button>' : '<button class="btn primary" type="button" data-rh="cerrar">Cerrar quincena</button>') : ''}</div></div>
      <p class="rep-note" style="margin-top:0">Quincena del ${esc(nombreQ(R.mes, R.q))}. Escribe los días, horas y valores en las casillas; cada cambio se guarda solo y queda en <b>Cambios</b> con tu nombre. Las casillas en amarillo fueron modificadas. Días trabajados = días de la quincena − incapacidad − vacaciones − licencias.</p>
      ${bloques || '<div class="empty"><p>No hay empleados con días en esta quincena.</p></div>'}
      <section class="rep-sum"><div class="tile main"><span class="lbl">Neto a pagar quincena</span><span class="val">${fmt(granTotal.neto)}</span><span>Devengado ${fmt(granTotal.devengado)} − deducciones ${fmt(granTotal.deducciones)}</span></div></section>`;
  }

  // Novedades del mes y planilla
  function renderPlanilla() {
    const d = R.datos;
    if (!d.empleados.length) { $('#rh-cuerpo').innerHTML = sinEmpleados(); return; }
    const filas = planillaMes(R.mesPla);
    const empresas = [...new Set(filas.map((x) => x.e.empresa || EMPRESA_DEF))];
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
    const novedad = (x) => [x.ing && `Ingreso ${fmtDate(x.ing)}`, x.ret && `Retiro ${fmtDate(x.ret)}`, x.inc && `Incapacidad ${x.inc} d`, x.vac && `Vacaciones ${x.vac} d`, x.lr && `Lic. remunerada ${x.lr} d`, x.lnr && `Lic. no remunerada ${x.lnr} d`, x.he && `Horas extra ${fmt(x.he)}`].filter(Boolean).join(' · ');
    const qs = [1, 2].map((q) => (d.periodos[claveQ(R.mesPla, q)] || {}).estado === 'cerrado');
    $('#rh-cuerpo').innerHTML = `
      <div class="rh-barra"><div class="grupo"><div class="field"><label for="rh-mespla">Mes</label><input type="month" id="rh-mespla" value="${esc(R.mesPla)}"></div>
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
    el.disabled = true;
    try {
      let msg = '';
      await mutar((d) => {
        const p = d.periodos[clave] = d.periodos[clave] || { estado: 'borrador', filas: {} };
        if (p.estado === 'cerrado') { msg = 'Esta quincena ya fue cerrada.'; return false; }
        const e = d.empleados.find((x) => x.id === empId);
        if (!e) { msg = 'El empleado ya no existe.'; return false; }
        p.filas = p.filas || {};
        const antes = filaDe(e, R.mes, R.q)[campo];
        if (String(antes ?? '') === String(valor)) return false;
        p.filas[empId] = { ...(p.filas[empId] || {}), [campo]: valor };
        anotar(d, { tipo: 'nomina', periodo: clave, empId, campo, antes: antes ?? '', despues: valor });
      });
      if (msg) toast(msg);
    } catch (e) { toast('No se guardó: ' + msgGitHub(e)); }
    render();
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
  const CAMPOS_EMP = { nombre: 'Nombre', cedula: 'Cédula', empresa: 'Empresa', cargo: 'Cargo', contrato: 'Tipo de contrato', salario: 'Salario', riesgo: 'Riesgo ARL', aux: 'Auxilio de transporte', ingreso: 'Ingreso', cc: 'Centro de costo', eps: 'EPS', afp: 'Pensión', retiro: 'Retiro', motivoRetiro: 'Motivo del retiro' };
  function abrirEmpleado(id) {
    const e = id ? R.datos.empleados.find((x) => x.id === id) : null;
    editando = e ? e.id : null;
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
    $('#dlg-emp').showModal();
  }
  $('#emp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nuevo = {
      nombre: $('#emp-nombre').value.trim().toUpperCase(), cedula: $('#emp-cedula').value.replace(/\D/g, ''), empresa: $('#emp-empresa').value.trim() || EMPRESA_DEF,
      cargo: $('#emp-cargo').value.trim(), contrato: $('#emp-contrato').value, salario: Math.round(parseMonto($('#emp-salario').value) || 0), riesgo: Number($('#emp-riesgo').value) || 1,
      aux: $('#emp-aux').checked, ingreso: $('#emp-ingreso').value, cc: $('#emp-cc').value.trim(), eps: $('#emp-eps').value.trim(), afp: $('#emp-afp').value.trim(),
      retiro: $('#emp-retiro').value, motivoRetiro: $('#emp-motivo').value.trim(),
    };
    const nota = $('#emp-nota').value.trim();
    if (!nuevo.nombre) return mostrarError('#emp-err', 'Escribe el nombre.');
    if (!nuevo.cedula) return mostrarError('#emp-err', 'Escribe la cédula.');
    if (!(nuevo.salario > 0)) return mostrarError('#emp-err', 'Escribe el salario mensual.');
    if (nuevo.retiro && nuevo.ingreso && nuevo.retiro < nuevo.ingreso) return mostrarError('#emp-err', 'La fecha de retiro no puede ser antes del ingreso.');
    const b = $('#emp-guardar'); b.disabled = true;
    try {
      let msg = '';
      await mutar((d) => {
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
          Object.assign(e, nuevo, { modificado: new Date().toISOString() });
        } else {
          const e = { id: nuevoId(), ...nuevo, creado: new Date().toISOString() };
          d.empleados.push(e);
          anotar(d, { tipo: 'empleado', accion: 'nuevo', empId: e.id, nombre: e.nombre, nota });
        }
      });
      if (msg) { mostrarError('#emp-err', msg); b.disabled = false; return; }
      $('#dlg-emp').close(); toast('Empleado guardado.'); render();
    } catch (e) { mostrarError('#emp-err', msgGitHub(e)); }
    b.disabled = false;
  });

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
    for (const e of R.datos.empleados) filas.push([e.nombre, e.cedula, e.empresa || EMPRESA_DEF, e.cargo || '', e.contrato || '', Number(e.salario) || 0, e.aux !== false ? 'Sí' : 'No', e.riesgo || 1, e.ingreso || '', e.eps || '', e.afp || '', e.cc || '', activo(e) ? 'Activo' : 'Retirado', e.retiro || '', e.motivoRetiro || '']);
    libro([{ titulo: 'Empleados', filas, anchos: [32, 14, 22, 22, 18, 14, 10, 8, 12, 16, 16, 16, 10, 12, 24], pesos: [5] }], `Empleados ODESA ${hoy()}.xlsx`);
  }
  function excelNomina() {
    const cab = ['Nombre', 'Cédula', 'Cargo', 'Salario mensual', 'Días quincena', 'Incapacidad', 'Vacaciones', 'Lic. remunerada', 'Lic. no remunerada', 'Días trabajados', 'HE diurnas (h)', 'HE nocturnas (h)', 'Recargo nocturno (h)', 'Recargo dom/fest (h)', 'HE dom diurnas (h)', 'HE dom nocturnas (h)', 'Salario quincena', 'Vac/Lic/Incap', 'Horas extra', 'Aux. transporte', 'Otros pagos (no constitutivos)', 'Total devengado', 'Salud 4%', 'Pensión 4%', 'Fondo solidaridad', 'Préstamos', 'Otras deducciones', 'Total deducciones', 'Neto a pagar', 'Nota'];
    const emps = empleadosDe(R.mes, R.q);
    const hojas = [...new Set(emps.map((e) => e.empresa || EMPRESA_DEF))].map((emp) => {
      const filas = [[`NÓMINA ${nombreQ(R.mes, R.q).toUpperCase()}`], [`Empresa: ${emp}`], [], cab];
      for (const e of emps.filter((x) => (x.empresa || EMPRESA_DEF) === emp)) {
        const f = filaDe(e, R.mes, R.q), c = calcular(e, f), n = (k) => Number(f[k]) || 0;
        filas.push([e.nombre, e.cedula, e.cargo || '', Number(e.salario) || 0, n('dias'), n('inc'), n('vac'), n('lr'), n('lnr'), c.diasTrab, n('hed'), n('hen'), n('rn'), n('rdf'), n('hedf'), n('henf'), c.salario, c.vac + c.lr + c.inc, c.he, c.aux, c.otros, c.devengado, c.salud, c.pension, c.fsp, c.prestamos, c.otrasDed, c.deducciones, c.neto, f.nota || '']);
      }
      return { titulo: `${R.q === 1 ? '1-15' : '16-30'} ${emp}`, filas, anchos: [30, 13, 18, 14, ...Array(12).fill(9), ...Array(13).fill(14), 30], pesos: [3, ...Array.from({ length: 13 }, (_, i) => 16 + i)] };
    });
    libro(hojas, `Nómina ${R.mes} quincena ${R.q}.xlsx`);
  }
  function excelNovedades() {
    const mes = R.mesPla;
    const cab = ['Empresa', 'Nombre', 'Cédula', 'Cargo', 'Salario', 'Días Q1', 'Días Q2', 'Incapacidad (días)', 'Vacaciones (días)', 'Lic. remunerada (días)', 'Lic. no remunerada (días)', 'HE diurnas (h)', 'HE nocturnas (h)', 'Recargo nocturno (h)', 'Recargo dom/fest (h)', 'HE dom diurnas (h)', 'HE dom nocturnas (h)', 'Otros pagos', 'Préstamos', 'Otras deducciones', 'Ingreso', 'Retiro', 'Motivo retiro', 'Notas', 'Modificaciones registradas'];
    const filas = [[`REPORTE DE NOVEDADES · ${nombreMes(mes).toUpperCase()}`], [], cab];
    const vistos = new Map();
    for (const q of [1, 2]) for (const e of empleadosDe(mes, q)) { const k = e.cedula || e.id; if (!vistos.has(k)) vistos.set(k, { e, f: [null, null] }); vistos.get(k).f[q - 1] = filaDe(e, mes, q); }
    const cambiosMes = R.datos.cambios.filter((c) => String(c.periodo || '').startsWith(mes));
    for (const { e, f } of [...vistos.values()].sort((a, b) => String(a.e.empresa).localeCompare(String(b.e.empresa)) || String(a.e.nombre).localeCompare(String(b.e.nombre)))) {
      const s = (k) => (Number((f[0] || {})[k]) || 0) + (Number((f[1] || {})[k]) || 0);
      const mods = cambiosMes.filter((c) => c.empId === e.id).map((c) => `${quien(c.por)}: ${NOMBRE_CAMPO[c.campo] || c.campo} ${c.antes || 0}→${c.despues || 0}`).join('; ');
      filas.push([e.empresa || EMPRESA_DEF, e.nombre, e.cedula, e.cargo || '', Number(e.salario) || 0, f[0] ? Number(f[0].dias) || 0 : 0, f[1] ? Number(f[1].dias) || 0 : 0, s('inc'), s('vac'), s('lr'), s('lnr'), s('hed'), s('hen'), s('rn'), s('rdf'), s('hedf'), s('henf'), s('otros'), s('prestamos'), s('otrasDed'),
        e.ingreso && e.ingreso.slice(0, 7) === mes ? e.ingreso : '', e.retiro && e.retiro.slice(0, 7) === mes ? e.retiro : '', e.retiro && e.retiro.slice(0, 7) === mes ? e.motivoRetiro || '' : '', [f[0] && f[0].nota, f[1] && f[1].nota].filter(Boolean).join(' / '), mods]);
    }
    libro([{ titulo: 'Novedades', filas, anchos: [20, 30, 13, 18, 13, ...Array(15).fill(10), 12, 12, 20, 30, 60], pesos: [4, 17, 18, 19] }], `Novedades nómina ${mes}.xlsx`);
  }
  function excelPlanilla() {
    const mes = R.mesPla, P = R.datos.param, filas = planillaMes(mes);
    const empresas = [...new Set(filas.map((x) => x.e.empresa || EMPRESA_DEF))];
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
    const out = [[`PLANILLA CONSOLIDADA DE SEGURIDAD SOCIAL · ${nombreMes(mes).toUpperCase()} (BORRADOR)`], [],
      ['RESUMEN', ...empresas, 'TOTAL'],
      ...[['Pensión', 'pension'], ['Salud', 'salud'], ['ARL', 'arl'], ['Caja de compensación', 'ccf'], ['SENA', 'sena'], ['ICBF', 'icbf'], ['TOTAL A PAGAR PLANILLA', 'total'], ['(-) Descontado a empleados', 'descontado'], ['COSTO NETO EMPRESA', 'empresa']]
        .map(([l, k]) => [l, ...empresas.map((emp) => sum(filas.filter((x) => (x.e.empresa || EMPRESA_DEF) === emp), k)), sum(filas, k)]),
      [], ['No.', 'EMPRESA', 'NOMBRE', 'IDENTIFICACIÓN', 'CARGO', 'CLASE RIESGO ARL', 'TARIFA ARL %', 'SALARIO MENSUAL', 'DÍAS Q1', 'DÍAS Q2', 'DÍAS COTIZADOS', 'IBC Q1', 'IBC Q2', 'IBC MES', 'PENSIÓN 16%', 'SALUD', 'ARL', 'CCF 4%', 'SENA', 'ICBF', 'TOTAL APORTES', 'DESCONTADO AL EMPLEADO', 'APORTE EMPRESA', 'ING', 'RET', 'IGE (días)', 'VAC (días)', 'LR (días)', 'SLN (días)']];
    let i = 0;
    for (const emp of empresas) for (const x of filas.filter((y) => (y.e.empresa || EMPRESA_DEF) === emp).sort((a, b) => String(a.e.nombre).localeCompare(String(b.e.nombre)))) {
      out.push([++i, emp, x.e.nombre, x.e.cedula, x.e.cargo || '', x.e.riesgo || 1, P.arl[x.e.riesgo || 1], Number(x.e.salario) || 0, x.diasQ1, x.diasQ2, x.dias, x.ibcQ1, x.ibcQ2, x.ibc, x.pension, x.salud, x.arl, x.ccf, x.sena, x.icbf, x.total, x.descontado, x.empresa, x.ing ? 'X' : '', x.ret ? 'X' : '', x.inc || '', x.vac || '', x.lr || '', x.lnr || '']);
    }
    out.push([], ['Notas: borrador calculado por la app. IBC = salario de los días + vacaciones, licencias, incapacidades y horas extra (sin auxilio de transporte ni pagos no constitutivos). Aportes redondeados a la centena. Exonerado de salud empleador, SENA e ICBF (art. 114-1 E.T.) para salarios menores a 10 SMMLV.']);
    libro([{ titulo: `Planilla ${mes}`, filas: out, anchos: [6, 22, 30, 14, 18, 8, 8, 14, 7, 7, 8, 13, 13, 13, 13, 12, 12, 12, 10, 10, 14, 14, 14, 5, 5, 8, 8, 8, 8], pesos: [1, 2, 3, 4, 7, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] }], `Borrador planilla ${mes}.xlsx`);
  }

  // ---------- eventos ----------
  $('#view-rrhh').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-rh-tab], [data-rh], [data-rh-ver], [data-rh-q], [data-rh-emp]');
    if (!t) return;
    if (t.dataset.rhTab) { R.tab = t.dataset.rhTab; render(); return; }
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
