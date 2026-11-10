// Informes de proyectos: PyG por centro de costo (o grupo de centros) con los movimientos de Siigo.
// Los datos los sube el computador (proyectos-siigo.js) a datos/proyectos.enc, cifrados con la llave de la app.
// La configuración (clasificación de cuentas, grupos, m² y valor vendido, personal asignado) está en
// datos/proyectos-conf.enc: la ven todos los usuarios; solo la administradora la modifica.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmt, fmtDate, toast, mostrarError, msgGitHub, nuevoId, todayISO } = A;
  const R_DATOS = 'datos/proyectos.enc', R_CONF = 'datos/proyectos-conf.enc', R_RRHH = 'datos/rrhh.enc', R_ASIS = 'datos/asistencia.enc';

  // Estructura del PyG (modelo de gerencia)
  const ING = ['FACTURACION TOTAL', 'DESCUENTOS'];
  // Salarios operativos proyecto: personal contratado fijo solo para esa obra (su seguridad social va en
  // "Seguridad social operativa directa"); van en el costo de ventas. Salarios operativos compartidos: personal
  // de la empresa que rota entre obras (su seguridad social va en "Seguridad social"); van en gastos.
  const COSTO = ['MANO DE OBRA DIRECTA', 'SALARIOS OPERATIVOS PROYECTO', 'SEGURIDAD SOCIAL OPERATIVA DIRECTA', 'PREOPERATIVOS', 'ESTRUCTURAS', 'IMPERMEABILIZACIONES', 'REVOQUES Y ENCHAPES', 'PARTE ELECTRICA', 'TUBERIA', 'COMPRA DE EQUIPOS', 'GARANTIAS'];
  const GASTO = ['SALARIOS OPERATIVOS COMPARTIDOS', 'SEGURIDAD SOCIAL', 'TRANSPORTES Y VIATICOS', 'GASTOS ADMINISTRATIVOS'];
  const SIN = 'SIN CLASIFICAR', NO = 'NO INCLUIR'; // NO INCLUIR: cuentas que no van al PyG del proyecto (renta, ingresos no operacionales)
  const RUBROS = [...ING, ...COSTO, ...GASTO];
  const ACENTOS = { electrica: 'eléctrica', tuberia: 'tubería', garantias: 'garantías', viaticos: 'viáticos', facturacion: 'facturación' };
  const titulo = (r) => { let s = String(r).toLowerCase(); for (const [a, b] of Object.entries(ACENTOS)) s = s.replace(a, b); return s.charAt(0).toUpperCase() + s.slice(1); };

  // periodo: 'rango' (fecha de inicio a fecha de corte, las escoge la usuaria) o 'mes'
  // repartir: la mano de obra se reparte dentro de los rubros (gerencia no quiere "Mano de obra directa" como rubro aparte)
  const P = { datos: null, conf: null, sha: null, rrhh: null, sel: '', sub: '', periodo: 'rango', desde: '', hasta: '', mes: '', q: '', cargando: false, leido: 0, repartir: true };
  const isAdmin = () => !!A.isAdmin;
  const confBase = () => ({ mapa: {}, grupos: [], obras: {}, personal: [], obrasAsis: {}, presup: {}, actRubro: {} });

  // ---------- datos ----------
  async function leerTodo(forzar) {
    if (P.datos && !forzar && Date.now() - P.leido < 10 * 60e3) return;
    const [fd, fc, fr, fa] = await Promise.all([GH.leer(R_DATOS), GH.leer(R_CONF), GH.leer(R_RRHH), GH.leer(R_ASIS)]);
    P.datos = fd ? await Cripto.descifrarJSON(A.maestra, fd.bytes) : null;
    P.sha = fc ? fc.sha : null;
    P.conf = Object.assign(confBase(), fc ? await Cripto.descifrarJSON(A.maestra, fc.bytes) : {});
    P.rrhh = fr ? await Cripto.descifrarJSON(A.maestra, fr.bytes) : { empleados: [], param: {} };
    // Horas por obra de la app de asistencia (las sube el computador de contabilidad)
    P.asis = fa ? await Cripto.descifrarJSON(A.maestra, fa.bytes) : null;
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
    const out = [], conAsis = mesesConAsistencia();
    for (const a of P.conf.personal || []) {
      if (!ccs.includes(a.cc)) continue;
      const e = ((P.rrhh && P.rrhh.empleados) || []).find((x) => x.id === a.empId) || a.snap || {};
      const c = costoMensual(e);
      for (const [mes, f] of repartoMeses(a)) {
        // Si ese mes la persona ya tiene horas en la app de asistencia, manda la asistencia (no se cuenta dos veces)
        if (conAsis.has(ced(e.cedula) + '|' + mes)) continue;
        const fecha = mes + '-28', comp = 'Personal asignado', t = -1, nombre = e.nombre || a.nombre;
        out.push([fecha, comp, 'N:sal', a.cc, t, c.sal * f, `${nombre}: ${f < 1 ? f.toFixed(2).replace('.', ',') + ' mes' : '1 mes'} de salario y auxilio`, nombre, e.cedula]);
        out.push([fecha, comp, 'N:pre', a.cc, t, c.pre * f, `${nombre}: prima, cesantías, intereses y vacaciones`, nombre, e.cedula]);
        out.push([fecha, comp, 'N:ss', a.cc, t, c.ss * f, `${nombre}: pensión, ARL y caja`, nombre, e.cedula]);
        if (Number(a.viaticoDia) > 0) out.push([fecha, comp, 'N:via', a.cc, t, Number(a.viaticoDia) * 30 * f, `${nombre}: viáticos`, nombre, e.cedula]);
      }
    }
    return out;
  }
  // ---------- personal según la app de asistencia ----------
  // Cada mes, el costo de cada empleado (salario, auxilio, prestaciones y seguridad social) se reparte entre
  // las obras según sus "horas a pagar". Solo empleados que están en Recursos humanos (los subcontratados no).
  const ced = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  let cacheAsis = null;
  function resumenAsistencia() {
    const clave = P.leido + '|' + JSON.stringify(P.conf.obrasAsis || {});
    if (cacheAsis && cacheAsis.clave === clave) return cacheAsis;
    const emps = new Map(((P.rrhh && P.rrhh.empleados) || []).map((e) => [ced(e.cedula), e]));
    const meses = new Map(); // "cedula|AAAA-MM" -> { total, obras: Map(obra -> horas) }
    const fuera = new Map(); // cédulas que marcan pero no están en Recursos humanos -> horas
    for (const [fecha, c, obra, horas] of (P.asis && P.asis.filas) || []) {
      const h = Number(horas) || 0; if (h <= 0) continue;
      if (!emps.has(c)) { fuera.set(c, (fuera.get(c) || 0) + h); continue; }
      const k = c + '|' + String(fecha).slice(0, 7), x = meses.get(k) || { total: 0, obras: new Map() };
      x.total += h; x.obras.set(obra, (x.obras.get(obra) || 0) + h); meses.set(k, x);
    }
    // Nómina que Siigo ya cargó a un centro de costo para esa persona ese mes
    const enSiigo = new Set();
    for (const f of P.datos.filas) if (/^(72|5105)/.test(f[2]) && TER[f[4]]) enSiigo.add(ced(TER[f[4]][0]) + '|' + f[3] + '|' + f[0].slice(0, 7));
    const sinCentro = new Map(); // obras de la asistencia sin centro de costo -> horas
    const filas = [];
    for (const [k, x] of meses) {
      const [c, mes] = k.split('|'), e = emps.get(c);
      const costo = costoMensual(e), frac = fraccionMes(e, mes);
      for (const [obra, h] of x.obras) {
        const cc = (P.conf.obrasAsis || {})[obra];
        if (!cc) { sinCentro.set(obra, (sinCentro.get(obra) || 0) + h); continue; }
        if (cc === 'NO') continue;
        const parte = h / x.total * frac;
        const base = { mes, cc, cedula: c, nombre: e.nombre, horas: h, totalMes: x.total, parte, enSiigo: enSiigo.has(c + '|' + cc + '|' + mes) };
        base.costo = (costo.sal + costo.pre + costo.ss) * parte;
        filas.push(Object.assign(base, { sal: costo.sal * parte, pre: costo.pre * parte, ss: costo.ss * parte }));
      }
    }
    cacheAsis = { clave, filas, meses, fuera, sinCentro, obras: (P.asis && P.asis.obras) || [] };
    return cacheAsis;
  }
  // Parte del mes en que la persona estuvo vinculada (mes comercial de 30 días)
  function fraccionMes(e, mes) {
    const ini = mes + '-01', fin = mes + '-' + String(new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).getDate()).padStart(2, '0');
    if ((e.ingreso && e.ingreso > fin) || (e.retiro && e.retiro < ini)) return 0;
    const d1 = e.ingreso && e.ingreso > ini ? Math.min(30, Number(e.ingreso.slice(8))) : 1;
    const d2 = e.retiro && e.retiro < fin ? Math.min(30, Number(e.retiro.slice(8))) : 30;
    return Math.max(0, d2 - d1 + 1) / 30;
  }
  function mesesConAsistencia() { const r = resumenAsistencia(); return new Set([...r.meses.keys()]); }
  function filasAsistencia(ccs) {
    const out = [];
    for (const x of resumenAsistencia().filas) {
      if (!ccs.includes(x.cc) || x.enSiigo) continue;
      const fecha = x.mes + '-28', comp = 'Asistencia', pc = Math.round(x.horas / x.totalMes * 100);
      out.push([fecha, comp, 'N:sal', x.cc, -1, x.sal, `${x.nombre}: ${x.horas} de ${x.totalMes} horas del mes (${pc} %) · salario y auxilio`, x.nombre, x.cedula]);
      out.push([fecha, comp, 'N:pre', x.cc, -1, x.pre, `${x.nombre}: ${pc} % de prima, cesantías, intereses y vacaciones`, x.nombre, x.cedula]);
      out.push([fecha, comp, 'N:ss', x.cc, -1, x.ss, `${x.nombre}: ${pc} % de pensión, ARL y caja`, x.nombre, x.cedula]);
    }
    return out;
  }
  // Sugerencia de centro de costo para una obra de la asistencia, por palabras en común con el nombre
  function sugerirCentro(obra) {
    const pal = (s) => new Set(String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['contrato', 'piscina', 'construccion', 'mano', 'obra'].includes(w)));
    const p = pal(obra); let mejor = '', puntos = 0;
    for (const c of P.datos.centros.filter((x) => x.mov)) { const q = pal(c.name); let n = 0; for (const w of p) if (q.has(w)) n++; if (n > puntos) { puntos = n; mejor = c.code; } }
    return mejor;
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
    const base = P.datos.filas.filter((f) => set.has(f[3])).concat(filasPersonal(ccs), filasAsistencia(ccs));
    return P.repartir ? repartirMO(base) : base;
  }
  // Rubro de una fila: el que le dio el reparto de mano de obra (f[9]) o el de su cuenta
  const rubFila = (f) => f[9] || rubroDe(f[2], f[1]);

  // ---------- mano de obra dentro de cada rubro ----------
  // La nómina operativa del proyecto (y el personal de la asistencia) se reparte en los rubros de obra:
  // 1) según las actividades que esa persona marcó en la asistencia ese mes en esa obra;
  // 2) si ella no marcó, según las actividades de toda la obra ese mes;
  // 3) lo general (limpieza, "Otra", sin asistencia) en proporción al presupuesto de la obra o, si no hay,
  //    a los materiales que ya se gastaron en ella.
  const MO = ['MANO DE OBRA DIRECTA', 'SEGURIDAD SOCIAL OPERATIVA DIRECTA', 'SALARIOS OPERATIVOS PROYECTO'];
  const OBRA = ['PREOPERATIVOS', 'ESTRUCTURAS', 'IMPERMEABILIZACIONES', 'REVOQUES Y ENCHAPES', 'PARTE ELECTRICA', 'TUBERIA', 'COMPRA DE EQUIPOS', 'GARANTIAS'];
  const GEN = 'GENERAL';
  const sinTilde = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function sugerirRubroAct(a) {
    const s = sinTilde(a);
    if (/impermeab/.test(s)) return 'IMPERMEABILIZACIONES';
    if (/enchap|acabad|mamposter|panete|revoque|membrana|piedra|ceramic/.test(s)) return 'REVOQUES Y ENCHAPES';
    if (/electric|luces|ilumin/.test(s)) return 'PARTE ELECTRICA';
    if (/hidraul|tuberi|cuarto de (maquinas|bombas)|plomer/.test(s)) return 'TUBERIA';
    if (/acero|formalet|fundid|concreto|estructur|armad/.test(s)) return 'ESTRUCTURAS';
    if (/excavac|movimiento de tierra|demolic|replanteo|prelimin|relleno/.test(s)) return 'PREOPERATIVOS';
    if (/equipo/.test(s)) return 'COMPRA DE EQUIPOS';
    if (/garantia/.test(s)) return 'GARANTIAS';
    return GEN; // limpieza, cargue, mantenimiento, "Otra"
  }
  const rubroActividad = (a) => (P.conf.actRubro || {})[a] || sugerirRubroAct(a);
  const actividadesDe = (txt) => { const l = String(txt || '').split('/').map((s) => s.trim()).filter(Boolean); return l.length ? l : ['Otra']; };
  let cacheAct = null;
  function indiceActividades() {
    const clave = P.leido + '|' + JSON.stringify(P.conf.obrasAsis || {}) + JSON.stringify(P.conf.actRubro || {}) + JSON.stringify(P.conf.presup || {}).length + JSON.stringify(P.conf.mapa || {}).length;
    if (cacheAct && cacheAct.clave === clave) return cacheAct;
    const per = new Map(), obra = new Map(), vistas = new Map();
    const suma = (m, k, r, h) => { const x = m.get(k) || new Map(); x.set(r, (x.get(r) || 0) + h); m.set(k, x); };
    for (const [fecha, c, nomObra, horas, , act] of (P.asis && P.asis.filas) || []) {
      const h = Number(horas) || 0; if (h <= 0) continue;
      const l = actividadesDe(act);
      for (const a of l) vistas.set(a, (vistas.get(a) || 0) + h / l.length);
      const cc = (P.conf.obrasAsis || {})[nomObra]; if (!cc || cc === 'NO') continue;
      const mes = String(fecha).slice(0, 7);
      for (const a of l) { const r = rubroActividad(a); suma(per, cc + '|' + mes + '|' + ced(c), r, h / l.length); suma(obra, cc + '|' + mes, r, h / l.length); }
    }
    cacheAct = { clave, per, obra, vistas, gen: new Map() };
    return cacheAct;
  }
  // Presupuesto que aplica a un centro de costo: el suyo o el del grupo que se está mirando
  function presupDe(cc) {
    const p = P.conf.presup || {};
    if (p['c:' + cc]) return p['c:' + cc];
    if (P.sel.startsWith('g:') && p[P.sel] && ccsDe(P.sel).includes(cc)) return p[P.sel];
    for (const g of grupos()) if (p['g:' + g.id] && (g.ccs || []).includes(cc)) return p['g:' + g.id];
    return null;
  }
  const pesosPresup = (pr) => { const m = new Map(); for (const cap of pr.caps || []) for (const it of cap.items || []) if (OBRA.includes(it.r)) m.set(it.r, (m.get(it.r) || 0) + (Number(it.v) || 0)); return m; };
  // Pesos para repartir lo "general" de un centro de costo
  function pesosGenerales(cc) {
    const idx = indiceActividades();
    if (idx.gen.has(cc)) return idx.gen.get(cc);
    let r = null;
    const pr = presupDe(cc);
    if (pr) { const m = pesosPresup(pr); if ([...m.values()].some((v) => v > 0)) r = { m, como: 'según el presupuesto' }; }
    if (!r) {
      const m = new Map();
      for (const f of P.datos.filas) if (f[3] === cc) { const rb = rubroDe(f[2], f[1]); if (OBRA.includes(rb)) m.set(rb, (m.get(rb) || 0) + f[5]); }
      for (const [k, v] of m) if (v <= 0) m.delete(k);
      if (m.size) r = { m, como: 'según los materiales de la obra' };
    }
    idx.gen.set(cc, r);
    return r;
  }
  // Solo el personal FIJO del proyecto (nómina de Siigo en Mano de obra directa, Salarios operativos proyecto y
  // Seguridad social operativa directa). El personal compartido (asistencia y asignado a mano) se queda en gastos.
  const esMO = (f) => f[1] !== 'Asistencia' && !f[2].startsWith('N:') && MO.includes(rubroDe(f[2], f[1]));
  function repartirMO(filas) {
    const idx = indiceActividades(), out = [];
    for (const f of filas) {
      if (!esMO(f)) { out.push(f); continue; }
      const mes = f[0].slice(0, 7), cc = f[3];
      const cedula = f[4] >= 0 ? ced((TER[f[4]] || [])[0]) : ced(f[8]);
      let base = idx.per.get(cc + '|' + mes + '|' + cedula), como = 'según sus actividades en la asistencia';
      if (!base) { base = idx.obra.get(cc + '|' + mes); como = 'según las actividades de la obra ese mes'; }
      const pesos = new Map(); let general = 0;
      if (base) { for (const [r, h] of base) { if (r === GEN) general += h; else pesos.set(r, (pesos.get(r) || 0) + h); } }
      else general = 1;
      if (general > 0) {
        const g = pesosGenerales(cc);
        if (g) {
          const gt = [...g.m.values()].reduce((s, v) => s + v, 0);
          for (const [r, v] of g.m) pesos.set(r, (pesos.get(r) || 0) + general * v / gt);
          if (!base) como = g.como;
        } else pesos.set('MANO DE OBRA DIRECTA', (pesos.get('MANO DE OBRA DIRECTA') || 0) + general);
      }
      const tot = [...pesos.values()].reduce((s, v) => s + v, 0);
      if (!(tot > 0)) { out.push(f); continue; }
      for (const [r, w] of pesos) {
        const g = f.slice(); g[5] = f[5] * w / tot; g[9] = r; g[10] = base ? 'act' : 'gen';
        if (pesos.size > 1) g[6] = `${f[6]} · ${pct(w / tot)} ${como}`;
        out.push(g);
      }
    }
    return out;
  }

  function calcular(ccs) {
    const filas = filasDe(ccs).filter((f) => enPeriodo(f[0]));
    const r = {}; for (const x of [...RUBROS, SIN]) r[x] = 0;
    const porProv = new Map(), porMes = new Map(), sinCl = new Map();
    const mo = { total: 0, act: 0, gen: 0, rub: new Map() };
    for (const f of filas) {
      const rub = rubFila(f);
      if (f[10]) { mo.total += f[5]; mo[f[10]] += f[5]; mo.rub.set(rub, (mo.rub.get(rub) || 0) + f[5]); }
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
    return { r, fact, desc, ventas, costoVentas, gastos, costo: costoVentas + gastos, bruta, operativa, porProv, porMes, sinCl, mo, n: filas.length };
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
    const cTot = P.periodo === 'mes' ? calcularTodo(ccs) : c;
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
        <div class="quick" role="group" aria-label="Mano de obra"><button class="qbtn" type="button" data-proy-mo="1" aria-pressed="${P.repartir}" title="El personal fijo del proyecto se reparte en estructuras, enchape, tubería… según las actividades">Mano de obra dentro de cada rubro</button><button class="qbtn" type="button" data-proy-mo="0" aria-pressed="${!P.repartir}">Mano de obra aparte</button></div>
      </div><div class="grupo">${isAdmin() && P.sel.startsWith('g:') ? '<button class="btn" type="button" data-proy="grupo">Editar grupo</button>' : ''}<button class="btn" type="button" data-proy="excel">Descargar Excel</button></div></div>
      ${subChips}
      <p class="proy-periodo">${esc(textoPeriodo())} · ${esc(P.sub ? `Centro de costo ${P.sub}` : P.sel.startsWith('g:') ? `Grupo: ${todos.join(', ')}` : `Centro de costo ${P.sel.slice(2)}`)}</p>
      ${c.sinCl.size ? `<div class="proy-aviso">⚠ Hay ${c.sinCl.size} ${c.sinCl.size === 1 ? 'cuenta' : 'cuentas'} sin rubro por ${fmt([...c.sinCl.values()].reduce((s, v) => s + v, 0))}: salen en "Sin clasificar". ${isAdmin() ? '<button class="rh-link" type="button" data-proy="clasificar">Clasificarlas</button>' : 'La administradora debe clasificarlas.'}</div>` : ''}
      <section class="rep-sum proy-tiles">${tiles.map(([cl, l, v, s]) => `<div class="tile ${cl}"><span class="lbl">${l}</span><span class="val">${v}</span><span>${s}</span></div>`).join('')}</section>
      ${!m2 || !vendido ? guia(`💡 ${isAdmin() ? 'Escribe los <b>m²</b> y el <b>valor vendido</b> de la obra en "Datos de la obra" (abajo) para ver el costo por m².' : 'Cuando la administradora registre los m² y el valor vendido, aquí verás el costo por m².'}`) : ''}
      ${seccionPresupuesto(claveObra, ccs, obra)}
      <div class="proy-graficas">
        <section class="proy-caja"><h3>¿En qué se fue la plata?</h3><p class="proy-nota">Costos y gastos por rubro. Toca una barra para ver los proveedores.</p>${barrasRubros(c)}</section>
        <section class="proy-caja"><h3>Mes a mes</h3><p class="proy-nota">Ventas y costos de cada mes.</p>${graficaMeses(ccs)}</section>
      </div>
      <section class="proy-caja"><h3>Acumulado en el tiempo</h3><p class="proy-nota">${P.periodo === 'mes' ? `Cómo se fueron sumando las ventas, los costos y la utilidad del proyecto hasta ${esc(nombreMes(P.mes).toLowerCase())}.` : 'Cómo se fueron sumando las ventas, los costos y la utilidad entre la fecha de inicio y la de corte.'} Pasa el dedo o el mouse por un punto para ver el valor.</p>${graficaLineas(serieMeses(ccs))}</section>
      <section class="proy-caja"><h3>Estado de resultados (PyG)</h3><p class="proy-nota">Toca un rubro para ver qué proveedores y documentos lo forman.${P.repartir && c.mo.total ? ' El personal fijo del proyecto está dentro de cada rubro; tócalo para ver cada empleado.' : ''}</p>${tablaPyG(c)}</section>
      ${seccionMO(c)}
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
    const pm = new Map(); for (const f of filasDe(ccs)) { const rb = rubFila(f); if (rb === NO) continue; const m = f[0].slice(0, 7); const x = pm.get(m) || { ing: 0, costo: 0 }; if (ING.includes(rb)) x.ing -= f[5]; else x.costo += f[5]; pm.set(m, x); }
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
  // Serie mensual: ventas, costos y utilidad de cada mes y sus acumulados.
  // Acumulado: meses entre la fecha de inicio y la de corte. Un mes: desde el inicio del proyecto hasta ese mes.
  function serieMeses(ccs) {
    const dentro = (fecha) => (P.periodo === 'mes' ? fecha.slice(0, 7) <= P.mes : enPeriodo(fecha));
    const pm = new Map();
    for (const f of filasDe(ccs)) {
      if (!dentro(f[0])) continue;
      const rb = rubFila(f); if (rb === NO) continue;
      const m = f[0].slice(0, 7), x = pm.get(m) || { ing: 0, costo: 0 };
      if (ING.includes(rb)) x.ing -= f[5]; else x.costo += f[5];
      pm.set(m, x);
    }
    const conMov = [...pm.keys()].sort();
    const ini = P.periodo === 'mes' ? (conMov[0] || P.mes) : (P.desde || todayISO()).slice(0, 7);
    const fin = P.periodo === 'mes' ? P.mes : (P.hasta || todayISO()).slice(0, 7);
    const out = []; let ia = 0, ca = 0;
    for (let m = ini; m <= fin && out.length < 600; m = mesMas(m, 1)) {
      const v = pm.get(m) || { ing: 0, costo: 0 }; ia += v.ing; ca += v.costo;
      out.push({ mes: m, ing: v.ing, costo: v.costo, util: v.ing - v.costo, ingAc: ia, costoAc: ca, utilAc: ia - ca });
    }
    return out;
  }
  function graficaLineas(serie) {
    if (!serie.length || serie.every((s) => !s.ing && !s.costo)) return '<p class="proy-nota">Sin movimientos en este periodo.</p>';
    const L = [['ingAc', 'Ventas acumuladas', 'l-ven'], ['costoAc', 'Costos acumulados', 'l-cos'], ['utilAc', 'Utilidad acumulada', 'l-uti']];
    const vals = serie.flatMap((s) => L.map(([k]) => s[k]));
    const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
    const W = 720, H = 260, izq = 64, der = 12, arr = 14, aba = 26;
    const x = (i) => izq + (serie.length === 1 ? (W - izq - der) / 2 : i * (W - izq - der) / (serie.length - 1));
    const y = (v) => arr + (max - v) / (max - min) * (H - arr - aba);
    // Líneas guía: 0, máximo, mínimo y la mitad
    const guias = [...new Set([max, max / 2, 0, min].filter((v, i) => i < 3 || v < 0))].filter((v) => v === 0 || Math.abs(y(v) - y(0)) > 14).map((v) => `<line x1="${izq}" x2="${W - der}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${v === 0 ? 'cero' : 'guia'}"/><text x="${izq - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(millones(v))}</text>`).join('');
    const paso = Math.ceil(serie.length / 12);
    const meses = serie.map((s, i) => (i % paso === 0 || i === serie.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(mesCorto(s.mes))}</text>` : '')).join('');
    const lineas = L.map(([k, , cl]) => `<polyline class="${cl}" points="${serie.map((s, i) => `${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`).join(' ')}"/>`).join('');
    const puntos = serie.map((s, i) => `<g class="pt"><title>${esc(nombreMes(s.mes))}\nVentas acumuladas: ${fmt(s.ingAc)}\nCostos acumulados: ${fmt(s.costoAc)}\nUtilidad acumulada: ${fmt(s.utilAc)}</title><rect x="${(x(i) - (W - izq - der) / Math.max(1, serie.length) / 2).toFixed(1)}" y="${arr}" width="${Math.max(4, (W - izq - der) / Math.max(1, serie.length)).toFixed(1)}" height="${H - arr - aba}" class="zona"/>${L.map(([k, , cl]) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s[k]).toFixed(1)}" r="${serie.length > 40 ? 1.8 : 3}" class="${cl}"/>`).join('')}</g>`).join('');
    const u = serie[serie.length - 1];
    return `<svg class="proy-lineas" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ventas, costos y utilidad acumulados por mes">${guias}${meses}${lineas}${puntos}</svg>
      <p class="proy-ley">${L.map(([k, n, cl]) => `<span class="${cl}"></span> ${n}: <b>${esc(millones(u[k]))}</b>`).join(' ')}</p>`;
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

  // ---------- presupuesto contra lo real ----------
  // Todo el proyecto (sin importar el periodo escogido): el presupuesto es de la obra completa
  // (hasta hoy: el personal de la asistencia y el asignado se cargan el día 28 de cada mes, como la nómina)
  function calcularTodo(ccs) { const s = [P.periodo, P.desde, P.hasta]; P.periodo = 'rango'; P.desde = ''; P.hasta = todayISO(); try { return calcular(ccs); } finally { [P.periodo, P.desde, P.hasta] = s; } }
  function comparativo(pr, cp) {
    const pres = pesosPresup(pr);
    const rubros = [...new Set([...OBRA.filter((r) => pres.has(r)), ...COSTO.filter((r) => Math.abs(cp.r[r]) >= 1)])];
    const filas = rubros.map((r) => { const p = pres.get(r) || 0, v = cp.r[r] || 0; return { r, p, v, dif: p - v, uso: p ? v / p : (v ? Infinity : 0) }; });
    const pTot = Number(pr.directo) || filas.reduce((s, x) => s + x.p, 0);
    return { filas, pTot, vTot: cp.costoVentas };
  }
  const estadoUso = (u) => (u > 1.0001 ? 'rojo' : u >= 0.8 ? 'amarillo' : 'verde');
  function seccionPresupuesto(claveObra, ccs, obra) {
    const pr = (P.conf.presup || {})[claveObra];
    const cab = '<section class="proy-caja proy-pres"><h3>Presupuesto contra lo real</h3>';
    if (!pr) {
      return `${cab}<p class="proy-nota">${isAdmin() ? 'Sube el presupuesto de la obra en PDF (el que hace el área técnica). Cuadra lee los capítulos y sus valores y los compara con lo que se ha gastado en cada rubro.' : 'La administradora aún no ha cargado el presupuesto de esta obra.'}</p>${isAdmin() ? '<button class="btn primary" type="button" data-proy="presupuesto">Subir presupuesto (PDF)</button>' : ''}</section>`;
    }
    const cp = calcularTodo(ccs), k = comparativo(pr, cp);
    const usoTot = k.pTot ? k.vTot / k.pTot : 0;
    const vendido = Number(obra.valorVenta) || Number(pr.total) - (Number(pr.iva) || 0);
    const avance = vendido ? cp.ventas / vendido : NaN;
    const barra = (u) => `<span class="pres-barra ${estadoUso(u)}"><span style="width:${Math.min(100, Math.max(0, (isFinite(u) ? u : 1) * 100)).toFixed(1)}%"></span></span>`;
    const filas = k.filas.sort((a, b) => b.p - a.p || b.v - a.v).map((x) => `<tr class="click" data-proy-rubro="${esc(x.r)}"><td>${esc(titulo(x.r))}</td><td class="n">${x.p ? fmt(x.p) : '<span class="sub">Sin presupuesto</span>'}</td><td class="n">${fmt(x.v)}</td><td class="n ${x.dif < 0 ? 'neg' : ''}">${x.p ? fmt(x.dif) : '—'}</td><td class="pres-uso">${barra(x.uso)}<b>${x.p ? pct(x.uso) : '—'}</b></td></tr>`).join('');
    const pasados = k.filas.filter((x) => x.p && x.uso > 1.0001), sinPres = k.filas.filter((x) => !x.p && x.v >= 1);
    const alertas = [
      ...pasados.map((x) => `<span class="rojo">● ${esc(titulo(x.r))}: se pasó ${fmt(-x.dif)}</span>`),
      ...k.filas.filter((x) => x.p && x.uso >= 0.8 && x.uso <= 1.0001).map((x) => `<span class="amarillo">● ${esc(titulo(x.r))}: lleva ${pct(x.uso)}</span>`),
      ...(sinPres.length ? [`<span class="amarillo">● Sin presupuesto: ${sinPres.map((x) => esc(titulo(x.r))).join(', ')}</span>`] : []),
    ];
    const utilEsp = vendido - k.pTot, utilAct = vendido - cp.costo;
    return `${cab}
      <p class="proy-nota">${esc(pr.nombre || '')}${pr.cot ? ' · ' + esc(pr.cot) : ''}${pr.version ? ' · versión ' + esc(pr.version) : ''}. Se compara con <b>todo el proyecto</b> (sin importar las fechas escogidas arriba)${P.repartir ? ', con la mano de obra dentro de cada rubro' : ''}. Toca un rubro para ver los proveedores.</p>
      <section class="rep-sum proy-tiles">
        <div class="tile main"><span class="lbl">Costo directo presupuestado</span><span class="val">${millones(k.pTot)}</span><span>Valor de la obra ${millones(Number(pr.total) || 0)} (con administración, imprevistos y utilidad)</span></div>
        <div class="tile ${usoTot > 1 ? 'neg' : ''}"><span class="lbl">Costo real a la fecha</span><span class="val">${millones(k.vTot)}</span><span>${pct(usoTot)} del presupuesto consumido</span></div>
        <div class="tile"><span class="lbl">Avance facturado</span><span class="val">${pct(avance)}</span><span>${millones(cp.ventas)} de ${millones(vendido)}</span></div>
        <div class="tile ${k.pTot - k.vTot < 0 ? 'neg' : 'pos'}"><span class="lbl">Queda del presupuesto</span><span class="val">${millones(k.pTot - k.vTot)}</span><span>Utilidad esperada del contrato: ${millones(utilEsp)}${utilAct < utilEsp ? ` · con lo gastado hoy quedarían ${millones(utilAct)}` : ''}</span></div>
      </section>
      ${alertas.length ? `<div class="rh-semaforo">${alertas.join('')}</div>` : '<div class="rh-semaforo"><span class="verde">● Todos los rubros van dentro del presupuesto</span></div>'}
      <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Rubro</th><th class="n">Presupuesto</th><th class="n">Real</th><th class="n">Disponible</th><th>Consumido</th></tr></thead><tbody>${filas}
        <tr class="tot"><td>Total costo directo</td><td class="n">${fmt(k.pTot)}</td><td class="n">${fmt(k.vTot)}</td><td class="n ${k.pTot - k.vTot < 0 ? 'neg' : ''}">${fmt(k.pTot - k.vTot)}</td><td class="pres-uso">${barra(usoTot)}<b>${pct(usoTot)}</b></td></tr></tbody></table></div>
      <p class="proy-nota">Verde: menos del 80 % · amarillo: del 80 % al 100 % · rojo: se pasó. Compara el % consumido con el avance de la obra. La administración (${fmt(pr.adm || 0)}) y los imprevistos (${fmt(pr.imp || 0)}) son parte del valor de la piscina; los gastos operativos reales (${fmt(cp.gastos)}) no se restan del costo directo.</p>
      <details class="pres-det"><summary>Ver los capítulos e ítems del presupuesto</summary>${(pr.caps || []).map((cap) => `<h4>${esc(cap.n)} · ${fmt(cap.items.reduce((s, it) => s + (Number(it.v) || 0), 0))}</h4><ul class="proy-cuentas">${cap.items.map((it) => `<li><span>${esc(it.c)} ${esc(it.d)} <span class="sub">· ${esc(titulo(it.r))}</span></span><b>${fmt(it.v)}</b></li>`).join('')}</ul>`).join('')}</details>
      ${isAdmin() ? '<div class="rh-card-acc" style="margin-top:10px"><button class="btn" type="button" data-proy="presupuesto">Cambiar presupuesto</button><button class="btn" type="button" data-proy="presupuesto-quitar">Quitar presupuesto</button></div>' : ''}
    </section>`;
  }

  // Cómo quedó repartida la mano de obra (periodo escogido)
  function seccionMO(c) {
    if (!P.repartir || !(Math.abs(c.mo.total) >= 1)) return '';
    const l = [...c.mo.rub.entries()].filter(([, v]) => Math.abs(v) >= 1).sort((a, b) => b[1] - a[1]);
    const idx = indiceActividades();
    return `<section class="proy-caja"><h3>Mano de obra dentro de los rubros</h3>
      <p class="proy-nota">El personal fijo del proyecto (salarios operativos proyecto y seguridad social operativa directa: ${fmt(c.mo.total)}) se repartió en los rubros. El personal compartido sigue abajo, en gastos operativos. Reparto: <b>${pct(c.mo.act / c.mo.total)}</b> según las actividades que marcaron en la asistencia y <b>${pct(c.mo.gen / c.mo.total)}</b> en proporción ${Object.keys(P.conf.presup || {}).length ? 'al presupuesto (o a los materiales, si la obra no tiene presupuesto)' : 'a los materiales de la obra'}, para los meses sin asistencia y las labores generales (limpieza, cargue, "Otra").</p>
      <ul class="proy-cuentas">${l.map(([r, v]) => `<li><span>${esc(titulo(r))}</span><b>${fmt(v)}</b></li>`).join('')}</ul>
      ${isAdmin() && idx.vistas.size ? '<div class="rh-card-acc" style="margin-top:10px"><button class="btn" type="button" data-proy="actividades">Actividades y rubros</button></div>' : ''}
    </section>`;
  }
  function abrirActividades() {
    const idx = indiceActividades();
    const l = [...idx.vistas.entries()].sort((a, b) => b[1] - a[1]);
    abrirForm('Actividades de la asistencia y rubros', `
      <p class="full proy-nota" style="margin:0">Escoge el rubro de cada actividad que marcan los trabajadores. Las horas de esa actividad llevan su costo a ese rubro. "General" se reparte en proporción al presupuesto de la obra.</p>
      <div class="full rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Actividad</th><th class="n">Horas</th><th>Rubro</th></tr></thead><tbody>
      ${l.map(([a, h]) => { const actual = rubroActividad(a); return `<tr><td>${esc(a)}${(P.conf.actRubro || {})[a] ? '' : '<br><span class="sub">Sugerido</span>'}</td><td class="n">${Math.round(h).toLocaleString('es-CO')}</td><td><select data-pact="${esc(a)}"><option value="${GEN}"${actual === GEN ? ' selected' : ''}>General (según el presupuesto)</option>${OBRA.map((r) => `<option value="${esc(r)}"${actual === r ? ' selected' : ''}>${esc(titulo(r))}</option>`).join('')}</select></td></tr>`; }).join('')}
      </tbody></table></div>`,
    async () => {
      const m = {}; document.querySelectorAll('[data-pact]').forEach((s) => { m[s.dataset.pact] = s.value; });
      await mutarConf((c) => { c.actRubro = Object.assign({}, c.actRubro || {}, m); });
    }, 'Guardar');
  }

  // ---------- lectura del presupuesto en PDF ----------
  // Formato del presupuesto del área técnica: "CAPÍTULO n - NOMBRE", ítems "1.01 Descripción Und Cant. $ P.U. $ Parcial",
  // "Subtotal …", "Subtotal costos directos", Administración, Imprevistos, Utilidad, IVA sobre utilidad y TOTAL.
  async function lineasPdf(file) {
    if (typeof Lector === 'undefined' || !Lector.pdfjs) throw new Error('No cargó el lector de PDF. Recarga la página.');
    const lib = await Lector.pdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const out = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      const filas = [];
      for (const it of tc.items) {
        if (!String(it.str).trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let f = filas.find((z) => Math.abs(z.y - y) <= 2.5);
        if (!f) { f = { y, xs: [] }; filas.push(f); }
        f.xs.push([x, it.str]);
      }
      filas.sort((a, b) => b.y - a.y).forEach((f) => out.push(f.xs.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ').replace(/\s+/g, ' ').trim()));
    }
    return out;
  }
  const montoPres = (s) => Number(String(s || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
  function rubroCapitulo(nombre) {
    const s = sinTilde(nombre);
    if (/prelimin|preoperat/.test(s)) return 'PREOPERATIVOS';
    if (/estructur/.test(s)) return 'ESTRUCTURAS';
    if (/impermeab/.test(s)) return 'IMPERMEABILIZACIONES';
    if (/panete|revoque|enchap|acabad/.test(s)) return 'REVOQUES Y ENCHAPES';
    if (/electric/.test(s)) return 'PARTE ELECTRICA';
    if (/equipo/.test(s)) return 'COMPRA DE EQUIPOS';
    if (/hidraul|tuberi|instalaciones tecnicas|instalacion/.test(s)) return 'TUBERIA';
    if (/garantia/.test(s)) return 'GARANTIAS';
    return 'ESTRUCTURAS';
  }
  function rubroItem(capRubro, desc) {
    const s = sinTilde(desc);
    if (capRubro === 'TUBERIA' && /electric|luces|regata/.test(s)) return 'PARTE ELECTRICA';
    return capRubro;
  }
  function leerPresupuesto(lineas) {
    const pr = { caps: [], avisos: [] };
    const tx = lineas.join('\n');
    const i0 = lineas.findIndex((l) => /^PRESUPUESTO$/i.test(l));
    pr.nombre = (i0 >= 0 ? lineas[i0 + 1] : '') || '';
    pr.cliente = ((/Cliente:\s*(.+?)(?:\s*·|\s+NIT|$)/m.exec(tx) || [])[1] || '').trim();
    pr.cot = ((/Cotizaci[oó]n\s*N[°º.o]*\s*([\w-]+)/i.exec(tx) || [])[1] || '').trim();
    pr.version = ((/Versi[oó]n:?\s*([\w-]+)/i.exec(tx) || [])[1] || '').trim();
    const tomar = (re) => { const m = re.exec(tx); return m ? montoPres(m[m.length - 1]) : 0; };
    pr.directo = tomar(/Subtotal costos directos\s*\$?\s*([\d.,]+)/i);
    pr.adm = tomar(/Administraci[oó]n[^$\n]*\$\s*([\d.,]+)/i);
    pr.imp = tomar(/Imprevistos[^$\n]*\$\s*([\d.,]+)/i);
    pr.util = tomar(/\nUtilidad[^$\n]*\$\s*([\d.,]+)/i);
    pr.iva = tomar(/(?:^|\n)\s*IVA\b[^$\n]*\$\s*([\d.,]+)/);
    pr.total = tomar(/\nTOTAL\s*\$\s*([\d.,]+)/i);
    // Ítems: se juntan las líneas desde el código hasta el siguiente ítem, capítulo o subtotal
    let cap = null, buf = '';
    const ITEM = /^(\d+\.\d+)\s+(.+?)\s+(\S{1,6})\s+([\d.,]+)\s+\$\s*([\d.,]+)\s+\$\s*([\d.,]+)\s*(.*)$/;
    const cerrar = () => {
      if (!buf) return;
      const m = ITEM.exec(buf);
      if (m && cap) { const d = (m[2] + (m[7] ? ' ' + m[7] : '')).trim(); cap.items.push({ c: m[1], d, u: m[3], q: montoPres(m[4]), pu: montoPres(m[5]), v: montoPres(m[6]), r: rubroItem(cap.r, d) }); }
      else pr.avisos.push('No pude leer: ' + buf.slice(0, 90));
      buf = '';
    };
    for (const l of lineas) {
      const capM = /CAP[ÍI]TULO\s+(\d+)\s*[-–:]\s*(.+)$/i.exec(l);
      if (capM) { cerrar(); cap = { n: capM[2].trim(), r: rubroCapitulo(capM[2]), items: [], sub: 0 }; pr.caps.push(cap); continue; }
      const sub = /^Subtotal\s+(.+?)\s*\$\s*([\d.,]+)$/i.exec(l);
      if (sub) { cerrar(); if (cap && !/costos directos/i.test(sub[1])) cap.sub = montoPres(sub[2]); if (/costos directos/i.test(sub[1])) cap = null; continue; }
      if (/^#\s*Descripci/i.test(l) || /NIT\s*\d|Tel\s*\d/i.test(l)) continue;
      if (/^\d+\.\d+\s/.test(l)) { cerrar(); buf = l; continue; }
      if (buf) buf += ' ' + l;
    }
    cerrar();
    // Revisiones de cuadre
    for (const c of pr.caps) { const s = c.items.reduce((a, it) => a + it.v, 0); if (c.sub && Math.abs(s - c.sub) > 2) pr.avisos.push(`El capítulo ${c.n} suma ${fmt(s)} y su subtotal dice ${fmt(c.sub)}.`); }
    const sumaItems = pr.caps.reduce((a, c) => a + c.items.reduce((b, it) => b + it.v, 0), 0);
    if (pr.directo && Math.abs(sumaItems - pr.directo) > 5) pr.avisos.push(`Los ítems suman ${fmt(sumaItems)} y el subtotal de costos directos dice ${fmt(pr.directo)}.`);
    if (!pr.directo) pr.directo = sumaItems;
    if (pr.total && Math.abs(pr.directo + pr.adm + pr.imp + pr.util + pr.iva - pr.total) > 5) pr.avisos.push('El total no cuadra con costos directos + administración + imprevistos + utilidad + IVA.');
    return pr;
  }
  function abrirPresupuesto() {
    const clave = P.sub ? 'c:' + P.sub : P.sel;
    let leido = null;
    abrirForm(`Presupuesto · ${P.sub ? nombreCC(P.sub) : nombreSel(P.sel)}`, `
      <div class="field full"><label for="pr-file">Presupuesto en PDF</label><input type="file" id="pr-file" accept="application/pdf,.pdf"><span class="hint">El que genera el área técnica (capítulos, ítems, subtotal de costos directos, AIU y total).</span></div>
      <div class="full" id="pr-res"></div>`,
    async () => {
      if (!leido) throw new Error('Escoge el PDF del presupuesto.');
      const items = leido.caps.reduce((a, c) => a + c.items.length, 0);
      if (!items) throw new Error('No encontré ítems en el PDF.');
      document.querySelectorAll('[data-pri]').forEach((s) => { const [ci, ii] = s.dataset.pri.split('.').map(Number); leido.caps[ci].items[ii].r = s.value; });
      const usarValor = $('#pr-valor') && $('#pr-valor').checked;
      const guardar = { nombre: leido.nombre, cliente: leido.cliente, cot: leido.cot, version: leido.version, archivo: leido.archivo, directo: leido.directo, adm: leido.adm, imp: leido.imp, util: leido.util, iva: leido.iva, total: leido.total, caps: leido.caps.map((c) => ({ n: c.n, items: c.items.map((it) => ({ c: it.c, d: it.d, u: it.u, q: it.q, pu: it.pu, v: it.v, r: it.r })) })), en: new Date().toISOString(), por: A.uid };
      await mutarConf((c) => {
        c.presup = c.presup || {}; c.presup[clave] = guardar;
        if (usarValor) { c.obras = c.obras || {}; c.obras[clave] = Object.assign({}, c.obras[clave] || {}, { valorVenta: Math.round(leido.total - leido.iva) }); }
      });
    }, 'Guardar presupuesto');
    $('#pf-go').disabled = true;
    $('#pr-file').addEventListener('change', async (ev) => {
      const file = ev.target.files[0]; const res = $('#pr-res'); leido = null; $('#pf-go').disabled = true;
      if (!file) { res.innerHTML = ''; return; }
      res.innerHTML = '<p class="proy-nota">Leyendo el PDF…</p>';
      try {
        leido = leerPresupuesto(await lineasPdf(file)); leido.archivo = file.name;
        const obra = (P.conf.obras || {})[clave] || {};
        const sinIva = Math.round(leido.total - leido.iva);
        const opc = (r) => OBRA.map((x) => `<option value="${esc(x)}"${x === r ? ' selected' : ''}>${esc(titulo(x))}</option>`).join('');
        res.innerHTML = `<div class="rh-asis-res">
          <p class="rh-asis-resumen"><b>${esc(leido.nombre || file.name)}</b>${leido.cot ? ' · ' + esc(leido.cot) : ''}${leido.version ? ' · ' + esc(leido.version) : ''}<br>Costos directos <b>${fmt(leido.directo)}</b> · administración ${fmt(leido.adm)} · imprevistos ${fmt(leido.imp)} · utilidad ${fmt(leido.util)} · IVA ${fmt(leido.iva)} · <b>total ${fmt(leido.total)}</b></p>
          ${leido.avisos.length ? `<div class="proy-aviso">⚠ ${leido.avisos.map(esc).join('<br>')}</div>` : '<p class="proy-nota">✔ Los capítulos cuadran con el subtotal de costos directos y el total.</p>'}
          <p class="proy-nota">Revisa el rubro de cada ítem (la mano de obra de cada ítem va en su mismo rubro):</p>
          <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Ítem</th><th class="n">Valor</th><th>Rubro</th></tr></thead><tbody>
          ${leido.caps.map((c, ci) => `<tr class="sec"><td colspan="3">${esc(c.n)} · <select data-prc="${ci}" aria-label="Rubro de todo el capítulo">${opc(c.r)}</select></td></tr>${c.items.map((it, ii) => `<tr><td>${esc(it.c)} ${esc(it.d)}</td><td class="n">${fmt(it.v)}</td><td><select data-pri="${ci}.${ii}">${opc(it.r)}</select></td></tr>`).join('')}`).join('')}
          </tbody></table></div>
          ${leido.total ? `<label class="check" style="margin-top:8px"><input type="checkbox" id="pr-valor" ${!obra.valorVenta || Math.round(obra.valorVenta) !== sinIva ? 'checked' : ''}> Usar ${fmt(sinIva)} (total sin el IVA) como valor vendido de la obra${obra.valorVenta ? ` (hoy dice ${fmt(obra.valorVenta)})` : ''}</label>` : ''}
        </div>`;
        res.querySelectorAll('[data-prc]').forEach((s) => s.addEventListener('change', () => res.querySelectorAll(`[data-pri^="${s.dataset.prc}."]`).forEach((x) => { x.value = s.value; })));
        $('#pf-go').disabled = false;
      } catch (e) { leido = null; res.innerHTML = `<p class="rh-asis-falta">No pude leer el PDF: ${esc(e.message || e)}</p>`; }
    });
  }

  // Personal según la app de asistencia, en este proyecto y periodo
  function seccionAsistencia(ccs) {
    const cab = `<section class="proy-caja"><h3>Personal según la asistencia</h3>`;
    const botones = isAdmin() ? `<div class="rh-card-acc" style="margin-top:10px"><button class="btn" type="button" data-proy="asis-conexion">Conexión con la asistencia</button>${P.asis ? '<button class="btn" type="button" data-proy="asis-obras">Relacionar obras con centros de costo</button>' : ''}</div>` : '';
    if (!P.asis) return `${cab}<p class="proy-nota">Aún no hay datos de la app de asistencia. ${isAdmin() ? 'Cuando tu compañero instale la conexión, escribe aquí la clave que te dé y el computador de contabilidad traerá las horas automáticamente.' : 'La administradora la está conectando.'}</p>${botones}</section>`;
    const r = resumenAsistencia();
    const l = r.filas.filter((x) => ccs.includes(x.cc) && enPeriodo(x.mes + '-28')).sort((a, b) => b.mes.localeCompare(a.mes) || String(a.nombre).localeCompare(String(b.nombre)));
    const total = l.filter((x) => !x.enSiigo).reduce((s, x) => s + x.costo, 0);
    const avisoObras = r.sinCentro.size ? `<div class="proy-aviso">⚠ ${r.sinCentro.size} ${r.sinCentro.size === 1 ? 'obra de la asistencia no está relacionada' : 'obras de la asistencia no están relacionadas'} con un centro de costo (${[...r.sinCentro.keys()].slice(0, 3).map(esc).join(', ')}${r.sinCentro.size > 3 ? '…' : ''}). Sus horas todavía no se cargan a ningún proyecto. ${isAdmin() ? '<button class="rh-link" type="button" data-proy="asis-obras">Relacionarlas</button>' : ''}</div>` : '';
    const fecha = P.asis.actualizado ? new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(P.asis.actualizado)) : '';
    return `${cab}<p class="proy-nota">Horas que cada empleado marcó en esta obra. Su costo del mes (salario, auxilio, prestaciones y seguridad social) se reparte entre las obras según esas horas y va a <b>Salarios operativos compartidos</b> y <b>Seguridad social</b> (personal de la empresa que rota entre obras)${P.repartir ? '. Sus <b>actividades</b> también sirven para repartir al personal fijo del proyecto en los rubros' : ''}. Datos de la asistencia actualizados el ${esc(fecha)}${/\.$/.test(fecha) ? '' : '.'}${r.fuera.size ? ` No se ${r.fuera.size === 1 ? 'carga' : 'cargan'} ${r.fuera.size} ${r.fuera.size === 1 ? 'persona que marca' : 'personas que marcan'} y no ${r.fuera.size === 1 ? 'está' : 'están'} en Recursos humanos (subcontratados o pendientes de registrar).` : ''}</p>
      ${avisoObras}
      ${l.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th>Mes</th><th class="n">Horas en la obra</th><th class="n">% de su mes</th><th class="n">Costo cargado</th></tr></thead><tbody>
        ${l.map((x) => `<tr><td><span class="emp">${esc(x.nombre)}</span>${ccs.length > 1 ? `<br><span class="sub">${esc(x.cc)}</span>` : ''}</td><td>${esc(nombreMes(x.mes))}</td><td class="n">${String(Math.round(x.horas * 10) / 10).replace('.', ',')} de ${String(Math.round(x.totalMes * 10) / 10).replace('.', ',')}</td><td class="n">${pct(x.horas / x.totalMes)}</td><td class="n">${x.enSiigo ? '<span class="sub" title="Su nómina de ese mes ya está cargada a este proyecto en Siigo">Ya está en Siigo</span>' : `<b>${fmt(x.costo)}</b>`}</td></tr>`).join('')}
        <tr class="tot"><td>Total cargado</td><td colspan="3"></td><td class="n">${fmt(total)}</td></tr></tbody></table></div>` : '<p class="proy-nota"><i>Nadie marcó horas en esta obra en el periodo.</i></p>'}
      ${botones}</section>`;
  }
  function abrirConexionAsis() {
    const a = P.conf.asistencia || {};
    abrirForm('Conexión con la app de asistencia', `
      <p class="full proy-nota" style="margin:0">Tu compañero instala en su motor de Google el archivo "Cuadra.gs" y te pasa una clave. Escríbela aquí. El computador de contabilidad traerá solo fecha, cédula, obra y horas a pagar (sin fotos ni ubicaciones).</p>
      <div class="field full"><label for="pa-url">Enlace del motor (termina en /exec)</label><input id="pa-url" value="${esc(a.url || 'https://script.google.com/macros/s/AKfycbz0hLqOp6tHmlSybmM3jXsxAgqrFu4GnLdluG3HuKSqSfonG2LNaqGutg1sPNMdMB99Kw/exec')}" autocomplete="off"></div>
      <div class="field full"><label for="pa-clave">Clave que te dio tu compañero</label><input id="pa-clave" type="password" autocomplete="off" placeholder="${a.clave ? 'Ya hay una clave guardada; escribe otra solo si cambió' : 'Pega aquí la clave'}"></div>
      <p class="hint full">${P.asis ? `Última actualización: ${esc(new Date(P.asis.actualizado).toLocaleString('es-CO'))} · ${(P.asis.filas || []).length} jornadas.` : a.clave ? 'La clave está guardada. Los datos llegan en la próxima actualización automática (máximo una hora).' : ''}${a.error ? ` <b>Último error:</b> ${esc(a.error)}` : ''}</p>`,
    async () => {
      const url = $('#pa-url').value.trim(), clave = $('#pa-clave').value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('El enlace debe ser el del motor de Google y terminar en /exec.');
      if (!clave && !a.clave) throw new Error('Pega la clave que te dio tu compañero.');
      await mutarConf((c) => { c.asistencia = { url, clave: clave || (c.asistencia || {}).clave, en: new Date().toISOString() }; });
    });
  }
  function abrirObrasAsis() {
    const horas = new Map(); for (const [, , obra, h] of P.asis.filas || []) horas.set(obra, (horas.get(obra) || 0) + (Number(h) || 0));
    const obras = [...new Set([...(P.asis.obras || []), ...horas.keys()])].filter(Boolean).sort((a, b) => (horas.get(b) || 0) - (horas.get(a) || 0));
    const centros = P.datos.centros.filter((c) => c.mov || Object.values(P.conf.obrasAsis || {}).includes(c.code)).sort((a, b) => a.code.localeCompare(b.code));
    abrirForm('Obras de la asistencia y centros de costo', `
      <p class="full proy-nota" style="margin:0">Escoge el centro de costo de Siigo de cada obra. Las que no son proyecto (oficina, bodega) márcalas como "No es un proyecto". Si aparece una obra nueva en la asistencia, Cuadra te avisa.</p>
      <div class="full rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Obra en la asistencia</th><th class="n">Horas</th><th>Centro de costo</th></tr></thead><tbody>
      ${obras.map((o) => { const actual = (P.conf.obrasAsis || {})[o]; const sug = actual ? '' : sugerirCentro(o); return `<tr><td>${esc(o)}${!actual ? '<br><span class="sub">Sin relacionar' + (sug ? ' · te sugiero ' + esc(sug) : '') + '</span>' : ''}</td><td class="n">${Math.round(horas.get(o) || 0).toLocaleString('es-CO')}</td><td><select data-pao="${esc(o)}"><option value="">Sin relacionar</option><option value="NO"${actual === 'NO' ? ' selected' : ''}>No es un proyecto</option>${centros.map((c) => `<option value="${esc(c.code)}"${(actual || sug) === c.code ? ' selected' : ''}>${esc(c.code)} · ${esc(c.name.slice(0, 50))}</option>`).join('')}</select></td></tr>`; }).join('')}
      </tbody></table></div>`,
    async () => {
      const m = {}; document.querySelectorAll('[data-pao]').forEach((s) => { if (s.value) m[s.dataset.pao] = s.value; });
      await mutarConf((c) => { c.obrasAsis = Object.assign({}, c.obrasAsis || {}, m); for (const s of document.querySelectorAll('[data-pao]')) if (!s.value) delete c.obrasAsis[s.dataset.pao]; });
    }, 'Guardar');
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
      ${seccionAsistencia(ccs)}
      <section class="proy-caja"><h3>Personal operativo asignado</h3>
        <p class="proy-nota">Personal compartido que no tiene centro de costo en Siigo y que se carga a este proyecto por meses: va a <b>Salarios operativos compartidos</b> y su seguridad social a <b>Seguridad social</b>. El costo incluye salario, auxilio de transporte, prestaciones sociales (prima, cesantías, intereses y vacaciones) y la seguridad social que paga la empresa (pensión 12 %, ARL según el riesgo y caja 4 %).</p>
        ${filas ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Trabajador</th><th>Centro</th><th>Meses</th><th class="n">Cantidad</th><th class="n">Costo por mes</th><th class="n">Total</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>` : '<p class="proy-nota"><i>No hay personal asignado.</i></p>'}
        ${isAdmin() ? '<button class="btn primary" type="button" data-proy="personal">+ Asignar trabajador</button>' : ''}
      </section>`;
  }

  // ---------- detalle: proveedores de un rubro y documentos ----------
  function abrirDetalle(rubro, prov) {
    const ccs = P.sub ? [P.sub] : ccsDe(P.sel);
    const filas = filasDe(ccs).filter((f) => enPeriodo(f[0]) && (rubro ? rubFila(f) === rubro : rubFila(f) !== NO));
    const terc = (f) => (f[4] >= 0 ? (TER[f[4]] || [])[1] || 'Sin tercero' : f[7]);
    const signo = rubro && ING.includes(rubro) && rubro !== 'DESCUENTOS' ? -1 : 1;
    let html;
    if (!prov) {
      const m = new Map(); for (const f of filas) { const n = terc(f); const x = m.get(n) || { v: 0, n: 0 }; x.v += f[5] * signo; x.n++; m.set(n, x); }
      const l = [...m.entries()].sort((a, b) => b[1].v - a[1].v);
      const total = l.reduce((s, [, x]) => s + x.v, 0);
      // Cuentas que forman el rubro
      const cu = new Map(); for (const f of filas) cu.set(f[2], (cu.get(f[2]) || 0) + f[5] * signo);
      // Personal fijo del proyecto que quedó dentro de este rubro, con sus horas en esas actividades
      const per = new Map(), idx = indiceActividades();
      for (const f of filas) {
        if (!f[9] || !OBRA.includes(f[9])) continue;
        const cedula = f[4] >= 0 ? ced((TER[f[4]] || [])[0]) : ced(f[8]);
        const x = per.get(cedula) || { n: terc(f), v: 0, meses: new Set(), act: 0 };
        x.v += f[5]; x.meses.add(f[3] + '|' + f[0].slice(0, 7)); if (f[10] === 'act') x.act += f[5]; per.set(cedula, x);
      }
      const pl = [...per.entries()].map(([cedula, x]) => {
        let h = 0; for (const k of x.meses) { const m = idx.per.get(k + '|' + cedula); if (m) h += m.get(rubro) || 0; }
        return { ...x, h };
      }).sort((a, b) => b.v - a.v);
      const bloquePer = pl.length ? `<h4 style="margin:4px 0 4px">Personal del proyecto en este rubro</h4>
        <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Empleado</th><th class="n">Horas en estas actividades</th><th class="n">Costo</th><th>Cómo se calculó</th></tr></thead><tbody>${pl.map((x) => `<tr class="click" data-det-prov="${esc(x.n)}"><td>${esc(x.n)}</td><td class="n">${x.h ? Math.round(x.h).toLocaleString('es-CO') : '—'}</td><td class="n">${fmt(x.v)}</td><td>${x.act >= x.v * 0.99 ? 'Por sus actividades en la asistencia' : x.act > 0 ? 'Actividades + reparto general' : 'Reparto según el presupuesto o los materiales (sin asistencia ese mes)'}</td></tr>`).join('')}</tbody></table></div>
        <p class="proy-nota">Incluye salario, prestaciones y seguridad social que Siigo cargó a la obra. Toca un empleado para ver mes a mes.</p>` : '';
      html = `${bloquePer}<p class="proy-nota">${esc(textoPeriodo())} · ${l.length} ${l.length === 1 ? 'tercero' : 'terceros'} · total <b>${fmt(total)}</b>. Toca uno para ver sus documentos.</p>
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
  // Hojas: Resumen (datos de la obra, indicadores y gráfico de líneas), Mes a mes (datos del gráfico), PyG y Movimientos
  async function excel() {
    if (!window.XLSX) return toast('No cargó el generador de Excel. Recarga la página.');
    const b = document.querySelector('[data-proy="excel"]'); if (b) b.disabled = true;
    try { await excelArmar(); } catch (e) { toast('No se pudo armar el Excel: ' + (e.message || e)); }
    if (b) b.disabled = false;
  }
  async function cargarJSZip() {
    if (window.JSZip) return;
    await new Promise((ok, mal) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = ok; s.onerror = () => mal(new Error('no cargó el componente para el gráfico; revisa el internet')); document.head.appendChild(s); });
  }
  async function excelArmar() {
    const ccs = P.sub ? [P.sub] : ccsDe(P.sel), c = calcular(ccs);
    const nombre = P.sub ? nombreCC(P.sub) : nombreSel(P.sel);
    const claveObra = P.sub ? 'c:' + P.sub : P.sel, obra = (P.conf.obras || {})[claveObra] || {};
    const m2 = Number(obra.m2) || 0, vendido = Number(obra.valorVenta) || 0;
    const cTot = P.periodo === 'mes' ? calcularTodo(ccs) : c;
    const serie = serieMeses(ccs);
    const DIN = '"$" #,##0', PCT = '0.0%';
    // Resumen
    const res = [
      ['INFORME DE PROYECTO'], [nombre], [textoPeriodo()], [P.sub ? `Centro de costo ${P.sub}` : P.sel.startsWith('g:') ? `Grupo: ${ccsDe(P.sel).join(', ')}` : `Centro de costo ${P.sel.slice(2)}`], [],
      ['DATOS DE LA OBRA'],
      ['Valor del contrato (vendido, sin IVA)', vendido || 'Sin registrar', vendido ? DIN : null],
      ['Metros cuadrados', m2 || 'Sin registrar', m2 ? (Number.isInteger(m2) ? '#,##0 "m²"' : '#,##0.00 "m²"') : null],
      ...(obra.nota ? [['Nota', obra.nota]] : []), [],
      ['INDICADORES'],
      ['Ventas netas', c.ventas, DIN], ['Costos y gastos', c.costo, DIN], ['Utilidad bruta', c.bruta, DIN], ['Utilidad operativa', c.operativa, DIN],
      ['Margen bruto', c.ventas ? c.bruta / c.ventas : '', PCT], ['Margen operativo', c.ventas ? c.operativa / c.ventas : '', PCT],
      ...(m2 ? [['Costo por m²', cTot.costo / m2, DIN]] : []),
      ...(m2 && vendido ? [['Valor vendido por m²', vendido / m2, DIN], ['Utilidad esperada por m²', (vendido - cTot.costo) / m2, DIN]] : []),
      ...(vendido ? [['Facturado del contrato', cTot.ventas / vendido, PCT]] : []),
      ...(P.periodo === 'mes' && (m2 || vendido) ? [['(Los indicadores por m² y del contrato usan todo el proyecto, no solo el mes.)']] : []),
      [], ['VENTAS, COSTOS Y UTILIDAD ACUMULADOS (datos en la hoja "Mes a mes")'],
    ];
    const filaGrafico = res.length; // el gráfico va debajo de esta fila (base 0)
    const hRes = XLSX.utils.aoa_to_sheet(res.map((f) => f.slice(0, 2)));
    res.forEach((f, i) => { if (f[2] && typeof f[1] === 'number') hRes[XLSX.utils.encode_cell({ r: i, c: 1 })].z = f[2]; });
    hRes['!cols'] = [{ wch: 44 }, { wch: 22 }];
    // Mes a mes
    const mm = [['Mes', 'Ventas', 'Costos y gastos', 'Utilidad', 'Ventas acumuladas', 'Costos acumulados', 'Utilidad acumulada']]
      .concat(serie.map((s) => [mesCorto(s.mes), Math.round(s.ing), Math.round(s.costo), Math.round(s.util), Math.round(s.ingAc), Math.round(s.costoAc), Math.round(s.utilAc)]));
    const hMes = XLSX.utils.aoa_to_sheet(mm);
    for (let r = 1; r < mm.length; r++) for (let k = 1; k <= 6; k++) hMes[XLSX.utils.encode_cell({ r, c: k })].z = DIN;
    hMes['!cols'] = [{ wch: 10 }, ...Array(6).fill({ wch: 19 })];
    // PyG
    const pyg = [[`INFORME DE PROYECTO · ${nombre}`], [textoPeriodo()], [], ['Rubro', 'Valor', '% de ventas'],
      ['Facturación total', c.fact], ['Descuentos', -c.desc], ['VENTAS NETAS', c.ventas], [],
      ...COSTO.map((r) => [titulo(r), c.r[r]]), ['TOTAL COSTO DE VENTAS', c.costoVentas], ['UTILIDAD BRUTA', c.bruta], [],
      ...GASTO.map((r) => [titulo(r), c.r[r]]), ...(Math.abs(c.r[SIN]) >= 1 ? [['Sin clasificar', c.r[SIN]]] : []), ['TOTAL GASTOS OPERATIVOS', c.gastos], ['UTILIDAD OPERATIVA', c.operativa]];
    pyg.forEach((f) => { if (typeof f[1] === 'number' && c.ventas) f[2] = f[1] / c.ventas; });
    const det = [['Fecha', 'Documento', 'Centro de costo', 'Cuenta / concepto', 'Rubro', 'Tercero', 'Detalle', 'Valor']].concat(
      filasDe(ccs).filter((f) => enPeriodo(f[0]) && rubFila(f) !== NO).map((f) => [f[0], f[1], f[3], (f[2].startsWith('P:') || f[2].startsWith('N:') ? '' : f[2] + ' ') + nombreCuenta(f[2]), titulo(rubFila(f)), f[4] >= 0 ? (TER[f[4]] || [])[1] : f[7], f[6], Math.round(f[5])]));
    const hPyg = XLSX.utils.aoa_to_sheet(pyg);
    pyg.forEach((f, i) => { if (typeof f[1] === 'number') { hPyg[XLSX.utils.encode_cell({ r: i, c: 1 })].z = DIN; if (typeof f[2] === 'number') hPyg[XLSX.utils.encode_cell({ r: i, c: 2 })].z = PCT; } });
    hPyg['!cols'] = [{ wch: 38 }, { wch: 20 }, { wch: 12 }];
    const hDet = XLSX.utils.aoa_to_sheet(det);
    hDet['!cols'] = [{ wch: 11 }, { wch: 16 }, { wch: 9 }, { wch: 36 }, { wch: 28 }, { wch: 32 }, { wch: 44 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, hRes, 'Resumen');
    XLSX.utils.book_append_sheet(wb, hMes, 'Mes a mes');
    XLSX.utils.book_append_sheet(wb, hPyg, 'PyG');
    // Presupuesto contra lo real (todo el proyecto)
    const pr = (P.conf.presup || {})[claveObra];
    if (pr) {
      const k = comparativo(pr, calcularTodo(ccs));
      const pp = [[`PRESUPUESTO CONTRA LO REAL · ${nombre}`], [`${pr.nombre || ''}${pr.cot ? ' · ' + pr.cot : ''}${pr.version ? ' · versión ' + pr.version : ''} · todo el proyecto${P.repartir ? ' · mano de obra dentro de cada rubro' : ''}`], [],
        ['Rubro', 'Presupuesto', 'Real', 'Disponible', '% consumido', 'Estado'],
        ...k.filas.sort((a, b) => b.p - a.p || b.v - a.v).map((x) => [titulo(x.r), x.p, x.v, x.p ? x.dif : '', x.p ? x.uso : '', x.p ? { rojo: 'Se pasó', amarillo: 'Ojo (80 % o más)', verde: 'Bien' }[estadoUso(x.uso)] : 'Sin presupuesto']),
        ['TOTAL COSTO DIRECTO', k.pTot, k.vTot, k.pTot - k.vTot, k.pTot ? k.vTot / k.pTot : '', ''], [],
        ['Administración (parte del valor)', pr.adm || 0], ['Imprevistos (parte del valor)', pr.imp || 0], ['Utilidad', pr.util || 0], ['IVA sobre utilidad', pr.iva || 0], ['VALOR TOTAL DEL PRESUPUESTO', pr.total || 0], [],
        ['DETALLE DEL PRESUPUESTO'], ['Ítem', 'Descripción', 'Und', 'Cantidad', 'Precio unitario', 'Parcial', 'Rubro'],
        ...(pr.caps || []).flatMap((c) => [[c.n], ...c.items.map((it) => [it.c, it.d, it.u, it.q, it.pu, it.v, titulo(it.r)])])];
      const hPre = XLSX.utils.aoa_to_sheet(pp);
      pp.forEach((f, i) => f.forEach((v, j) => { if (typeof v !== 'number') return; const cel = hPre[XLSX.utils.encode_cell({ r: i, c: j })]; if (!cel) return; const det = i > 4 + k.filas.length + 8; cel.z = !det && j === 4 ? PCT : det && j === 3 ? 'General' : DIN; }));
      hPre['!cols'] = [{ wch: 34 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 26 }];
      XLSX.utils.book_append_sheet(wb, hPre, 'Presupuesto');
    }
    XLSX.utils.book_append_sheet(wb, hDet, 'Movimientos');
    let datos = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    // Gráfico de líneas nativo de Excel (se puede editar), en la hoja Resumen, con los datos de "Mes a mes"
    if (serie.length) { await cargarJSZip(); datos = await conGrafico(datos, 'Resumen', serie.length, filaGrafico, nombre); }
    const blob = new Blob([datos], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `Informe proyecto ${nombre.replace(/[\\/:*?"<>|]/g, '').slice(0, 40)} ${P.periodo === 'mes' ? P.mes : `${P.desde} a ${P.hasta}`}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  // Agrega al .xlsx un gráfico de líneas (DrawingML) anclado en la hoja indicada
  async function conGrafico(datos, hoja, n, fila, nombre) {
    const zip = await JSZip.loadAsync(datos);
    const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const wbx = await zip.file('xl/workbook.xml').async('string');
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const rid = (new RegExp(`<sheet [^>]*name="${hoja}"[^>]*r:id="([^"]+)"`).exec(wbx) || [])[1];
    const target = (new RegExp(`<Relationship [^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels) || [])[1];
    const rutaHoja = 'xl/' + String(target || 'worksheets/sheet1.xml').replace(/^\/?xl\//, '');
    const archivo = rutaHoja.split('/').pop();
    // Valores en caché (Excel los recalcula al abrir)
    const hojaMes = XLSX.read(datos, { type: 'array' }).Sheets['Mes a mes'];
    const celda = (r, c) => (hojaMes[XLSX.utils.encode_cell({ r, c })] || {}).v;
    const cats = Array.from({ length: n }, (_, i) => celda(i + 1, 0));
    const ref = (col) => `'Mes a mes'!$${col}$2:$${col}$${n + 1}`;
    const serieXml = (i, col, colorHex) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>
      <c:tx><c:strRef><c:f>'Mes a mes'!$${col}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xe(celda(0, 'EFG'.indexOf(col) + 4))}</c:v></c:pt></c:strCache></c:strRef></c:tx>
      <c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill><a:round/></a:ln></c:spPr>
      <c:marker><c:symbol val="circle"/><c:size val="4"/><c:spPr><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>
      <c:cat><c:strRef><c:f>${ref('A')}</c:f><c:strCache><c:ptCount val="${n}"/>${cats.map((v, k) => `<c:pt idx="${k}"><c:v>${xe(v)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat>
      <c:val><c:numRef><c:f>${ref(col)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${Array.from({ length: n }, (_, k) => `<c:pt idx="${k}"><c:v>${Number(celda(k + 1, 'EFG'.indexOf(col) + 4)) || 0}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val>
      <c:smooth val="0"/></c:ser>`;
    const chart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/>
<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="es-CO" sz="1200" b="1"/><a:t>${xe(nombre.slice(0, 60))}: ventas, costos y utilidad acumulados</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>
${serieXml(0, 'E', '002796')}${serieXml(1, 'F', 'E07B00')}${serieXml(2, 'G', '1A7343')}
<c:marker val="1"/><c:axId val="50010001"/><c:axId val="50010002"/></c:lineChart>
<c:catAx><c:axId val="50010001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:crossAx val="50010002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>
<c:valAx><c:axId val="50010002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="&quot;$&quot; #,##0" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>
</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
    const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fila}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fila + 22}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Gráfico de líneas"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
    zip.file('xl/charts/chart1.xml', chart);
    zip.file('xl/drawings/drawing1.xml', drawing);
    zip.file('xl/drawings/_rels/drawing1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>');
    // Relación de la hoja con el dibujo
    const rutaRels = rutaHoja.replace(archivo, '_rels/' + archivo + '.rels');
    let hr = zip.file(rutaRels) ? await zip.file(rutaRels).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    hr = hr.replace('</Relationships>', '<Relationship Id="rIdGrafico1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
    zip.file(rutaRels, hr);
    let sx = await zip.file(rutaHoja).async('string');
    if (!/xmlns:r=/.test(sx.slice(0, 600))) sx = sx.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    sx = sx.replace('</worksheet>', '<drawing r:id="rIdGrafico1"/></worksheet>');
    zip.file(rutaHoja, sx);
    let ct = await zip.file('[Content_Types].xml').async('string');
    ct = ct.replace('</Types>', '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
    zip.file('[Content_Types].xml', ct);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  // ---------- eventos ----------
  $('#view-proy').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-proy-sel], [data-proy-sub], [data-proy-per], [data-proy-mo], [data-proy], [data-proy-rubro], [data-proy-prov], [data-proy-quitar], #proy-volver-lista');
    if (!t) return;
    if (t.dataset.proyMo) { P.repartir = t.dataset.proyMo === '1'; render(); return; }
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
    else if (a === 'asis-conexion') abrirConexionAsis();
    else if (a === 'asis-obras') abrirObrasAsis();
    else if (a === 'presupuesto') abrirPresupuesto();
    else if (a === 'actividades') abrirActividades();
    else if (a === 'presupuesto-quitar') {
      if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = '¿Quitar el presupuesto? Toca de nuevo'; return; }
      const clave = P.sub ? 'c:' + P.sub : P.sel;
      mutarConf((c) => { if (c.presup) delete c.presup[clave]; }).then(() => { render(); toast('Presupuesto quitado.'); }).catch((e) => toast(msgGitHub(e)));
    }
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
