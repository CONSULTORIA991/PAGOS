// Pagos por Aprobar — versión GitHub Pages con datos cifrados.
// Archivos en el repositorio (todos ilegibles sin contraseña, salvo usuarios.json que solo
// contiene llaves envueltas y no revela nombres):
//   datos/usuarios.json        llave maestra envuelta con la contraseña de cada usuario
//   datos/config.enc           token de GitHub, nombres y roles (cifrado)
//   datos/pagos.enc            pagos y saldo en banco (cifrado)
//   datos/facturas/<id>.bin    cada factura (cifrada)
(() => {
  const $ = (s) => document.querySelector(s);
  const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const fmt = (n) => money.format(Math.round(Number(n) || 0));
  const dateFmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  const dtFmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const R_USUARIOS = 'datos/usuarios.json';
  const R_CONFIG = 'datos/config.enc';
  const R_PAGOS = 'datos/pagos.enc';
  const rFactura = (id) => 'datos/facturas/' + id + '.bin';
  const MIN_CLAVE = 10;
  const SESION_KEY = 'pagos.sesion';

  const ESTADOS = { revisar: { label: 'Por revisar' }, aprobado: { label: 'Aprobado' }, pendiente: { label: 'Pendiente' }, pagado: { label: 'Pagado' }, rechazado: { label: 'Rechazado' } };
  const TABS = [['revisar', 'Por revisar'], ['aprobado', 'Aprobados'], ['pendiente', 'Pendientes'], ['pagado', 'Pagados'], ['rechazado', 'Rechazados'], ['todos', 'Todos']];
  const TIPO_DOC = { cobro: 'Cuenta de cobro', anticipo: 'Anticipo', caja: 'Caja menor' };

  const S = { pagos: [], banco: null, loaded: false, tab: 'revisar', q: '', siigoVer: '', sort: 'vence', openId: null, confirm: null, view: 'aprob', rDesde: '', rHasta: '', rRange: 'mes', payDate: '', sel: new Set() };
  // Sesión: llave maestra, identidad y configuración descifrada.
  let maestra = null, rawMaestra = null, uid = null, conf = null;
  let isAdmin = false;
  let etagPagos = null, escribiendo = 0;
  const busy = new Set();
  const facturaUrl = {}; const facturaCargando = new Set(); const facturaError = {};

  try { const t = localStorage.getItem('pagos.tab'); if (t) S.tab = t; } catch (e) {}

  // ---------- utilidades ----------
  function parseMonto(v) {
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).trim().replace(/[^\d,.\-]/g, '');
    if (!s) return NaN;
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot > -1 && lastComma > -1) {
      const dec = lastDot > lastComma ? '.' : ',';
      const th = dec === '.' ? ',' : '.';
      s = s.split(th).join('').replace(dec, '.');
    } else if (lastComma > -1) {
      const parts = s.split(',');
      s = (parts.length > 2 || parts[parts.length - 1].length === 3) ? parts.join('') : parts.join('.');
    } else if (lastDot > -1) {
      const parts = s.split('.');
      s = (parts.length > 2 || parts[parts.length - 1].length === 3) ? parts.join('') : s;
    }
    return Number(s);
  }
  function localISO(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function todayISO() { return localISO(new Date()); }
  function fechaPagoDe(p) { return p.fechaPago || (p.pagadoEn ? localISO(new Date(p.pagadoEn)) : ''); }
  function daysUntil(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - t) / 86400000);
  }
  function fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return dateFmt.format(new Date(y, m - 1, d)); }
  function dueChip(p) {
    if (p.estado === 'pagado' || !p.vence) return '';
    const n = daysUntil(p.vence);
    if (n < 0) return `<span class="chip late">Vencida hace ${-n} ${-n === 1 ? 'día' : 'días'}</span>`;
    if (n === 0) return '<span class="chip late">Vence hoy</span>';
    if (n <= 5) return `<span class="chip soon">Vence en ${n} ${n === 1 ? 'día' : 'días'}</span>`;
    return `<span class="chip ok">En ${n} días</span>`;
  }
  function personName(id) {
    if (!id) return 'Alguien';
    if (id === uid) return 'Tú';
    const u = conf && conf.usuarios && conf.usuarios[id];
    return (u && (u.nombre || u.usuario)) || 'Usuario retirado';
  }
  // ---------- datos contables para Siigo ----------
  const SIIGO_DEF = { tipo: 11, cuentaBanco: '11100501', cuentaProv: '22050501', centros: [] };
  const CUENTAS_CON_VENCIMIENTO = new Set(['22050501', '23359501', '13300501']);
  function siigoConf() { return Object.assign({}, SIIGO_DEF, (conf && conf.siigo) || {}); }
  // "BMB-503" → { prefijo: "BMB", numero: "503" }; "FE 9020" → FE / 9020; "C2329102" → C / 2329102
  function partirFactura(f) {
    const s = String(f || '').trim().toUpperCase();
    const m = s.match(/^(.*?)[\s\-_.]*(\d+)$/);
    if (!m) return { prefijo: '', numero: '' };
    return { prefijo: m[1].replace(/[\s\-_.]+$/, '').replace(/\s+/g, ''), numero: String(Number(m[2])) };
  }
  const normTxt = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const GENERICAS = new Set('CONTRATO PISCINA PISCINAS SUMINISTRO INSTALACION DOTACION COMUNAL REPARACION LIMPIEZA DESINFECCION CONSTRUCCION SISTEMA RECIRCULACION ADICIONALES TERMINACION MANTENIMIENTO EQUIPOS SERVICIOS ESCALERA PEGANTE ENCHAPE FILTRACION COMERCIAL PROYECTOS NUEVOS ADMINISTRACION FAMILIA PRUEBAS HIDROSTATICAS SEGURIDAD PERILLA REJILLA COTIZACION ODESA CARIBE BARRANQUILLA COLOMBIA BOGOTA CALLE CARRERA PLAYA VILLA CASA CENTRO NORTE'.split(' '));
  // Reconoce en el texto de la factura (o la nota) el nombre o número de contrato de un centro de costo.
  function matchCentro(texto) {
    const centros = siigoConf().centros;
    if (!centros.length || !texto) return '';
    const T = ' ' + normTxt(texto) + ' ';
    let mejor = null, puntos = 0, empate = false;
    for (const c of centros) {
      const n = normTxt(c.nombre);
      let s = 0;
      for (const num of n.match(/\d{7,}/g) || []) if (T.includes(num)) s += 10;
      // Palabras propias del nombre: si hay varias, deben aparecer al menos dos (evita "PLAZA", "RESERVA" sueltas)
      const propias = [...new Set(n.split(' ').filter((w) => w.length >= 5 && !/\d/.test(w) && !GENERICAS.has(w)))];
      const halladas = propias.filter((w) => T.includes(' ' + w + ' ')).length;
      if (halladas >= Math.min(2, propias.length)) s += 3 * halladas;
      if (s > puntos) { mejor = c; puntos = s; empate = false; } else if (s && s === puntos) empate = true;
    }
    return mejor && !empate ? mejor.codigo : '';
  }
  function centroNombre(codigo) { const c = siigoConf().centros.find((x) => x.codigo === codigo); return c ? c.nombre : ''; }
  // Convierte lo que se escriba (código, solo el número, o el nombre de la obra) en el código de Siigo.
  // Regla de ODESA: los centros terminan en "-1" → "100067" o "100067-3" pasan a "100067-1" si existe;
  // por nombre se prefiere el que termina en -1 cuando hay varios.
  function ccDeInput(v) {
    v = String(v || '').trim();
    if (!v) return '';
    const centros = siigoConf().centros;
    const code = v.split('·')[0].trim().replace(/\s+/g, '').toUpperCase();
    const buscar = (k) => centros.find((x) => String(x.codigo).toUpperCase() === k);
    if (buscar(code)) return buscar(code).codigo;
    const base = code.replace(/-\d+$/, '');
    if (base && buscar(base + '-1')) return buscar(base + '-1').codigo;
    const t = normTxt(v.includes('·') ? v.split('·').slice(1).join(' ') : v);
    if (t) {
      const exacto = centros.filter((x) => normTxt(x.nombre) === t);
      const pref = (arr) => (arr.length > 1 && arr.filter((x) => /-1$/.test(x.codigo)).length === 1 ? arr.filter((x) => /-1$/.test(x.codigo)) : arr);
      if (pref(exacto).length === 1) return pref(exacto)[0].codigo;
      const porNombre = pref(centros.filter((x) => normTxt(x.nombre).includes(t)));
      if (porNombre.length === 1) return porNombre[0].codigo;
      const porTexto = matchCentro(v);
      if (porTexto) return porTexto;
    }
    return /^\d+$/.test(code) ? code + '-1' : code;
  }
  // Al salir del campo se muestra el centro ya corregido ("summus" → "100067-1 · SUMMUS")
  function autocorregirCC(sel, hint) {
    const inp = document.querySelector(sel);
    if (!inp) return;
    inp.addEventListener('change', () => {
      if (!inp.value.trim() || !siigoConf().centros.length) return;
      const c = ccDeInput(inp.value);
      const ok = siigoConf().centros.some((x) => x.codigo === c);
      if (ok) inp.value = ccTexto(c);
      const h = hint && document.querySelector(hint);
      if (h) h.textContent = ok ? '' : 'No encontré ese centro de costo: escribe el nombre de la obra o el código y elígelo de la lista.';
    });
  }
  // ---------- estado en Siigo de cada registro ----------
  // Pagos → comprobante 11 (p.siigo); cajas → comprobante 14 (p.siigo14); cuentas de cobro → documento soporte (p.ds)
  const enSiigo = (p) => (p.tipoDoc === 'caja' ? p.siigo14 : p.siigo);
  const subiendoSiigo = (p) => (p.tipoDoc === 'caja' ? p.siigoEnvio14 : p.siigoEnvio);
  // La tarea del computador revisa en Siigo lo marcado como subido y deja p.siigoRev
  const alertaSiigo = (p) => !!(p.siigoRev && p.siigoRev.estado === 'mal' && (enSiigo(p) || p.ds));
  const necesitaDS = (p) => p.tipoDoc === 'cobro' && (p.estado === 'aprobado' || p.estado === 'pagado') && !p.ds;
  function chipsSiigo(p) {
    if (!isAdmin) return '';
    const out = [];
    if (alertaSiigo(p)) out.push(`<span class="chip sg-mal" title="${esc(p.siigoRev.nota)}">⚠ No cuadra con Siigo</span>`);
    if (p.ds) out.push(`<span class="chip sg-ok" title="Documento soporte creado en Siigo">✓ ${esc(p.ds.nombre)}</span>`);
    else if (p.siigoEnvioDS) out.push('<span class="chip sg-va">Enviando documento soporte…</span>');
    else if (necesitaDS(p)) out.push('<span class="chip sg-no">Sin documento soporte</span>');
    const s = enSiigo(p);
    if (s) out.push(`<span class="chip sg-ok" title="${s.api ? 'Subido a Siigo desde la app' : 'Exportado a Siigo'}">✓ Siigo ${esc(p.tipoDoc === 'caja' ? '14' : (s.tipo || '11'))}-${esc(s.comprobante)}</span>`);
    else if (subiendoSiigo(p)) out.push('<span class="chip sg-va">Subiendo a Siigo…</span>');
    else if (p.estado === 'pagado' || (p.tipoDoc === 'caja' && p.estado === 'aprobado')) out.push('<span class="chip sg-no">Sin enviar a Siigo</span>');
    return out.length ? ' ' + out.join(' ') : '';
  }
  const ccTexto = (codigo) => (codigo ? codigo + (centroNombre(codigo) ? ' · ' + centroNombre(codigo) : '') : '');

  // Quién aprobó (última vez que el pago pasó a "Se procede") y quién tomó la última decisión.
  function aprobacion(p) {
    const h = (p.historial || []).slice().reverse().find((x) => x.estado === 'aprobado');
    return h ? { por: h.por, en: h.en } : null;
  }
  function etiquetaDecision(p) {
    if (p.estado === 'aprobado' || p.estado === 'pagado') {
      const a = aprobacion(p);
      return a ? `Aprobó ${personName(a.por)}` : '';
    }
    if (p.estado === 'pendiente' && p.decididoPor) return `Dejó pendiente ${personName(p.decididoPor)}`;
    if (p.estado === 'rechazado' && p.decididoPor) return `Rechazó ${personName(p.decididoPor)}`;
    return '';
  }
  function nuevoId() { return [...Cripto.aleatorio(10)].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20); }
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3400); }
  function notice(msg) { const n = $('#notice'); n.textContent = msg || ''; n.hidden = !msg; }
  function pantalla(id) { ['#pantalla-carga', '#pantalla-login', '#pantalla-setup', '#app'].forEach((s) => { $(s).hidden = s !== id; }); }
  function mostrarError(sel, msg) { const e = $(sel); e.textContent = msg || ''; e.hidden = !msg; }
  function msgGitHub(e) {
    if (!e) return 'Ocurrió un error. Inténtalo de nuevo.';
    if (e.status === 401) return 'El token de GitHub no es válido o venció. La administradora debe actualizarlo en Usuarios.';
    if (e.status === 403) return 'GitHub rechazó la operación (límite de uso o permisos). Espera unos minutos e inténtalo de nuevo.';
    if (e.status === 404) return 'No se encontró el repositorio o el token no tiene acceso.';
    if (e.name === 'OperationError') return 'No se pudieron descifrar los datos.';
    return 'No se pudo conectar con GitHub. Revisa la conexión e inténtalo de nuevo.';
  }

  // Las cajas menores se revisan en su sección; pasan a Proveedores cuando las dejan pendientes (o las aprueban).
  const enProveedores = (p) => !(p.tipoDoc === 'caja' && (p.estado === 'revisar' || p.estado === 'rechazado'));
  const pagosProv = () => S.pagos.filter(enProveedores);
  function totals() {
    const sum = (st) => pagosProv().filter((p) => p.estado === st).reduce((a, p) => a + (Number(p.valor) || 0), 0);
    const cnt = (st) => pagosProv().filter((p) => p.estado === st).length;
    return { aprob: sum('aprobado'), revisar: sum('revisar'), nAprob: cnt('aprobado'), nRevisar: cnt('revisar') };
  }

  // ---------- render ----------
  function renderLedger() {
    const t = totals();
    const saldo = S.banco && typeof S.banco.saldo === 'number' ? S.banco.saldo : null;
    $('#v-saldo').textContent = saldo == null ? '—' : fmt(saldo);
    if (S.banco && S.banco.actualizado) {
      const who = S.banco.por ? ' por ' + personName(S.banco.por) : '';
      $('#m-saldo').textContent = (S.banco.cuenta ? S.banco.cuenta + ' · ' : '') + 'Actualizado ' + dtFmt.format(new Date(S.banco.actualizado)) + who;
    } else {
      $('#m-saldo').textContent = isAdmin ? 'Registra el saldo para calcular lo que quedaría' : 'Aún no se ha registrado';
    }
    $('#v-aprob').textContent = fmt(t.aprob);
    $('#m-aprob').textContent = `${t.nAprob} ${t.nAprob === 1 ? 'pago aprobado' : 'pagos aprobados'}`;
    const res = $('#t-result');
    if (saldo == null) {
      $('#v-queda').textContent = '—';
      res.classList.remove('neg');
      $('#m-queda').textContent = 'Falta registrar el saldo en banco';
    } else {
      const q = saldo - t.aprob;
      $('#v-queda').textContent = fmt(q);
      res.classList.toggle('neg', q < 0);
      $('#m-queda').textContent = q < 0 ? `Faltan ${fmt(-q)} para cubrir lo aprobado` : 'Después de hacer los pagos aprobados';
    }
    const base = Math.max(saldo || 0, t.aprob + t.revisar, 1);
    const free = Math.max((saldo || 0) - t.aprob - t.revisar, 0);
    $('#seg-a').style.width = (t.aprob / base * 100) + '%';
    $('#seg-r').style.width = (t.revisar / base * 100) + '%';
    $('#seg-f').style.width = (free / base * 100) + '%';
    const lim = $('#limit');
    if (saldo != null && saldo > 0 && saldo < t.aprob + t.revisar) { lim.hidden = false; lim.style.left = `calc(${saldo / base * 100}% - 1px)`; lim.title = 'Saldo en banco'; }
    else lim.hidden = true;
    const w = $('#whatif');
    if (saldo != null && t.nRevisar > 0) {
      const q2 = saldo - t.aprob - t.revisar;
      w.innerHTML = `Quedan <strong>${t.nRevisar}</strong> por revisar por <strong class="num">${fmt(t.revisar)}</strong>. Si se aprobaran todos, quedaría <strong class="num ${q2 < 0 ? 'neg' : ''}">${fmt(q2)}</strong>${q2 < 0 ? ' (no alcanza)' : ''}.`;
    } else if (saldo != null && S.loaded && S.pagos.length) {
      w.textContent = 'No hay pagos por revisar.';
    } else w.textContent = '';
  }

  function renderTabs() {
    const lista = pagosProv();
    const counts = { todos: lista.length };
    for (const k of Object.keys(ESTADOS)) counts[k] = lista.filter((p) => p.estado === k).length;
    $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${S.tab === k}">${l}<span class="c">${counts[k] || 0}</span></button>`).join('');
  }

  function visible() {
    const q = S.q.trim().toLowerCase();
    let arr = pagosProv().filter((p) => (S.tab === 'todos' || p.estado === S.tab));
    if (S.aprobador) arr = arr.filter((p) => { const a = aprobacion(p); return a && a.por === S.aprobador && (p.estado === 'aprobado' || p.estado === 'pagado'); });
    if (q) arr = arr.filter((p) => [p.proveedor, p.concepto, p.factura].some((x) => String(x || '').toLowerCase().includes(q)));
    if (isAdmin && S.siigoVer) arr = arr.filter((p) => {
      if (S.siigoVer === 'dsPend') return necesitaDS(p);
      if (S.siigoVer === 'dsEnv') return !!p.ds || !!p.siigoEnvioDS;
      if (S.siigoVer === 'sinSiigo') return p.estado === 'pagado' && !enSiigo(p) && !subiendoSiigo(p);
      if (S.siigoVer === 'enSiigo') return !!enSiigo(p) || !!p.ds;
      if (S.siigoVer === 'alerta') return alertaSiigo(p);
      return true;
    });
    const byVence = (a, b) => (a.vence || '9999') < (b.vence || '9999') ? -1 : (a.vence || '9999') > (b.vence || '9999') ? 1 : 0;
    if (S.sort === 'valor') arr.sort((a, b) => (b.valor || 0) - (a.valor || 0));
    else if (S.sort === 'prov') arr.sort((a, b) => String(a.proveedor || '').localeCompare(String(b.proveedor || ''), 'es'));
    else arr.sort(byVence);
    return arr;
  }

  function decisionButtons(p, small) {
    const cls = small ? ' sm' : '';
    const dis = busy.has(p.id) ? ' disabled' : '';
    if (p.estado === 'pagado') return '';
    const out = [];
    // Caja menor sin revisar: se revisa en Cajas y se pasa a Proveedores (queda pendiente de pago)
    if (p.tipoDoc === 'caja' && p.estado === 'revisar') {
      out.push(`<button class="btn go${cls}" type="button" data-act="pendiente" data-id="${p.id}"${dis}>Revisada: pasar a pagos</button>`);
      if (!small) out.push(`<button class="btn no${cls}" type="button" data-act="rechazado" data-id="${p.id}"${dis}>Rechazar</button>`);
      return out.join('');
    }
    if (p.estado !== 'aprobado') out.push(`<button class="btn go${cls}" type="button" data-act="aprobado" data-id="${p.id}"${dis}>Aprobar</button>`);
    if (p.estado !== 'pendiente') out.push(`<button class="btn hold${cls}" type="button" data-act="pendiente" data-id="${p.id}"${dis}>Dejar pendiente</button>`);
    if (!small && p.estado !== 'rechazado') out.push(`<button class="btn no${cls}" type="button" data-act="rechazado" data-id="${p.id}"${dis}>Rechazar</button>`);
    return out.join('');
  }

  function renderList() {
    const list = $('#list');
    const foot = $('#list-foot');
    if (!S.loaded) return;
    const arr = visible();
    if (!S.pagos.length) {
      list.innerHTML = `<div class="empty"><h3>Aún no hay pagos registrados</h3><p>${isAdmin ? 'Agrega el primer pago con su factura, o importa tu Excel de pagos pendientes para cargarlos todos de una vez.' : 'Cuando se registren pagos por aprobar aparecerán aquí con su factura.'}</p>${isAdmin ? '<div class="top-actions"><button class="btn" type="button" data-open="import">Importar desde Excel</button><button class="btn primary" type="button" data-open="add">+ Agregar pago</button></div>' : ''}</div>`;
      foot.innerHTML = '';
      return;
    }
    if (!arr.length) {
      const lbl = (TABS.find((t) => t[0] === S.tab) || [, ''])[1].toLowerCase();
      if (S.siigoVer) { list.innerHTML = `<div class="empty"><h3>Nada aquí</h3><p>${esc($('#f-siigo').selectedOptions[0].textContent)}: no hay registros${S.q ? ' que coincidan con la búsqueda' : ''}.</p></div>`; foot.innerHTML = ''; return; }
      list.innerHTML = `<div class="empty"><h3>${S.q ? 'Sin resultados' : 'Nada en ' + esc(lbl)}</h3><p>${S.q ? 'Ningún pago coincide con la búsqueda.' : S.tab === 'revisar' ? 'Todos los pagos ya tienen una decisión.' : 'No hay pagos en este estado.'}</p></div>`;
      foot.innerHTML = '';
      return;
    }
    list.innerHTML = arr.map((p) => {
      const st = ESTADOS[p.estado] ? p.estado : 'revisar';
      const sub = [p.concepto, p.factura ? 'Fact. ' + p.factura : ''].filter(Boolean).map(esc).join(' · ');
      return `<article class="row s-${st}" data-row="${p.id}" tabindex="0">
        <div class="r-main"><div class="r-prov">${isAdmin && st === 'aprobado' ? `<input type="checkbox" class="sel" data-sel="${p.id}"${S.sel.has(p.id) ? ' checked' : ''} aria-label="Seleccionar para pagar junto con otras"> ` : ''}${TIPO_DOC[p.tipoDoc] ? `<span class="chip doc">${TIPO_DOC[p.tipoDoc]}</span> ` : ''}${esc(p.proveedor || 'Sin proveedor')}</div><div class="r-sub">${sub || '&nbsp;'}${p.archivo ? ` · <span class="clip">${p.tipoDoc ? 'Documento adjunto' : 'Factura adjunta'}</span>` : ''}${chipsSiigo(p)}</div></div>
        <div class="r-due">${st === 'pagado'
          ? `<span>${fechaPagoDe(p) ? 'Pagado el ' + esc(fmtDate(fechaPagoDe(p))) : 'Pagado (sin fecha)'}</span>`
          : `${dueChip(p)}<span>${p.vence ? 'Vence ' + esc(fmtDate(p.vence)) : 'Sin fecha'}</span>`}</div>
        <div class="r-amt">${fmt(p.valor)}</div>
        <div class="r-act"><span class="r-state-box"><span class="r-state pill st-${st}">${ESTADOS[st].label}</span>${etiquetaDecision(p) ? `<span class="quien">${esc(etiquetaDecision(p))}</span>` : ''}</span>${decisionButtons(p, true)}</div>
      </article>`;
    }).join('');
    const tot = arr.reduce((a, p) => a + (Number(p.valor) || 0), 0);
    foot.innerHTML = `<span>${arr.length} ${arr.length === 1 ? 'pago' : 'pagos'}</span><span>Total: <strong class="num">${fmt(tot)}</strong></span>`;
  }

  // Las facturas se descargan cifradas y se descifran en el navegador.
  async function cargarFactura(p) {
    if (!p.archivo || facturaUrl[p.archivo] || facturaCargando.has(p.archivo)) return;
    facturaCargando.add(p.archivo);
    delete facturaError[p.archivo];
    try {
      const f = await GH.leer(rFactura(p.archivo));
      if (!f) throw { status: 404 };
      const bytes = await Cripto.descifrar(maestra, f.bytes);
      facturaUrl[p.archivo] = URL.createObjectURL(new Blob([bytes], { type: p.archivoTipo || 'application/pdf' }));
    } catch (e) {
      facturaError[p.archivo] = e && e.status === 404 ? 'No se encontró el archivo de la factura.' : 'No se pudo abrir la factura. Inténtalo de nuevo.';
    }
    facturaCargando.delete(p.archivo);
    if (S.openId === p.id) renderDetail();
  }

  function renderInvoice(p) {
    if (!p.archivo) return '<div class="invoice none">No se adjuntó la factura de este pago.</div>';
    const url = facturaUrl[p.archivo];
    if (!url) {
      if (facturaError[p.archivo]) return `<div class="invoice none">${esc(facturaError[p.archivo])} <button class="btn sm" type="button" data-retry="${p.id}">Reintentar</button></div>`;
      cargarFactura(p);
      return '<div class="invoice none">Descifrando la factura…</div>';
    }
    const isPdf = (p.archivoTipo || '').includes('pdf');
    const nombre = p.archivoNombre || ('Factura ' + (p.factura || '') + (isPdf ? '.pdf' : ''));
    return `<div class="invoice">${isPdf ? `<iframe src="${url}" title="Factura ${esc(p.factura || '')}"></iframe>` : `<img src="${url}" alt="Factura ${esc(p.factura || '')}">`}
      <div class="inv-bar"><span>${esc(nombre)}</span><span class="decide" style="flex:none"><a class="btn sm" href="${url}" target="_blank" rel="noopener">Abrir en pestaña nueva</a><a class="btn sm" href="${url}" download="${esc(nombre)}">Descargar</a></span></div></div>`;
  }

  function renderDetail() {
    const dlg = $('#dlg-detail');
    if (!S.openId) return;
    const p = S.pagos.find((x) => x.id === S.openId);
    const box = $('#detail');
    if (!p) { box.innerHTML = '<div class="dlg-head"><h2>Este pago ya no existe</h2><button class="btn ghost x" type="button" data-close>Cerrar</button></div>'; if (!dlg.open) dlg.showModal(); return; }
    const notaPrev = $('#d-nota') ? $('#d-nota').value : '';
    const st = ESTADOS[p.estado] ? p.estado : 'revisar';
    const t = totals();
    const saldo = S.banco && typeof S.banco.saldo === 'number' ? S.banco.saldo : null;
    let impact = '';
    if (saldo != null && st !== 'pagado') {
      const now = saldo - t.aprob;
      const v = Number(p.valor) || 0;
      const after = st === 'aprobado' ? now : now - v;
      impact = st === 'aprobado'
        ? `<div class="impact"><span>Este pago ya está aprobado. Con él, en banco quedaría <span class="num ${now < 0 ? 'neg' : ''}">${fmt(now)}</span>.</span><span>Si se deja pendiente, quedaría <span class="num">${fmt(now + v)}</span>.</span></div>`
        : `<div class="impact"><span>Hoy quedaría en banco <span class="num ${now < 0 ? 'neg' : ''}">${fmt(now)}</span>.</span><span>Si se aprueba este pago, quedaría <span class="num ${after < 0 ? 'neg' : ''}">${fmt(after)}</span>.</span></div>`;
    }
    const hist = (p.historial || []).slice().reverse().map((h) => `<li><span class="pill st-${ESTADOS[h.estado] ? h.estado : 'revisar'}">${(ESTADOS[h.estado] || ESTADOS.revisar).label}</span><span>${esc(personName(h.por))}</span><span class="when">${esc(dtFmt.format(new Date(h.en)))}</span>${h.nota ? `<span>— ${esc(h.nota)}</span>` : ''}</li>`).join('');
    const canDecide = st !== 'pagado';

    let adminBox = '';
    if (isAdmin) {
      let cf = '';
      if (S.confirm === 'delete') cf = `<div class="confirm"><span>¿Eliminar este pago? No se puede deshacer.</span><span class="decide" style="flex:none"><button class="btn sm" type="button" data-confirm="cancel">Cancelar</button><button class="btn sm danger solid" type="button" data-confirm="delete">Eliminar</button></span></div>`;
      if (S.confirm === 'pay') cf = `<div class="confirm pay"><span class="pay-date"><label for="d-fpago">Fecha de pago</label><input type="date" id="d-fpago" value="${esc(S.payDate || todayISO())}" max="${todayISO()}"></span><span>Marcar como pagado${saldo != null ? ` y descontar <b class="num">${fmt(p.valor)}</b> del saldo en banco` : ''}.</span><span class="decide" style="flex:none"><button class="btn sm" type="button" data-confirm="cancel">Cancelar</button>${saldo != null ? '<button class="btn sm" type="button" data-confirm="pay-only">Solo marcar pagado</button>' : ''}<button class="btn sm primary" type="button" data-confirm="pay">${saldo != null ? 'Pagado y descontar' : 'Marcar pagado'}</button></span></div>`;
      adminBox = `<div class="admin-box"><span class="section-lbl">Administración</span>
        <div class="decide">${necesitaDS(p) ? (p.siigoEnvioDS ? '<span class="pill st-pendiente">Enviando documento soporte a Siigo…</span><button class="btn sm" type="button" data-admin="ds">Ver estado</button>' : '<button class="btn primary sm" type="button" data-admin="ds">Retenciones y documento soporte</button>') : ''}${st === 'aprobado' ? '<button class="btn primary sm" type="button" data-admin="pay">Marcar como pagado</button>' : ''}${st !== 'revisar' ? '<button class="btn sm" type="button" data-act="revisar" data-id="' + p.id + '">Volver a “Por revisar”</button>' : ''}<button class="btn sm" type="button" data-admin="edit">Editar</button><button class="btn sm danger" type="button" data-admin="delete">Eliminar</button></div>${cf}</div>`;
    }

    box.innerHTML = `
      <div class="dlg-head"><div style="display:grid;gap:6px;min-width:0"><span class="pill st-${st}" style="justify-self:start">${ESTADOS[st].label}</span><h2>${esc(p.proveedor || 'Sin proveedor')}</h2></div><button class="btn ghost x" type="button" data-close>Cerrar</button></div>
      <div class="big-amt">${fmt(p.valor)}</div>
      <dl class="facts">
        <div><dt>Concepto</dt><dd>${esc(p.concepto || '—')}</dd></div>
        <div><dt>Factura</dt><dd>${esc(p.factura || '—')}</dd></div>
        <div><dt>Vencimiento</dt><dd>${p.vence ? esc(fmtDate(p.vence)) + ' ' + dueChip(p) : '—'}</dd></div>
        ${st === 'pagado' ? `<div><dt>Fecha de pago</dt><dd>${fechaPagoDe(p) ? esc(fmtDate(fechaPagoDe(p))) : 'Sin registrar'}</dd></div>` : ''}
        ${TIPO_DOC[p.tipoDoc] ? `<div><dt>Tipo</dt><dd>${TIPO_DOC[p.tipoDoc]} · radicado ${esc(p.radicado || '')}</dd></div>` : ''}
        ${p.contratista ? `<div><dt>Contratista</dt><dd>C.C. ${esc(p.nit)} · cel. ${esc(p.contratista.celular)}</dd></div>` : ''}
        ${isAdmin && p.contratista ? `<div><dt>Consignar a</dt><dd>${esc(p.contratista.banco)} · ${esc(p.contratista.tipoCuenta)} · ${esc(p.contratista.numeroCuenta)}</dd></div>` : ''}
        ${isAdmin && (p.nit || p.cc) ? `<div><dt>NIT · Centro de costo</dt><dd>${esc(p.nit || 'Sin NIT')} · ${esc(p.cc ? ccTexto(p.cc) : 'Sin centro de costo')}</dd></div>` : ''}
        ${p.anticipoManual && p.anticipoManual.valor > 0 ? `<div><dt>Anticipo</dt><dd>${fmt(p.anticipoManual.valor)} · documento ${esc(p.anticipoManual.documento)}${p.ds ? '' : ` · valor de la cuenta de cobro ${fmt(p.valorBruto)}, se descontó del valor a pagar`}</dd></div>` : ''}
        ${p.ds ? `<div><dt>Documento soporte</dt><dd>${esc(p.ds.nombre)} · valor ${fmt(p.ds.valorBruto)}${(p.ds.retenciones || []).length ? ' · ' + p.ds.retenciones.map((r) => `${esc(r.nombre)} ${fmt(r.valor)}`).join(' · ') : ' · sin retenciones'}${(p.ds.cruces || []).length ? ` · anticipos cruzados ${fmt(p.ds.cruces.reduce((s, c) => s + (Number(c.valor) || 0), 0))} (${esc(p.ds.cruce)})` : ''} · <b>${p.ds.yaPagado || st === 'pagado' ? 'neto ' + fmt(p.ds.neto) : 'por pagar ' + fmt(p.valor)}</b></dd></div>` : ''}
        ${isAdmin && alertaSiigo(p) ? `<div><dt>Revisión en Siigo</dt><dd><span class="chip sg-mal">⚠ No cuadra</span> ${esc(p.siigoRev.nota)} <small>(revisado ${esc(dtFmt.format(new Date(p.siigoRev.en)))}; si ya lo corregiste en Siigo, el computador lo vuelve a revisar solo en unas horas)</small></dd></div>` : ''}
        ${isAdmin && enSiigo(p) ? `<div><dt>Siigo</dt><dd><span class="chip sg-ok">✓ Ya está en Siigo</span> comprobante ${esc(p.tipoDoc === 'caja' ? '14' : (enSiigo(p).tipo || '11'))}-${esc(enSiigo(p).comprobante)}${enSiigo(p).api ? ' · subido desde la app' : ' · exportado en Excel'}${enSiigo(p).en ? ' el ' + esc(dtFmt.format(new Date(enSiigo(p).en))) : ''}. No hay que volver a enviarlo.</dd></div>`
          : isAdmin && subiendoSiigo(p) ? '<div><dt>Siigo</dt><dd><span class="chip sg-va">Subiendo a Siigo…</span></dd></div>'
          : isAdmin && (st === 'pagado' || (p.tipoDoc === 'caja' && st === 'aprobado')) ? '<div><dt>Siigo</dt><dd><span class="chip sg-no">Sin enviar a Siigo</span></dd></div>' : ''}
        ${aprobacion(p) && (st === 'aprobado' || st === 'pagado') ? `<div><dt>Aprobado por</dt><dd>${esc(personName(aprobacion(p).por))}, ${esc(dtFmt.format(new Date(aprobacion(p).en)))}</dd></div>` : ''}
        ${p.decididoPor && p.decididoEn ? `<div><dt>Última decisión</dt><dd>${esc(personName(p.decididoPor))}, ${esc(dtFmt.format(new Date(p.decididoEn)))}</dd></div>` : ''}
      </dl>
      ${p.nota ? `<div class="impact"><span class="section-lbl">Nota</span><span>${esc(p.nota)}</span></div>` : ''}
      ${impact}
      ${p.tipoDoc === 'caja' ? renderSoportesCaja(p) : renderInvoice(p)}
      ${canDecide ? `<div class="field"><label for="d-nota">Comentario de la decisión (opcional)</label><input id="d-nota" autocomplete="off" placeholder="Ej. Pagar la próxima semana" value="${esc(notaPrev)}"></div><div class="decide">${p.estado !== 'aprobado' ? `<button class="btn go" type="button" data-act="aprobado" data-id="${p.id}"${busy.has(p.id) ? ' disabled' : ''}>Aprobar este pago</button>` : ''}${p.estado !== 'pendiente' ? `<button class="btn hold" type="button" data-act="pendiente" data-id="${p.id}"${busy.has(p.id) ? ' disabled' : ''}>Dejar pendiente</button>` : ''}${p.estado !== 'rechazado' ? `<button class="btn no" type="button" data-act="rechazado" data-id="${p.id}"${busy.has(p.id) ? ' disabled' : ''}>Rechazar</button>` : ''}</div>` : ''}
      ${hist ? `<div style="display:grid;gap:8px"><span class="section-lbl">Historial</span><ul class="hist">${hist}</ul></div>` : ''}
      ${adminBox}`;
    if (!dlg.open) dlg.showModal();
  }

  function renderAprobadores() {
    const sel = $('#f-aprobador');
    const ids = new Set();
    for (const p of S.pagos) { const a = aprobacion(p); if (a && a.por) ids.add(a.por); }
    const actual = S.aprobador || '';
    const opciones = ['<option value="">Aprobado por: todos</option>'].concat([...ids].map((id) => `<option value="${esc(id)}">Aprobado por: ${esc(id === uid ? ((conf.usuarios[uid] || {}).nombre || 'Tú') + ' (tú)' : personName(id))}</option>`));
    const html = opciones.join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = ids.has(actual) ? actual : '';
    if (!ids.has(actual)) S.aprobador = '';
    sel.hidden = ids.size === 0;
  }

  function render() {
    $('#hoy').textContent = dayFmt.format(new Date());
    renderAprobadores();
    renderLedger(); renderTabs(); renderList(); renderReport(); renderSelBar(); renderInicio();
    if (S.openId) renderDetail();
    renderCartResumen(); renderCartera();
    renderInicio(); renderConsultaProv(); renderConsultaCli(); renderCajas();
  }

  // ---------- datos: lectura, sincronización y escritura ----------
  async function cargarDatos() {
    const r = await GH.leer(R_PAGOS, { etag: etagPagos });
    if (r && r.sinCambios) return false;
    const d = r ? await Cripto.descifrarJSON(maestra, r.bytes) : { pagos: [], banco: null };
    etagPagos = r ? r.etag : null;
    S.pagos = d.pagos || []; S.banco = d.banco || null; S.siigo = d.siigo || {}; S.loaded = true;
    return true;
  }

  async function sincronizar() {
    if (!maestra || escribiendo || document.visibilityState !== 'visible') return;
    try {
      const a = await cargarDatos();
      const b = await cargarCartera();
      if (a || b) render();
      revisarAvisos();
      $('#sync').textContent = 'Actualizado ' + new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date());
      notice('');
    } catch (e) {
      if (e && e.status === 401) notice(msgGitHub(e));
    }
  }

  // Aplica un cambio sobre la versión más reciente del archivo; si otra persona guardó al mismo tiempo, reintenta.
  async function mutar(cambio) {
    escribiendo++;
    try {
      for (let intento = 0; intento < 4; intento++) {
        const r = await GH.leer(R_PAGOS);
        const d = r ? await Cripto.descifrarJSON(maestra, r.bytes) : { pagos: [], banco: null };
        d.pagos = d.pagos || [];
        const resultado = cambio(d);
        if (resultado === false) return false;
        try {
          await GH.escribir(R_PAGOS, await Cripto.cifrarJSON(maestra, d), r && r.sha);
          S.pagos = d.pagos; S.banco = d.banco || null; S.siigo = d.siigo || {}; etagPagos = null;
          return true;
        } catch (e) {
          if (e && e.conflicto) { await new Promise((ok) => setTimeout(ok, 400 + Math.random() * 600)); continue; }
          throw e;
        }
      }
      throw { message: 'conflicto' };
    } finally { escribiendo--; }
  }
  function writeError(e) { toast(msgGitHub(e)); }

  async function setEstado(id, estado) {
    const p = S.pagos.find((x) => x.id === id);
    if (!p || busy.has(id)) return;
    const notaEl = $('#d-nota');
    const nota = S.openId === id && notaEl ? notaEl.value.trim() : '';
    const now = new Date().toISOString();
    busy.add(id); renderList(); if (S.openId) renderDetail();
    try {
      const ok = await mutar((d) => {
        const x = d.pagos.find((y) => y.id === id);
        if (!x) return false;
        x.estado = estado; x.decididoPor = uid; x.decididoEn = now;
        x.historial = (x.historial || []).slice(-24).concat([{ estado, por: uid, en: now, nota }]);
      });
      if (ok) toast(estado === 'aprobado' ? `Aprobado: ${p.proveedor}` : estado === 'pendiente' ? `Quedó pendiente: ${p.proveedor}` : estado === 'rechazado' ? `Rechazado: ${p.proveedor}` : `Volvió a por revisar: ${p.proveedor}`);
      else toast('Este pago ya no existe.');
      if (notaEl && S.openId === id) notaEl.value = '';
    } catch (e) { writeError(e); }
    busy.delete(id); render();
  }

  async function marcarPagado(id, descontar) {
    const p = S.pagos.find((x) => x.id === id);
    if (!p) return;
    const now = new Date().toISOString();
    const fechaPago = S.payDate || todayISO();
    try {
      await mutar((d) => {
        const x = d.pagos.find((y) => y.id === id);
        if (!x) return false;
        x.estado = 'pagado'; x.decididoPor = uid; x.decididoEn = now; x.pagadoEn = now; x.fechaPago = fechaPago;
        x.historial = (x.historial || []).slice(-24).concat([{ estado: 'pagado', por: uid, en: now, nota: 'Pagado el ' + fmtDate(fechaPago) + (descontar ? ' · descontado del saldo' : '') }]);
        if (descontar && d.banco && typeof d.banco.saldo === 'number') d.banco = { ...d.banco, saldo: d.banco.saldo - (Number(x.valor) || 0), actualizado: now, por: uid };
      });
      S.confirm = null;
      toast(descontar ? `Pagado. Se descontaron ${fmt(p.valor)} del saldo.` : 'Marcado como pagado.');
    } catch (e) { writeError(e); }
    render();
  }

  // ---------- pagar varias facturas de un mismo proveedor juntas (un solo movimiento de banco) ----------
  const claveProv = (p) => (p.nit ? 'n' + p.nit : 't' + normTxt(p.proveedor));
  function seleccionados() {
    for (const id of [...S.sel]) { const p = S.pagos.find((x) => x.id === id); if (!p || p.estado !== 'aprobado') S.sel.delete(id); }
    return S.pagos.filter((p) => S.sel.has(p.id));
  }
  function renderSelBar() {
    const sel = seleccionados();
    const bar = $('#sel-bar');
    bar.hidden = !isAdmin || !sel.length;
    if (!sel.length) return;
    const total = sel.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const provs = new Set(sel.map(claveProv));
    $('#sel-txt').textContent = `${sel.length} ${sel.length === 1 ? 'factura' : 'facturas'} de ${sel[0].proveedor}${provs.size > 1 ? ' y otros' : ''} · ${fmt(total)}`;
    const err = $('#sel-err');
    err.hidden = provs.size <= 1;
    err.textContent = provs.size > 1 ? 'Selecciona solo facturas de un mismo proveedor para hacer un solo pago.' : '';
    $('#sel-pagar').disabled = provs.size > 1 || S.pagandoLote;
    $('#sel-pagar').textContent = sel.length === 1 ? 'Marcar pagada' : `Marcar ${sel.length} pagadas juntas`;
    if (!$('#sel-fecha').value) $('#sel-fecha').value = todayISO();
    $('#sel-fecha').max = todayISO();
    $('#sel-banco').closest('label').hidden = !(S.banco && typeof S.banco.saldo === 'number');
  }
  // El clic en la casilla solo selecciona (no abre el detalle del pago)
  document.addEventListener('click', (ev) => {
    const c = ev.target.closest && ev.target.closest('input[data-sel]');
    if (!c) return;
    ev.stopPropagation();
    if (c.checked) S.sel.add(c.dataset.sel); else S.sel.delete(c.dataset.sel);
    renderSelBar();
  }, true);
  $('#sel-limpiar').addEventListener('click', () => { S.sel.clear(); renderList(); renderSelBar(); });
  $('#sel-pagar').addEventListener('click', async () => {
    const sel = seleccionados();
    if (!sel.length || new Set(sel.map(claveProv)).size > 1 || S.pagandoLote) return;
    const fechaPago = $('#sel-fecha').value || todayISO();
    const descontar = $('#sel-banco').checked && S.banco && typeof S.banco.saldo === 'number';
    const ids = new Set(sel.map((p) => p.id));
    const total = sel.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const lote = sel.length > 1 ? nuevoId() : '';
    const now = new Date().toISOString();
    const facturas = sel.map((p) => p.factura || p.concepto || 'sin número').join(', ');
    S.pagandoLote = true; renderSelBar();
    try {
      await mutar((d) => {
        let suma = 0;
        for (const x of d.pagos) {
          if (!ids.has(x.id)) continue;
          suma += Number(x.valor) || 0;
          x.estado = 'pagado'; x.decididoPor = uid; x.decididoEn = now; x.pagadoEn = now; x.fechaPago = fechaPago;
          if (lote) x.lote = lote;
          x.historial = (x.historial || []).slice(-24).concat([{ estado: 'pagado', por: uid, en: now, nota: `Pagado el ${fmtDate(fechaPago)}${lote ? ` junto con ${sel.length - 1} ${sel.length === 2 ? 'factura más' : 'facturas más'} (${facturas}) en un solo pago de ${fmt(total)}` : ''}${descontar ? ' · descontado del saldo' : ''}` }]);
        }
        if (descontar && d.banco && typeof d.banco.saldo === 'number') d.banco = { ...d.banco, saldo: d.banco.saldo - suma, actualizado: now, por: uid };
      });
      S.sel.clear();
      toast(`${sel.length === 1 ? 'Pago registrado' : `${sel.length} facturas pagadas en un solo movimiento`} por ${fmt(total)}${descontar ? ', descontado del saldo' : ''}.`);
    } catch (e) { writeError(e); }
    S.pagandoLote = false;
    render();
  });

  async function eliminar(id) {
    const p = S.pagos.find((x) => x.id === id);
    try {
      await mutar((d) => { d.pagos = d.pagos.filter((y) => y.id !== id); });
      if (p && p.archivo) { try { await GH.borrar(rFactura(p.archivo)); } catch (e) {} }
      S.confirm = null; S.openId = null; $('#dlg-detail').close();
      toast('Pago eliminado.');
      render();
    } catch (e) { writeError(e); }
  }

  async function subirFactura(file) {
    const id = nuevoId();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await GH.escribir(rFactura(id), await Cripto.cifrar(maestra, bytes), null);
    const tipo = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream');
    return { archivo: id, archivoTipo: tipo, archivoNombre: file.name };
  }

  // ---------- formulario de pago ----------
  let editingId = null;
  // Cuenta de cobro subida a mano: el valor que se escribe es el de la cuenta de cobro y, si se le dio
  // anticipo, se descuenta para el valor a pagar (el anticipo se cruza luego en el documento soporte).
  function aplicarTipoForm() {
    const p = editingId ? S.pagos.find((x) => x.id === editingId) : null;
    const cobro = $('#f-tipo').value === 'cobro';
    $('#f-archivo-lbl').textContent = cobro ? 'Cuenta de cobro (PDF o imagen)' : 'Factura (PDF o imagen)';
    $('#f-factura-lbl').textContent = cobro ? 'N.º de la cuenta de cobro' : 'N.º de factura';
    $('#f-factura').placeholder = cobro ? 'CC-15' : 'BMB-503';
    $('#f-valor-lbl').textContent = cobro ? 'Valor de la cuenta de cobro (COP)' : 'Valor a pagar (COP)';
    $('label[for="f-nit"]').textContent = cobro ? 'Cédula del contratista' : 'NIT del proveedor (sin DV)';
    $('label[for="f-prov"]').textContent = cobro ? 'Contratista' : 'Proveedor o beneficiario';
    $('#f-ant-wrap').hidden = !cobro;
    $('#f-ant-datos').hidden = !cobro || !$('#f-ant').checked;
    // Con documento soporte ya hecho, el valor y el anticipo quedan como se enviaron a Siigo
    const bloqueado = !!(p && p.ds);
    ['#f-valor', '#f-ant', '#f-ant-valor', '#f-ant-doc'].forEach((s) => { $(s).disabled = bloqueado; });
    totalAnticipoForm();
  }
  function totalAnticipoForm() {
    const p = editingId ? S.pagos.find((x) => x.id === editingId) : null;
    const el = $('#f-ant-total');
    if (p && p.ds) { el.textContent = `Ya tiene documento soporte ${p.ds.nombre}: el valor y el anticipo no se pueden cambiar aquí.`; return; }
    if ($('#f-tipo').value !== 'cobro' || !$('#f-ant').checked) { el.textContent = ''; return; }
    const v = parseMonto($('#f-valor').value), a = parseMonto($('#f-ant-valor').value);
    el.innerHTML = isFinite(v) && v > 0 && isFinite(a) && a > 0 ? `Valor a pagar: ${fmt(v)} − anticipo ${fmt(a)} = <b>${fmt(v - a)}</b> (las retenciones se descuentan en el documento soporte).` : '';
  }
  $('#f-tipo').addEventListener('change', aplicarTipoForm);
  $('#f-ant').addEventListener('change', aplicarTipoForm);
  ['#f-valor', '#f-ant-valor'].forEach((s) => $(s).addEventListener('input', totalAnticipoForm));

  function openForm(id, tipo) {
    editingId = id || null;
    const p = id ? S.pagos.find((x) => x.id === id) : null;
    const otroTipo = p && p.tipoDoc && p.tipoDoc !== 'cobro'; // cajas y anticipos conservan su tipo
    $('#f-tipo').closest('.field').hidden = !!otroTipo;
    $('#f-tipo').value = p ? (p.tipoDoc === 'cobro' ? 'cobro' : '') : (tipo || '');
    const am = p && p.anticipoManual;
    $('#f-ant').checked = !!am;
    $('#f-ant-valor').value = am ? new Intl.NumberFormat('es-CO').format(am.valor) : '';
    $('#f-ant-doc').value = am ? am.documento || '' : '';
    $('#form-title').textContent = p ? (p.tipoDoc === 'cobro' ? 'Editar cuenta de cobro' : 'Editar pago') : (tipo === 'cobro' ? 'Subir cuenta de cobro' : 'Agregar pago');
    $('#f-prov').value = p ? p.proveedor || '' : '';
    $('#f-concepto').value = p ? p.concepto || '' : '';
    $('#f-factura').value = p ? p.factura || '' : '';
    // En cuentas de cobro con anticipo se muestra el valor de la cuenta de cobro (antes de descontarlo)
    $('#f-valor').value = p ? new Intl.NumberFormat('es-CO').format((p.tipoDoc === 'cobro' && !p.ds && p.anticipoManual ? p.valorBruto : p.valor) || 0) : '';
    $('#f-vence').value = p ? p.vence || '' : '';
    $('#f-estado').value = p ? p.estado || 'revisar' : 'revisar';
    $('#f-fpago').value = p ? fechaPagoDe(p) : '';
    $('#f-fpago').max = todayISO();
    $('#f-fpago-wrap').hidden = $('#f-estado').value !== 'pagado';
    $('#f-nota').value = p ? p.nota || '' : '';
    $('#f-nit').value = p ? p.nit || '' : '';
    $('#f-cuenta').value = (p && p.cuenta) || siigoConf().cuentaProv;
    $('#cc-lista').innerHTML = siigoConf().centros.map((c) => `<option value="${esc(c.codigo + ' · ' + c.nombre)}"></option>`).join('');
    $('#f-cc').value = p ? ccTexto(p.cc) : '';
    $('#f-cc-hint').textContent = siigoConf().centros.length ? '' : 'Carga los centros de costo en Usuarios → Siigo para elegirlos de la lista.';
    pistaFactura();
    $('#f-archivo').value = '';
    $('#f-archivo-hint').textContent = p && p.archivo ? 'Ya tiene factura adjunta. Elige otro archivo solo si quieres reemplazarla.' : 'Adjúntala primero: la app lee la factura y llena los datos. Se guarda cifrada.';
    lecturaId++;
    autoLlenados.clear();
    document.querySelectorAll('#pago-form .ai-filled').forEach((el) => el.classList.remove('ai-filled'));
    $('#f-ai').hidden = true;
    mostrarError('#form-err', '');
    aplicarTipoForm();
    if ($('#dlg-detail').open) $('#dlg-detail').close();
    $('#dlg-form').showModal();
    (p ? $('#f-prov') : $('#f-archivo')).focus();
  }

  // ---------- lectura automática al adjuntar una factura ----------
  const autoLlenados = new Set();
  let lecturaId = 0;
  ['#f-prov', '#f-concepto', '#f-factura', '#f-valor', '#f-vence', '#f-nit', '#f-cc'].forEach((sel) => {
    $(sel).addEventListener('input', () => { autoLlenados.delete(sel); $(sel).classList.remove('ai-filled'); });
  });
  function pistaFactura() {
    const { prefijo, numero } = partirFactura($('#f-factura').value);
    $('#f-factura-hint').textContent = $('#f-factura').value.trim()
      ? (prefijo ? `Siigo: prefijo ${prefijo} · consecutivo ${numero}${prefijo.length > 6 ? ' (el prefijo debe tener máximo 6 caracteres)' : ''}` : 'Siigo exige prefijo: escríbelo como BMB-503.')
      : '';
  }
  $('#f-factura').addEventListener('input', pistaFactura);
  function estadoLectura(clase, msg) {
    const el = $('#f-ai');
    el.className = 'ai-status ' + clase;
    el.innerHTML = (clase === 'working' ? '<span class="spin" aria-hidden="true"></span>' : '') + `<span>${esc(msg)}</span>`;
    el.hidden = false;
  }
  function llenar(sel, val) {
    if (val == null || val === '' || val === 0) return false;
    const el = $(sel);
    if (el.value.trim() && !autoLlenados.has(sel)) return false; // no pisar lo que la persona escribió
    el.value = val; autoLlenados.add(sel); el.classList.add('ai-filled');
    return true;
  }
  $('#f-archivo').addEventListener('change', async () => {
    const file = $('#f-archivo').files[0];
    if (!file) return;
    const id = ++lecturaId;
    estadoLectura('working', conf && conf.claudeKey ? 'Leyendo la factura con Claude…' : 'Leyendo la factura…');
    try {
      const r = await Lector.leer(file, conf && conf.claudeKey);
      if (id !== lecturaId) return;
      const d = r.datos, llenos = [];
      if (llenar('#f-prov', d.proveedor)) llenos.push('proveedor');
      if (llenar('#f-concepto', d.concepto)) llenos.push('concepto');
      if (llenar('#f-factura', d.factura)) llenos.push('factura');
      if (d.valor && llenar('#f-valor', new Intl.NumberFormat('es-CO').format(d.valor))) llenos.push('valor');
      if (llenar('#f-vence', d.vence)) llenos.push('vencimiento');
      if (llenar('#f-nit', d.nit)) llenos.push('NIT');
      const cc = matchCentro((r.texto || '') + ' ' + $('#f-nota').value + ' ' + file.name);
      if (cc && llenar('#f-cc', ccTexto(cc))) llenos.push('centro de costo');
      pistaFactura();
      const falta = r.faltan.length ? ` Revisa o completa: ${r.faltan.join(', ')}.` : '';
      if (llenos.length) estadoLectura(r.faltan.length ? 'fail' : 'done', `${r.fuente === 'claude' ? 'Leída con Claude' : 'Leída'}: llené ${llenos.join(', ')}. Los campos en verde vienen de la factura.${falta}${r.error ? ' ' + r.error : ''}`);
      else estadoLectura('fail', (r.error || 'No reconocí los datos de esta factura.') + ' Llena los datos a mano.');
    } catch (e) {
      if (id === lecturaId) estadoLectura('fail', 'No pude leer la factura. Llena los datos a mano.');
    }
  });

  // ---------- carga masiva de facturas ----------
  let masivaActiva = false, masivaModo = '';
  function openMasiva(modo) {
    if (masivaActiva) { $('#dlg-masiva').showModal(); return; }
    masivaModo = modo === 'cobro' ? 'cobro' : '';
    const cobro = masivaModo === 'cobro';
    $('#m-titulo').textContent = cobro ? 'Subir varias cuentas de cobro' : 'Subir varias facturas';
    $('#m-zona-txt').textContent = cobro ? 'Arrastra aquí las cuentas de cobro' : 'Arrastra aquí las facturas';
    $('#m-intro').innerHTML = cobro
      ? 'Selecciona o arrastra las cuentas de cobro de los contratistas (PDF o imagen). Cada una se lee, se guarda cifrada y queda como cuenta de cobro <b>Por revisar</b>. Después ábrelas con Editar para revisar la cédula, el número (ej. CC-15) y, si se le dio anticipo, marcarlo.'
      : 'Selecciona o arrastra las facturas (PDF o imagen). Cada una se lee, se guarda cifrada y queda como pago <b>Por revisar</b>. Las que ya están cargadas (mismo archivo o mismo número de factura y proveedor) se omiten.';
    $('#m-lista').innerHTML = ''; $('#m-files').value = ''; mostrarError('#m-err', '');
    $('#m-modo').textContent = conf && conf.claudeKey ? 'Lectura con Claude activada.' : 'Lectura con el lector propio de la app (facturas electrónicas en PDF). Para escaneadas o fotos, configura Claude en Usuarios.';
    $('#dlg-masiva').showModal();
  }
  const normaliza = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function filaMasiva(nombre) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nombre"></span><span class="estado wait">En espera</span><span class="det"></span>`;
    li.querySelector('.nombre').textContent = nombre;
    $('#m-lista').appendChild(li);
    return {
      set(clase, estado, det) { const e = li.querySelector('.estado'); e.className = 'estado ' + clase; e.textContent = estado; li.querySelector('.det').textContent = det || ''; },
    };
  }
  async function procesarMasiva(files) {
    const lista = [...files].filter((f) => /\.(pdf|png|jpe?g|webp)$/i.test(f.name) || /^(application\/pdf|image\/)/.test(f.type));
    if (!lista.length) { mostrarError('#m-err', 'Elige archivos PDF o imágenes.'); return; }
    masivaActiva = true; mostrarError('#m-err', '');
    const nombresExistentes = new Set(S.pagos.map((p) => p.archivoNombre).filter(Boolean));
    const clavesExistentes = new Set(S.pagos.filter((p) => p.factura).map((p) => normaliza(p.proveedor).slice(0, 12) + '|' + normaliza(p.factura)));
    const filas = lista.map((f) => filaMasiva(f.name));
    const nuevos = [];
    for (let i = 0; i < lista.length; i++) {
      const f = lista[i], fila = filas[i];
      if (nombresExistentes.has(f.name)) { fila.set('wait', 'Ya estaba', 'Este archivo ya está cargado.'); continue; }
      if (f.size > 25 * 1024 * 1024) { fila.set('bad', 'Muy pesada', 'Pesa más de 25 MB.'); continue; }
      fila.set('wait', 'Leyendo…');
      try {
        const r = await Lector.leer(f, conf && conf.claudeKey);
        const d = r.datos;
        const clave = normaliza(d.proveedor).slice(0, 12) + '|' + normaliza(d.factura);
        if (d.factura && clavesExistentes.has(clave)) { fila.set('wait', 'Ya estaba', `La factura ${d.factura} de ${d.proveedor} ya está cargada.`); continue; }
        fila.set('wait', 'Cifrando y subiendo…');
        const adj = await subirFactura(f);
        const now = new Date().toISOString();
        const leido = d.proveedor || d.valor;
        const cobro = masivaModo === 'cobro';
        nuevos.push({
          id: nuevoId(), proveedor: d.proveedor || f.name.replace(/\.[^.]+$/, ''), concepto: d.concepto, factura: d.factura,
          valor: d.valor || 0, vence: d.vence, estado: 'revisar', nota: '', fechaPago: '', ...adj,
          nit: d.nit || '', cuenta: siigoConf().cuentaProv, cc: matchCentro((r.texto || '') + ' ' + f.name),
          ...(cobro ? { tipoDoc: 'cobro', valorBruto: d.valor || 0 } : {}),
          creado: now, creadoPor: uid,
          historial: [{ estado: 'revisar', por: uid, en: now, nota: (cobro ? 'Cuenta de cobro cargada en lote' : 'Cargada en lote') + (r.faltan.length ? ' · faltó: ' + r.faltan.join(', ') : '') }],
        });
        nombresExistentes.add(f.name); if (d.factura) clavesExistentes.add(clave);
        const det = [d.proveedor, d.factura && 'Fact. ' + d.factura, d.valor ? fmt(d.valor) : '', d.vence && 'vence ' + fmtDate(d.vence)].filter(Boolean).join(' · ');
        if (!leido) fila.set('bad', 'Sin leer', (r.error || 'No reconocí los datos.') + ' Quedó cargada con el nombre del archivo; complétala con Editar.');
        else if (r.faltan.length) fila.set('warn', 'Revisar', det + ' — falta: ' + r.faltan.join(', '));
        else fila.set('ok', 'Lista', det);
      } catch (e) {
        fila.set('bad', 'Error', msgGitHub(e));
      }
    }
    if (nuevos.length) {
      try {
        await mutar((d) => { d.pagos.push(...nuevos); });
        render();
        toast(`Se cargaron ${nuevos.length} ${nuevos.length === 1 ? 'factura' : 'facturas'} en “Por revisar”.`);
      } catch (e) { mostrarError('#m-err', 'Las facturas se subieron, pero no se pudieron registrar los pagos: ' + msgGitHub(e)); }
    }
    masivaActiva = false;
    $('#m-files').value = '';
  }
  $('#m-files').addEventListener('change', () => { if (!masivaActiva) procesarMasiva($('#m-files').files); });
  const zona = $('#m-zona');
  zona.addEventListener('dragover', (ev) => { ev.preventDefault(); zona.classList.add('over'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('over'));
  zona.addEventListener('drop', (ev) => { ev.preventDefault(); zona.classList.remove('over'); if (!masivaActiva) procesarMasiva(ev.dataTransfer.files); });

  $('#pago-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prov = $('#f-prov').value.trim();
    const valor = parseMonto($('#f-valor').value);
    if (!prov) return mostrarError('#form-err', 'Escribe el proveedor o beneficiario.');
    if (!isFinite(valor) || valor <= 0) return mostrarError('#form-err', 'Escribe un valor mayor que cero, por ejemplo 1.250.000.');
    const file = $('#f-archivo').files[0];
    if (file && file.size > 25 * 1024 * 1024) return mostrarError('#form-err', 'La factura pesa más de 25 MB. Comprímela e inténtalo de nuevo.');
    const previo = editingId ? S.pagos.find((x) => x.id === editingId) : null;
    const tipoVisible = !$('#f-tipo').closest('.field').hidden;
    const cobro = tipoVisible && $('#f-tipo').value === 'cobro';
    const conDS = !!(previo && previo.ds);
    let anticipo = null;
    if (cobro && !conDS) {
      if (!$('#f-nit').value.replace(/\D/g, '')) return mostrarError('#form-err', 'Escribe la cédula del contratista: se necesita para el documento soporte.');
      if (!partirFactura($('#f-factura').value).prefijo) return mostrarError('#form-err', 'Escribe el número de la cuenta de cobro con prefijo, por ejemplo CC-15.');
      if ($('#f-ant').checked) {
        const av = parseMonto($('#f-ant-valor').value);
        const doc = $('#f-ant-doc').value.trim().toUpperCase();
        const { prefijo, numero } = partirFactura(doc);
        if (!isFinite(av) || av <= 0) return mostrarError('#form-err', 'Escribe el valor del anticipo.');
        if (av >= valor) return mostrarError('#form-err', 'El anticipo no puede ser igual o mayor que el valor de la cuenta de cobro.');
        if (!prefijo || !numero) return mostrarError('#form-err', 'Escribe el documento del anticipo en Siigo con prefijo y número, por ejemplo CC-2200.');
        anticipo = { valor: Math.round(av), documento: doc, prefijo, numero };
      }
    }
    const btn = $('#form-save'); btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const estado = $('#f-estado').value;
      const data = {
        proveedor: prov, concepto: $('#f-concepto').value.trim(), factura: $('#f-factura').value.trim(),
        valor: Math.round(valor), vence: $('#f-vence').value || '', estado, nota: $('#f-nota').value.trim(),
        fechaPago: estado === 'pagado' ? ($('#f-fpago').value || todayISO()) : '',
        nit: $('#f-nit').value.replace(/\D/g, ''), cuenta: $('#f-cuenta').value, cc: ccDeInput($('#f-cc').value),
      };
      if (tipoVisible) data.tipoDoc = cobro ? 'cobro' : '';
      if (conDS) delete data.valor; // ya está en Siigo con su documento soporte
      else if (cobro) {
        data.valorBruto = Math.round(valor);
        data.anticipoManual = anticipo;
        data.valor = Math.round(valor) - (anticipo ? anticipo.valor : 0);
      } else if (previo && previo.tipoDoc === 'cobro') { data.anticipoManual = null; data.valorBruto = null; }
      if (file) { btn.textContent = 'Cifrando y subiendo factura…'; Object.assign(data, await subirFactura(file)); btn.textContent = 'Guardando…'; }
      const now = new Date().toISOString();
      let archivoViejo = null;
      if (editingId) {
        const id = editingId;
        await mutar((d) => {
          const x = d.pagos.find((y) => y.id === id);
          if (!x) return false;
          if (x.estado !== estado) {
            x.historial = (x.historial || []).slice(-24).concat([{ estado, por: uid, en: now, nota: 'Cambiado al editar' }]);
            x.decididoPor = uid; x.decididoEn = now;
          }
          if (data.archivo && x.archivo && x.archivo !== data.archivo) archivoViejo = x.archivo;
          Object.assign(x, data);
        });
        if (archivoViejo) { try { await GH.borrar(rFactura(archivoViejo)); } catch (e) {} }
        toast('Pago actualizado.');
      } else {
        const nuevo = { id: nuevoId(), ...data, creado: now, creadoPor: uid, historial: [{ estado, por: uid, en: now, nota: 'Registrado' }] };
        await mutar((d) => { d.pagos.push(nuevo); });
        toast('Pago agregado.');
      }
      $('#dlg-form').close();
      render();
    } catch (e) {
      mostrarError('#form-err', msgGitHub(e));
    }
    btn.disabled = false; btn.textContent = 'Guardar pago';
  });
  $('#f-estado').addEventListener('change', () => {
    const pag = $('#f-estado').value === 'pagado';
    $('#f-fpago-wrap').hidden = !pag;
    if (pag && !$('#f-fpago').value) $('#f-fpago').value = todayISO();
  });

  // ---------- saldo ----------
  function openSaldo() {
    $('#sb-valor').value = S.banco && typeof S.banco.saldo === 'number' ? new Intl.NumberFormat('es-CO').format(S.banco.saldo) : '';
    $('#sb-cuenta').value = (S.banco && S.banco.cuenta) || '';
    mostrarError('#saldo-err', '');
    $('#dlg-saldo').showModal();
    $('#sb-valor').focus();
  }
  $('#saldo-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = parseMonto($('#sb-valor').value);
    if (!isFinite(v)) return mostrarError('#saldo-err', 'Escribe el saldo, por ejemplo 85.000.000.');
    try {
      const banco = { saldo: Math.round(v), cuenta: $('#sb-cuenta').value.trim(), actualizado: new Date().toISOString(), por: uid };
      await mutar((d) => { d.banco = banco; });
      $('#dlg-saldo').close();
      toast('Saldo actualizado.');
      render();
    } catch (e) { mostrarError('#saldo-err', msgGitHub(e)); }
  });

  // ---------- importar Excel ----------
  const COLS = {
    proveedor: ['proveedor', 'tercero', 'beneficiario', 'razon social', 'razón social', 'nombre', 'acreedor'],
    concepto: ['concepto', 'detalle', 'descripcion', 'descripción', 'observacion', 'observación'],
    factura: ['factura', 'no factura', 'n factura', 'nro factura', 'numero factura', 'número factura', 'documento', 'fact'],
    valor: ['valor a pagar', 'valor', 'monto', 'total', 'importe', 'saldo', 'neto a pagar', 'a pagar'],
    vence: ['vencimiento', 'fecha vencimiento', 'fecha de vencimiento', 'vence', 'fecha pago', 'fecha de pago', 'fecha'],
    estado: ['estado', 'aprobacion', 'aprobación', 'decision', 'decisión'],
  };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function matchCols(header) {
    const h = header.map(norm);
    const map = {};
    for (const [key, alts] of Object.entries(COLS)) {
      for (const a of alts.map(norm)) {
        const i = h.findIndex((x, idx) => x && x === a && !Object.values(map).includes(idx));
        if (i > -1) { map[key] = i; break; }
      }
      if (map[key] == null) {
        for (const a of alts.map(norm)) {
          const i = h.findIndex((x, idx) => x && x.includes(a) && !Object.values(map).includes(idx));
          if (i > -1) { map[key] = i; break; }
        }
      }
    }
    return map;
  }
  function toISODate(v) {
    if (v instanceof Date && !isNaN(v)) return localISO(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    return '';
  }
  function toEstado(v) {
    const s = norm(v);
    if (!s) return 'revisar';
    if (/pagad/.test(s)) return 'pagado';
    if (/aprob|procede|^si$|ok/.test(s)) return 'aprobado';
    if (/pendien|aplaz/.test(s) || s === 'no') return 'pendiente';
    return 'revisar';
  }
  let importRows = [];
  $('#i-file').addEventListener('change', async () => {
    const f = $('#i-file').files[0];
    const out = $('#i-result');
    importRows = []; $('#i-go').disabled = true;
    if (!f) { out.innerHTML = ''; return; }
    if (!window.XLSX) { out.innerHTML = '<p class="err">No se pudo cargar el lector de Excel. Recarga la página e inténtalo de nuevo.</p>'; return; }
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      let hi = -1, map = {};
      for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const m = matchCols(rows[i]);
        if (m.proveedor != null && m.valor != null) { hi = i; map = m; break; }
      }
      if (hi < 0) { out.innerHTML = '<p class="err">No encontré la fila de encabezados. Asegúrate de que la primera hoja tenga columnas llamadas al menos “Proveedor” y “Valor”.</p>'; return; }
      const header = rows[hi];
      for (const r of rows.slice(hi + 1)) {
        const prov = String(r[map.proveedor] || '').trim();
        const valor = parseMonto(r[map.valor]);
        if (!prov || !isFinite(valor) || valor <= 0 || /^total/i.test(prov)) continue;
        importRows.push({
          proveedor: prov,
          concepto: map.concepto != null ? String(r[map.concepto] || '').trim() : '',
          factura: map.factura != null ? String(r[map.factura] || '').trim() : '',
          valor: Math.round(valor),
          vence: map.vence != null ? toISODate(r[map.vence]) : '',
          estado: map.estado != null ? toEstado(r[map.estado]) : 'revisar',
        });
      }
      const nombres = { proveedor: 'Proveedor', concepto: 'Concepto', factura: 'Factura', valor: 'Valor', vence: 'Vencimiento', estado: 'Estado' };
      const used = Object.entries(map).map(([k, i]) => `<b>${esc(String(header[i]))}</b> → ${nombres[k]}`).join(' · ');
      if (!importRows.length) { out.innerHTML = `<p class="mapinfo">${used}</p><p class="err">No encontré filas con proveedor y valor mayor que cero.</p>`; return; }
      const tot = importRows.reduce((a, r) => a + r.valor, 0);
      out.innerHTML = `<p class="mapinfo">Columnas reconocidas: ${used}</p>
        <p class="mapinfo">Se importarán <b>${importRows.length}</b> pagos por <b class="num">${fmt(tot)}</b>. Vista previa:</p>
        <div class="preview"><table><thead><tr><th>Proveedor</th><th>Concepto</th><th>Factura</th><th>Vence</th><th>Estado</th><th style="text-align:right">Valor</th></tr></thead><tbody>
        ${importRows.slice(0, 8).map((r) => `<tr><td>${esc(r.proveedor)}</td><td>${esc(r.concepto)}</td><td>${esc(r.factura)}</td><td>${esc(r.vence ? fmtDate(r.vence) : '')}</td><td>${ESTADOS[r.estado].label}</td><td class="n">${fmt(r.valor)}</td></tr>`).join('')}
        </tbody></table></div>${importRows.length > 8 ? `<p class="mapinfo">…y ${importRows.length - 8} más.</p>` : ''}
        <p class="mapinfo">Las facturas se adjuntan después, abriendo cada pago y eligiendo “Editar”.</p>`;
      $('#i-go').disabled = false;
      $('#i-go').textContent = `Importar ${importRows.length} pagos`;
    } catch (e) {
      out.innerHTML = '<p class="err">No pude leer el archivo. Verifica que sea un Excel (.xlsx o .xls) o un CSV.</p>';
    }
  });
  $('#i-go').addEventListener('click', async () => {
    const btn = $('#i-go'); btn.disabled = true; btn.textContent = 'Importando…';
    const now = new Date().toISOString();
    const nuevos = importRows.map((r) => ({ id: nuevoId(), ...r, nota: '', fechaPago: '', creado: now, creadoPor: uid, historial: [{ estado: r.estado, por: uid, en: now, nota: 'Importado desde Excel' }] }));
    try {
      await mutar((d) => { d.pagos.push(...nuevos); });
      $('#dlg-import').close();
      toast(`Se importaron ${nuevos.length} pagos.`);
      render();
    } catch (e) { toast(msgGitHub(e)); }
    importRows = []; $('#i-file').value = ''; $('#i-result').innerHTML = ''; btn.textContent = 'Importar';
  });
  function openImport() { $('#i-file').value = ''; $('#i-result').innerHTML = ''; $('#i-go').disabled = true; $('#i-go').textContent = 'Importar'; $('#dlg-import').showModal(); }

  // ---------- reporte de pagos realizados ----------
  function rangeDates(r) {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    const add = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return localISO(x); };
    if (r === 'hoy') return [todayISO(), todayISO()];
    if (r === 'ayer') return [add(-1), add(-1)];
    if (r === '7d') return [add(-6), todayISO()];
    if (r === 'mesant') return [localISO(new Date(d.getFullYear(), d.getMonth() - 1, 1, 12)), localISO(new Date(d.getFullYear(), d.getMonth(), 0, 12))];
    return [localISO(new Date(d.getFullYear(), d.getMonth(), 1, 12)), todayISO()];
  }
  function setRange(r) { S.rRange = r; [S.rDesde, S.rHasta] = rangeDates(r); $('#r-desde').value = S.rDesde; $('#r-hasta').value = S.rHasta; renderReport(); }
  function onDateInput() { S.rDesde = $('#r-desde').value; S.rHasta = $('#r-hasta').value; S.rRange = ''; renderReport(); }
  $('#r-desde').addEventListener('change', onDateInput);
  $('#r-hasta').addEventListener('change', onDateInput);
  // Secciones: Inicio · Proveedores (aprob, rep, prov) · Clientes (cart, cli)
  const VISTAS = ['inicio', 'aprob', 'cajas', 'rep', 'prov', 'cart', 'cli', 'rrhh', 'proy', 'conc'];
  function setView(v) {
    S.view = VISTAS.includes(v) ? v : 'inicio';
    const grupo = ['aprob', 'cajas', 'rep', 'prov'].includes(S.view) ? 'prov' : ['cart', 'cli'].includes(S.view) ? 'cli' : S.view;
    if (S.view === 'rrhh' && window.RRHH) window.RRHH.abrir();
    if (S.view === 'proy' && window.PROY) window.PROY.abrir();
    if (S.view === 'conc' && window.CONC) window.CONC.abrir();
    document.querySelectorAll('.vbtn[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
    for (const x of VISTAS) $('#view-' + x).hidden = S.view !== x;
    $('#nav-prov').hidden = grupo !== 'prov';
    $('#nav-cli').hidden = grupo !== 'cli';
    $('#admin-actions').hidden = !isAdmin || grupo !== 'prov';
    if (S.view === 'inicio') renderInicio();
    if (S.view === 'rep') renderReport();
    if (S.view === 'cajas') renderCajas();
    if (S.view === 'prov') renderConsultaProv();
    if (S.view === 'cart' && typeof renderCartera === 'function') renderCartera();
    if (S.view === 'cli') renderConsultaCli();
    window.scrollTo({ top: 0 });
  }

  // ---------- inicio ----------
  const millones = (n) => (Math.abs(n) >= 1e6 ? '$ ' + (n / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M' : fmt(n));
  function renderInicio() {
    if (S.view !== 'inicio') return;
    const h = new Date().getHours();
    const nombre = ((conf && conf.usuarios && conf.usuarios[uid] && conf.usuarios[uid].nombre) || '').split(/\s+/)[0];
    const nom = nombre ? nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase() : '';
    $('#i-saludo').textContent = (h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches') + (nom ? ', ' + nom : '');
    const t = totals();
    const saldo = S.banco && typeof S.banco.saldo === 'number' ? S.banco.saldo : null;
    $('#i-saldo').textContent = saldo == null ? 'Sin registrar' : fmt(saldo);
    $('#i-aprob').textContent = fmt(t.aprob);
    const q = saldo == null ? null : saldo - t.aprob;
    $('#i-queda').textContent = q == null ? '—' : fmt(q);
    $('#i-queda').classList.toggle('neg', q != null && q < 0);
    $('#i-queda').classList.toggle('ok', !(q != null && q < 0));
    $('#i-prov-dato').textContent = S.loaded ? (t.nRevisar ? `${t.nRevisar} por revisar · ${millones(t.revisar)}` : 'Nada por revisar') : '';
    $('#i-cli-dato').textContent = C.loaded && C.items.length ? `Por cobrar · ${millones(totalesCartera().total)}` : '';
    const cjRev = S.pagos.filter((p) => p.tipoDoc === 'caja' && p.estado === 'revisar');
    $('#i-cajas-dato').textContent = S.loaded ? (cjRev.length ? `${cjRev.length} por revisar · ${millones(cjRev.reduce((s, p) => s + (Number(p.valor) || 0), 0))}` : 'Nada por revisar') : '';
    renderTareas(saldo, t);
    renderPendSiigo();
  }
  // "Para hacer hoy": lo urgente de cada sección, en palabras, con un toque para ir allá
  function renderTareas(saldo, t) {
    const box = $('#i-tareas');
    if (!S.loaded) { box.hidden = true; return; }
    const hoy = todayISO(), out = [];
    const suma = (a) => a.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
    const rev = S.pagos.filter((p) => p.estado === 'revisar' && p.tipoDoc !== 'caja');
    if (rev.length) {
      const venc = rev.filter((p) => p.vence && p.vence < hoy).length;
      out.push([venc ? 'rojo' : 'amarillo', `${plural(rev.length, 'factura o cuenta de cobro', 'facturas o cuentas de cobro')} por revisar (${millones(suma(rev))})${venc ? `, ${plural(venc, 'vencida', 'vencidas')}` : ''}`, 'Proveedores', 'aprob:revisar']);
    }
    const cj = S.pagos.filter((p) => p.tipoDoc === 'caja' && p.estado === 'revisar');
    if (cj.length) out.push(['amarillo', `${plural(cj.length, 'caja menor espera', 'cajas menores esperan')} revisión (${millones(suma(cj))})`, 'Cajas menores', 'cajas']);
    if (t.nAprob) {
      const falta = saldo != null && saldo - t.aprob < 0;
      out.push([falta ? 'rojo' : 'azul', `${plural(t.nAprob, 'pago aprobado', 'pagos aprobados')} por hacer (${millones(t.aprob)})${falta ? ': no alcanza el saldo en banco' : ''}`, 'Proveedores', 'aprob:aprobado']);
    }
    if (C.loaded && C.items.length) {
      const tc = totalesCartera();
      if (tc.vencido >= 1) out.push(['amarillo', `${millones(tc.vencido)} vencidos en cartera (${Math.round(tc.vencido / tc.total * 100)} % de lo que nos deben)`, 'Clientes', 'cart']);
    }
    box.innerHTML = `<h2>Para hacer hoy</h2>${out.length
      ? `<ul>${out.map(([cl, txt, area, ir]) => `<li><button type="button" data-tarea="${ir}"><i class="${cl}" aria-hidden="true"></i><span><b>${esc(txt)}</b><small>${esc(area)}</small></span><span class="ir">Ir →</span></button></li>`).join('')}</ul>`
      : '<p class="ok">✓ Nada urgente por ahora.</p>'}`;
    box.hidden = false;
  }
  $('#i-tareas').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tarea]');
    if (!b) return;
    const [v, tab] = b.dataset.tarea.split(':');
    if (v === 'aprob') { S.tab = tab; S.siigoVer = ''; const f = $('#f-siigo'); if (f) f.value = ''; setView('aprob'); renderTabs(); renderList(); return; }
    setView(v);
  });
  let siigoAbierto = false; // la lista de pendientes con Siigo empieza recogida
  // Avisos al entrar (solo administradora): lo que falta por enviar a Siigo o no cuadra
  function renderPendSiigo() {
    const box = $('#i-avisos');
    if (!isAdmin || !S.loaded) { box.hidden = true; return; }
    const sinDS = S.pagos.filter((p) => necesitaDS(p) && !p.siigoEnvioDS).length;
    const pagosSin = S.pagos.filter((p) => p.tipoDoc !== 'caja' && p.estado === 'pagado' && !enSiigo(p) && !subiendoSiigo(p)).length;
    const cajasSin = S.pagos.filter((p) => p.tipoDoc === 'caja' && (p.estado === 'aprobado' || p.estado === 'pagado') && !enSiigo(p) && !subiendoSiigo(p)).length;
    const malos = S.pagos.filter(alertaSiigo).length;
    const fila = (n, txt, clase, accion) => (n ? `<div class="aviso ${clase}"><span><b>${n}</b> ${txt}</span><button class="btn sm" type="button" data-aviso="${accion}">Ver</button></div>` : '');
    const html = fila(malos, malos === 1 ? 'registro no cuadra con Siigo' : 'registros no cuadran con Siigo', 'mal', 'alerta')
      + fila(sinDS, sinDS === 1 ? 'cuenta de cobro aprobada sin documento soporte' : 'cuentas de cobro aprobadas sin documento soporte', 'pend', 'dsPend')
      + fila(pagosSin, pagosSin === 1 ? 'pago pagado sin subir a Siigo' : 'pagos pagados sin subir a Siigo', 'pend', 'sinSiigo')
      + fila(cajasSin, cajasSin === 1 ? 'caja menor sin subir a Siigo' : 'cajas menores sin subir a Siigo', 'pend', 'cajas');
    // Recogido por defecto: solo un botoncito; se abre cuando la administradora lo toca
    const total = malos + sinDS + pagosSin + cajasSin;
    box.classList.toggle('mini', !siigoAbierto);
    box.innerHTML = `<button class="siigo-chip" type="button" data-siigo-toggle aria-expanded="${siigoAbierto}">Pendientes con Siigo ${total ? `<b class="${malos ? 'mal' : 'pend'}">${total}</b>` : '<span class="ok">✓</span>'} <span aria-hidden="true">${siigoAbierto ? '▴' : '▾'}</span></button>`
      + (siigoAbierto ? (html || '<div class="aviso"><span>✓ Todo está al día con Siigo.</span></div>') : '');
    box.hidden = false;
  }
  $('#i-avisos').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-siigo-toggle]')) { siigoAbierto = !siigoAbierto; renderPendSiigo(); return; }
    const b = ev.target.closest('[data-aviso]');
    if (!b) return;
    if (b.dataset.aviso === 'cajas') { setView('cajas'); return; }
    S.siigoVer = b.dataset.aviso; $('#f-siigo').value = S.siigoVer; S.tab = 'todos';
    setView('aprob'); renderTabs(); renderList();
  });

  // ---------- consultas por proveedor y por cliente ----------
  function rangoConsulta(r) {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    if (r === 'anio') return [d.getFullYear() + '-01-01', todayISO()];
    if (r === 'todo') return ['', ''];
    return rangeDates(r);
  }
  const Q = { prov: { clave: '', per: 'anio', desde: '', hasta: '' }, cli: { clave: '', per: 'anio', desde: '', hasta: '', ver: 'todo', orden: 'desc' } };
  [Q.prov.desde, Q.prov.hasta] = rangoConsulta('anio'); [Q.cli.desde, Q.cli.hasta] = rangoConsulta('anio');
  const enRango = (f, q) => !!f && (!q.desde || f >= q.desde) && (!q.hasta || f <= q.hasta);
  const periodoTxt = (q) => (q.desde || q.hasta ? `${q.desde ? fmtDate(q.desde) : 'inicio'} – ${q.hasta ? fmtDate(q.hasta) : 'hoy'}` : 'Todo el tiempo');
  // Agrupa por NIT (o por nombre si no hay NIT)
  function grupos(lista, nombreDe) {
    const m = new Map();
    for (const x of lista) {
      const nombre = String(nombreDe(x) || '').trim();
      if (!nombre) continue;
      const clave = x.nit ? 'n' + x.nit : 't' + normTxt(nombre);
      if (!m.has(clave)) m.set(clave, { clave, nombre, nit: x.nit || '', items: [] });
      m.get(clave).items.push(x);
    }
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }
  function buscarGrupo(gs, texto) {
    const t = normTxt(texto), dig = String(texto).replace(/\D/g, '');
    if (!t) return { lista: [] };
    const exacto = gs.find((g) => normTxt(g.nombre) === t || (dig.length >= 6 && g.nit === dig));
    if (exacto) return { uno: exacto };
    const lista = gs.filter((g) => normTxt(g.nombre).includes(t) || (dig.length >= 4 && g.nit.includes(dig)));
    return lista.length === 1 ? { uno: lista[0] } : { lista };
  }
  function pintarPeriodo(attr, q) {
    document.querySelectorAll(`[${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === q.per)));
  }

  function renderConsultaProv() {
    if (S.view !== 'prov') return;
    const q = Q.prov;
    const gs = grupos(S.pagos, (p) => p.proveedor);
    const html = gs.map((g) => `<option value="${esc(g.nombre)}">${g.nit ? 'NIT ' + esc(g.nit) : ''}</option>`).join('');
    if ($('#qp-lista').dataset.html !== html) { $('#qp-lista').innerHTML = html; $('#qp-lista').dataset.html = html; }
    $('#qp-desde').value = q.desde; $('#qp-hasta').value = q.hasta; pintarPeriodo('data-qper', q);
    const res = $('#qp-res');
    const g = q.clave ? gs.find((x) => x.clave === q.clave) : null;
    if (!g) {
      const b = buscarGrupo(gs, $('#qp-input').value);
      if (b.uno) { q.clave = b.uno.clave; return renderConsultaProv(); }
      res.innerHTML = b.lista && b.lista.length
        ? `<div class="res-grupo"><span class="section-lbl">Elige el proveedor</span><div class="elegir">${b.lista.slice(0, 20).map((x) => `<button class="btn sm" type="button" data-qpsel="${esc(x.clave)}">${esc(x.nombre)}</button>`).join('')}</div></div>`
        : `<div class="empty" style="margin-top:16px"><h3>Busca un proveedor</h3><p>Escribe parte del nombre o el NIT. Verás cuánto se le ha pagado en el periodo, el detalle de cada pago y lo que tiene pendiente.</p></div>`;
      return;
    }
    const pagados = g.items.filter((p) => p.estado === 'pagado' && enRango(fechaPagoDe(p), q)).sort((a, b) => fechaPagoDe(b).localeCompare(fechaPagoDe(a)));
    const pendientes = g.items.filter((p) => ['revisar', 'aprobado', 'pendiente'].includes(p.estado));
    const totPag = pagados.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const totPend = pendientes.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const fila = (p, pag) => {
      const st = ESTADOS[p.estado] ? p.estado : 'revisar';
      const ap = aprobacion(p);
      const det = pag ? `Pagado el ${esc(fmtDate(fechaPagoDe(p)))}${ap ? ' · Aprobó ' + esc(personName(ap.por)) : ''}` : (p.vence ? 'Vence ' + esc(fmtDate(p.vence)) : 'Sin fecha');
      return `<article class="row rrow s-${st}" data-row="${p.id}" tabindex="0"><div class="r-main"><div class="r-prov">${esc([p.factura ? 'Fact. ' + p.factura : '', p.concepto].filter(Boolean).join(' · ') || 'Pago')}</div><div class="r-sub">${det}</div></div><div class="r-amt">${fmt(p.valor)}<div class="quien">${ESTADOS[st].label}</div></div></article>`;
    };
    res.innerHTML = `
      <div class="ficha" style="margin-top:16px">
        <div><h3>${esc(g.nombre)}</h3><span class="nit">${g.nit ? 'NIT ' + esc(g.nit) + ' · ' : ''}${esc(periodoTxt(q))}</span></div>
        <div class="cifras">
          <div><span class="l">Total pagado</span><span class="v g">${fmt(totPag)}</span></div>
          <div><span class="l">Pagos</span><span class="v">${pagados.length}</span></div>
          <div><span class="l">Por pagar</span><span class="v">${fmt(totPend)}</span></div>
        </div>
      </div>
      <div class="res-grupo"><span class="section-lbl">Pagos realizados</span>${pagados.length ? pagados.map((p) => fila(p, true)).join('') : '<p class="rep-note">No hay pagos en este periodo.</p>'}</div>
      ${pendientes.length ? `<div class="res-grupo"><span class="section-lbl">Pendientes por pagar</span>${pendientes.map((p) => fila(p, false)).join('')}</div>` : ''}`;
  }

  function renderConsultaCli() {
    if (S.view !== 'cli') return;
    const q = Q.cli;
    const gs = grupos(C.items, (it) => it.cliente);
    const html = gs.map((g) => `<option value="${esc(g.nombre)}">${g.nit ? 'NIT ' + esc(g.nit) : ''}</option>`).join('');
    if ($('#qc-lista').dataset.html !== html) { $('#qc-lista').innerHTML = html; $('#qc-lista').dataset.html = html; }
    $('#qc-desde').value = q.desde; $('#qc-hasta').value = q.hasta; pintarPeriodo('data-qcper', q);
    document.querySelectorAll('[data-qcver]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.qcver === q.ver)));
    document.querySelectorAll('[data-qcord]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.qcord === q.orden)));
    const res = $('#qc-res');
    if (!C.loaded) { res.innerHTML = '<div class="empty" style="margin-top:16px"><h3>Cargando cartera…</h3></div>'; return; }
    const g = q.clave ? gs.find((x) => x.clave === q.clave) : null;
    if (!g) {
      const b = buscarGrupo(gs, $('#qc-input').value);
      if (b.uno) { q.clave = b.uno.clave; return renderConsultaCli(); }
      res.innerHTML = b.lista && b.lista.length
        ? `<div class="res-grupo"><span class="section-lbl">Elige el cliente</span><div class="elegir">${b.lista.slice(0, 20).map((x) => `<button class="btn sm" type="button" data-qcsel="${esc(x.clave)}">${esc(x.nombre)}</button>`).join('')}</div></div>`
        : `<div class="empty" style="margin-top:16px"><h3>Busca un cliente</h3><p>Escribe parte del nombre o el NIT. Verás cuánto te ha pagado en el periodo, cada cobro y lo que tiene pendiente por pagar.</p></div>`;
      return;
    }
    const cobros = [];
    for (const it of g.items) for (const c of it.cobros || []) if (enRango(c.fecha, q) || (!c.fecha && !q.desde && !q.hasta)) cobros.push({ it, c });
    const dir = q.orden === 'asc' ? 1 : -1;
    cobros.sort((a, b) => dir * String(a.c.fecha || '').localeCompare(String(b.c.fecha || '')));
    const fDoc = (it) => String(it.fecha || it.vence || '');
    const pendientes = g.items.filter((it) => porCobrarDe(it) > 0).sort((a, b) => dir * fDoc(a).localeCompare(fDoc(b)) || dir * String(a.documento || '').localeCompare(String(b.documento || ''), 'es', { numeric: true }));
    const verCob = q.ver !== 'pend', verPend = q.ver !== 'cob';
    const totCob = cobros.reduce((s, x) => s + (Number(x.c.valor) || 0), 0);
    const totRet = cobros.reduce((s, x) => s + (Number(x.c.ret) || 0), 0);
    const totPend = pendientes.reduce((s, it) => s + porCobrarDe(it), 0);
    res.innerHTML = `
      <div class="ficha" style="margin-top:16px">
        <div><h3>${esc(g.nombre)}</h3><span class="nit">${g.nit ? 'NIT ' + esc(g.nit) + ' · ' : ''}${esc(periodoTxt(q))}</span></div>
        <div class="cifras">
          <div><span class="l">Total cobrado</span><span class="v g">${fmt(totCob)}</span></div>
          <div><span class="l">Cobros</span><span class="v">${cobros.length}</span></div>
          ${totRet ? `<div><span class="l">Retenciones</span><span class="v">${fmt(totRet)}</span></div>` : ''}
          <div><span class="l">Por cobrar</span><span class="v">${fmt(totPend)}</span></div>
        </div>
      </div>
      ${verCob ? `<div class="res-grupo"><span class="section-lbl">Cobros recibidos</span>${cobros.length ? cobros.map(({ it, c }) => `<article class="row rrow s-aprobado" data-crow="${it.id}" tabindex="0"><div class="r-main"><div class="r-prov">${esc([it.documento, it.descripcion].filter(Boolean).join(' · ').slice(0, 140) || 'Cobro')}</div><div class="r-sub">${c.fecha ? 'Recibido el ' + esc(fmtDate(c.fecha)) : 'Sin fecha'}${c.historico ? ' · histórico' : ''}${c.ret ? ' · retenciones ' + fmt(c.ret) : ''}</div></div><div class="r-amt">${fmt(c.valor)}</div></article>`).join('') : '<p class="rep-note">No hay cobros en este periodo.</p>'}</div>` : ''}
      ${verPend ? `<div class="res-grupo"><span class="section-lbl">Pendiente por cobrar</span>${pendientes.length ? pendientes.map((it) => `<article class="row rrow s-${CE_CLASE[it.estado] || 'revisar'}" data-crow="${it.id}" tabindex="0"><div class="r-main"><div class="r-prov">${esc([it.documento, it.descripcion].filter(Boolean).join(' · ').slice(0, 140))}</div><div class="r-sub">${it.vence ? 'Vence ' + esc(fmtDate(it.vence)) : it.fecha ? 'Elaborada ' + esc(fmtDate(it.fecha)) : ''} · ${CE[it.estado] || it.estado}</div></div><div class="r-amt">${fmt(porCobrarDe(it))}</div></article>`).join('') : '<p class="rep-note">No tiene nada pendiente por cobrar.</p>'}</div>` : ''}`;
  }

  // Eventos de las consultas
  $('#qp-input').addEventListener('input', () => { Q.prov.clave = ''; renderConsultaProv(); });
  $('#qc-input').addEventListener('input', () => { Q.cli.clave = ''; renderConsultaCli(); });
  ['qp', 'qc'].forEach((k) => {
    const q = k === 'qp' ? Q.prov : Q.cli, rend = () => (k === 'qp' ? renderConsultaProv() : renderConsultaCli());
    $(`#${k}-desde`).addEventListener('change', (e) => { q.desde = e.target.value; q.per = ''; rend(); });
    $(`#${k}-hasta`).addEventListener('change', (e) => { q.hasta = e.target.value; q.per = ''; rend(); });
  });
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-qper], [data-qcper], [data-qpsel], [data-qcsel], [data-qcver], [data-qcord]');
    if (!t) return;
    if (t.dataset.qcver) { Q.cli.ver = t.dataset.qcver; renderConsultaCli(); }
    if (t.dataset.qcord) { Q.cli.orden = t.dataset.qcord; renderConsultaCli(); }
    if (t.dataset.qper) { Q.prov.per = t.dataset.qper; [Q.prov.desde, Q.prov.hasta] = rangoConsulta(t.dataset.qper); renderConsultaProv(); }
    if (t.dataset.qcper) { Q.cli.per = t.dataset.qcper; [Q.cli.desde, Q.cli.hasta] = rangoConsulta(t.dataset.qcper); renderConsultaCli(); }
    if (t.dataset.qpsel) { Q.prov.clave = t.dataset.qpsel; const g = grupos(S.pagos, (p) => p.proveedor).find((x) => x.clave === t.dataset.qpsel); if (g) $('#qp-input').value = g.nombre; renderConsultaProv(); }
    if (t.dataset.qcsel) { Q.cli.clave = t.dataset.qcsel; const g = grupos(C.items, (it) => it.cliente).find((x) => x.clave === t.dataset.qcsel); if (g) $('#qc-input').value = g.nombre; renderConsultaCli(); }
  });
  function pagosEnRango() {
    let a = S.rDesde, b = S.rHasta;
    if (a && b && a > b) [a, b] = [b, a];
    return S.pagos.filter((p) => {
      if (p.estado !== 'pagado') return false;
      const f = fechaPagoDe(p);
      return f && (!a || f >= a) && (!b || f <= b);
    }).sort((x, y) => fechaPagoDe(y).localeCompare(fechaPagoDe(x)) || String(x.proveedor || '').localeCompare(String(y.proveedor || ''), 'es'));
  }
  function renderReport() {
    if (S.view !== 'rep') return;
    document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === S.rRange)));
    const sum = $('#r-sum'), list = $('#r-list');
    if (!S.loaded) { sum.innerHTML = ''; list.innerHTML = '<div class="empty"><h3>Cargando pagos…</h3></div>'; return; }
    const arr = pagosEnRango();
    const total = arr.reduce((t, p) => t + (Number(p.valor) || 0), 0);
    const provs = new Set(arr.map((p) => String(p.proveedor || '').trim().toLowerCase())).size;
    const periodo = S.rDesde && S.rHasta ? (S.rDesde === S.rHasta ? fmtDate(S.rDesde) : `${fmtDate(S.rDesde)} – ${fmtDate(S.rHasta)}`) : 'Todo';
    sum.innerHTML = `
      <div class="tile main"><span class="lbl">Total pagado</span><span class="val">${fmt(total)}</span><span>${esc(periodo)}</span></div>
      <div class="tile"><span class="lbl">Pagos realizados</span><span class="val">${arr.length}</span></div>
      <div class="tile"><span class="lbl">Proveedores</span><span class="val">${provs}</span></div>`;
    $('#r-dl').hidden = !window.XLSX || !arr.length;
    $('#r-siigo').hidden = !isAdmin || !window.XLSX;
    const sinFecha = S.pagos.filter((p) => p.estado === 'pagado' && !fechaPagoDe(p)).length;
    const nota = sinFecha ? `<p class="rep-note">${sinFecha} ${sinFecha === 1 ? 'pago marcado como pagado no tiene' : 'pagos marcados como pagados no tienen'} fecha de pago y no aparece${sinFecha === 1 ? '' : 'n'} en el reporte.${isAdmin ? ' Ábrelos en la pestaña Pagados y usa Editar para ponerles la fecha.' : ''}</p>` : '';
    if (!arr.length) {
      list.innerHTML = `<div class="empty"><h3>No hay pagos en este periodo</h3><p>Prueba con otro rango de fechas. Los pagos aparecen aquí cuando se marcan como pagados con su fecha.</p></div>${nota}`;
      return;
    }
    const byDay = new Map();
    for (const p of arr) { const f = fechaPagoDe(p); if (!byDay.has(f)) byDay.set(f, []); byDay.get(f).push(p); }
    list.innerHTML = [...byDay.entries()].map(([f, ps]) => {
      const [y, m, d] = f.split('-').map(Number);
      const sub = ps.reduce((t, p) => t + (Number(p.valor) || 0), 0);
      return `<div class="day"><div class="day-head"><h3>${esc(dayFmt.format(new Date(y, m - 1, d)))}</h3><span>${ps.length} ${ps.length === 1 ? 'pago' : 'pagos'} · <strong class="num">${fmt(sub)}</strong></span></div>
        <div class="list">${ps.map((p) => {
          const subl = [p.concepto, p.factura ? 'Fact. ' + p.factura : ''].filter(Boolean).map(esc).join(' · ');
          const ap = aprobacion(p);
          return `<article class="row rrow s-pagado" data-row="${p.id}" tabindex="0"><div class="r-main"><div class="r-prov">${esc(p.proveedor || 'Sin proveedor')}</div><div class="r-sub">${subl || '&nbsp;'}${p.archivo ? ' · <span class="clip">Factura adjunta</span>' : ''}</div>${ap ? `<div class="quien">Aprobó ${esc(personName(ap.por))}</div>` : ''}</div><div class="r-amt">${fmt(p.valor)}</div></article>`;
        }).join('')}</div></div>`;
    }).join('') + nota;
  }
  function descargarReporte() {
    if (!window.XLSX) return;
    const arr = pagosEnRango();
    const rows = [['Fecha de pago', 'Proveedor', 'Concepto', 'N.º factura', 'Vencimiento', 'Valor pagado', 'Aprobado por', 'Fecha aprobación', 'Nota']];
    for (const p of arr) {
      const [y, m, d] = fechaPagoDe(p).split('-').map(Number);
      const v = p.vence ? p.vence.split('-').map(Number) : null;
      const ap = aprobacion(p);
      const nombreAp = ap ? (ap.por === uid ? ((conf.usuarios[uid] || {}).nombre || 'Administradora') : personName(ap.por)) : '';
      rows.push([new Date(y, m - 1, d), p.proveedor || '', p.concepto || '', p.factura || '', v ? new Date(v[0], v[1] - 1, v[2]) : '', Number(p.valor) || 0, nombreAp, ap ? new Date(ap.en) : '', p.nota || '']);
    }
    rows.push([]); rows.push(['', '', '', '', 'Total', arr.reduce((t, p) => t + (Number(p.valor) || 0), 0), '', '', '']);
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 40 }];
    for (let r = 1; r < rows.length; r++) { const c = ws[XLSX.utils.encode_cell({ r, c: 5 })]; if (c && typeof c.v === 'number') c.z = '"$"#,##0'; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pagos realizados');
    const name = S.rDesde === S.rHasta ? `Pagos realizados ${S.rDesde}.xlsx` : `Pagos realizados ${S.rDesde || 'inicio'} a ${S.rHasta || 'hoy'}.xlsx`;
    XLSX.writeFile(wb, name, { cellDates: true });
  }

  // ---------- reporte mensual: pagado, por proveedor, por centro de costo y retenciones ----------
  function datosMes(mes) {
    const enMes = (f) => String(f || '').slice(0, 7) === mes;
    const pagos = S.pagos.filter((p) => p.estado === 'pagado' && enMes(fechaPagoDe(p)));
    const agrupar = (arr, clave, valor) => {
      const m = new Map();
      for (const p of arr) { const k = clave(p); const x = m.get(k) || { nombre: k, n: 0, total: 0 }; x.n++; x.total += valor(p); m.set(k, x); }
      return [...m.values()].sort((a, b) => b.total - a.total);
    };
    const val = (p) => Number(p.valor) || 0;
    const porProv = agrupar(pagos, (p) => String(p.proveedor || 'Sin proveedor').trim().toUpperCase(), val);
    const porCC = agrupar(pagos, (p) => (p.cc ? ccTexto(p.cc) : 'Sin centro de costo'), val);
    const porTipo = agrupar(pagos, (p) => TIPO_DOC[p.tipoDoc] || 'Factura de proveedor', val);
    // Retenciones: documentos soporte con fecha en el mes
    const ds = S.pagos.filter((p) => p.ds && enMes(p.ds.fecha));
    const ret = new Map();
    for (const p of ds) for (const r of p.ds.retenciones || []) { const x = ret.get(r.nombre) || { nombre: r.nombre, n: 0, base: 0, total: 0 }; x.n++; x.base += Number(p.ds.valorBruto) || 0; x.total += Number(r.valor) || 0; ret.set(r.nombre, x); }
    const contratistas = ds.map((p) => { const t = (p.ds.retenciones || []).reduce((s, r) => s + (Number(r.valor) || 0), 0); return { nombre: p.proveedor || '', nit: p.nit || '', ds: p.ds.nombre, bruto: Number(p.ds.valorBruto) || 0, ret: t, neto: (Number(p.ds.valorBruto) || 0) - t, cc: p.ds.cc ? ccTexto(p.ds.cc) : '' }; });
    return { pagos, total: pagos.reduce((s, p) => s + val(p), 0), porProv, porCC, porTipo, retenciones: [...ret.values()], contratistas, totalRet: contratistas.reduce((s, c) => s + c.ret, 0) };
  }
  function nombreMes(mes) { const [y, m] = mes.split('-').map(Number); const s = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 15)); return s.charAt(0).toUpperCase() + s.slice(1); }
  function renderMensual() {
    const mes = $('#rm-mes').value;
    if (!mes) return;
    const d = datosMes(mes);
    const tabla = (titulo, cab, filas) => `<section><span class="section-lbl">${titulo}</span><table><thead><tr>${cab.map((c, i) => `<th${i ? ' class="n"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>${filas || `<tr><td colspan="${cab.length}">Sin datos</td></tr>`}</tbody></table></section>`;
    $('#rm-res').innerHTML = `
      <section class="rep-sum">
        <div class="tile main"><span class="lbl">Total pagado</span><span class="val">${fmt(d.total)}</span><span>${esc(nombreMes(mes))}</span></div>
        <div class="tile"><span class="lbl">Pagos</span><span class="val">${d.pagos.length}</span></div>
        <div class="tile"><span class="lbl">Retenido</span><span class="val">${fmt(d.totalRet)}</span></div>
      </section>
      ${tabla('Por tipo', ['Tipo', 'Pagos', 'Total'], d.porTipo.map((x) => `<tr><td>${esc(x.nombre)}</td><td class="n">${x.n}</td><td class="n">${fmt(x.total)}</td></tr>`).join(''))}
      ${tabla('A quién se le pagó', ['Proveedor o contratista', 'Pagos', 'Total'], d.porProv.map((x) => `<tr><td>${esc(x.nombre)}</td><td class="n">${x.n}</td><td class="n">${fmt(x.total)}</td></tr>`).join(''))}
      ${tabla('Por centro de costo', ['Centro de costo', 'Pagos', 'Total'], d.porCC.map((x) => `<tr><td>${esc(x.nombre)}</td><td class="n">${x.n}</td><td class="n">${fmt(x.total)}</td></tr>`).join(''))}
      ${tabla('Retenciones (documentos soporte del mes)', ['Retención', 'Documentos', 'Base', 'Retenido'], d.retenciones.map((x) => `<tr><td>${esc(x.nombre)}</td><td class="n">${x.n}</td><td class="n">${fmt(x.base)}</td><td class="n">${fmt(x.total)}</td></tr>`).join(''))}
      ${tabla('Retenciones por contratista', ['Contratista', 'Documento soporte', 'Valor', 'Retenido', 'Neto'], d.contratistas.map((x) => `<tr><td>${esc(x.nombre)}${x.nit ? ' · ' + esc(x.nit) : ''}</td><td class="n">${esc(x.ds)}</td><td class="n">${fmt(x.bruto)}</td><td class="n">${fmt(x.ret)}</td><td class="n">${fmt(x.neto)}</td></tr>`).join(''))}
      <p class="rep-note">Lo pagado sale de los pagos marcados como pagados con fecha en el mes. Las retenciones salen de los documentos soporte hechos desde la app.</p>`;
    $('#rm-dl').hidden = !window.XLSX;
  }
  function descargarMensual() {
    const mes = $('#rm-mes').value;
    if (!mes || !window.XLSX) return;
    const d = datosMes(mes), wb = XLSX.utils.book_new();
    const hoja = (nombre, filas, anchos, colsPesos) => {
      const ws = XLSX.utils.aoa_to_sheet(filas, { cellDates: true, dateNF: 'dd/mm/yyyy' });
      ws['!cols'] = anchos.map((w) => ({ wch: w }));
      for (let r = 1; r < filas.length; r++) for (const c of colsPesos) { const x = ws[XLSX.utils.encode_cell({ r, c })]; if (x && typeof x.v === 'number') x.z = '"$"#,##0'; }
      XLSX.utils.book_append_sheet(wb, ws, nombre);
    };
    hoja('Resumen', [['Mes', nombreMes(mes)], ['Total pagado', d.total], ['Número de pagos', d.pagos.length], ['Total retenido', d.totalRet], [], ['Tipo', 'Pagos', 'Total'], ...d.porTipo.map((x) => [x.nombre, x.n, x.total])], [28, 18, 16], [1, 2]);
    hoja('Proveedores', [['Proveedor o contratista', 'Pagos', 'Total'], ...d.porProv.map((x) => [x.nombre, x.n, x.total])], [44, 8, 16], [2]);
    hoja('Centros de costo', [['Centro de costo', 'Pagos', 'Total'], ...d.porCC.map((x) => [x.nombre, x.n, x.total])], [44, 8, 16], [2]);
    hoja('Retenciones', [['Retención', 'Documentos', 'Base', 'Retenido'], ...d.retenciones.map((x) => [x.nombre, x.n, x.base, x.total]), [], ['Contratista', 'Cédula', 'Documento soporte', 'Centro de costo', 'Valor', 'Retenido', 'Neto'], ...d.contratistas.map((x) => [x.nombre, x.nit, x.ds, x.cc, x.bruto, x.ret, x.neto])], [34, 14, 16, 30, 14, 14, 14], [2, 3, 4, 5, 6]);
    hoja('Detalle de pagos', [['Fecha de pago', 'Tipo', 'Proveedor', 'NIT', 'Concepto', 'Documento', 'Centro de costo', 'Valor pagado'], ...d.pagos.map((p) => { const [y, m, dd] = fechaPagoDe(p).split('-').map(Number); return [new Date(y, m - 1, dd), TIPO_DOC[p.tipoDoc] || 'Factura', p.proveedor || '', p.nit || '', p.concepto || '', p.factura || '', p.cc ? ccTexto(p.cc) : '', Number(p.valor) || 0]; })], [12, 16, 34, 14, 40, 14, 30, 16], [7]);
    XLSX.writeFile(wb, `Reporte mensual ${mes}.xlsx`, { cellDates: true });
  }
  $('#r-mensual').addEventListener('click', () => {
    const d = new Date(); if (!$('#rm-mes').value) $('#rm-mes').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    $('#rm-mes').max = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderMensual(); $('#dlg-mensual').showModal();
  });
  $('#rm-mes').addEventListener('change', renderMensual);
  $('#rm-dl').addEventListener('click', descargarMensual);

  // ---------- exportación a Siigo (modelo de importación de comprobantes contables) ----------
  const ENCABEZADO_SIIGO = ['Tipo de comprobante', 'Consecutivo comprobante', 'Fecha de elaboración ', 'Sigla moneda', 'Tasa de cambio', 'Código cuenta contable', 'Identificación tercero', 'Sucursal', 'Código producto', 'Código de bodega', 'Acción', 'Cantidad producto', 'Prefijo', 'Consecutivo', 'No. cuota', 'Fecha vencimiento', 'Código impuesto', 'Código grupo activo fijo', 'Código activo fijo', 'Descripción', 'Código centro/subcentro de costos', 'Débito', 'Crédito', 'Observaciones', 'Base gravable libro compras/ventas  ', 'Base exenta libro compras/ventas', 'Mes de cierre'];
  const ddmmaaaa = (iso) => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };

  function filasSiigo() {
    let a = $('#sg-desde').value, b = $('#sg-hasta').value;
    if (a && b && a > b) [a, b] = [b, a];
    const incluir = $('#sg-incluir').checked;
    return S.pagos
      .filter((p) => p.estado === 'pagado' && !p.siigoEnvio && fechaPagoDe(p) && (!a || fechaPagoDe(p) >= a) && (!b || fechaPagoDe(p) <= b) && (incluir || !p.siigo))
      .sort((x, y) => fechaPagoDe(x).localeCompare(fechaPagoDe(y)) || String(x.proveedor || '').localeCompare(String(y.proveedor || ''), 'es'))
      .map((p) => {
        const { prefijo, numero } = partirFactura(p.factura);
        const cuenta = p.cuenta || siigoConf().cuentaProv;
        const errores = [], avisos = [];
        if (!p.nit) errores.push('NIT');
        // Prefijo y número solo son obligatorios en cuentas que cruzan documentos (con vencimiento)
        if (CUENTAS_CON_VENCIMIENTO.has(cuenta)) {
          if (!prefijo) errores.push('prefijo');
          else if (prefijo.length > 6) errores.push('prefijo de más de 6 caracteres');
          if (!numero) errores.push('n.º de factura');
        }
        if (CUENTAS_CON_VENCIMIENTO.has(cuenta) && !p.vence) errores.push('vencimiento');
        if (!(Number(p.valor) > 0)) errores.push('valor');
        if (!p.cc) avisos.push('centro de costo');
        if (p.siigo) avisos.push(`ya exportado (comp. ${p.siigo.comprobante})`);
        return { p, prefijo, numero, cuenta, errores, avisos };
      });
  }

  // Un comprobante por día de pago: todos los pagos de la misma fecha comparten el consecutivo
  function consecutivosPorDia(filas, inicial) {
    const m = new Map();
    for (const f of filas) { const dia = fechaPagoDe(f.p); if (!m.has(dia)) m.set(dia, inicial + m.size); }
    return m;
  }

  function renderSiigo() {
    const filas = filasSiigo();
    const sc = siigoConf();
    $('#sg-conf').textContent = `Comprobante tipo ${sc.tipo} · crédito a ${sc.cuentaBanco}${sc.cuentaBanco === '11100501' ? ' (Bancolombia cte 2278)' : ''} · ${sc.centros.length ? sc.centros.length + ' centros de costo cargados' : 'sin centros de costo cargados (Usuarios → Siigo)'}`;
    if (!filas.length) {
      $('#sg-tabla').innerHTML = '<p style="margin:12px;color:var(--muted)">No hay pagos marcados como pagados en este periodo' + ($('#sg-incluir').checked ? '' : ' sin exportar') + '.</p>';
      $('#sg-go').disabled = true; $('#sg-go').textContent = 'Descargar archivo para Siigo';
      botonSubir('#sg-subir', true, 'Subir a Siigo');
      return;
    }
    const consec = Number($('#sg-consec').value);
    const porDia = consecutivosPorDia(filas, consec > 0 ? consec : 1);
    $('#sg-tabla').innerHTML = `<table><thead><tr><th>Comp.</th><th>Fecha pago</th><th>Proveedor</th><th>NIT</th><th>Factura</th><th>Vence</th><th>Centro de costo</th><th style="text-align:right">Valor</th><th>Estado</th></tr></thead><tbody>
      ${filas.map((f) => `<tr><td>${consec > 0 ? porDia.get(fechaPagoDe(f.p)) : '—'}</td><td>${esc(fmtDate(fechaPagoDe(f.p)))}</td><td>${esc(f.p.proveedor)}</td><td>${esc(f.p.nit || '—')}</td><td>${esc(f.prefijo ? f.prefijo + ' / ' + f.numero : f.p.factura || '—')}</td><td>${esc(f.p.vence ? fmtDate(f.p.vence) : '—')}</td><td>${esc(f.p.cc || '—')}</td><td class="n">${fmt(f.p.valor)}</td>
        <td>${f.errores.length ? `<span class="bulk"><span class="bad">Falta: ${esc(f.errores.join(', '))}</span></span>` : f.avisos.length ? `<span class="bulk"><span class="warn">Sin ${esc(f.avisos.join(', '))}</span></span>` : '<span class="bulk"><span class="ok">Listo</span></span>'} <button class="btn sm ghost" type="button" data-sg-editar="${f.p.id}">Editar</button></td></tr>`).join('')}
      </tbody></table>`;
    const conErrores = filas.filter((f) => f.errores.length).length;
    if (!(consec > 0)) mostrarError('#sg-err', 'Escribe el primer consecutivo del comprobante.');
    else if (conErrores) mostrarError('#sg-err', `${conErrores} ${conErrores === 1 ? 'pago tiene' : 'pagos tienen'} datos obligatorios incompletos. Usa “Completar desde las facturas” o “Editar”.`);
    else mostrarError('#sg-err', '');
    $('#sg-go').disabled = !(consec > 0) || conErrores > 0;
    $('#sg-go').textContent = `Descargar archivo para Siigo (${porDia.size} ${porDia.size === 1 ? 'comprobante' : 'comprobantes'} · ${filas.length} ${filas.length === 1 ? 'pago' : 'pagos'})`;
    botonSubir('#sg-subir', !(consec > 0) || conErrores > 0, `Subir a Siigo (${porDia.size} ${porDia.size === 1 ? 'comprobante' : 'comprobantes'})`);
  }

  function openSiigo() {
    $('#sg-desde').value = S.rDesde || ''; $('#sg-hasta').value = S.rHasta || '';
    const ult = S.siigo && Number(S.siigo.ultimo);
    if (!$('#sg-consec').value && ult > 0) $('#sg-consec').value = ult + 1;
    renderSiigo();
    $('#dlg-siigo').showModal();
    abrirEnvios();
  }
  ['#sg-desde', '#sg-hasta', '#sg-incluir'].forEach((s) => $(s).addEventListener('change', renderSiigo));
  $('#sg-consec').addEventListener('input', renderSiigo);

  async function leerFacturaGuardada(p) {
    const f = await GH.leer(rFactura(p.archivo));
    if (!f) return null;
    const bytes = await Cripto.descifrar(maestra, f.bytes);
    return new File([bytes], p.archivoNombre || 'factura.pdf', { type: p.archivoTipo || 'application/pdf' });
  }

  $('#sg-completar').addEventListener('click', async () => {
    const btn = $('#sg-completar');
    const faltan = filasSiigo().map((f) => f.p).filter((p) => !p.nit || !p.cc || !p.vence);
    if (!faltan.length) { toast('Todos los pagos del periodo ya tienen NIT, vencimiento y centro de costo.'); return; }
    btn.disabled = true;
    const cambios = {};
    let n = 0;
    for (const p of faltan) {
      btn.textContent = `Leyendo ${++n} de ${faltan.length}…`;
      const c = {};
      try {
        let texto = (p.nota || '') + ' ' + (p.concepto || '') + ' ' + (p.archivoNombre || '');
        if (p.archivo && (!p.nit || !p.vence || !p.cc)) {
          const file = await leerFacturaGuardada(p);
          if (file) {
            const r = await Lector.leer(file, conf && conf.claudeKey);
            texto += ' ' + (r.texto || '');
            if (!p.nit && r.datos.nit) c.nit = r.datos.nit.replace(/\D/g, '');
            if (!p.vence && r.datos.vence) c.vence = r.datos.vence;
            if (!p.factura && r.datos.factura) c.factura = r.datos.factura;
          }
        }
        if (!p.cc) { const cc = matchCentro(texto); if (cc) c.cc = cc; }
      } catch (e) { /* se deja para completar a mano */ }
      if (Object.keys(c).length) cambios[p.id] = c;
    }
    const total = Object.keys(cambios).length;
    if (total) {
      try {
        await mutar((d) => { for (const x of d.pagos) if (cambios[x.id]) for (const [k, v] of Object.entries(cambios[x.id])) if (!x[k]) x[k] = v; });
        render();
      } catch (e) { mostrarError('#sg-err', msgGitHub(e)); }
    }
    btn.disabled = false; btn.textContent = 'Completar NIT y centro de costo desde las facturas';
    renderSiigo();
    toast(total ? `Se completaron datos en ${total} ${total === 1 ? 'pago' : 'pagos'}. Revisa los que sigan incompletos.` : 'No encontré más datos en las facturas; complétalos con Editar.');
  });

  // Arma los comprobantes (las mismas líneas para el Excel y para subir a Siigo por la API).
  // Un comprobante por día de pago; los pagos del mismo "lote" comparten UN crédito al banco.
  function comprobantesPagos(filas, inicial, tipo, sc) {
    const porDia = consecutivosPorDia(filas, inicial);
    const comps = new Map();
    const gruposPago = [];
    const porLote = new Map();
    for (const f of filas) {
      const k = f.p.lote ? fechaPagoDe(f.p) + '|' + f.p.lote : 'p' + f.p.id;
      if (!porLote.has(k)) { const g = []; porLote.set(k, g); gruposPago.push(g); }
      porLote.get(k).push(f);
    }
    for (const grupo of gruposPago) {
      const p0 = grupo[0].p;
      const dia = fechaPagoDe(p0), consec = porDia.get(dia);
      if (!comps.has(consec)) comps.set(consec, { tipo, consec, fecha: dia, ids: [], lineas: [], observaciones: `Pagos del ${fmtDate(dia)} (app Pagos ODESA)` });
      const c = comps.get(consec);
      const facturas = grupo.map((f) => `${f.prefijo}-${f.numero}`);
      // Débito: una línea por factura, a la cuenta del proveedor (cruza cada factura)
      for (const f of grupo) {
        const p = f.p, cruza = CUENTAS_CON_VENCIMIENTO.has(f.cuenta);
        c.lineas.push({ cuenta: f.cuenta, nit: String(p.nit), prefijo: cruza ? f.prefijo : '', numero: cruza ? f.numero : '', vence: cruza ? p.vence : '',
          descripcion: (p.concepto || `Pago factura ${f.prefijo}-${f.numero}`).slice(0, 100), cc: p.cc || '', debito: Math.round(Number(p.valor) || 0), credito: 0,
          obs: `Pago ${p.proveedor} factura ${f.prefijo}-${f.numero}`.slice(0, 300) });
        c.ids.push(p.id);
      }
      // Crédito al banco: una línea por centro de costo, mismo tercero
      const porCC = new Map();
      for (const f of grupo) porCC.set(f.p.cc || '', (porCC.get(f.p.cc || '') || 0) + Math.round(Number(f.p.valor) || 0));
      for (const [cc, valor] of porCC) {
        c.lineas.push({ cuenta: String(sc.cuentaBanco), nit: String(p0.nit), prefijo: '', numero: '', vence: '',
          descripcion: (grupo.length === 1 ? (p0.concepto || `Pago factura ${facturas[0]}`) : `Pago facturas ${facturas.join(', ')}`).slice(0, 100), cc, debito: 0, credito: valor,
          obs: `Pago ${p0.proveedor} ${grupo.length === 1 ? 'factura' : 'facturas'} ${facturas.join(', ')}`.slice(0, 300) });
      }
    }
    return [...comps.values()];
  }
  // Líneas → filas del modelo de importación de Siigo
  function filasExcelSiigo(comps) {
    const filas = [ENCABEZADO_SIIGO];
    for (const c of comps) for (const l of c.lineas) {
      const r = new Array(ENCABEZADO_SIIGO.length).fill('');
      r[0] = c.tipo; r[1] = c.consec; r[2] = ddmmaaaa(c.fecha); r[5] = Number(l.cuenta); r[6] = String(l.nit);
      if (l.prefijo) { r[12] = l.prefijo; r[13] = Number(l.numero); r[14] = 1; r[15] = ddmmaaaa(l.vence || c.fecha); }
      r[19] = l.descripcion; r[20] = l.cc; if (l.debito) r[21] = l.debito; if (l.credito) r[22] = l.credito; r[23] = l.obs || '';
      filas.push(r);
    }
    return filas;
  }

  $('#sg-go').addEventListener('click', async () => {
    const filas = filasSiigo();
    const sc = siigoConf();
    const inicial = Number($('#sg-consec').value);
    if (!(inicial > 0) || !filas.length || filas.some((f) => f.errores.length)) return;
    const tipo = Number(sc.tipo) || 11;
    const comps = comprobantesPagos(filas, inicial, tipo, sc);
    const asignados = {};
    for (const c of comps) for (const id of c.ids) asignados[id] = c.consec;
    const porDia = { size: comps.length };
    const filasXls = filasExcelSiigo(comps);
    const ws = XLSX.utils.aoa_to_sheet(filasXls);
    ws['!cols'] = ENCABEZADO_SIIGO.map((h) => ({ wch: Math.max(12, Math.min(28, h.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    const a = $('#sg-desde').value, b = $('#sg-hasta').value;
    XLSX.writeFile(wb, `Siigo comprobantes ${tipo} ${a === b ? a : a + ' a ' + b}.xlsx`);
    const ultimo = inicial + porDia.size - 1;
    const ahora = new Date().toISOString();
    try {
      await mutar((d) => {
        for (const x of d.pagos) if (asignados[x.id]) x.siigo = { tipo, comprobante: asignados[x.id], en: ahora };
        d.siigo = { ...(d.siigo || {}), ultimo: Math.max(ultimo, Number((d.siigo || {}).ultimo) || 0) };
      });
      toast(porDia.size === 1 ? `Archivo generado: comprobante ${tipo}-${inicial} con ${filas.length} pagos. Súbelo en Siigo.` : `Archivo generado: comprobantes ${tipo}-${inicial} a ${tipo}-${ultimo} (uno por día, ${filas.length} pagos). Súbelo en Siigo.`);
      render(); renderSiigo();
    } catch (e) { mostrarError('#sg-err', 'El archivo se descargó, pero no se pudo marcar como exportado: ' + msgGitHub(e)); }
  });

  // Configuración de Siigo (en Usuarios)
  let centrosPendientes = null;
  function renderSiigoConf() {
    const sc = siigoConf();
    $('#sc-tipo').value = sc.tipo; $('#sc-banco').value = sc.cuentaBanco; $('#sc-centros').value = ''; centrosPendientes = null;
    $('#sc-centros-hint').textContent = sc.centros.length ? `${sc.centros.length} centros de costo cargados. Sube el Excel de nuevo solo si cambian.` : 'Aún no hay centros de costo cargados.';
    mostrarError('#siigo-err', '');
  }
  $('#sc-centros').addEventListener('change', async () => {
    const f = $('#sc-centros').files[0];
    centrosPendientes = null;
    if (!f || !window.XLSX) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      const lista = [];
      for (const r of rows) {
        const i = r.findIndex((c) => /^\s*[A-Z0-9]+\s*-\s*\d+\s*$/i.test(String(c)));
        if (i < 0) continue;
        const nombre = r.slice(i + 1).map(String).find((c) => /[A-Za-zÁÉÍÓÚÑ]/.test(c));
        if (nombre) lista.push({ codigo: String(r[i]).replace(/\s+/g, '').toUpperCase(), nombre: nombre.trim() });
      }
      if (!lista.length) { mostrarError('#siigo-err', 'No encontré códigos de centro de costo (formato 100067-1) en el archivo.'); return; }
      centrosPendientes = lista;
      $('#sc-centros-hint').textContent = `Se cargarán ${lista.length} centros de costo al guardar.`;
      mostrarError('#siigo-err', '');
    } catch (e) { mostrarError('#siigo-err', 'No pude leer el archivo de centros de costo.'); }
  });
  $('#siigo-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const tipo = Number($('#sc-tipo').value), banco = $('#sc-banco').value.replace(/\D/g, '');
    if (!(tipo > 0)) return mostrarError('#siigo-err', 'Escribe el tipo de comprobante (por ejemplo 11).');
    if (banco.length < 6) return mostrarError('#siigo-err', 'Escribe la cuenta del banco a nivel transaccional (por ejemplo 11100501).');
    const anterior = conf.siigo;
    conf.siigo = { ...siigoConf(), tipo, cuentaBanco: banco, ...(centrosPendientes ? { centros: centrosPendientes } : {}) };
    try { await guardarConfig(); renderSiigoConf(); toast('Datos de Siigo guardados.'); }
    catch (e) { conf.siigo = anterior; mostrarError('#siigo-err', msgGitHub(e)); }
  });

  // ---------- cuentas de cobro y anticipos de contratistas (buzón) ----------
  // El formulario público (cobro.html) cifra cada envío con la llave pública y lo deja como "issue" en un
  // repositorio privado que sirve de buzón. La app (con la llave privada, guardada cifrada en config)
  // los recoge, genera el PDF de la cuenta de cobro y los registra como pagos "Por revisar".
  const R_COBRO_CONF = 'cobro-config.json';
  const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  function ofuscar(token) {
    const clave = Cripto.enc.encode('odesa-buzon');
    const b = Cripto.enc.encode(token).map((x, i) => x ^ clave[i % clave.length]);
    return Cripto.b64(b).split('').reverse().join('');
  }
  async function apiBuzon(ruta, metodo, cuerpo) {
    const c = conf.cobros;
    const r = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}${ruta}`, {
      method: metodo || 'GET', cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + c.token, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (!r.ok && r.status !== 204) throw { status: r.status };
    return r.status === 204 ? null : r.json();
  }
  function enlacesCobro() {
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return { cobro: base + 'cobro.html?tipo=cobro', anticipo: base + 'cobro.html?tipo=anticipo' };
  }
  function renderCobrosConf() {
    const c = conf.cobros;
    $('#cb-activo').hidden = !c;
    $('#cb-repo').value = (c && c.repo) || '';
    $('#cb-token').value = '';
    $('#cb-btn').textContent = c ? 'Actualizar buzón' : 'Activar enlaces';
    mostrarError('#cb-err', '');
    if (!c) return;
    const l = enlacesCobro();
    $('#cb-estado').textContent = `✓ Activo. Los envíos llegan al buzón ${c.owner}/${c.repo} y entran a la app como “Por revisar”.`;
    $('#cb-link-cobro').value = l.cobro; $('#cb-link-anticipo').value = l.anticipo;
    $('#cb-wa-cobro').href = 'https://wa.me/?text=' + encodeURIComponent('Hola. Para cobrar a ODESA llena tu cuenta de cobro aquí (desde el celular): ' + l.cobro);
    $('#cb-wa-anticipo').href = 'https://wa.me/?text=' + encodeURIComponent('Hola. Para solicitar el anticipo a ODESA llena el formulario aquí (desde el celular): ' + l.anticipo);
  }
  $('#cb-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const repo = $('#cb-repo').value.trim().replace(/^.*\//, '');
    const token = $('#cb-token').value.trim() || (conf.cobros && conf.cobros.token) || '';
    if (!repo) return mostrarError('#cb-err', 'Escribe el nombre del repositorio buzón.');
    if (!token) return mostrarError('#cb-err', 'Pega el token del buzón.');
    if (repo.toLowerCase() === String(conf.repo).toLowerCase()) return mostrarError('#cb-err', 'El buzón debe ser un repositorio distinto al de la app.');
    if (token === conf.token) return mostrarError('#cb-err', 'Usa un token distinto al de la app: este queda en el formulario público.');
    const btn = $('#cb-btn'); btn.disabled = true; btn.textContent = 'Verificando…';
    const anterior = conf.cobros;
    try {
      const owner = conf.owner;
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (!r.ok) { mostrarError('#cb-err', r.status === 404 ? 'No encontré el repositorio buzón o el token no tiene acceso a él.' : 'El token del buzón no es válido (error ' + r.status + ').'); return; }
      const info = await r.json();
      if (!info.private) { mostrarError('#cb-err', 'El repositorio buzón debe ser privado.'); return; }
      let pub = anterior && anterior.pub, priv = anterior && anterior.priv;
      if (!pub || !priv) {
        btn.textContent = 'Creando llaves…';
        const par = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
        pub = await crypto.subtle.exportKey('jwk', par.publicKey);
        priv = await crypto.subtle.exportKey('jwk', par.privateKey);
      }
      conf.cobros = { owner, repo, token, pub, priv };
      await guardarConfig();
      const actual = await GH.leer(R_COBRO_CONF);
      const publico = { v: 1, owner, repo, t: ofuscar(token), pub: { kty: pub.kty, n: pub.n, e: pub.e, alg: pub.alg, ext: true } };
      await GH.escribir(R_COBRO_CONF, Cripto.enc.encode(JSON.stringify(publico, null, 1)), actual && actual.sha);
      renderCobrosConf();
      toast('Enlaces activos. En 1 o 2 minutos quedan publicados.');
    } catch (e) { conf.cobros = anterior; mostrarError('#cb-err', msgGitHub(e)); }
    finally { btn.disabled = false; if (!conf.cobros) btn.textContent = 'Activar enlaces'; }
  });

  // Número en letras para la cuenta de cobro
  function numeroALetras(n) {
    n = Math.round(Number(n) || 0);
    if (!n) return 'CERO PESOS M/CTE';
    const U = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIÚN', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
    const D = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
    const C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
    const cien = (x) => {
      if (x === 100) return 'CIEN';
      const c = Math.floor(x / 100), r = x % 100;
      const dec = r < 30 ? U[r] : D[Math.floor(r / 10)] + (r % 10 ? ' Y ' + U[r % 10] : '');
      return [C[c], dec].filter(Boolean).join(' ');
    };
    const millones = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000;
    const p = [];
    if (millones) p.push(millones === 1 ? 'UN MILLÓN' : cien(millones) + ' MILLONES');
    if (miles) p.push(miles === 1 ? 'MIL' : cien(miles) + ' MIL');
    if (resto) p.push(cien(resto));
    return p.join(' ') + (millones && !miles && !resto ? ' DE' : '') + ' PESOS M/CTE';
  }
  const fmtCedula = (c) => new Intl.NumberFormat('es-CO').format(Number(c) || 0);
  function cargarScriptApp(src) {
    return new Promise((ok, mal) => {
      if (document.querySelector(`script[src="${src}"]`) && window.jspdf) return ok();
      const s = document.createElement('script'); s.src = src; s.onload = () => ok(); s.onerror = () => mal(new Error('jsPDF')); document.head.appendChild(s);
    });
  }
  async function generarCuentaPDF(x, numero) {
    await cargarScriptApp(JSPDF);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const W = 215.9, izq = 22, ancho = W - 44;
    let y = 24;
    const anticipo = x.tipo === 'anticipo';
    const fechaTxt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(x.fecha));
    const titulo = (t) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.text(t, izq, y); y += 5.5; doc.setFont('helvetica', 'normal'); doc.setFontSize(11); };
    const parrafo = (t, extra) => { const l = doc.splitTextToSize(t, ancho); doc.text(l, izq, y); y += l.length * 5.4 + (extra || 0); };
    doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
    doc.text(anticipo ? 'SOLICITUD DE ANTICIPO' : 'CUENTA DE COBRO', W / 2, y, { align: 'center' }); y += 7;
    doc.setFontSize(12); doc.text('N.º ' + numero, W / 2, y, { align: 'center' }); y += 13;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text('Barranquilla, ' + fechaTxt, izq, y); y += 12;
    doc.setFont('helvetica', 'bold'); doc.text('ODESA CARIBE S.A.S.', izq, y); y += 5.4;
    doc.setFont('helvetica', 'normal'); doc.text('NIT 900.409.543-1', izq, y); y += 12;
    titulo(anticipo ? 'SOLICITA ANTICIPO A FAVOR DE:' : 'DEBE A:');
    parrafo(x.nombre.toUpperCase());
    parrafo(`C.C. ${fmtCedula(x.cedula)}   ·   Celular ${x.celular}`, 7);
    titulo('LA SUMA DE:');
    doc.setFont('helvetica', 'bold'); parrafo(fmt(x.valor)); doc.setFont('helvetica', 'normal');
    parrafo('(' + numeroALetras(x.valor) + ')', 7);
    titulo('POR CONCEPTO DE:');
    parrafo(x.descripcion, 1);
    if (x.proyecto) parrafo('Proyecto: ' + x.proyecto, 7); else y += 6;
    titulo('DATOS PARA EL PAGO:');
    parrafo(`${x.banco} · ${x.tipoCuenta} · N.º ${x.numeroCuenta} · Titular: ${x.nombre}`, 9);
    doc.setFontSize(9.5);
    parrafo(anticipo
      ? 'Declaro que la información suministrada es verídica y que el valor del anticipo será descontado del valor total del trabajo o compra.'
      : 'Declaro bajo la gravedad de juramento que la información suministrada es verídica, que presté el servicio descrito y que no soy responsable del impuesto sobre las ventas (IVA).', 8);
    doc.setFontSize(11);
    if (x.firma) {
      const pr = doc.getImageProperties(x.firma);
      const fw = 70, fh = Math.min(30, fw * pr.height / pr.width);
      doc.addImage(x.firma, 'PNG', izq, y, fw, fh, undefined, 'FAST'); y += fh + 1;
    }
    doc.line(izq, y, izq + 80, y); y += 5;
    doc.text(x.nombre, izq, y); y += 5; doc.text('C.C. ' + fmtCedula(x.cedula), izq, y);
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(`Radicado ${x.radicado} · enviado el ${new Date(x.fecha).toLocaleString('es-CO')} desde el formulario de ODESA · firma digital del contratista`, izq, 268);
    doc.setTextColor(0);
    if (x.foto) {
      doc.addPage();
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('Documento de identidad', izq, 22);
      const pr = doc.getImageProperties(x.foto);
      let fw = ancho, fh = fw * pr.height / pr.width;
      if (fh > 220) { fh = 220; fw = fh * pr.width / pr.height; }
      doc.addImage(x.foto, 'JPEG', izq, 28, fw, fh);
    }
    return doc.output('blob');
  }

  let revisandoBuzon = false;
  async function revisarBuzon() {
    if (!isAdmin || !conf || !conf.cobros || !conf.cobros.priv || revisandoBuzon) return;
    revisandoBuzon = true;
    try {
      const issues = (await apiBuzon('/issues?state=open&per_page=30&sort=created&direction=asc'))
        .filter((i) => !i.pull_request && /^buzon-v1/.test(i.body || ''));
      if (!issues.length) return;
      const llavePriv = await crypto.subtle.importKey('jwk', conf.cobros.priv, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      const recibidos = [];
      for (const is of issues) {
        try {
          const partes = Number(((is.body.match(/partes=(\d+)/) || [])[1]) || 1);
          let sobre = is.body.slice(is.body.indexOf('\n') + 1);
          let comentarios = [];
          if (partes > 1) {
            comentarios = (await apiBuzon(`/issues/${is.number}/comments?per_page=100`)).sort((a, b) => a.id - b.id);
            for (let k = 2; k <= partes; k++) {
              const cm = comentarios.find((c) => (c.body || '').startsWith(`parte ${k}\n`));
              if (!cm) throw new Error('incompleto');
              sobre += cm.body.slice(cm.body.indexOf('\n') + 1);
            }
          }
          const s = JSON.parse(sobre);
          const llave = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, llavePriv, Cripto.unb64(s.ek)));
          const datos = await Cripto.descifrarJSON(await Cripto.importarMaestra(llave), Cripto.unb64(s.ct));
          recibidos.push({ is, datos, comentarios });
        } catch (e) { /* envío incompleto o dañado: se deja en el buzón */ }
      }
      if (!recibidos.length) return;
      const nuevos = recibidos.filter((r) => !S.pagos.some((p) => p.radicado === r.datos.radicado));
      // Reservar los consecutivos (CC-n para cuentas de cobro, AN-n para anticipos)
      let base = null;
      if (nuevos.length) {
        await mutar((d) => {
          d.cobros = d.cobros || { cc: 0, an: 0 };
          base = { ...d.cobros };
          d.cobros.cc += nuevos.filter((r) => r.datos.tipo !== 'anticipo').length;
          d.cobros.an += nuevos.filter((r) => r.datos.tipo === 'anticipo').length;
        });
      }
      const pagosNuevos = [];
      for (const r of nuevos) {
        const x = r.datos;
        const anticipo = x.tipo === 'anticipo';
        const numero = anticipo ? 'AN-' + (++base.an) : 'CC-' + (++base.cc);
        const pdf = await generarCuentaPDF(x, numero);
        const archivo = new File([pdf], `${anticipo ? 'Anticipo' : 'Cuenta de cobro'} ${numero} ${x.nombre}.pdf`, { type: 'application/pdf' });
        const adj = await subirFactura(archivo);
        pagosNuevos.push({
          id: nuevoId(), tipoDoc: anticipo ? 'anticipo' : 'cobro', radicado: x.radicado,
          proveedor: x.nombre, nit: x.cedula, concepto: x.descripcion.slice(0, 120), factura: numero, valor: Math.round(x.valor),
          vence: localISO(new Date(x.fecha)), estado: 'revisar', nota: x.proyecto ? 'Proyecto: ' + x.proyecto : '', fechaPago: '',
          contratista: { celular: x.celular, banco: x.banco, tipoCuenta: x.tipoCuenta, numeroCuenta: x.numeroCuenta },
          cuenta: anticipo ? '13300501' : '22050501', cc: matchCentro(x.proyecto + ' ' + x.descripcion), ...adj,
          creado: x.fecha, creadoPor: null,
          historial: [{ estado: 'revisar', por: null, en: x.fecha, nota: `Enviada por ${x.nombre} desde el enlace (radicado ${x.radicado})` }],
        });
      }
      if (pagosNuevos.length) {
        await mutar((d) => { for (const p of pagosNuevos) if (!d.pagos.some((y) => y.radicado === p.radicado)) d.pagos.push(p); });
        render();
        const nc = pagosNuevos.filter((p) => p.tipoDoc === 'cobro').length, na = pagosNuevos.length - nc;
        toast(`Llegaron ${[nc && nc + (nc === 1 ? ' cuenta de cobro' : ' cuentas de cobro'), na && na + (na === 1 ? ' solicitud de anticipo' : ' solicitudes de anticipo')].filter(Boolean).join(' y ')} al buzón.`);
      }
      // Vaciar y cerrar los envíos ya registrados (los datos quedan solo en la app)
      for (const r of recibidos) {
        try {
          for (const cm of r.comentarios) await apiBuzon(`/issues/comments/${cm.id}`, 'DELETE');
          await apiBuzon(`/issues/${r.is.number}`, 'PATCH', { state: 'closed', body: 'procesado ' + r.datos.radicado });
        } catch (e) { /* se reintenta en la próxima revisión; el radicado evita duplicados */ }
      }
    } catch (e) {
      if (e && e.status === 401) notice('El token del buzón de contratistas venció o no es válido. Actualízalo en Usuarios → Enlaces para contratistas.');
    } finally { revisandoBuzon = false; }
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-copiar]');
    if (!b) return;
    const input = document.getElementById(b.dataset.copiar);
    try { await navigator.clipboard.writeText(input.value); toast('Enlace copiado.'); }
    catch (e) { input.select(); toast('Selecciona el enlace y cópialo.'); }
  });

  // ---------- cartera (facturas de venta, anticipos de clientes y retegarantías) ----------
  // Se guarda cifrada en su propio archivo. Solo los cobros registrados (dinero recibido) suman al saldo en banco.
  const R_CARTERA = 'datos/cartera.enc';
  const CE = { pendiente: 'Pendiente', reclamacion: 'Reclamación', pagado: 'Pagada', anulada: 'Anulada', cruzada: 'Cruzada', castigada: 'Castigada', rechazada: 'Rechazada' };
  const CE_CLASE = { pendiente: 'revisar', reclamacion: 'pendiente', pagado: 'aprobado', anulada: 'rechazado', castigada: 'rechazado', rechazada: 'rechazado', cruzada: 'pagado' };
  const CT = { factura: 'Factura', anticipo: 'Anticipo', retegarantia: 'Retegarantía' };
  const CTABS = [['cobrar', 'Por cobrar'], ['pagado', 'Pagadas'], ['otras', 'Anuladas y otras'], ['todas', 'Todas']];
  const C = { items: [], loaded: false, tab: 'cobrar', q: '', tipo: '', openId: null };
  let etagCartera = null;

  async function cargarCartera() {
    const r = await GH.leer(R_CARTERA, { etag: etagCartera });
    if (r && r.sinCambios) return false;
    const d = r ? await Cripto.descifrarJSON(maestra, r.bytes) : { items: [] };
    etagCartera = r ? r.etag : null;
    C.items = d.items || []; C.loaded = true;
    return true;
  }
  async function mutarCartera(cambio) {
    escribiendo++;
    try {
      for (let i = 0; i < 4; i++) {
        const r = await GH.leer(R_CARTERA);
        const d = r ? await Cripto.descifrarJSON(maestra, r.bytes) : { items: [] };
        d.items = d.items || [];
        if (cambio(d) === false) return false;
        try {
          await GH.escribir(R_CARTERA, await Cripto.cifrarJSON(maestra, d), r && r.sha);
          C.items = d.items; etagCartera = null;
          return true;
        } catch (e) {
          if (e && e.conflicto) { await new Promise((ok) => setTimeout(ok, 400 + Math.random() * 600)); continue; }
          throw e;
        }
      }
      throw { message: 'conflicto' };
    } finally { escribiendo--; }
  }

  // cobrado = dinero que entró; retenido = retenciones/descuentos del cliente con los que se saldó la factura
  const cobrado = (it) => (it.cobros || []).reduce((t, c) => t + (Number(c.valor) || 0), 0);
  const retenido = (it) => (it.cobros || []).reduce((t, c) => t + (Number(c.ret) || 0), 0);
  const netoDe = (it) => Number(it.neto) || Number(it.valor) || 0;
  const porCobrarDe = (it) => (it.estado === 'pendiente' || it.estado === 'reclamacion') ? Math.max(netoDe(it) - cobrado(it) - retenido(it), 0) : 0;
  const ultimaFechaCobro = (it) => (it.cobros || []).map((c) => c.fecha).filter(Boolean).sort().pop() || '';
  const normDoc = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

  function totalesCartera() {
    const t = { factura: 0, reclamacion: 0, retegarantia: 0, anticipo: 0, total: 0, vencido: 0, n: 0 };
    const hoy = todayISO();
    for (const it of C.items) {
      const p = porCobrarDe(it);
      if (!p) continue;
      t.n++; t.total += p;
      if (it.estado === 'reclamacion') t.reclamacion += p;
      else if (it.tipo === 'retegarantia') t.retegarantia += p;
      else if (it.tipo === 'anticipo') t.anticipo += p;
      else t.factura += p;
      if (it.vence && it.vence < hoy) t.vencido += p;
    }
    return t;
  }
  function cobrosEnMes() {
    const mes = todayISO().slice(0, 7);
    let total = 0;
    for (const it of C.items) for (const c of it.cobros || []) if (!c.historico && String(c.fecha || '').startsWith(mes)) total += Number(c.valor) || 0;
    return total;
  }

  // Línea consolidada debajo del saldo (la ven todos)
  function renderCartResumen() {
    const el = $('#cart-resumen');
    // A pedido de la administradora, la línea de cartera ya no se muestra en Pagos (la cartera sigue en su propia sección)
    el.hidden = true; return;
    if (!C.loaded || !C.items.length) { el.hidden = true; return; }
    const t = totalesCartera();
    const saldo = S.banco && typeof S.banco.saldo === 'number' ? S.banco.saldo : null;
    const aprob = totals().aprob;
    const partes = [t.factura && `facturas <strong class="num">${fmt(t.factura)}</strong>`, t.reclamacion && `en reclamación <strong class="num">${fmt(t.reclamacion)}</strong>`, t.retegarantia && `retegarantías <strong class="num">${fmt(t.retegarantia)}</strong>`, t.anticipo && `anticipos por recibir <strong class="num">${fmt(t.anticipo)}</strong>`].filter(Boolean);
    const conCartera = saldo != null ? saldo - aprob + t.factura + t.anticipo : null;
    el.innerHTML = `<b>Cartera por cobrar: <span class="num">${fmt(t.total)}</span></b>${partes.length ? ' — ' + partes.join(' · ') : ''}.` +
      (conCartera != null ? ` Si se cobran las facturas y anticipos pendientes, quedaría <strong class="num">${fmt(conCartera)}</strong>.` : '') +
      ` <button class="link" type="button" data-view="cart">Ver cartera</button>`;
    el.hidden = false;
  }

  function visibleCartera() {
    const q = normTxt(C.q);
    return C.items.filter((it) => {
      if (C.tipo && it.tipo !== C.tipo) return false;
      if (C.tab === 'cobrar' && !porCobrarDe(it)) return false;
      if (C.tab === 'pagado' && it.estado !== 'pagado') return false;
      if (C.tab === 'otras' && !['anulada', 'cruzada', 'castigada', 'rechazada'].includes(it.estado)) return false;
      if (q && !normTxt([it.cliente, it.documento, it.descripcion, it.proyecto, it.nit].join(' ')).includes(q)) return false;
      return true;
    }).sort((a, b) => C.tab === 'pagado'
      ? ultimaFechaCobro(b).localeCompare(ultimaFechaCobro(a))
      : (a.vence || a.fecha || '9999').localeCompare(b.vence || b.fecha || '9999'));
  }

  function renderCartera() {
    if (S.view !== 'cart') return;
    $('#c-admin').hidden = !isAdmin;
    const lista = $('#c-list'), foot = $('#c-foot');
    if (!C.loaded) { lista.innerHTML = '<div class="empty"><h3>Cargando cartera…</h3></div>'; return; }
    const t = totalesCartera();
    $('#c-sum').innerHTML = `
      <div class="tile main"><span class="lbl">Por cobrar</span><span class="val">${fmt(t.total)}</span><span>${t.n} ${t.n === 1 ? 'documento' : 'documentos'}</span></div>
      <div class="tile"><span class="lbl">Vencido</span><span class="val">${fmt(t.vencido)}</span></div>
      <div class="tile"><span class="lbl">En reclamación</span><span class="val">${fmt(t.reclamacion)}</span></div>
      <div class="tile"><span class="lbl">Retegarantías</span><span class="val">${fmt(t.retegarantia)}</span></div>
      <div class="tile"><span class="lbl">Anticipos por recibir</span><span class="val">${fmt(t.anticipo)}</span></div>
      <div class="tile"><span class="lbl">Cobrado este mes</span><span class="val">${fmt(cobrosEnMes())}</span></div>`;
    const cuenta = (k) => C.items.filter((it) => k === 'todas' || (k === 'cobrar' ? porCobrarDe(it) > 0 : k === 'pagado' ? it.estado === 'pagado' : ['anulada', 'cruzada', 'castigada', 'rechazada'].includes(it.estado))).length;
    $('#c-tabs').innerHTML = CTABS.map(([k, l]) => `<button class="tab" role="tab" type="button" data-ctab="${k}" aria-selected="${C.tab === k}">${l}<span class="c">${cuenta(k)}</span></button>`).join('');
    if (!C.items.length) {
      lista.innerHTML = `<div class="empty"><h3>La cartera está vacía</h3><p>${isAdmin ? 'Importa tu Excel de cartera para traer las facturas, anticipos y retegarantías con sus estados. Las facturas nuevas llegarán solas desde la carpeta FACTURAS DE VENTA.' : 'Aún no se ha cargado la cartera.'}</p></div>`;
      foot.innerHTML = ''; return;
    }
    const arr = visibleCartera();
    if (!arr.length) { lista.innerHTML = '<div class="empty"><h3>Nada para mostrar</h3><p>No hay documentos con este filtro.</p></div>'; foot.innerHTML = ''; return; }
    lista.innerHTML = arr.map((it) => {
      const pend = porCobrarDe(it), cob = cobrado(it);
      const fechaTxt = it.estado === 'pagado' ? (ultimaFechaCobro(it) ? 'Pagada el ' + fmtDate(ultimaFechaCobro(it)) : 'Pagada') : it.vence ? 'Vence ' + fmtDate(it.vence) : it.fecha ? 'Elaborada ' + fmtDate(it.fecha) : '';
      const chip = pend && it.vence ? dueChip({ estado: 'x', vence: it.vence }) : '';
      const sub = [it.documento, it.descripcion].filter(Boolean).join(' · ');
      return `<article class="row s-${CE_CLASE[it.estado] || 'revisar'}" data-crow="${it.id}" tabindex="0">
        <div class="r-main"><div class="r-prov">${it.tipo !== 'factura' ? `<span class="chip doc">${CT[it.tipo]}</span> ` : ''}${esc(it.cliente || 'Sin cliente')}</div><div class="r-sub">${esc(sub.slice(0, 160))}${(it.archivos || []).length ? ` · <span class="clip">${it.archivos.length} ${it.archivos.length === 1 ? 'documento' : 'documentos'}</span>` : ''}</div></div>
        <div class="r-due">${chip}<span>${esc(fechaTxt)}</span></div>
        <div class="r-amt">${fmt(pend || (it.estado === 'pagado' ? cob || netoDe(it) : netoDe(it)))}${pend && cob ? `<div class="quien">abonado ${fmt(cob)}</div>` : ''}</div>
        <div class="r-act"><span class="pill st-${CE_CLASE[it.estado] || 'revisar'}">${CE[it.estado] || it.estado}</span></div>
      </article>`;
    }).join('');
    const tot = arr.reduce((s, it) => s + (C.tab === 'cobrar' ? porCobrarDe(it) : C.tab === 'pagado' ? cobrado(it) : netoDe(it)), 0);
    foot.innerHTML = `<span>${arr.length} ${arr.length === 1 ? 'documento' : 'documentos'}</span><span>${C.tab === 'cobrar' ? 'Por cobrar' : C.tab === 'pagado' ? 'Cobrado' : 'Total'}: <strong class="num">${fmt(tot)}</strong></span>`;
  }

  function renderCartDetalle() {
    const it = C.items.find((x) => x.id === C.openId);
    const box = $('#cart-detail');
    if (!it) { box.innerHTML = '<div class="dlg-head"><h2>Este documento ya no existe</h2><button class="btn ghost x" type="button" data-close>Cerrar</button></div>'; return; }
    const pend = porCobrarDe(it);
    const docs = (it.archivos || []).map((a, i) => `<li><span>${esc(a.archivoNombre || 'Documento ' + (i + 1))}</span> <button class="btn sm" type="button" data-cver="${i}">Abrir</button></li>`).join('');
    const cobros = (it.cobros || []).map((c) => `<li><span class="when">${esc(c.fecha ? fmtDate(c.fecha) : 'sin fecha')}</span><span class="num">${fmt(c.valor)}</span>${c.ret ? `<span>+ retenciones ${fmt(c.ret)}</span>` : ''}<span>${c.historico ? 'histórico (Excel)' : esc(personName(c.por)) + (c.banco ? ' · sumó al banco' : '')}</span>${isAdmin && !c.historico && c.en ? `<button class="btn sm danger" type="button" data-canular="${esc(c.en)}">${C.anular === c.en ? '¿Seguro? Toca de nuevo' : 'Anular cobro'}</button>` : ''}</li>`).join('');
    const hist = (it.historial || []).slice().reverse().map((h) => `<li><span class="when">${esc(dtFmt.format(new Date(h.en)))}</span><span>${esc(personName(h.por))}</span><span>— ${esc(h.nota || '')}</span></li>`).join('');
    box.innerHTML = `
      <div class="dlg-head"><div style="display:grid;gap:6px;min-width:0"><span class="pill st-${CE_CLASE[it.estado] || 'revisar'}" style="justify-self:start">${CE[it.estado] || it.estado} · ${CT[it.tipo] || ''}</span><h2>${esc(it.cliente || 'Sin cliente')}</h2></div><button class="btn ghost x" type="button" data-close>Cerrar</button></div>
      <div class="big-amt">${fmt(netoDe(it))}${it.neto && it.neto !== it.valor ? `<div class="quien">Facturado ${fmt(it.valor)} · a recibir ${fmt(it.neto)}</div>` : ''}</div>
      <dl class="facts">
        <div><dt>Comprobante</dt><dd>${esc(it.documento || '—')}</dd></div>
        <div><dt>NIT</dt><dd>${esc(it.nit || '—')}</dd></div>
        <div><dt>Elaborada</dt><dd>${it.fecha ? esc(fmtDate(it.fecha)) : '—'}</dd></div>
        <div><dt>Vencimiento</dt><dd>${it.vence ? esc(fmtDate(it.vence)) + ' ' + (pend ? dueChip({ estado: 'x', vence: it.vence }) : '') : '—'}</dd></div>
        <div><dt>Cobrado</dt><dd>${fmt(cobrado(it))}</dd></div>
        ${retenido(it) ? `<div><dt>Retenciones del cliente</dt><dd>${fmt(retenido(it))}</dd></div>` : ''}
        <div><dt>Por cobrar</dt><dd>${fmt(pend)}</dd></div>
        ${it.proyecto ? `<div><dt>Proyecto</dt><dd>${esc(it.proyecto)}</dd></div>` : ''}
      </dl>
      ${it.descripcion ? `<div class="impact"><span class="section-lbl">Descripción</span><span>${esc(it.descripcion)}</span></div>` : ''}
      ${it.observacion ? `<div class="impact"><span class="section-lbl">Observación</span><span>${esc(it.observacion)}</span></div>` : ''}
      <div id="cart-visor"></div>
      ${docs ? `<div style="display:grid;gap:8px"><span class="section-lbl">Documentos</span><ul class="users">${docs}</ul></div>` : '<div class="invoice none">Sin documentos adjuntos.</div>'}
      ${cobros ? `<div style="display:grid;gap:8px"><span class="section-lbl">Cobros recibidos</span><ul class="hist">${cobros}</ul></div>` : ''}
      ${isAdmin ? `<div class="admin-box"><span class="section-lbl">Registrar cobro</span>
        <form class="grid" id="cc-form" novalidate>
          <div class="field"><label for="cc-fecha">Fecha en que entró el dinero</label><input id="cc-fecha" type="date" value="${todayISO()}" max="${todayISO()}"></div>
          <div class="field"><label for="cc-valor">Valor recibido en el banco (COP)</label><input id="cc-valor" inputmode="decimal" value="${pend ? new Intl.NumberFormat('es-CO').format(pend) : ''}" data-pend="${pend}"></div>
          <div class="full" id="cc-dif" hidden style="display:grid;gap:6px">
            <span class="hint" id="cc-dif-txt"></span>
            <label class="check"><input type="radio" name="cc-tipo" id="cc-total" value="total"> <span><b>Pago total con retenciones:</b> la factura queda pagada y la diferencia se registra como retenciones del cliente.</span></label>
            <label class="check"><input type="radio" name="cc-tipo" id="cc-abono" value="abono"> <span><b>Abono parcial:</b> la diferencia sigue pendiente por cobrar.</span></label>
          </div>
          <label class="check full"><input type="checkbox" id="cc-banco" checked> Sumar el valor recibido al saldo en banco</label>
          <div class="err full" id="cc-err" hidden></div>
          <div class="form-actions full"><button class="btn primary sm" type="submit">Registrar cobro</button></div>
        </form>
        <span class="section-lbl">Estado</span>
        <div class="pay-date"><select id="cc-estado">${Object.entries(CE).map(([k, l]) => `<option value="${k}"${k === it.estado ? ' selected' : ''}>${l}</option>`).join('')}</select><input id="cc-nota" placeholder="Motivo u observación (opcional)" style="flex:1 1 200px"><button class="btn sm" type="button" id="cc-estado-go">Cambiar estado</button></div>
        <div class="decide"><button class="btn sm" type="button" data-cedit="${it.id}">Editar</button><button class="btn sm danger" type="button" id="cc-borrar">${C.borrar ? '¿Seguro? Toca de nuevo para eliminar' : 'Eliminar'}</button></div>
      </div>` : ''}
      ${hist ? `<div style="display:grid;gap:8px"><span class="section-lbl">Historial</span><ul class="hist">${hist}</ul></div>` : ''}`;
    if (!$('#dlg-cart').open) $('#dlg-cart').showModal();
  }

  async function verDocCartera(i) {
    const it = C.items.find((x) => x.id === C.openId);
    const a = it && (it.archivos || [])[Number(i)];
    if (!a) return;
    const visor = $('#cart-visor');
    visor.innerHTML = '<div class="invoice none">Descifrando el documento…</div>';
    try {
      if (!facturaUrl[a.archivo]) {
        const f = await GH.leer(rFactura(a.archivo));
        if (!f) throw { status: 404 };
        facturaUrl[a.archivo] = URL.createObjectURL(new Blob([await Cripto.descifrar(maestra, f.bytes)], { type: a.archivoTipo || 'application/pdf' }));
      }
      const url = facturaUrl[a.archivo];
      const isPdf = (a.archivoTipo || '').includes('pdf');
      visor.innerHTML = `<div class="invoice">${isPdf ? `<iframe src="${url}" title="${esc(a.archivoNombre || 'Documento')}"></iframe>` : `<img src="${url}" alt="${esc(a.archivoNombre || 'Documento')}">`}<div class="inv-bar"><span>${esc(a.archivoNombre || 'Documento')}</span><span class="decide" style="flex:none"><a class="btn sm" href="${url}" target="_blank" rel="noopener">Abrir en pestaña nueva</a><a class="btn sm" href="${url}" download="${esc(a.archivoNombre || 'documento.pdf')}">Descargar</a></span></div></div>`;
    } catch (e) { visor.innerHTML = '<div class="invoice none">No se pudo abrir el documento.</div>'; }
  }

  // Anular un cobro registrado por error: se quita de la factura y, si había sumado al banco, se resta del saldo
  async function anularCobro(en) {
    if (C.anular !== en) { C.anular = en; renderCartDetalle(); return; }
    C.anular = null;
    const it = C.items.find((x) => x.id === C.openId);
    const c = it && (it.cobros || []).find((y) => y.en === en);
    if (!c || C.guardando) return;
    C.guardando = true;
    const now = new Date().toISOString();
    try {
      await mutarCartera((d) => {
        const x = d.items.find((y) => y.id === it.id);
        if (!x) return false;
        x.cobros = (x.cobros || []).filter((y) => y.en !== en);
        if (x.estado === 'pagado' && porCobrarDe({ ...x, estado: 'pendiente' }) > 0) x.estado = 'pendiente';
        x.historial = (x.historial || []).slice(-30).concat([{ por: uid, en: now, nota: `Cobro anulado: ${fmt(c.valor)} del ${c.fecha ? fmtDate(c.fecha) : 'sin fecha'}${c.ret ? ` (+ retenciones ${fmt(c.ret)})` : ''}${c.banco ? ' · restado del banco' : ''}` }]);
      });
      if (c.banco && S.banco && typeof S.banco.saldo === 'number') {
        await mutar((d) => { if (d.banco && typeof d.banco.saldo === 'number') d.banco = { ...d.banco, saldo: d.banco.saldo - (Number(c.valor) || 0), actualizado: now, por: uid }; });
      }
      toast(`Cobro anulado${c.banco ? ': se restaron ' + fmt(c.valor) + ' del saldo en banco' : ''}.`);
      render(); renderCartDetalle();
    } catch (e) { toast(msgGitHub(e)); }
    finally { C.guardando = false; }
  }

  async function registrarCobro(ev) {
    ev.preventDefault();
    const it = C.items.find((x) => x.id === C.openId);
    if (!it || C.guardando) return; // evita registrar el mismo cobro dos veces por doble clic
    const fecha = $('#cc-fecha').value, valor = Math.round(parseMonto($('#cc-valor').value)), alBanco = $('#cc-banco').checked;
    if (!fecha) return mostrarError('#cc-err', 'Elige la fecha en que entró el dinero.');
    if (!(valor > 0)) return mostrarError('#cc-err', 'Escribe el valor recibido.');
    const pend = porCobrarDe(it);
    const dif = pend - valor;
    const tipo = (document.querySelector('input[name="cc-tipo"]:checked') || {}).value;
    if (dif > 0 && !tipo) return mostrarError('#cc-err', 'Indica si es un pago total con retenciones o un abono parcial.');
    const saldar = dif > 0 && tipo === 'total';
    const now = new Date().toISOString();
    C.guardando = true;
    const btnCobro = ev.target.querySelector('button[type="submit"]');
    if (btnCobro) { btnCobro.disabled = true; btnCobro.textContent = 'Registrando…'; }
    try {
      let quedoPagada = false;
      await mutarCartera((d) => {
        const x = d.items.find((y) => y.id === it.id);
        if (!x) return false;
        const pendX = porCobrarDe(x);
        const ret = saldar ? Math.max(pendX - valor, 0) : 0;
        x.cobros = (x.cobros || []).concat([{ fecha, valor, ...(ret ? { ret } : {}), por: uid, en: now, banco: alBanco }]);
        if ((saldar || cobrado(x) + retenido(x) >= netoDe(x) - 1) && (x.estado === 'pendiente' || x.estado === 'reclamacion')) { x.estado = 'pagado'; quedoPagada = true; }
        x.historial = (x.historial || []).slice(-30).concat([{ por: uid, en: now, nota: `Cobro de ${fmt(valor)} el ${fmtDate(fecha)}${ret ? ` + retenciones ${fmt(ret)}` : ''}${alBanco ? ' (sumado al banco)' : ''}${quedoPagada ? ' · quedó pagada' : ''}` }]);
      });
      if (alBanco && S.banco && typeof S.banco.saldo === 'number') {
        await mutar((d) => { if (d.banco && typeof d.banco.saldo === 'number') d.banco = { ...d.banco, saldo: d.banco.saldo + valor, actualizado: now, por: uid }; });
      }
      toast(`Cobro registrado${alBanco && S.banco ? ': se sumaron ' + fmt(valor) + ' al saldo en banco' : ''}.`);
      render(); renderCartDetalle();
    } catch (e) { mostrarError('#cc-err', msgGitHub(e)); if (btnCobro) { btnCobro.disabled = false; btnCobro.textContent = 'Registrar cobro'; } }
    finally { C.guardando = false; }
  }

  async function cambiarEstadoCartera() {
    const it = C.items.find((x) => x.id === C.openId);
    if (!it) return;
    const estado = $('#cc-estado').value, nota = $('#cc-nota').value.trim();
    if (estado === it.estado && !nota) return;
    const now = new Date().toISOString();
    try {
      await mutarCartera((d) => {
        const x = d.items.find((y) => y.id === it.id);
        if (!x) return false;
        x.estado = estado;
        if (nota) x.observacion = [x.observacion, nota].filter(Boolean).join(' · ');
        x.historial = (x.historial || []).slice(-30).concat([{ por: uid, en: now, nota: `Estado: ${CE[estado]}${nota ? ' — ' + nota : ''}` }]);
      });
      toast('Estado actualizado.'); render(); renderCartDetalle();
    } catch (e) { toast(msgGitHub(e)); }
  }

  async function borrarCartera() {
    if (!C.borrar) { C.borrar = true; renderCartDetalle(); return; }
    const it = C.items.find((x) => x.id === C.openId);
    C.borrar = false;
    try {
      await mutarCartera((d) => { d.items = d.items.filter((y) => y.id !== it.id); });
      for (const a of it.archivos || []) { try { await GH.borrar(rFactura(a.archivo)); } catch (e) {} }
      $('#dlg-cart').close(); toast('Documento eliminado de la cartera.'); render();
    } catch (e) { toast(msgGitHub(e)); }
  }

  // Agregar / editar
  let cartEditId = null;
  function abrirCartForm(id) {
    cartEditId = id || null;
    const it = id ? C.items.find((x) => x.id === id) : null;
    $('#cf-title').textContent = it ? 'Editar documento de cartera' : 'Agregar a cartera';
    $('#cf-tipo').value = it ? it.tipo : 'factura';
    $('#cf-doc').value = it ? it.documento || '' : '';
    $('#cf-cliente').value = it ? it.cliente || '' : '';
    $('#cf-nit').value = it ? it.nit || '' : '';
    $('#cf-fecha').value = it ? it.fecha || '' : todayISO();
    $('#cf-valor').value = it && it.valor ? new Intl.NumberFormat('es-CO').format(it.valor) : '';
    $('#cf-neto').value = it && it.neto && it.neto !== it.valor ? new Intl.NumberFormat('es-CO').format(it.neto) : '';
    $('#cf-vence').value = it ? it.vence || '' : '';
    $('#cf-proyecto').value = it ? it.proyecto || '' : '';
    $('#cf-desc').value = it ? it.descripcion || '' : '';
    $('#cf-obs').value = it ? it.observacion || '' : '';
    $('#cf-arch').value = '';
    mostrarError('#cf-err', '');
    if ($('#dlg-cart').open) $('#dlg-cart').close();
    $('#dlg-cart-form').showModal();
  }
  $('#cart-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cliente = $('#cf-cliente').value.trim(), valor = Math.round(parseMonto($('#cf-valor').value));
    const netoTxt = $('#cf-neto').value.trim();
    if (!cliente) return mostrarError('#cf-err', 'Escribe el cliente.');
    if (!(valor > 0)) return mostrarError('#cf-err', 'Escribe el valor facturado.');
    const btn = $('#cf-save'); btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const adjuntos = [];
      for (const f of $('#cf-arch').files) adjuntos.push(await subirFactura(f));
      const datos = {
        tipo: $('#cf-tipo').value, documento: $('#cf-doc').value.trim().toUpperCase(), cliente, nit: $('#cf-nit').value.replace(/\D/g, ''),
        fecha: $('#cf-fecha').value, valor, neto: netoTxt ? Math.round(parseMonto(netoTxt)) : valor, vence: $('#cf-vence').value,
        proyecto: $('#cf-proyecto').value.trim(), descripcion: $('#cf-desc').value.trim(), observacion: $('#cf-obs').value.trim(),
      };
      const now = new Date().toISOString();
      if (cartEditId) {
        const id = cartEditId;
        await mutarCartera((d) => {
          const x = d.items.find((y) => y.id === id);
          if (!x) return false;
          Object.assign(x, datos);
          x.archivos = (x.archivos || []).concat(adjuntos);
          x.historial = (x.historial || []).slice(-30).concat([{ por: uid, en: now, nota: 'Editado' }]);
        });
      } else {
        await mutarCartera((d) => { d.items.push({ id: nuevoId(), ...datos, estado: 'pendiente', cobros: [], archivos: adjuntos, origen: 'manual', historial: [{ por: uid, en: now, nota: 'Agregado a mano' }] }); });
      }
      $('#dlg-cart-form').close(); toast('Guardado.'); render();
    } catch (e) { mostrarError('#cf-err', msgGitHub(e)); }
    btn.disabled = false; btn.textContent = 'Guardar';
  });

  // Importar el Excel de cartera (hojas CARTERA y ANTICIPOS Y GARANTIAS)
  let cartImport = [];
  function fechaExcel(v) {
    if (v instanceof Date && !isNaN(v)) return localISO(v);
    if (typeof v === 'number' && v > 30000 && v < 70000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const s = String(v || '').trim();
    if (/^\d{5}$/.test(s) && +s > 30000 && +s < 70000) return fechaExcel(+s);
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }
  const ESTADO_EXCEL = (s) => {
    const n = normTxt(s);
    if (!n) return 'pendiente';
    if (/^PAGAD/.test(n)) return 'pagado';
    if (/^ANULAD/.test(n)) return 'anulada';
    if (/^RECLAMAC/.test(n)) return 'reclamacion';
    if (/^CRUZ/.test(n)) return 'cruzada';
    if (/^CASTIG/.test(n)) return 'castigada';
    if (/^RECHAZ/.test(n)) return 'rechazada';
    return 'pendiente';
  };
  function leerHojaCartera(rows) {
    const iEnc = rows.findIndex((r) => r.some((c) => normTxt(c) === 'IDENTIFICACION') && r.some((c) => normTxt(c) === 'COMPROBANTE'));
    if (iEnc < 0) return [];
    const enc = rows[iEnc].map(normTxt);
    const col = (nombre) => enc.indexOf(nombre);
    const ci = { nit: col('IDENTIFICACION'), cliente: col('NOMBRE TERCERO'), cuenta: col('CODIGO CONTABLE'), desc: col('CUENTA CONTABLE'), doc: col('COMPROBANTE'), fecha: col('FECHA ELABORACION'), valor: col('DEBITO'), estado: col('ESTADO'), fpago: col('FECHA DE PAGO'), vpago: col('VALOR PAGADO'), obs: col('OBSERVACION') };
    const out = [];
    for (const r of rows.slice(iEnc + 1)) {
      const doc = String(r[ci.doc] || '').trim(), cliente = String(r[ci.cliente] || '').trim();
      const valor = Math.round(parseMonto(r[ci.valor])) || 0;
      if (!cliente || (!doc && !(valor > 0))) continue;
      const desc = String(r[ci.desc] || '').replace(/\s+/g, ' ').trim();
      const cuenta = String(r[ci.cuenta] || '').trim();
      const tipo = /anticipo/i.test(desc) || cuenta === '28050501' ? 'anticipo' : cuenta === '13500503' ? 'retegarantia' : 'factura';
      const estado = ESTADO_EXCEL(r[ci.estado]);
      // Fecha(s) y valor(es) pagados: pueden venir como "02/02/2026 Y 03/02/2026" y "$15,000,000 Y $13,000,000"
      const fechas = (typeof r[ci.fpago] === 'number' ? [r[ci.fpago]] : String(r[ci.fpago] || '').split(/\s+y\s+/i)).map(fechaExcel).filter(Boolean);
      const valores = (typeof r[ci.vpago] === 'number' ? [r[ci.vpago]] : String(r[ci.vpago] || '').split(/\s+y\s+/i)).map((x) => Math.round(parseMonto(x))).filter((x) => x > 0);
      const cobros = valores.map((v, k) => ({ fecha: fechas[k] || fechas[fechas.length - 1] || '', valor: v, historico: true }));
      const extras = (ci.obs >= 0 ? r.slice(ci.obs) : []).map((x) => (typeof x === 'number' && x > 30000 && x < 70000 && Number.isInteger(x) ? fmtDate(fechaExcel(x)) : typeof x === 'number' ? fmt(x) : String(x || '').trim())).filter(Boolean);
      const observacion = extras.join(' · ');
      const vm = observacion.match(/Vence\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const pm = desc.match(/PROYECTO\s+([A-ZÁÉÍÓÚÑ0-9 \-]{3,40})/i);
      out.push({ tipo, documento: doc.toUpperCase(), cliente, nit: String(r[ci.nit] || '').replace(/\D/g, ''), cuenta, descripcion: desc, fecha: fechaExcel(r[ci.fecha]), valor, estado, cobros, observacion, vence: vm ? fechaExcel(vm[1]) : '', proyecto: pm ? pm[1].trim() : '' });
    }
    return out;
  }
  $('#ci-file').addEventListener('change', async () => {
    const f = $('#ci-file').files[0];
    cartImport = []; $('#ci-go').disabled = true;
    if (!f || !window.XLSX) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      for (const nombre of wb.SheetNames) cartImport.push(...leerHojaCartera(XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, defval: '' })));
      if (!cartImport.length) { $('#ci-result').innerHTML = '<p class="err">No encontré la tabla de cartera (columnas Identificación, Comprobante, Débito, Estado…).</p>'; return; }
      const porEstado = {}; const porTipo = {};
      for (const x of cartImport) { porEstado[x.estado] = (porEstado[x.estado] || 0) + 1; porTipo[x.tipo] = (porTipo[x.tipo] || 0) + 1; }
      const existentes = cartImport.filter((x) => x.documento && C.items.some((it) => normDoc(it.documento) === normDoc(x.documento))).length;
      const pend = cartImport.filter((x) => x.estado === 'pendiente' || x.estado === 'reclamacion').reduce((s, x) => s + Math.max(x.valor - x.cobros.reduce((a, c) => a + c.valor, 0), 0), 0);
      $('#ci-result').innerHTML = `<p class="mapinfo">Se leyeron <b>${cartImport.length}</b> registros: ${Object.entries(porTipo).map(([k, n]) => `${n} ${CT[k].toLowerCase()}${n === 1 ? '' : 's'}`).join(', ')}.</p>
        <p class="mapinfo">Estados: ${Object.entries(porEstado).map(([k, n]) => `${CE[k]} ${n}`).join(' · ')}. Por cobrar: <b class="num">${fmt(pend)}</b>.</p>
        ${existentes ? `<p class="mapinfo">${existentes} ya están en la app y se actualizarán (estado, pagos y observaciones).</p>` : ''}`;
      $('#ci-go').disabled = false; $('#ci-go').textContent = `Importar ${cartImport.length} registros`;
    } catch (e) { $('#ci-result').innerHTML = '<p class="err">No pude leer el archivo.</p>'; }
  });
  $('#ci-go').addEventListener('click', async () => {
    const btn = $('#ci-go'); btn.disabled = true; btn.textContent = 'Importando…';
    const now = new Date().toISOString();
    try {
      let nuevos = 0, act = 0;
      await mutarCartera((d) => {
        nuevos = 0; act = 0;
        for (const x of cartImport) {
          const ex = x.documento && d.items.find((it) => normDoc(it.documento) === normDoc(x.documento) && (!it.nit || !x.nit || it.nit === x.nit));
          if (ex) {
            ex.estado = x.estado; ex.tipo = x.tipo; ex.observacion = x.observacion || ex.observacion;
            ex.cobros = (ex.cobros || []).filter((c) => !c.historico).concat(x.cobros);
            for (const k of ['cliente', 'nit', 'descripcion', 'fecha', 'vence', 'proyecto', 'cuenta']) if (!ex[k] && x[k]) ex[k] = x[k];
            if (!ex.valor) ex.valor = x.valor;
            ex.historial = (ex.historial || []).slice(-30).concat([{ por: uid, en: now, nota: 'Actualizado desde el Excel de cartera' }]);
            act++;
          } else {
            d.items.push({ id: nuevoId(), ...x, neto: x.valor, archivos: [], origen: 'excel', historial: [{ por: uid, en: now, nota: 'Importado del Excel de cartera' }] });
            nuevos++;
          }
        }
      });
      $('#dlg-cart-import').close();
      toast(`Cartera importada: ${nuevos} nuevos, ${act} actualizados.`);
      render();
    } catch (e) { $('#ci-result').insertAdjacentHTML('beforeend', `<p class="err">${esc(msgGitHub(e))}</p>`); }
    btn.disabled = false; btn.textContent = 'Importar';
  });

  function descargarCartera() {
    if (!window.XLSX) return;
    const filas = [['Tipo', 'Identificación', 'Cliente', 'Comprobante', 'Fecha elaboración', 'Vencimiento', 'Valor facturado', 'Valor a recibir', 'Cobrado', 'Retenciones', 'Por cobrar', 'Estado', 'Fecha último cobro', 'Proyecto', 'Descripción', 'Observación']];
    const f = (iso) => (iso ? new Date(iso + 'T12:00:00') : '');
    for (const it of C.items.slice().sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')))) {
      filas.push([CT[it.tipo] || '', it.nit || '', it.cliente || '', it.documento || '', f(it.fecha), f(it.vence), it.valor || 0, netoDe(it), cobrado(it), retenido(it), porCobrarDe(it), CE[it.estado] || it.estado, f(ultimaFechaCobro(it)), it.proyecto || '', it.descripcion || '', it.observacion || '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(filas, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = [10, 14, 34, 14, 12, 12, 16, 16, 16, 14, 16, 12, 14, 20, 50, 40].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cartera');
    XLSX.writeFile(wb, `Cartera ODESA ${todayISO()}.xlsx`, { cellDates: true });
  }

  // Eventos de cartera
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-ctab], [data-crow], [data-cver], [data-cedit], [data-canular], #cc-estado-go, #cc-borrar, #c-btn-add, #c-btn-import, #c-btn-dl');
    if (!t) return;
    if (t.dataset.canular) { anularCobro(t.dataset.canular); return; }
    if (t.dataset.ctab) { C.tab = t.dataset.ctab; renderCartera(); return; }
    if (t.dataset.cver != null) { verDocCartera(t.dataset.cver); return; }
    if (t.dataset.cedit) { abrirCartForm(t.dataset.cedit); return; }
    if (t.id === 'cc-estado-go') { cambiarEstadoCartera(); return; }
    if (t.id === 'cc-borrar') { borrarCartera(); return; }
    if (t.id === 'c-btn-add') { abrirCartForm(); return; }
    if (t.id === 'c-btn-dl') { descargarCartera(); return; }
    if (t.id === 'c-btn-import') { $('#ci-file').value = ''; $('#ci-result').innerHTML = ''; $('#ci-go').disabled = true; $('#dlg-cart-import').showModal(); return; }
    if (t.dataset.crow) { C.openId = t.dataset.crow; C.borrar = false; renderCartDetalle(); }
  });
  document.addEventListener('submit', (ev) => { if (ev.target.id === 'cc-form') registrarCobro(ev); });
  // Si el valor recibido es menor que el saldo, preguntar si son retenciones (pago total) o un abono
  document.addEventListener('input', (ev) => {
    if (ev.target.id !== 'cc-valor') return;
    const pend = Number(ev.target.dataset.pend) || 0, v = Math.round(parseMonto(ev.target.value)) || 0;
    const dif = pend - v;
    $('#cc-dif').hidden = !(v > 0 && dif > 0);
    if (v > 0 && dif > 0) $('#cc-dif-txt').innerHTML = `Diferencia con el saldo por cobrar: <b class="num">${fmt(dif)}</b>`;
  });
  $('#dlg-cart').addEventListener('close', () => { C.openId = null; C.borrar = false; C.anular = null; });
  $('#c-q').addEventListener('input', (e) => { C.q = e.target.value; renderCartera(); });
  $('#c-tipo').addEventListener('change', (e) => { C.tipo = e.target.value; renderCartera(); });

  // Usuario técnico para la tarea automática del computador
  function renderRobot() {
    const id = Object.keys(conf.usuarios || {}).find((k) => conf.usuarios[k].rol === 'sistema');
    $('#rb-estado').textContent = id ? `✓ Ya existe el acceso “${conf.usuarios[id].usuario}”. Si perdiste el archivo, créalo de nuevo (el anterior deja de servir).` : 'Aún no hay acceso para la tarea automática.';
    mostrarError('#rb-err', '');
  }
  $('#rb-crear').addEventListener('click', async () => {
    const btn = $('#rb-crear'); btn.disabled = true;
    try {
      const usuario = 'robot-cartera';
      const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const clave = [...Cripto.aleatorio(32)].map((b) => abc[b % abc.length]).join('');
      const id = await Cripto.idUsuario(usuario);
      const u = await leerUsuarios();
      u.datos.usuarios[id] = await Cripto.envolver(rawMaestra, clave);
      conf.usuarios[id] = { usuario, nombre: 'Tarea automática de cartera', rol: 'sistema' };
      await guardarConfig();
      await guardarUsuarios(u.datos, u.sha);
      const archivo = JSON.stringify({ owner: conf.owner, repo: conf.repo, branch: conf.branch, usuario, clave }, null, 1);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([archivo], { type: 'application/json' }));
      a.download = 'robot-cartera.json';
      document.body.appendChild(a); a.click(); a.remove();
      renderRobot(); renderUsuarios();
      toast('Acceso creado. Se descargó robot-cartera.json en tu carpeta Descargas.');
    } catch (e) { mostrarError('#rb-err', msgGitHub(e)); }
    btn.disabled = false;
  });

  // ---------- avisos al celular (ntfy) ----------
  // Cuando la administradora carga pagos "Por revisar", se envía UN aviso por tanda (2 minutos sin pagos nuevos).
  // El canal es un nombre aleatorio guardado cifrado; el aviso solo dice cuántos pagos hay, sin datos sensibles.
  const NTFY = 'https://ntfy.sh';
  const ESPERA_TANDA = 2 * 60 * 1000;
  let avisoTimer = null, enviandoAviso = false;
  function urlApp() { return location.origin + location.pathname.replace(/[^/]*$/, '') + '#proveedores'; }
  async function enviarNtfy(titulo, mensaje) {
    const r = await fetch(NTFY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: conf.avisos.canal, title: titulo, message: mensaje, click: urlApp(), tags: ['moneybag'], priority: 4 }) });
    if (!r.ok) throw { status: r.status };
  }
  async function revisarAvisos() {
    if (!isAdmin || !conf || !conf.avisos || !conf.avisos.canal || enviandoAviso) return;
    const desde = conf.avisos.desde || '';
    const nuevos = S.pagos.filter((p) => p.estado === 'revisar' && !p.avisado && String(p.creado || '') >= desde);
    if (!nuevos.length) return;
    const ultimo = Math.max(...nuevos.map((p) => Date.parse(p.creado) || 0));
    const falta = ultimo + ESPERA_TANDA - Date.now();
    if (falta > 0) { clearTimeout(avisoTimer); avisoTimer = setTimeout(revisarAvisos, falta + 1000); return; }
    enviandoAviso = true;
    try {
      const n = nuevos.length, cobros = nuevos.filter((p) => p.tipoDoc).length;
      await enviarNtfy('Pagos por autorizar', `${n === 1 ? 'Hay 1 pago nuevo' : `Hay ${n} pagos nuevos`} por revisar${cobros ? ` (${cobros} de contratistas)` : ''}. Toca para abrir la app.`);
      const ids = new Set(nuevos.map((p) => p.id));
      await mutar((d) => { for (const p of d.pagos) if (ids.has(p.id)) p.avisado = true; });
    } catch (e) { /* se reintenta en la próxima sincronización */ }
    finally { enviandoAviso = false; }
  }
  function renderAvisos() {
    const a = conf.avisos;
    $('#av-off').hidden = !!a; $('#av-on').hidden = !a;
    mostrarError('#av-err', '');
    if (!a) return;
    $('#av-canal').value = a.canal;
    $('#av-wa').href = 'https://wa.me/?text=' + encodeURIComponent(`Para recibir en el celular los avisos de pagos por autorizar de ODESA:\n1) Instala la app "ntfy" (Play Store o App Store).\n2) Ábrela, toca + (Suscribirse a un tema) y escribe: ${a.canal}\n3) Toca Suscribirse. Listo.`);
  }
  $('#av-activar').addEventListener('click', async () => {
    try {
      const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
      conf.avisos = { canal: 'odesa-pagos-' + [...Cripto.aleatorio(16)].map((b) => abc[b % abc.length]).join(''), desde: new Date().toISOString() };
      await guardarConfig();
      renderAvisos(); toast('Avisos activados. Comparte el canal con tus jefes.');
    } catch (e) { delete conf.avisos; mostrarError('#av-err', msgGitHub(e)); }
  });
  $('#av-prueba').addEventListener('click', async () => {
    try { await enviarNtfy('Pagos por autorizar', 'Aviso de prueba: si ves esto, los avisos de ODESA funcionan.'); toast('Aviso de prueba enviado.'); }
    catch (e) { mostrarError('#av-err', 'No se pudo enviar el aviso. Revisa la conexión e inténtalo de nuevo.'); }
  });
  $('#av-desactivar').addEventListener('click', async () => {
    const b = $('#av-desactivar');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '¿Seguro? Toca de nuevo'; return; }
    delete b.dataset.sure; b.textContent = 'Desactivar';
    const antes = conf.avisos;
    try { delete conf.avisos; await guardarConfig(); renderAvisos(); toast('Avisos desactivados.'); }
    catch (e) { conf.avisos = antes; mostrarError('#av-err', msgGitHub(e)); }
  });

  // ---------- credenciales API de Siigo (las usa la tarea del PC) ----------
  // Semáforo: verde = la tarea del PC se conectó a Siigo con las credenciales actuales en los últimos 3 días;
  // amarillo = credenciales guardadas pero sin verificar (o verificación vieja); rojo = sin credenciales o Siigo las rechazó.
  const fechaHora = (iso) => new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\.$/, '').replace(/\s/g, ' ');
  function estadoSiigo() {
    const a = conf && conf.siigoApi;
    if (!a || !a.llave) return { nivel: 'rojo', corto: 'Siigo: sin conectar', largo: 'Sin conexión con Siigo: faltan las credenciales de la API.' };
    const ver = a.verificado || '', err = a.error && a.error.en ? a.error : null;
    if (err && err.en >= (a.guardado || '') && err.en > ver) return { nivel: 'rojo', corto: 'Siigo: error', largo: `Siigo rechazó la conexión (${fechaHora(err.en)}): ${err.msg || 'error desconocido'}. Revisa el usuario, el Partner-ID y la access key.` };
    if (!ver || ver < (a.guardado || '')) return { nivel: 'amarillo', corto: 'Siigo: por verificar', largo: 'Credenciales guardadas. Falta que la tarea del computador pruebe la conexión (se hace cada hora, con el PC encendido y Claude abierto).' };
    if (Date.now() - new Date(ver).getTime() > 3 * 864e5) return { nivel: 'amarillo', corto: 'Siigo: sin revisar', largo: `La última conexión exitosa con Siigo fue el ${fechaHora(ver)}. Enciende el computador para que la tarea la vuelva a revisar.` };
    return { nivel: 'verde', corto: 'Siigo: conectado', largo: `Conectado a Siigo. Última verificación: ${fechaHora(ver)}.` };
  }
  function pintarSiigo() {
    const b = $('#siigo-luz');
    b.hidden = !isAdmin;
    if (!isAdmin) return;
    const e = estadoSiigo();
    b.dataset.nivel = e.nivel; b.title = e.largo; b.setAttribute('aria-label', e.largo);
    b.querySelector('span').textContent = e.corto;
    const t = $('#sa-estado');
    t.dataset.nivel = e.nivel; t.innerHTML = `<i aria-hidden="true"></i><span>${esc(e.largo)}</span>`;
  }
  // Relee solo la parte de Siigo de la configuración (la actualiza la tarea del PC)
  async function refrescarSiigo() {
    try { const f = await GH.leer(R_CONFIG); if (!f) return; const c = await Cripto.descifrarJSON(maestra, f.bytes); conf.siigoApi = c.siigoApi; pintarSiigo(); } catch (e) { /* se reintenta luego */ }
  }
  $('#siigo-luz').addEventListener('click', () => openDiag());

  // ---------- Diagnóstico Siigo ----------
  // La app deja la consulta en datos/siigo-diag.enc (cifrado); la tarea del PC (siigo-api.js atender) la responde ahí mismo.
  const R_DIAG = 'datos/siigo-diag.enc';
  const SD_PARAM = {
    tercero: ['NIT o cédula (sin dígito de verificación)', 'Ej. 890102010', true],
    movimientos: ['Desde (fecha)', 'AAAA-MM-DD · vacío = últimos 7 días', false],
    comprobantes: ['Tipo de documento', 'CC (contables), FV, RC, FC · vacío = CC', false],
    centros: ['Filtrar por nombre o código', 'Ej. SUMMUS · vacío = todos', false],
    formasPago: ['Tipo de documento', 'RC, FV, FC · vacío = RC', false],
  };
  const SD_NOMBRE = { conexion: 'Probar conexión', verificarTerceros: 'Terceros de la app vs Siigo', verificarCentros: 'Centros de costo de la app vs Siigo', tercero: 'Buscar tercero', movimientos: 'Comprobantes creados', comprobantes: 'Tipos de comprobante', centros: 'Centros de costo de Siigo', impuestos: 'Impuestos', formasPago: 'Formas de pago' };
  const SD = { datos: { solicitudes: [] }, sha: null, timer: null };
  async function leerDiag() {
    const f = await GH.leer(R_DIAG);
    SD.sha = f ? f.sha : null;
    SD.datos = f ? await Cripto.descifrarJSON(maestra, f.bytes) : { solicitudes: [] };
    SD.datos.solicitudes = SD.datos.solicitudes || [];
  }
  async function mutarDiag(fn) {
    for (let i = 0; i < 4; i++) {
      await leerDiag();
      fn(SD.datos);
      try { SD.sha = await GH.escribir(R_DIAG, await Cripto.cifrarJSON(maestra, SD.datos), SD.sha); return; }
      catch (e) { if (i === 3) throw e; await new Promise((ok) => setTimeout(ok, 800)); }
    }
  }
  function tablaDiag(r) {
    const malo = /^(NO EXISTE|Inactivo|No)$/;
    return `<div class="preview"><table><thead><tr>${r.columnas.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.filas.map((f) => `<tr>${f.map((v) => `<td class="${malo.test(String(v)) ? 'mal' : /^(Sí|Conectado ✓)$/.test(String(v)) ? 'bien' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${r.columnas.length}">Sin resultados.</td></tr>`}</tbody></table></div>`;
  }
  function renderDiag() {
    const e = estadoSiigo();
    const t = $('#sd-estado'); t.dataset.nivel = e.nivel; t.innerHTML = `<i aria-hidden="true"></i><span>${esc(e.largo)}</span>`;
    const tipo = $('#sd-tipo').value, p = SD_PARAM[tipo];
    $('#sd-param-box').hidden = !p;
    if (p) { $('#sd-param-lbl').textContent = p[0]; $('#sd-param').placeholder = p[1]; }
    const lista = [...SD.datos.solicitudes].sort((a, b) => String(b.pedido).localeCompare(String(a.pedido)));
    $('#sd-lista').innerHTML = lista.length ? lista.map((s) => {
      const quien = s.porNombre ? ` · ${esc(s.porNombre)}` : '';
      const cab = `<header><b>${esc(SD_NOMBRE[s.tipo] || s.tipo)}${s.param ? ': ' + esc(s.param) : ''}</b><small>Pedida ${esc(fechaHora(s.pedido))}${quien}${s.atendido ? ' · respondida ' + esc(fechaHora(s.atendido)) : ''}</small></header>`;
      if (s.estado === 'pendiente') return `<div class="sd-item">${cab}<span class="pill st-pendiente" style="justify-self:start">Esperando al computador de la oficina…</span><div><button class="btn sm ghost" type="button" data-sdquitar="${esc(s.id)}">Cancelar</button></div></div>`;
      if (s.estado === 'error') return `<div class="sd-item">${cab}<div class="err">${esc(s.error || 'Error')}</div><div><button class="btn sm ghost" type="button" data-sdquitar="${esc(s.id)}">Quitar</button></div></div>`;
      const r = s.resultado || { columnas: [], filas: [] };
      return `<div class="sd-item">${cab}<span>${esc(r.titulo || '')}${r.nota ? ` · <small>${esc(r.nota)}</small>` : ''}</span>${tablaDiag(r)}<div><button class="btn sm ghost" type="button" data-sdquitar="${esc(s.id)}">Quitar</button></div></div>`;
    }).join('') : '<p class="rep-note">Aún no hay consultas. Elige una arriba y toca Consultar.</p>';
  }
  async function refrescarDiag() {
    try { await leerDiag(); } catch (e) { mostrarError('#sd-err', msgGitHub(e)); }
    await refrescarSiigo();
    renderDiag();
  }
  async function openDiag() {
    if (!isAdmin) return;
    mostrarError('#sd-err', '');
    renderDiag();
    $('#dlg-sdiag').showModal();
    await refrescarDiag();
    clearInterval(SD.timer);
    SD.timer = setInterval(() => { if ($('#dlg-sdiag').open) { if (SD.datos.solicitudes.some((s) => s.estado === 'pendiente')) refrescarDiag(); } else clearInterval(SD.timer); }, 20000);
  }
  $('#sd-tipo').addEventListener('change', () => { $('#sd-param').value = ''; renderDiag(); });
  $('#sd-refrescar').addEventListener('click', () => refrescarDiag());
  $('#sd-cred').addEventListener('click', () => { $('#dlg-sdiag').close(); openUsuarios(); setTimeout(() => $('#sa-form').scrollIntoView({ block: 'center', behavior: 'smooth' }), 80); });
  $('#sa-diag').addEventListener('click', () => { $('#dlg-users').close(); openDiag(); });
  $('#sd-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('#sd-err', '');
    if (!conf.siigoApi) return mostrarError('#sd-err', 'Primero guarda las credenciales de Siigo (botón Credenciales).');
    const tipo = $('#sd-tipo').value, p = SD_PARAM[tipo], param = p ? $('#sd-param').value.trim() : '';
    if (p && p[2] && !param) return mostrarError('#sd-err', 'Escribe el dato: ' + p[0] + '.');
    if (tipo === 'movimientos' && param && !/^\d{4}-\d{2}-\d{2}$/.test(param)) return mostrarError('#sd-err', 'Escribe la fecha como AAAA-MM-DD (ej. 2026-11-01).');
    const yo = conf.usuarios && conf.usuarios[uid];
    const s = { id: nuevoId(), tipo, param, estado: 'pendiente', pedido: new Date().toISOString(), porNombre: yo ? (yo.nombre || yo.usuario) : '' };
    try {
      // Se guardan solo las últimas 15 consultas
      await mutarDiag((d) => { d.solicitudes = [...d.solicitudes, s].sort((a, b) => String(b.pedido).localeCompare(String(a.pedido))).slice(0, 15); });
      renderDiag(); toast('Consulta enviada. El computador de la oficina la responderá.');
    } catch (e) { mostrarError('#sd-err', msgGitHub(e)); }
  });
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-sdquitar]');
    if (!b) return;
    try { await mutarDiag((d) => { d.solicitudes = d.solicitudes.filter((x) => x.id !== b.dataset.sdquitar); }); renderDiag(); }
    catch (e) { mostrarError('#sd-err', msgGitHub(e)); }
  });
  function renderSiigoApi() {
    const a = conf.siigoApi;
    mostrarError('#sa-err', '');
    $('#sa-llave').value = '';
    $('#sa-usuario').value = a ? a.usuario : '';
    $('#sa-partner').value = a ? a.partner : '';
    $('#sa-quitar').hidden = !a;
    pintarSiigo();
  }
  $('#sa-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const usuario = $('#sa-usuario').value.trim(), partner = $('#sa-partner').value.trim().replace(/\s+/g, ''), llave = $('#sa-llave').value.trim();
    const antes = conf.siigoApi;
    if (!usuario || !partner) return mostrarError('#sa-err', 'Escribe el usuario API y el Partner-ID.');
    if (!llave && !antes) return mostrarError('#sa-err', 'Pega la access key.');
    try {
      conf.siigoApi = { usuario, partner, llave: llave || antes.llave, guardado: new Date().toISOString(), ...(antes && antes.verificado ? { verificado: antes.verificado } : {}) };
      await guardarConfig(); renderSiigoApi(); toast('Credenciales de Siigo guardadas.');
    } catch (e) { conf.siigoApi = antes; mostrarError('#sa-err', msgGitHub(e)); }
  });
  $('#sa-quitar').addEventListener('click', async () => {
    const b = $('#sa-quitar');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '¿Seguro? Toca de nuevo'; return; }
    delete b.dataset.sure; b.textContent = 'Quitar';
    const antes = conf.siigoApi;
    try { delete conf.siigoApi; await guardarConfig(); renderSiigoApi(); toast('Credenciales de Siigo quitadas.'); }
    catch (e) { conf.siigoApi = antes; mostrarError('#sa-err', msgGitHub(e)); }
  });

  // ---------- cajas menores ----------
  // Cada relación llega del enlace del responsable, la tarea del PC lee los soportes y la deja como un pago
  // tipoDoc "caja" (Por revisar) con sus soportes. Se aprueba completa; el reembolso es el pago (13300502 vs banco)
  // y la legalización se exporta a Siigo como comprobante 14.
  const CJ_TABS = [['revisar', 'Por revisar'], ['pendiente', 'En pagos: por aprobar'], ['aprobado', 'En pagos: aprobadas'], ['pagado', 'Reembolsadas'], ['rechazado', 'Rechazadas'], ['todos', 'Todas']];
  const CJ_GUIA = {
    revisar: 'Cajas que enviaron los responsables desde el celular. Revisa los soportes y, si todo está bien, toca <b>Revisada: pasar a pagos</b>: la caja aparece en Proveedores como un pago más.',
    pendiente: 'Cajas ya revisadas que están en <b>Proveedores</b> esperando aprobación.',
    aprobado: 'Cajas aprobadas en Proveedores que falta pagarle al responsable.',
    pagado: 'Cajas ya pagadas al responsable. En cada una puedes descargar la relación en PDF.',
    rechazado: 'Cajas devueltas al responsable.', todos: 'Todas las cajas menores, de la más nueva a la más antigua.',
  };
  const CJ_CUENTA = { '22050501': 'Factura a nombre de ODESA', '51959502': 'Factura a nombre de otro', '13300501': 'Recibo / cuenta de cobro' };
  const CJ = { tab: 'revisar', editando: null };
  const ddmmDe = (iso) => { const m = String(iso || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? m[2] + m[1] : ''; };
  const cajasDe = () => S.pagos.filter((p) => p.tipoDoc === 'caja');

  function renderCajas() {
    if (S.view !== 'cajas') return;
    const todas = cajasDe();
    const resp = (conf && conf.cajas && conf.cajas.responsables) || [];
    if (CJ.tab === 'resp' && !isAdmin) CJ.tab = 'revisar';
    const tabs = isAdmin ? [...CJ_TABS, ['resp', 'Responsables']] : CJ_TABS;
    $('#cj-tabs').innerHTML = tabs.map(([k, l]) => `<button class="tab" role="tab" type="button" data-cjtab="${k}" aria-selected="${CJ.tab === k}">${l}<span class="c">${k === 'resp' ? resp.filter((r) => r.activo !== false).length : todas.filter((p) => k === 'todos' || p.estado === k).length}</span></button>`).join('');
    // Responsables: solo en su propia pestaña (administradora)
    const verResp = CJ.tab === 'resp';
    $('#cj-resp').hidden = !verResp;
    $('#cj-list').hidden = verResp;
    $('#cj-siigo').hidden = verResp || !isAdmin || !window.XLSX;
    if (verResp) {
      $('#cc-lista').innerHTML = siigoConf().centros.map((c) => `<option value="${esc(c.codigo + ' · ' + c.nombre)}"></option>`).join('');
      $('#cj-resp-lista').innerHTML = resp.length ? resp.map((r) => {
        const n = todas.filter((p) => p.caja && p.caja.responsableId === r.id).length;
        return `<li><span class="who"><b>${esc(r.nombre)}</b><small>C.C. ${esc(r.cedula)}${r.cc ? ' · ' + esc(ccTexto(r.cc)) : ''} · ${n} ${n === 1 ? 'caja enviada' : 'cajas enviadas'}${r.activo === false ? ' · enlace desactivado' : ''}</small></span>
        <span class="decide" style="flex:none">${r.activo === false ? `<button class="btn sm" type="button" data-cjact="${r.id}">Reactivar</button>` : `<button class="btn sm" type="button" data-cjcopiar="${r.id}">Copiar enlace</button><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Hola ${r.nombre.split(' ')[0]}. Este es tu enlace para enviar la caja menor a ODESA desde el celular (toma una foto de cada soporte y envía la relación): ${enlaceCaja(r)}`)}">WhatsApp</a><button class="btn sm danger" type="button" data-cjdes="${r.id}">Desactivar</button>`}</span></li>`;
      }).join('') : '<li><span class="who"><small>Aún no hay responsables. Agrégalos abajo.</small></span></li>';
      return;
    }
    const arr = todas.filter((p) => CJ.tab === 'todos' || p.estado === CJ.tab).sort((a, b) => String(b.creado || '').localeCompare(String(a.creado || '')));
    const n = (st) => todas.filter((p) => p.estado === st).length;
    const paso = { revisar: 2, pendiente: 3, aprobado: 3, pagado: 4 }[CJ.tab] || 0;
    const P4 = [['El responsable la envía', 'Desde su celular, con la foto de cada soporte.', ''], ['Contabilidad la revisa', 'Mira los soportes y corrige datos si falta algo.', `${n('revisar')} por revisar`], ['Pasa a Proveedores', 'Queda pendiente y entra a la lista de pagos para aprobar.', `${n('pendiente') + n('aprobado')} en pagos`], ['Se reembolsa', 'Al pagarla en Proveedores, aquí queda reembolsada.', `${n('pagado')} reembolsadas`]];
    const camino = `<section class="cj-camino" aria-label="Cómo funciona una caja menor"><h3>El camino de una caja menor</h3><ol>${P4.map(([t, d, c], i) => `<li class="${i + 1 === paso ? 'act' : i + 1 < paso ? 'hecho' : ''}"><b><span>${i + 1}</span>${t}</b><small>${d}</small>${c ? `<em>${c}</em>` : ''}</li>`).join('')}</ol></section>
      <p class="proy-intro">${CJ_GUIA[CJ.tab] || ''}</p>`;
    $('#cj-list').innerHTML = camino + (arr.length ? arr.map((p) => {
      const st = ESTADOS[p.estado] ? p.estado : 'revisar';
      const c = p.caja || {};
      const malos = (p.soportes || []).filter((s) => s.revisar).length;
      return `<article class="row s-${st}" data-row="${p.id}" tabindex="0">
        <div class="r-main"><div class="r-prov">Caja No. ${esc(c.numero || '')} · ${esc(c.responsable || p.proveedor)}</div><div class="r-sub">${(p.soportes || []).length} soportes · enviada el ${esc(fmtDate(c.fecha || p.vence))}${malos ? ` · <span class="warn" style="color:var(--warn)">${malos} por revisar datos</span>` : ''}${chipsSiigo(p)}</div></div>
        <div class="r-due"><span>${etiquetaDecision(p) ? esc(etiquetaDecision(p)) : ''}</span></div>
        <div class="r-amt">${fmt(p.valor)}</div>
        <div class="r-act"><span class="pill st-${st}">${st === 'pagado' ? 'Reembolsada' : st === 'pendiente' ? 'En pagos' : ESTADOS[st].label}</span>${st === 'revisar' && isAdmin ? `<div class="decide">${decisionButtons(p, true)}</div>` : ''}</div>
      </article>`;
    }).join('') : `<div class="empty"><h3>No hay cajas en este estado</h3><p>${isAdmin ? 'Cuando un responsable envíe su relación desde su enlace, aparecerá aquí con sus soportes leídos.' : 'Aquí aparecen las relaciones de caja menor.'}</p></div>`);
  }
  function enlaceCaja(r) {
    const t = Cripto.b64(Cripto.enc.encode(JSON.stringify({ i: r.id, n: r.nombre, s: r.secreto }))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'caja.html#' + t;
  }
  $('#cj-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nombre = $('#cj-nombre').value.trim().replace(/\s+/g, ' '), cedula = $('#cj-cedula').value.replace(/\D/g, '');
    if (nombre.split(' ').length < 2) return mostrarError('#cj-err', 'Escribe nombre y apellido.');
    if (cedula.length < 5) return mostrarError('#cj-err', 'Escribe la cédula (solo números).');
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    const r = { id: nuevoId().slice(0, 10), nombre, cedula, cc: ccDeInput($('#cj-cc').value), secreto: [...Cripto.aleatorio(16)].map((b) => abc[b % abc.length]).join(''), activo: true, creado: new Date().toISOString() };
    const antes = conf.cajas;
    conf.cajas = { ...(conf.cajas || {}), responsables: [...((conf.cajas && conf.cajas.responsables) || []), r] };
    try { await guardarConfig(); $('#cj-form').reset(); mostrarError('#cj-err', ''); renderCajas(); toast(`Listo. Envíale a ${nombre.split(' ')[0]} su enlace por WhatsApp.`); }
    catch (e) { conf.cajas = antes; mostrarError('#cj-err', msgGitHub(e)); }
  });
  async function cambiarResponsable(id, activo) {
    const antes = conf.cajas;
    conf.cajas = { ...conf.cajas, responsables: conf.cajas.responsables.map((r) => (r.id === id ? { ...r, activo } : r)) };
    try { await guardarConfig(); renderCajas(); toast(activo ? 'Enlace reactivado.' : 'Enlace desactivado: ya no podrá enviar cajas.'); }
    catch (e) { conf.cajas = antes; toast(msgGitHub(e)); }
  }

  // Soportes dentro del detalle de la relación
  function renderSoportesCaja(p) {
    const sops = p.soportes || [];
    const edit = isAdmin && CJ.editando === p.id;
    const filas = sops.map((s, i) => edit ? `<tr>
        <td><button class="btn sm ghost" type="button" data-cjfoto="${i}">Ver</button></td>
        <td><select data-cjk="cuenta" data-cji="${i}">${Object.entries(CJ_CUENTA).map(([k, l]) => `<option value="${k}"${s.cuenta === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
        <td><input data-cjk="tercero" data-cji="${i}" value="${esc(s.tercero)}"></td>
        <td><input data-cjk="nit" data-cji="${i}" value="${esc(s.nit)}" inputmode="numeric" size="11"></td>
        <td><input data-cjk="prefijo" data-cji="${i}" value="${esc(s.prefijo)}" size="5"></td>
        <td><input data-cjk="numero" data-cji="${i}" value="${esc(s.numero)}" size="8"></td>
        <td><input type="date" data-cjk="fecha" data-cji="${i}" value="${esc(s.fecha)}"></td>
        <td><input data-cjk="descripcion" data-cji="${i}" value="${esc(s.descripcion)}"></td>
        <td><input data-cjk="valor" data-cji="${i}" value="${new Intl.NumberFormat('es-CO').format(s.valor || 0)}" inputmode="numeric" size="10"></td></tr>`
      : `<tr${s.revisar ? ' style="background:var(--warn-soft)"' : ''}><td><button class="btn sm ghost" type="button" data-cjfoto="${i}">Ver</button></td><td>${esc(s.tercero || '—')}<br><small style="color:var(--muted)">${esc(CJ_CUENTA[s.cuenta] || s.cuenta)} · ${esc(s.cuenta)}</small></td><td>${esc(s.nit || '—')}</td><td>${esc((s.prefijo || '') + '-' + (s.numero || ''))}</td><td>${esc(s.fecha ? fmtDate(s.fecha) : '—')}</td><td>${esc(s.descripcion || s.nota || '')}</td><td class="n">${fmt(s.valor)}</td></tr>`).join('');
    const cab = edit ? '<tr><th></th><th>Tipo</th><th>Tercero</th><th>NIT / C.C.</th><th>Pref.</th><th>Núm.</th><th>Fecha</th><th>Descripción</th><th>Valor</th></tr>'
      : '<tr><th></th><th>Tercero</th><th>NIT / C.C.</th><th>Documento</th><th>Fecha</th><th>Descripción</th><th style="text-align:right">Valor</th></tr>';
    const malos = sops.filter((s) => s.revisar).length;
    return `<div style="display:grid;gap:8px">
      <span class="section-lbl">Soportes (${sops.length})${malos ? ` · <span style="color:var(--warn)">${malos} con datos incompletos</span>` : ''}</span>
      <div class="preview"><table>${cab}${filas}<tr><td colspan="${edit ? 8 : 6}"><b>Total a reembolsar</b></td><td class="n"><b>${fmt(sops.reduce((t, s) => t + (Number(s.valor) || 0), 0))}</b></td></tr></table></div>
      <div id="cj-visor"></div>
      <div class="decide" style="justify-content:flex-start">
        <button class="btn sm" type="button" data-cjpdf="${p.id}">Descargar relación en PDF</button>
        ${isAdmin ? (edit ? `<button class="btn sm primary" type="button" data-cjguardar="${p.id}">Guardar cambios</button><button class="btn sm" type="button" data-cjcancel="1">Cancelar</button>` : `<button class="btn sm" type="button" data-cjeditar="${p.id}">Corregir datos de los soportes</button>`) : ''}
      </div></div>`;
  }
  async function bytesSoporte(s) {
    const f = await GH.leer(rFactura(s.foto));
    if (!f) throw { status: 404 };
    return Cripto.descifrar(maestra, f.bytes);
  }
  async function verSoporte(i) {
    const p = S.pagos.find((x) => x.id === S.openId);
    const s = p && (p.soportes || [])[Number(i)];
    if (!s) return;
    const visor = $('#cj-visor');
    visor.innerHTML = '<div class="invoice none">Descifrando el soporte…</div>';
    try {
      if (!facturaUrl[s.foto]) facturaUrl[s.foto] = URL.createObjectURL(new Blob([await bytesSoporte(s)], { type: s.fotoTipo || 'image/jpeg' }));
      const url = facturaUrl[s.foto], pdf = (s.fotoTipo || '').includes('pdf');
      visor.innerHTML = `<div class="invoice">${pdf ? `<iframe src="${url}" title="Soporte ${Number(i) + 1}"></iframe>` : `<img src="${url}" alt="Soporte ${Number(i) + 1}">`}<div class="inv-bar"><span>Soporte ${Number(i) + 1}${s.nota ? ' · ' + esc(s.nota) : ''}</span><a class="btn sm" href="${url}" target="_blank" rel="noopener">Abrir en pestaña nueva</a></div></div>`;
    } catch (e) { visor.innerHTML = '<div class="invoice none">No se pudo abrir el soporte.</div>'; }
  }
  async function guardarSoportes(id) {
    const p = S.pagos.find((x) => x.id === id);
    if (!p) return;
    const sops = (p.soportes || []).map((s) => ({ ...s }));
    document.querySelectorAll('[data-cjk]').forEach((el) => {
      const s = sops[Number(el.dataset.cji)], k = el.dataset.cjk;
      if (!s) return;
      s[k] = k === 'valor' ? Math.round(parseMonto(el.value)) || 0 : k === 'nit' || k === 'numero' ? el.value.replace(/\D/g, '') : k === 'prefijo' ? el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : el.value.trim();
    });
    for (const s of sops) {
      s.tipoSoporte = s.cuenta === '13300501' ? 'recibo' : 'fe';
      if (s.tipoSoporte === 'recibo') { s.prefijo = 'RC'; s.numero = ddmmDe(s.fecha); }
      s.revisar = !s.nit || !(s.valor > 0) || !s.numero;
    }
    const total = sops.reduce((t, s) => t + (Number(s.valor) || 0), 0);
    const now = new Date().toISOString();
    try {
      await mutar((d) => {
        const x = d.pagos.find((y) => y.id === id);
        if (!x) return false;
        x.soportes = sops; x.valor = total;
        x.concepto = `Caja menor No. ${(x.caja || {}).numero || ''} – ${sops.length} soportes`;
        x.historial = (x.historial || []).slice(-24).concat([{ estado: x.estado, por: uid, en: now, nota: `Soportes corregidos · total ${fmt(total)}` }]);
      });
      CJ.editando = null; toast('Soportes actualizados.'); render();
    } catch (e) { toast(msgGitHub(e)); }
  }

  // PDF de la relación: tabla de soportes + las fotos
  async function pdfRelacion(id) {
    const p = S.pagos.find((x) => x.id === id);
    if (!p) return;
    toast('Generando el PDF de la relación…');
    try {
      await cargarScriptApp(JSPDF);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'letter' });
      const c = p.caja || {}, izq = 14, W = 215.9;
      let y = 18;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(`RELACIÓN DE CAJA MENOR No. ${c.numero || ''}`, W / 2, y, { align: 'center' }); y += 7;
      doc.setFontSize(10); doc.setFont('helvetica', 'normal');
      doc.text(`ODESA CARIBE S.A.S. · NIT 900.409.543-1`, W / 2, y, { align: 'center' }); y += 9;
      doc.text(`Responsable: ${c.responsable || p.proveedor} · C.C. ${c.cedula || p.nit}`, izq, y); y += 5;
      doc.text(`Fecha de la relación: ${fmtDate(c.fecha || p.vence)} · Radicado ${p.radicado || ''} · Estado: ${ESTADOS[p.estado] ? ESTADOS[p.estado].label : p.estado}`, izq, y); y += 8;
      const cols = [[izq, 'N.º'], [izq + 9, 'Tercero'], [izq + 62, 'NIT / C.C.'], [izq + 88, 'Documento'], [izq + 112, 'Fecha'], [izq + 132, 'Descripción']];
      const fila = (vals, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); cols.forEach(([x], k) => doc.text(String(vals[k] || '').slice(0, k === 1 ? 30 : k === 5 ? 30 : 16), x, y)); doc.text(String(vals[6] || ''), W - 14, y, { align: 'right' }); y += 5; };
      doc.setFontSize(8.5);
      fila(['N.º', 'Tercero', 'NIT / C.C.', 'Documento', 'Fecha', 'Descripción', 'Valor'], true);
      doc.line(izq, y - 3.5, W - 14, y - 3.5);
      (p.soportes || []).forEach((s, i) => { if (y > 260) { doc.addPage(); y = 18; } fila([i + 1, s.tercero, s.nit, `${s.prefijo}-${s.numero}`, s.fecha ? fmtDate(s.fecha) : '', s.descripcion || s.nota, fmt(s.valor)]); });
      doc.line(izq, y - 3.5, W - 14, y - 3.5);
      doc.setFont('helvetica', 'bold'); doc.text('TOTAL A REEMBOLSAR', izq, y + 1); doc.text(fmt(p.valor), W - 14, y + 1, { align: 'right' });
      const ap = aprobacion(p);
      y += 10; doc.setFont('helvetica', 'normal');
      if (ap) doc.text(`Aprobada por ${personName(ap.por) === 'Tú' ? ((conf.usuarios[uid] || {}).nombre || '') : personName(ap.por)} el ${dtFmt.format(new Date(ap.en))}`, izq, y);
      for (const [i, s] of (p.soportes || []).entries()) {
        doc.addPage();
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
        doc.text(`Soporte ${i + 1} · ${s.tercero || ''} · ${s.prefijo}-${s.numero} · ${fmt(s.valor)}`, izq, 14);
        if ((s.fotoTipo || '').includes('pdf')) { doc.setFont('helvetica', 'normal'); doc.text('Soporte en PDF: ábrelo desde la aplicación (Cajas menores → Ver).', izq, 24); continue; }
        try {
          const bytes = await bytesSoporte(s);
          const url = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(new Blob([bytes], { type: 'image/jpeg' })); });
          const pr = doc.getImageProperties(url);
          let w = W - 28, h = w * pr.height / pr.width;
          if (h > 245) { h = 245; w = h * pr.width / pr.height; }
          doc.addImage(url, 'JPEG', izq, 20, w, h, undefined, 'FAST');
        } catch (e) { doc.text('No se pudo cargar la imagen de este soporte.', izq, 24); }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(doc.output('blob'));
      a.download = `Relación caja menor No. ${c.numero || ''} - ${c.responsable || ''}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast('No se pudo generar el PDF.'); }
  }

  // ---------- Subir a Siigo (por la API, a través del computador de la oficina) ----------
  // La app deja los comprobantes armados en datos/siigo-envios.enc; la tarea del PC (siigo-api.js atender, cada 2 min)
  // valida terceros/centros de costo/cuadre, los crea en Siigo y marca los pagos o cajas como exportados.
  const R_ENVIOS = 'datos/siigo-envios.enc';
  const SE = { datos: { envios: [] }, sha: null, timer: null };
  function botonSubir(sel, deshabilitar, texto) {
    const b = $(sel);
    delete b.dataset.sure;
    b.textContent = texto;
    b.disabled = deshabilitar || !(conf && conf.siigoApi);
    b.title = conf && conf.siigoApi ? '' : 'Primero guarda las credenciales de Siigo (Usuarios → Conexión con Siigo)';
  }
  async function leerEnvios() {
    const f = await GH.leer(R_ENVIOS);
    SE.sha = f ? f.sha : null;
    SE.datos = f ? await Cripto.descifrarJSON(maestra, f.bytes) : { envios: [] };
    SE.datos.envios = SE.datos.envios || [];
  }
  async function mutarEnvios(fn) {
    for (let i = 0; i < 4; i++) {
      await leerEnvios();
      if (fn(SE.datos) === false) return false;
      try { SE.sha = await GH.escribir(R_ENVIOS, await Cripto.cifrarJSON(maestra, SE.datos), SE.sha); return true; }
      catch (e) { if (i === 3) throw e; await new Promise((ok) => setTimeout(ok, 800)); }
    }
  }
  const CAMPO_ENVIO = { siigo: 'siigoEnvio', siigo14: 'siigoEnvio14' };
  async function subirASiigo(marca, comps) {
    const campo = CAMPO_ENVIO[marca], id = nuevoId(), ids = new Set(comps.flatMap((c) => c.ids)), ahora = new Date().toISOString();
    // 1) Bloquear los pagos/cajas para que no se exporten ni suban dos veces
    let ocupado = false;
    await mutar((d) => {
      ocupado = d.pagos.some((x) => ids.has(x.id) && (x[campo] || (marca === 'siigo14' ? x.siigo14 : x.siigo) && !$(marca === 'siigo14' ? '#s14-incluir' : '#sg-incluir').checked));
      if (ocupado) return false;
      for (const x of d.pagos) if (ids.has(x.id)) x[campo] = { id, en: ahora };
    });
    if (ocupado) throw new Error('Alguno de estos ya se está subiendo o ya se exportó. Cierra y abre la ventana de nuevo.');
    // 2) Dejar el envío en la cola
    const yo = conf.usuarios && conf.usuarios[uid];
    const envio = { id, estado: 'pendiente', pedido: ahora, porNombre: yo ? (yo.nombre || yo.usuario) : '', marca, tipo: comps[0].tipo, comprobantes: comps, hechos: [] };
    try { await mutarEnvios((d) => { d.envios = [envio, ...d.envios].slice(0, 30); }); }
    catch (e) { try { await mutar((d) => { for (const x of d.pagos) if (x[campo] && x[campo].id === id) delete x[campo]; }); } catch (e2) {} throw e; }
    vigilarEnvios();
  }
  async function cancelarEnvio(id) {
    let marca = null;
    const ok = await mutarEnvios((d) => {
      const e = d.envios.find((x) => x.id === id);
      if (!e || e.estado !== 'pendiente') return false;
      marca = e.marca; d.envios = d.envios.filter((x) => x.id !== id);
    });
    if (!ok) throw new Error('Ese envío ya lo está procesando el computador; espera el resultado.');
    const campo = CAMPO_ENVIO[marca];
    await mutar((d) => { for (const x of d.pagos) if (x[campo] && x[campo].id === id) delete x[campo]; });
  }
  function renderEnvios() {
    for (const [sel, marca] of [['#sg-envios', 'siigo'], ['#s14-envios', 'siigo14']]) {
      const lista = SE.datos.envios.filter((e) => e.marca === marca).slice(0, 5);
      $(sel).innerHTML = lista.length ? `<span class="section-lbl">Subidas a Siigo</span>${lista.map((e) => {
        const n = e.comprobantes.length, cab = `<header><b>${n} ${n === 1 ? 'comprobante' : 'comprobantes'} ${e.tipo}</b><small>Pedido ${esc(fechaHora(e.pedido))}${e.porNombre ? ' · ' + esc(e.porNombre) : ''}${e.terminado ? ' · terminado ' + esc(fechaHora(e.terminado)) : ''}</small></header>`;
        const hechos = (e.hechos || []).map((h) => h.nombre || `${e.tipo}-${h.numero}`);
        let cuerpo;
        if (e.estado === 'pendiente') cuerpo = `<span class="pill st-pendiente" style="justify-self:start">Esperando al computador de la oficina…</span><div><button class="btn sm ghost" type="button" data-secancel="${esc(e.id)}">Cancelar</button></div>`;
        else if (e.estado === 'enviando') cuerpo = `<span class="pill st-pendiente" style="justify-self:start">Creando en Siigo…${hechos.length ? ' ' + hechos.length + ' de ' + n : ''}</span>`;
        else if (e.estado === 'listo') cuerpo = `<span class="sd-ok">✓ Creado en Siigo: ${esc(hechos.join(', '))}</span>`;
        else cuerpo = `<span class="sd-mal">✗ No se subió${hechos.length ? ' completo' : ''}. Corrige y vuelve a subir.</span>${hechos.length ? `<span class="sd-ok">Sí se crearon: ${esc(hechos.join(', '))}</span>` : ''}<ul>${(e.problemas || []).map((p) => `<li>${esc(p)}</li>`).join('')}${e.error ? `<li>${esc(e.error)}</li>` : ''}</ul>`;
        return `<div class="sd-item">${cab}${cuerpo}</div>`;
      }).join('')}` : '';
    }
  }
  function vigilarEnvios() {
    clearInterval(SE.timer);
    const tick = async () => {
      const abierto = $('#dlg-siigo').open || $('#dlg-siigo14').open;
      if (!abierto) { clearInterval(SE.timer); return; }
      const habia = SE.datos.envios.filter((e) => e.estado === 'pendiente' || e.estado === 'enviando').map((e) => e.id);
      try { await leerEnvios(); } catch (e) { return; }
      renderEnvios();
      const termino = habia.some((id) => { const e = SE.datos.envios.find((x) => x.id === id); return !e || e.estado === 'listo' || e.estado === 'error'; });
      if (termino) { try { await sincronizar(); } catch (e) {} if ($('#dlg-siigo').open) renderSiigo(); if ($('#dlg-siigo14').open) renderSiigo14(); }
      if (!SE.datos.envios.some((e) => e.estado === 'pendiente' || e.estado === 'enviando')) clearInterval(SE.timer);
    };
    renderEnvios();
    SE.timer = setInterval(tick, 15000);
  }
  async function abrirEnvios() { try { await leerEnvios(); } catch (e) { /* sin envíos aún */ } renderEnvios(); vigilarEnvios(); }
  async function clickSubir(btnSel, errSel, marca, armar) {
    const b = $(btnSel);
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.dataset.txt = b.textContent; b.textContent = '¿Crear en Siigo? Toca de nuevo para confirmar'; setTimeout(() => { if (b.dataset.sure) { delete b.dataset.sure; b.textContent = b.dataset.txt; } }, 6000); return; }
    delete b.dataset.sure;
    const comps = armar();
    if (!comps || !comps.length) return;
    b.disabled = true; b.textContent = 'Enviando a la cola…';
    try {
      await subirASiigo(marca, comps);
      toast(`Listo: ${comps.length} ${comps.length === 1 ? 'comprobante quedó' : 'comprobantes quedaron'} en cola. El computador de la oficina los crea en Siigo en 1–2 minutos.`);
      render();
    } catch (e) { mostrarError(errSel, e.message && !e.status ? e.message : msgGitHub(e)); }
    if (marca === 'siigo') renderSiigo(); else renderSiigo14();
    renderEnvios();
  }
  $('#sg-subir').addEventListener('click', () => clickSubir('#sg-subir', '#sg-err', 'siigo', () => {
    const filas = filasSiigo(), sc = siigoConf(), inicial = Number($('#sg-consec').value);
    if (!(inicial > 0) || !filas.length || filas.some((f) => f.errores.length)) return null;
    return comprobantesPagos(filas, inicial, Number(sc.tipo) || 11, sc);
  }));
  $('#s14-subir').addEventListener('click', () => clickSubir('#s14-subir', '#s14-err', 'siigo14', () => {
    const arr = cajasParaSiigo();
    return arr.length ? comprobantesCajas(arr, 0) : null;
  }));
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-secancel]');
    if (!b) return;
    try { await cancelarEnvio(b.dataset.secancel); toast('Envío cancelado.'); render(); }
    catch (e) { toast(e.message || 'No se pudo cancelar.'); }
    if ($('#dlg-siigo').open) renderSiigo(); if ($('#dlg-siigo14').open) renderSiigo14();
    try { await leerEnvios(); } catch (e) {} renderEnvios();
  });

  // ---------- Retenciones y documento soporte (cuentas de cobro de trabajos de contratistas) ----------
  // La app arma el DS (valor, retenciones, cuenta, centro de costo y anticipos a cruzar) y lo deja en la cola
  // datos/siigo-envios.enc (marca "ds"); el computador lo crea en Siigo (/v1/purchases) y, si hay anticipos,
  // un comprobante 20 que cruza 22050501 (DS) contra 13300501 (anticipo). Luego la cuenta queda por el neto.
  const DSV = { id: null };
  const numeroDe = (v) => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
  const reteDe = (v) => { if (!v) return null; const [id, nombre, pct] = v.split('|'); return { id: Number(id), nombre, pct: Number(pct) }; };
  function anticiposDe(p) {
    const nit = String(p.nit || '').replace(/\D/g, '');
    // Anticipo escrito a mano al subir la cuenta de cobro (no está en la app como pago)
    const am = p.anticipoManual && p.anticipoManual.valor > 0
      ? [{ a: { id: 'man-' + p.id, factura: p.anticipoManual.documento, vence: '' }, saldo: Math.round(p.anticipoManual.valor), prefijo: p.anticipoManual.prefijo, numero: p.anticipoManual.numero, manual: true }] : [];
    if (!nit) return am;
    return am.concat(S.pagos.filter((a) => a.tipoDoc === 'anticipo' && a.estado === 'pagado' && String(a.nit || '').replace(/\D/g, '') === nit)
      .map((a) => { const cruzado = (a.cruces || []).reduce((s, c) => s + (Number(c.valor) || 0), 0); const { prefijo, numero } = partirFactura(a.factura); return { a, saldo: Math.max(0, Math.round(Number(a.valor) || 0) - cruzado), prefijo, numero }; })
      .filter((x) => x.saldo > 0));
  }
  function calcDS() {
    const valor = numeroDe($('#ds-valor').value);
    const rets = [reteDe($('#ds-rete').value), reteDe($('#ds-otra').value)].filter(Boolean).map((r) => ({ ...r, valor: Math.round(valor * r.pct / 100) }));
    const totalRet = rets.reduce((s, r) => s + r.valor, 0);
    const neto = valor - totalRet;
    const cruces = [...document.querySelectorAll('[data-dsant]')].filter((c) => c.checked).map((c) => {
      const x = anticiposDe(S.pagos.find((y) => y.id === DSV.id)).find((y) => y.a.id === c.dataset.dsant);
      const inp = document.querySelector(`[data-dsantv="${c.dataset.dsant}"]`);
      return x ? { anticipoId: x.a.id, prefijo: x.prefijo, numero: x.numero, vence: x.a.vence || fechaPagoDe(x.a) || '', valor: Math.min(numeroDe(inp && inp.value), x.saldo), saldo: x.saldo, factura: x.a.factura } : null;
    }).filter(Boolean);
    const totalCruces = cruces.reduce((s, c) => s + c.valor, 0);
    return { valor, rets, totalRet, neto, cruces, totalCruces, porPagar: neto - totalCruces };
  }
  function renderResumenDS() {
    const c = calcDS();
    $('#ds-resumen').innerHTML = `<div class="preview"><table><tbody>
      <tr><td>Valor de la cuenta de cobro</td><td class="n">${fmt(c.valor)}</td></tr>
      ${c.rets.map((r) => `<tr><td>− ${esc(r.nombre)}</td><td class="n">${fmt(r.valor)}</td></tr>`).join('')}
      <tr><td><b>Neto del documento soporte</b></td><td class="n"><b>${fmt(c.neto)}</b></td></tr>
      ${c.cruces.map((x) => `<tr><td>− Anticipo ${esc(x.factura || '')} cruzado</td><td class="n">${fmt(x.valor)}</td></tr>`).join('')}
      <tr><td><b>Queda por pagar al contratista</b></td><td class="n"><b>${fmt(c.porPagar)}</b></td></tr>
    </tbody></table></div>`;
    const b = $('#ds-enviar'); delete b.dataset.sure; b.textContent = 'Enviar documento soporte a Siigo';
  }
  async function estadoDS(p) {
    try { await leerEnvios(); } catch (e) { return; }
    const e = SE.datos.envios.filter((x) => x.marca === 'ds' && x.ds && x.ds.pagoId === p.id)[0];
    if (!e) { $('#ds-estado').innerHTML = ''; return; }
    const hechos = (e.hechos || []).map((h) => h.nombre).filter(Boolean);
    const cab = `<header><b>Envío a Siigo</b><small>Pedido ${esc(fechaHora(e.pedido))}${e.porNombre ? ' · ' + esc(e.porNombre) : ''}</small></header>`;
    let cuerpo;
    if (e.estado === 'pendiente') cuerpo = '<span class="pill st-pendiente" style="justify-self:start">Esperando al computador de la oficina…</span>';
    else if (e.estado === 'enviando') cuerpo = '<span class="pill st-pendiente" style="justify-self:start">Creando en Siigo…</span>';
    else if (e.estado === 'listo') cuerpo = `<span class="sd-ok">✓ Creado en Siigo: ${esc(hechos.join(' y '))}</span>`;
    else cuerpo = `<span class="sd-mal">✗ No se completó${hechos.length ? ` (sí se creó: ${esc(hechos.join(', '))})` : ''}.</span><ul>${(e.problemas || []).map((x) => `<li>${esc(x)}</li>`).join('')}${e.error ? `<li>${esc(e.error)}</li>` : ''}</ul>`;
    $('#ds-estado').innerHTML = `<div class="sd-item">${cab}${cuerpo}</div>`;
  }
  async function openDS(id) {
    const p = S.pagos.find((x) => x.id === id);
    if (!p || !isAdmin) return;
    DSV.id = id;
    mostrarError('#ds-err', '');
    // Lista de cuentas del PUC (la carga la tarea del computador en la configuración)
    try { const f = await GH.leer(R_CONFIG); if (f) { const c = await Cripto.descifrarJSON(maestra, f.bytes); if (c.siigo && c.siigo.cuentasCosto) conf.siigo = { ...(conf.siigo || {}), cuentasCosto: c.siigo.cuentasCosto }; } } catch (e) {}
    const cuentas = (conf.siigo && conf.siigo.cuentasCosto) || [];
    $('#ds-cuentas').innerHTML = cuentas.map(([c, n]) => `<option value="${esc(c + ' · ' + n)}"></option>`).join('');
    $('#cc-lista').innerHTML = siigoConf().centros.map((c) => `<option value="${esc(c.codigo + ' · ' + c.nombre)}"></option>`).join('');
    const { prefijo, numero } = partirFactura(p.factura);
    $('#ds-quien').innerHTML = `<b>${esc(p.proveedor || '')}</b> · C.C./NIT ${esc(p.nit || 'sin número')} · cuenta de cobro ${esc(p.factura || '—')}${p.contratista ? '' : ''}`;
    $('#ds-valor').value = Math.round(Number(p.valorBruto || p.valor) || 0).toLocaleString('es-CO');
    $('#ds-fecha').value = todayISO();
    $('#ds-desc').value = (p.concepto || '').slice(0, 300);
    const ult = conf.siigo && conf.siigo.ultimaCuentaDS;
    const sug = ult || (cuentas.find(([c]) => c === '61301001') ? '61301001' : '');
    const cu = cuentas.find(([c]) => c === sug);
    $('#ds-cuenta').value = cu ? `${cu[0]} · ${cu[1]}` : sug;
    $('#ds-cc').value = p.cc ? ccTexto(p.cc) : '';
    $('#ds-rete').value = ''; $('#ds-otra').value = '';
    // Ya pagada: solo se cruza el anticipo escrito en la cuenta de cobro (se descontó al pagar); el valor pagado no cambia
    const ants = p.estado === 'pagado' ? anticiposDe(p).filter((x) => x.manual) : anticiposDe(p);
    $('#ds-anticipos').innerHTML = p.estado === 'pagado' && !ants.length ? `<p class="sync" style="margin:0">Esta cuenta de cobro ya está <b>pagada</b>${fechaPagoDe(p) ? ' (' + esc(fmtDate(fechaPagoDe(p))) + ')' : ''}: solo se crea el documento soporte, sin cruzar anticipos, y el valor pagado en la app no cambia.</p>` : ants.length ? `<span class="section-lbl">Anticipos de este contratista por cruzar</span>${ants.map((x) => `<label class="check" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="checkbox" data-dsant="${esc(x.a.id)}"${x.manual ? ' checked' : ''}> ${esc(x.a.factura || 'Anticipo')} · ${x.manual ? 'anticipo escrito en la cuenta de cobro (ya descontado del valor a pagar)' : 'pagado ' + esc(fmtDate(fechaPagoDe(x.a) || ''))} · saldo ${fmt(x.saldo)}${x.prefijo && x.numero ? '' : ' <span class="sd-mal">(sin prefijo/número: no se puede cruzar)</span>'} <span>Cruzar</span><input data-dsantv="${esc(x.a.id)}" inputmode="numeric" style="width:130px" value="${esc(x.saldo.toLocaleString('es-CO'))}"></label>`).join('')}` : '<p class="sync" style="margin:0">Este contratista no tiene anticipos pagados pendientes por cruzar.</p>';
    renderResumenDS();
    $('#ds-estado').innerHTML = '';
    $('#dlg-ds').showModal();
    estadoDS(p);
    clearInterval(DSV.timer);
    DSV.timer = setInterval(async () => {
      if (!$('#dlg-ds').open) { clearInterval(DSV.timer); return; }
      const q = S.pagos.find((x) => x.id === DSV.id);
      if (q && q.siigoEnvioDS) { await estadoDS(q); try { await sincronizar(); } catch (e) {} }
    }, 15000);
  }
  ['#ds-valor', '#ds-rete', '#ds-otra'].forEach((s) => $(s).addEventListener('input', renderResumenDS));
  $('#ds-anticipos').addEventListener('input', renderResumenDS);
  $('#ds-anticipos').addEventListener('change', renderResumenDS);
  $('#ds-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrarError('#ds-err', '');
    const p = S.pagos.find((x) => x.id === DSV.id);
    if (!p) return;
    if (!conf.siigoApi) return mostrarError('#ds-err', 'Primero guarda las credenciales de Siigo (Usuarios → Conexión con Siigo).');
    if (p.ds) return mostrarError('#ds-err', `Esta cuenta de cobro ya tiene documento soporte (${p.ds.nombre}).`);
    if (p.siigoEnvioDS) return mostrarError('#ds-err', 'Ya se está enviando el documento soporte de esta cuenta de cobro.');
    const c = calcDS();
    const cuenta = ($('#ds-cuenta').value.match(/^\s*(\d{8})/) || [])[1];
    const cc = ccDeInput($('#ds-cc').value);
    const fecha = $('#ds-fecha').value;
    if (cc && siigoConf().centros.length && !siigoConf().centros.some((x) => x.codigo === cc)) return mostrarError('#ds-err', `No encontré el centro de costo "${$('#ds-cc').value}". Escribe el nombre de la obra o el código y elígelo de la lista.`);
    if (!(c.valor > 0)) return mostrarError('#ds-err', 'Escribe el valor de la cuenta de cobro.');
    if (!cuenta) return mostrarError('#ds-err', 'Elige la cuenta del costo o gasto (8 dígitos).');
    if (!fecha) return mostrarError('#ds-err', 'Escribe la fecha del documento soporte.');
    if (!p.nit) return mostrarError('#ds-err', 'La cuenta de cobro no tiene la cédula del contratista: agrégala con Editar.');
    if (!$('#ds-desc').value.trim()) return mostrarError('#ds-err', 'Escribe la descripción del trabajo.');
    if (c.cruces.some((x) => !x.prefijo || !x.numero)) return mostrarError('#ds-err', 'Uno de los anticipos marcados no tiene prefijo y número; corrígelo en ese anticipo con Editar.');
    if (c.cruces.some((x) => !(x.valor > 0))) return mostrarError('#ds-err', 'Escribe cuánto cruzar de cada anticipo marcado.');
    if (c.porPagar < 0) return mostrarError('#ds-err', 'Los anticipos a cruzar suman más que el neto del documento soporte.');
    const b = $('#ds-enviar');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = `¿Crear el documento soporte en Siigo (va a la DIAN)? Toca de nuevo`; setTimeout(() => { if (b.dataset.sure) { delete b.dataset.sure; b.textContent = 'Enviar documento soporte a Siigo'; } }, 7000); return; }
    delete b.dataset.sure;
    b.disabled = true; b.textContent = 'Enviando a la cola…';
    const id = nuevoId(), ahora = new Date().toISOString();
    const { prefijo, numero } = partirFactura(p.factura);
    const yo = conf.usuarios && conf.usuarios[uid];
    const envio = { id, estado: 'pendiente', pedido: ahora, porNombre: yo ? (yo.nombre || yo.usuario) : '', marca: 'ds', tipo: 'DS', comprobantes: [], hechos: [],
      ds: { pagoId: p.id, fecha, vence: p.vence && p.vence >= fecha ? p.vence : fecha, nit: String(p.nit).replace(/\D/g, ''), nombre: p.proveedor || '', cuenta, cc, descripcion: $('#ds-desc').value.trim(),
        valor: c.valor, prefijo, numero, yaPagado: p.estado === 'pagado', retenciones: c.rets.map((r) => ({ id: r.id, nombre: r.nombre, pct: r.pct, valor: r.valor })), neto: c.neto },
      cruces: c.cruces.map((x) => ({ anticipoId: x.anticipoId, prefijo: x.prefijo, numero: x.numero, vence: x.vence, valor: x.valor })) };
    try {
      let ocupado = false;
      await mutar((d) => { const x = d.pagos.find((y) => y.id === p.id); ocupado = !x || !!x.ds || !!x.siigoEnvioDS; if (ocupado) return false; x.siigoEnvioDS = { id, en: ahora }; });
      if (ocupado) throw new Error('Esta cuenta de cobro ya tiene o está enviando su documento soporte.');
      try { await mutarEnvios((d) => { d.envios = [envio, ...d.envios].slice(0, 30); }); }
      catch (e) { try { await mutar((d) => { const x = d.pagos.find((y) => y.id === p.id); if (x && x.siigoEnvioDS && x.siigoEnvioDS.id === id) delete x.siigoEnvioDS; }); } catch (e2) {} throw e; }
      // Recordar la última cuenta usada como sugerencia
      if (!conf.siigo || conf.siigo.ultimaCuentaDS !== cuenta) { conf.siigo = { ...(conf.siigo || {}), ultimaCuentaDS: cuenta }; guardarConfig().catch(() => {}); }
      toast('Documento soporte en cola: el computador de la oficina lo crea en Siigo en 1–2 minutos.');
      render(); estadoDS(p);
    } catch (e) { mostrarError('#ds-err', e.message && !e.status ? e.message : msgGitHub(e)); }
    b.disabled = false; b.textContent = 'Enviar documento soporte a Siigo';
  });

  // Un comprobante 14 por caja: un débito por soporte y el crédito a 13300502 a nombre del responsable (uno por centro de costo)
  function comprobantesCajas(arr, inicial) {
    return arr.map((p, i) => {
      const c = p.caja || {};
      const fecha = c.fecha || p.vence;
      const lineas = [];
      for (const s of p.soportes || []) {
        const cruza = CUENTAS_CON_VENCIMIENTO.has(s.cuenta);
        lineas.push({ cuenta: String(s.cuenta), nit: String(s.nit), prefijo: cruza ? s.prefijo : '', numero: cruza ? s.numero : '', vence: cruza ? (s.fecha || fecha) : '',
          descripcion: String(s.descripcion || s.nota || `Soporte caja menor No. ${c.numero}`).slice(0, 100), cc: s.cc || p.cc || '', debito: Math.round(Number(s.valor) || 0), credito: 0,
          obs: `Caja menor No. ${c.numero} ${c.responsable || ''} · ${s.tercero || ''} ${s.prefijo}-${s.numero}`.slice(0, 300) });
      }
      const porCC = new Map();
      for (const s of p.soportes || []) porCC.set(s.cc || p.cc || '', (porCC.get(s.cc || p.cc || '') || 0) + Math.round(Number(s.valor) || 0));
      for (const [cc, valor] of porCC) {
        lineas.push({ cuenta: '13300502', nit: String(c.cedula || p.nit), prefijo: '', numero: '', vence: '', descripcion: `Legalización caja menor No. ${c.numero} – ${c.responsable || ''}`.slice(0, 100),
          cc, debito: 0, credito: valor, obs: `Legalización caja menor No. ${c.numero} (${(p.soportes || []).length} soportes)` });
      }
      return { tipo: 14, consec: inicial > 0 ? inicial + i : 0, fecha, ids: [p.id], lineas, observaciones: `Legalización caja menor No. ${c.numero} – ${c.responsable || ''} (app Pagos ODESA)` };
    });
  }

  // Exportación a Siigo, comprobante 14 (legalización de la caja)
  function cajasParaSiigo() {
    const incluir = $('#s14-incluir').checked;
    return cajasDe().filter((p) => (p.estado === 'aprobado' || p.estado === 'pagado') && !p.siigoEnvio14 && (incluir || !p.siigo14))
      .sort((a, b) => String((a.caja || {}).fecha || '').localeCompare(String((b.caja || {}).fecha || '')) || ((a.caja || {}).numero || 0) - ((b.caja || {}).numero || 0));
  }
  function renderSiigo14() {
    const arr = cajasParaSiigo();
    const consec = Number($('#s14-consec').value);
    if (!arr.length) { $('#s14-tabla').innerHTML = '<p style="margin:12px;color:var(--muted)">No hay cajas aprobadas o reembolsadas por exportar.</p>'; $('#s14-go').disabled = true; $('#s14-go').textContent = 'Descargar archivo para Siigo'; botonSubir('#s14-subir', true, 'Subir a Siigo'); mostrarError('#s14-err', ''); return; }
    let errores = 0;
    $('#s14-tabla').innerHTML = `<table><thead><tr><th>Comp.</th><th>Caja</th><th>Responsable</th><th>Fecha</th><th>Soportes</th><th style="text-align:right">Total</th><th>Estado</th></tr></thead><tbody>${arr.map((p, i) => {
      const malos = (p.soportes || []).filter((s) => !s.nit || !(s.valor > 0) || (CUENTAS_CON_VENCIMIENTO.has(s.cuenta) && (!s.prefijo || !s.numero))).length;
      errores += malos ? 1 : 0;
      return `<tr><td>${consec > 0 ? consec + i : '—'}</td><td>No. ${esc((p.caja || {}).numero)}</td><td>${esc((p.caja || {}).responsable || p.proveedor)}</td><td>${esc(fmtDate((p.caja || {}).fecha || p.vence))}</td><td>${(p.soportes || []).length}</td><td class="n">${fmt(p.valor)}</td><td>${malos ? `<span class="bulk"><span class="bad">${malos} soporte(s) incompletos</span></span>` : p.siigo14 ? `<span class="bulk"><span class="warn">ya exportada (14-${esc(p.siigo14.comprobante)})</span></span>` : '<span class="bulk"><span class="ok">Lista</span></span>'} <button class="btn sm ghost" type="button" data-row="${p.id}">Ver</button></td></tr>`;
    }).join('')}</tbody></table>`;
    mostrarError('#s14-err', errores ? 'Hay cajas con soportes incompletos: ábrelas con “Ver” y usa “Corregir datos de los soportes”.' : '');
    $('#s14-go').disabled = !(consec > 0) || errores > 0;
    $('#s14-go').textContent = `Descargar archivo para Siigo (${arr.length} ${arr.length === 1 ? 'caja' : 'cajas'})`;
    $('#s14-go').title = consec > 0 ? '' : 'Para descargar el Excel escribe el primer consecutivo';
    botonSubir('#s14-subir', errores > 0 || !arr.length, `Subir a Siigo (${arr.length} ${arr.length === 1 ? 'caja' : 'cajas'})`);
  }
  $('#s14-consec').addEventListener('input', renderSiigo14);
  $('#s14-incluir').addEventListener('change', renderSiigo14);
  $('#s14-go').addEventListener('click', async () => {
    const arr = cajasParaSiigo();
    let consec = Number($('#s14-consec').value);
    if (!(consec > 0) || !arr.length) return;
    const comps = comprobantesCajas(arr, consec);
    const asignados = {};
    for (const c of comps) asignados[c.ids[0]] = c.consec;
    consec += comps.length;
    const filas = filasExcelSiigo(comps);
    const ws = XLSX.utils.aoa_to_sheet(filas);
    ws['!cols'] = ENCABEZADO_SIIGO.map((h) => ({ wch: Math.max(12, Math.min(28, h.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    XLSX.writeFile(wb, `Siigo comprobantes 14 cajas menores ${todayISO()}.xlsx`);
    const ahora = new Date().toISOString();
    try {
      await mutar((d) => { for (const x of d.pagos) if (asignados[x.id]) x.siigo14 = { comprobante: asignados[x.id], en: ahora }; d.siigo = { ...(d.siigo || {}), ultimo14: consec - 1 }; });
      toast(`Archivo generado: comprobantes 14-${consec - arr.length} a 14-${consec - 1}. Súbelo en Siigo.`); render(); renderSiigo14();
    } catch (e) { mostrarError('#s14-err', 'El archivo se descargó, pero no se pudo marcar como exportado: ' + msgGitHub(e)); }
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-cjtab], [data-cjcopiar], [data-cjdes], [data-cjact], [data-cjfoto], [data-cjeditar], [data-cjguardar], [data-cjcancel], [data-cjpdf], #cj-siigo');
    if (!t) return;
    if (t.dataset.cjtab) { CJ.tab = t.dataset.cjtab; renderCajas(); }
    else if (t.dataset.cjcopiar) {
      const r = conf.cajas.responsables.find((x) => x.id === t.dataset.cjcopiar);
      navigator.clipboard.writeText(enlaceCaja(r)).then(() => toast('Enlace copiado.'), () => toast(enlaceCaja(r)));
    }
    else if (t.dataset.cjdes) { if (t.dataset.sure) cambiarResponsable(t.dataset.cjdes, false); else { t.dataset.sure = '1'; t.textContent = '¿Seguro? Toca de nuevo'; } }
    else if (t.dataset.cjact) cambiarResponsable(t.dataset.cjact, true);
    else if (t.dataset.cjfoto != null) verSoporte(t.dataset.cjfoto);
    else if (t.dataset.cjeditar) { CJ.editando = t.dataset.cjeditar; renderDetail(); }
    else if (t.dataset.cjcancel) { CJ.editando = null; renderDetail(); }
    else if (t.dataset.cjguardar) guardarSoportes(t.dataset.cjguardar);
    else if (t.dataset.cjpdf) pdfRelacion(t.dataset.cjpdf);
    else if (t.id === 'cj-siigo') { const u = S.siigo && Number(S.siigo.ultimo14); if (!$('#s14-consec').value && u > 0) $('#s14-consec').value = u + 1; renderSiigo14(); $('#dlg-siigo14').showModal(); abrirEnvios(); }
  });

  // ---------- usuarios y contraseñas ----------
  async function leerUsuarios() {
    const f = await GH.leer(R_USUARIOS);
    return f ? { sha: f.sha, datos: JSON.parse(Cripto.dec.decode(f.bytes)) } : { sha: null, datos: { v: 1, usuarios: {} } };
  }
  async function guardarUsuarios(datos, sha) {
    await GH.escribir(R_USUARIOS, Cripto.enc.encode(JSON.stringify(datos, null, 1)), sha);
  }
  async function guardarConfig() {
    const f = await GH.leer(R_CONFIG);
    // Conservar lo que escribe la tarea del computador (lista de cuentas del PUC, verificación de Siigo)
    if (f) {
      try {
        const fresco = await Cripto.descifrarJSON(maestra, f.bytes);
        if (fresco.siigo && fresco.siigo.cuentasCosto && !(conf.siigo && conf.siigo.cuentasCosto)) conf.siigo = { ...(conf.siigo || {}), cuentasCosto: fresco.siigo.cuentasCosto };
        if (fresco.siigoApi && conf.siigoApi && fresco.siigoApi.llave === conf.siigoApi.llave) {
          if (String(fresco.siigoApi.verificado || '') > String(conf.siigoApi.verificado || '')) conf.siigoApi.verificado = fresco.siigoApi.verificado;
          if (fresco.siigoApi.error && String(fresco.siigoApi.error.en || '') > String((conf.siigoApi.error || {}).en || '')) conf.siigoApi.error = fresco.siigoApi.error;
        }
      } catch (e) { /* se guarda lo que hay en memoria */ }
    }
    await GH.escribir(R_CONFIG, await Cripto.cifrarJSON(maestra, conf), f && f.sha);
  }
  function renderUsuarios() {
    const ids = Object.keys(conf.usuarios || {});
    $('#users-list').innerHTML = ids.map((id) => {
      const u = conf.usuarios[id];
      return `<li><span class="who"><b>${esc(u.nombre || u.usuario)}</b><small>Usuario: ${esc(u.usuario)} · ${u.rol === 'admin' ? 'Administrador' : 'Aprobador'}</small></span>${id === uid ? '<span class="role">Tú</span>' : `<button class="btn sm danger" type="button" data-quitar="${id}">Quitar acceso</button>`}</li>`;
    }).join('');
  }
  function renderClaude() {
    $('#c-estado').textContent = conf.claudeKey ? '✓ Lectura con Claude activada.' : 'Lectura con Claude desactivada (se usa el lector propio).';
    $('#c-quitar').hidden = !conf.claudeKey;
  }
  function openUsuarios() { renderUsuarios(); renderClaude(); renderSiigoConf(); renderCobrosConf(); renderRobot(); renderAvisos(); renderSiigoApi(); mostrarError('#user-err', ''); mostrarError('#token-err', ''); mostrarError('#claude-err', ''); $('#user-form').reset(); $('#t-token').value = ''; $('#c-clave').value = ''; $('#dlg-users').showModal(); }

  $('#claude-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const clave = $('#c-clave').value.trim();
    if (!/^sk-ant-/.test(clave)) return mostrarError('#claude-err', 'La clave de la API de Claude empieza por “sk-ant-”.');
    try {
      conf.claudeKey = clave;
      await guardarConfig();
      $('#c-clave').value = '';
      mostrarError('#claude-err', '');
      renderClaude();
      toast('Clave de Claude guardada.');
    } catch (e) { delete conf.claudeKey; mostrarError('#claude-err', msgGitHub(e)); }
  });
  $('#c-quitar').addEventListener('click', async () => {
    try { delete conf.claudeKey; await guardarConfig(); renderClaude(); toast('Clave de Claude quitada.'); }
    catch (e) { mostrarError('#claude-err', msgGitHub(e)); }
  });

  $('#user-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nombre = $('#u-nombre').value.trim(), usuario = $('#u-usuario').value.trim(), rol = $('#u-rol').value, clave = $('#u-clave').value;
    if (!nombre || !usuario) return mostrarError('#user-err', 'Escribe el nombre y el usuario.');
    if (clave.length < MIN_CLAVE) return mostrarError('#user-err', `La contraseña debe tener al menos ${MIN_CLAVE} caracteres.`);
    const btn = $('#user-save'); btn.disabled = true; btn.textContent = 'Agregando…';
    try {
      const id = await Cripto.idUsuario(usuario);
      if (conf.usuarios[id]) { mostrarError('#user-err', 'Ese usuario ya existe.'); return; }
      const u = await leerUsuarios();
      u.datos.usuarios[id] = await Cripto.envolver(rawMaestra, clave);
      conf.usuarios[id] = { usuario, nombre, rol };
      await guardarConfig();
      await guardarUsuarios(u.datos, u.sha);
      $('#user-form').reset();
      renderUsuarios();
      toast(`Listo. ${nombre} ya puede entrar con el usuario “${usuario}”.`);
    } catch (e) { mostrarError('#user-err', msgGitHub(e)); }
    finally { btn.disabled = false; btn.textContent = 'Agregar usuario'; }
  });

  async function quitarUsuario(id) {
    try {
      const u = await leerUsuarios();
      delete u.datos.usuarios[id];
      await guardarUsuarios(u.datos, u.sha);
      delete conf.usuarios[id];
      await guardarConfig();
      renderUsuarios();
      toast('Acceso retirado.');
    } catch (e) { mostrarError('#user-err', msgGitHub(e)); }
  }

  $('#token-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const token = $('#t-token').value.trim();
    if (!token) return mostrarError('#token-err', 'Pega el token nuevo.');
    const anterior = GH.actual();
    GH.configurar({ ...anterior, token });
    const v = await GH.verificar();
    if (!v.ok) { GH.configurar(anterior); return mostrarError('#token-err', v.motivo); }
    try {
      conf.token = token;
      await guardarConfig();
      $('#t-token').value = '';
      mostrarError('#token-err', '');
      toast('Token actualizado.');
    } catch (e) { mostrarError('#token-err', msgGitHub(e)); }
  });

  $('#clave-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const a = $('#c-nueva').value, b = $('#c-nueva2').value;
    if (a.length < MIN_CLAVE) return mostrarError('#clave-err', `La contraseña debe tener al menos ${MIN_CLAVE} caracteres.`);
    if (a !== b) return mostrarError('#clave-err', 'Las contraseñas no coinciden.');
    try {
      const u = await leerUsuarios();
      u.datos.usuarios[uid] = await Cripto.envolver(rawMaestra, a);
      await guardarUsuarios(u.datos, u.sha);
      $('#dlg-clave').close();
      $('#clave-form').reset();
      toast('Contraseña cambiada.');
    } catch (e) { mostrarError('#clave-err', msgGitHub(e)); }
  });

  // ---------- inicio de sesión ----------
  async function abrirSesion(raw, id, recordar) {
    rawMaestra = raw;
    maestra = await Cripto.importarMaestra(raw);
    const cf = await GH.leerPublico(R_CONFIG);
    if (!cf) throw { message: 'sin-config' };
    conf = await Cripto.descifrarJSON(maestra, cf.bytes);
    const yo = conf.usuarios && conf.usuarios[id];
    if (!yo) throw { message: 'retirado' };
    uid = id;
    isAdmin = yo.rol === 'admin';
    GH.configurar({ owner: conf.owner, repo: conf.repo, branch: conf.branch, token: conf.token });
    if (recordar) {
      try { localStorage.setItem(SESION_KEY, JSON.stringify({ owner: conf.owner, repo: conf.repo, branch: conf.branch, uid: id, raw: Cripto.b64(raw) })); } catch (e) {}
    }
    try { localStorage.setItem('pagos.repo', JSON.stringify({ owner: conf.owner, repo: conf.repo, branch: conf.branch })); } catch (e) {}
    $('#role').textContent = isAdmin ? 'Administras los pagos' : 'Puedes aprobar pagos';
    $('#who').textContent = yo.nombre || yo.usuario;
    $('#btn-users').hidden = !isAdmin;
    $('#f-siigo').hidden = !isAdmin;
    setView(S.view);
    $('#btn-saldo').hidden = !isAdmin;
    pantalla('#app');
    render();
    await cargarDatos();
    try { await cargarCartera(); } catch (e) { /* la cartera se vuelve a intentar en la próxima sincronización */ }
    render();
    $('#sync').textContent = 'Actualizado ' + new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date());
    setInterval(sincronizar, 30000);
    if (isAdmin) { revisarBuzon(); setInterval(revisarBuzon, 120000); revisarAvisos(); pintarSiigo(); setInterval(refrescarSiigo, 300000); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const usuario = $('#l-usuario').value.trim(), clave = $('#l-clave').value;
    if (!usuario || !clave) return mostrarError('#login-err', 'Escribe tu usuario y tu contraseña.');
    const owner = $('#l-owner').value.trim(), repo = $('#l-repo').value.trim();
    if (!owner || !repo) { $('#l-repo-box').open = true; return mostrarError('#login-err', 'Indica el usuario de GitHub y el nombre del repositorio.'); }
    const btn = $('#login-btn'); btn.disabled = true; btn.textContent = 'Verificando…';
    mostrarError('#login-err', '');
    try {
      GH.configurar({ owner, repo, branch: (GH.actual().branch || 'main') });
      const uf = await GH.leerPublico(R_USUARIOS);
      if (!uf) { mostrarSetup(owner, repo); return; }
      const usuarios = JSON.parse(Cripto.dec.decode(uf.bytes)).usuarios || {};
      const id = await Cripto.idUsuario(usuario);
      const entrada = usuarios[id];
      let raw = null;
      if (entrada) { try { raw = await Cripto.desenvolver(entrada, clave); } catch (e) { raw = null; } }
      if (!raw) { mostrarError('#login-err', 'Usuario o contraseña incorrectos.'); return; }
      await abrirSesion(raw, id, $('#l-recordar').checked);
      $('#l-clave').value = '';
    } catch (e) {
      mostrarError('#login-err', e && e.message === 'retirado' ? 'Tu acceso fue retirado. Habla con la administradora.' : msgGitHub(e));
    } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  });

  // ---------- configuración inicial ----------
  function mostrarSetup(owner, repo) {
    $('#s-owner').value = owner || '';
    $('#s-repo').value = repo || '';
    pantalla('#pantalla-setup');
  }
  $('#setup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const owner = $('#s-owner').value.trim(), repo = $('#s-repo').value.trim(), branch = $('#s-rama').value.trim() || 'main';
    const token = $('#s-token').value.trim(), nombre = $('#s-nombre').value.trim(), usuario = $('#s-usuario').value.trim();
    const clave = $('#s-clave').value, clave2 = $('#s-clave2').value;
    if (!owner || !repo || !token || !nombre || !usuario) return mostrarError('#setup-err', 'Completa todos los campos.');
    if (clave.length < MIN_CLAVE) return mostrarError('#setup-err', `La contraseña debe tener al menos ${MIN_CLAVE} caracteres.`);
    if (clave !== clave2) return mostrarError('#setup-err', 'Las contraseñas no coinciden.');
    const btn = $('#setup-btn'); btn.disabled = true; btn.textContent = 'Activando…';
    mostrarError('#setup-err', '');
    try {
      GH.configurar({ owner, repo, branch, token });
      const v = await GH.verificar();
      if (!v.ok) { mostrarError('#setup-err', v.motivo); return; }
      if (await GH.leer(R_USUARIOS)) { mostrarError('#setup-err', 'Esta aplicación ya fue activada en este repositorio. Usa la pantalla de inicio de sesión.'); return; }
      const raw = Cripto.aleatorio(32);
      const llave = await Cripto.importarMaestra(raw);
      const id = await Cripto.idUsuario(usuario);
      const config = { owner, repo, branch, token, usuarios: { [id]: { usuario, nombre, rol: 'admin' } } };
      await GH.escribir(R_CONFIG, await Cripto.cifrarJSON(llave, config), null);
      await GH.escribir(R_PAGOS, await Cripto.cifrarJSON(llave, { pagos: [], banco: null }), null);
      await guardarUsuarios({ v: 1, usuarios: { [id]: await Cripto.envolver(raw, clave) } }, null);
      $('#s-token').value = ''; $('#s-clave').value = ''; $('#s-clave2').value = '';
      await abrirSesion(raw, id, false);
      toast('Aplicación activada. Ya puedes agregar usuarios y pagos.');
    } catch (e) { mostrarError('#setup-err', msgGitHub(e)); }
    finally { btn.disabled = false; btn.textContent = 'Activar y entrar'; }
  });

  function salir() {
    try { localStorage.removeItem(SESION_KEY); } catch (e) {}
    Object.values(facturaUrl).forEach((u) => URL.revokeObjectURL(u));
    location.reload();
  }

  // ---------- eventos ----------
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, [data-row], a');
    if (!t || t.tagName === 'A') return;
    if (t.dataset.close != null) { const d = t.closest('dialog'); if (d) d.close(); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; try { localStorage.setItem('pagos.tab', S.tab); } catch (e) {} renderTabs(); renderList(); return; }
    if (t.dataset.act) { ev.stopPropagation(); setEstado(t.dataset.id, t.dataset.act); return; }
    if (t.dataset.open === 'add') { openForm(); return; }
    if (t.dataset.open === 'import') { openImport(); return; }
    if (t.dataset.admin === 'edit') { openForm(S.openId); return; }
    if (t.dataset.admin === 'ds') { openDS(S.openId); return; }
    if (t.dataset.admin === 'delete') { S.confirm = 'delete'; renderDetail(); return; }
    if (t.dataset.admin === 'pay') { S.confirm = 'pay'; S.payDate = todayISO(); renderDetail(); return; }
    if (t.dataset.confirm === 'cancel') { S.confirm = null; renderDetail(); return; }
    if (t.dataset.confirm === 'delete') { eliminar(S.openId); return; }
    if (t.dataset.confirm === 'pay') { marcarPagado(S.openId, !!(S.banco && typeof S.banco.saldo === 'number')); return; }
    if (t.dataset.confirm === 'pay-only') { marcarPagado(S.openId, false); return; }
    if (t.dataset.retry) { const p = S.pagos.find((x) => x.id === t.dataset.retry); if (p) { delete facturaError[p.archivo]; renderDetail(); } return; }
    if (t.dataset.quitar) { if (t.dataset.sure) quitarUsuario(t.dataset.quitar); else { t.dataset.sure = '1'; t.textContent = '¿Seguro? Toca de nuevo'; } return; }
    if (t.dataset.sgEditar) { $('#dlg-siigo').close(); openForm(t.dataset.sgEditar); return; }
    if (t.dataset.view) { setView(t.dataset.view); return; }
    if (t.dataset.range) { setRange(t.dataset.range); return; }
    if (t.dataset.row) { S.openId = t.dataset.row; S.confirm = null; renderDetail(); }
  });
  document.addEventListener('keydown', (ev) => {
    const r = ev.target.closest && ev.target.closest('[data-row]');
    if (r && (ev.key === 'Enter' || ev.key === ' ') && ev.target === r) { ev.preventDefault(); S.openId = r.dataset.row; S.confirm = null; renderDetail(); }
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'd-fpago') S.payDate = ev.target.value; });
  $('#dlg-detail').addEventListener('close', () => { S.openId = null; S.confirm = null; });
  $('#btn-add').addEventListener('click', () => openForm());
  $('#btn-cobro').addEventListener('click', () => openForm(null, 'cobro'));
  $('#btn-masiva-cobro').addEventListener('click', () => openMasiva('cobro'));
  $('#btn-import').addEventListener('click', openImport);
  $('#btn-masiva').addEventListener('click', openMasiva);
  $('#btn-saldo').addEventListener('click', openSaldo);
  $('#btn-users').addEventListener('click', openUsuarios);
  $('#btn-clave').addEventListener('click', () => { mostrarError('#clave-err', ''); $('#clave-form').reset(); $('#dlg-clave').showModal(); });
  $('#btn-salir').addEventListener('click', salir);
  $('#r-dl').addEventListener('click', descargarReporte);
  $('#r-siigo').addEventListener('click', openSiigo);
  $('#q').addEventListener('input', (e) => { S.q = e.target.value; renderList(); });
  $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; renderList(); });
  $('#f-aprobador').addEventListener('change', (e) => {
    S.aprobador = e.target.value;
    if (S.aprobador && S.tab !== 'aprobado' && S.tab !== 'pagado' && S.tab !== 'todos') { S.tab = 'todos'; renderTabs(); }
    renderList();
  });
  autocorregirCC('#f-cc', '#f-cc-hint'); autocorregirCC('#ds-cc'); autocorregirCC('#cj-cc');
  // Filtro por estado en Siigo: mira todos los estados (aprobados y pagados a la vez)
  $('#f-siigo').addEventListener('change', (e) => {
    S.siigoVer = e.target.value;
    if (S.siigoVer && S.tab !== 'todos') { S.tab = 'todos'; renderTabs(); }
    renderList();
  });

  // ---------- arranque ----------
  async function iniciar() {
    if (!window.crypto || !crypto.subtle) {
      $('#carga-msg').textContent = 'Este navegador no permite el cifrado necesario. Abre la página desde la dirección https:// publicada en GitHub Pages.';
      return;
    }
    [S.rDesde, S.rHasta] = rangeDates('mes');
    $('#r-desde').value = S.rDesde; $('#r-hasta').value = S.rHasta;
    // Al entrar siempre se ve el inicio (o una sección pedida en el enlace: #reporte, #cartera, #proveedores, #clientes)
    const porHash = { '#reporte': 'rep', '#cartera': 'cart', '#proveedores': 'aprob', '#clientes': 'cart' };
    setView(porHash[location.hash] || 'inicio');

    let repo = GH.desdeUbicacion();
    if (!repo) { try { repo = JSON.parse(localStorage.getItem('pagos.repo') || 'null'); } catch (e) {} }

    // Sesión recordada en este dispositivo
    let guardada = null;
    try { guardada = JSON.parse(localStorage.getItem(SESION_KEY) || 'null'); } catch (e) {}
    if (guardada && guardada.raw) {
      try {
        GH.configurar({ owner: guardada.owner, repo: guardada.repo, branch: guardada.branch });
        await abrirSesion(Cripto.unb64(guardada.raw), guardada.uid, true);
        return;
      } catch (e) {
        // Solo se olvida la sesión si ya no es válida; si fue la conexión, se conserva para el próximo intento.
        if (e && (e.message === 'retirado' || e.name === 'OperationError')) { try { localStorage.removeItem(SESION_KEY); } catch (x) {} }
        else notice('');
      }
    }

    $('#l-owner').value = (repo && repo.owner) || '';
    $('#l-repo').value = (repo && repo.repo) || '';
    if (repo) {
      try {
        GH.configurar({ owner: repo.owner, repo: repo.repo, branch: repo.branch || 'main' });
        const uf = await GH.leerPublico(R_USUARIOS);
        if (!uf) { mostrarSetup(repo.owner, repo.repo); return; }
      } catch (e) { /* sin conexión: igual se muestra el inicio de sesión */ }
    } else {
      $('#l-repo-box').open = true;
    }
    pantalla('#pantalla-login');
    $('#l-usuario').focus();
  }
  // Herramientas que usa el módulo de Recursos humanos (rrhh.js)
  window.ODESA = {
    get maestra() { return maestra; }, get uid() { return uid; }, get conf() { return conf; }, get isAdmin() { return isAdmin; },
    $, esc, fmt, fmtDate, dtFmt, toast, mostrarError, msgGitHub, nuevoId, personName, parseMonto, todayISO, localISO, setView,
    // Aviso al celular de los jefes (ntfy), solo si el canal está activado. Sin nombres ni valores.
    async avisar(titulo, mensaje) { if (conf && conf.avisos && conf.avisos.canal) { await enviarNtfy(titulo, mensaje); return true; } return false; },
  };
  iniciar();
})();
