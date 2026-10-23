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

  const ESTADOS = { revisar: { label: 'Por revisar' }, aprobado: { label: 'Se procede' }, pendiente: { label: 'Pendiente' }, pagado: { label: 'Pagado' }, rechazado: { label: 'Rechazado' } };
  const TABS = [['revisar', 'Por revisar'], ['aprobado', 'Se proceden'], ['pendiente', 'Pendientes'], ['pagado', 'Pagados'], ['rechazado', 'Rechazados'], ['todos', 'Todos']];
  const TIPO_DOC = { cobro: 'Cuenta de cobro', anticipo: 'Anticipo' };

  const S = { pagos: [], banco: null, loaded: false, tab: 'revisar', q: '', sort: 'vence', openId: null, confirm: null, view: 'aprob', rDesde: '', rHasta: '', rRange: 'mes', payDate: '' };
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
  function ccDeInput(v) {
    v = String(v || '').trim();
    if (!v) return '';
    const centros = siigoConf().centros;
    const code = v.split('·')[0].trim().replace(/\s+/g, '');
    if (centros.some((x) => x.codigo === code)) return code;
    const porNombre = centros.filter((x) => normTxt(x.nombre).includes(normTxt(v)));
    if (porNombre.length === 1) return porNombre[0].codigo;
    return code;
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

  function totals() {
    const sum = (st) => S.pagos.filter((p) => p.estado === st).reduce((a, p) => a + (Number(p.valor) || 0), 0);
    const cnt = (st) => S.pagos.filter((p) => p.estado === st).length;
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
    const counts = { todos: S.pagos.length };
    for (const k of Object.keys(ESTADOS)) counts[k] = S.pagos.filter((p) => p.estado === k).length;
    $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${S.tab === k}">${l}<span class="c">${counts[k] || 0}</span></button>`).join('');
  }

  function visible() {
    const q = S.q.trim().toLowerCase();
    let arr = S.pagos.filter((p) => (S.tab === 'todos' || p.estado === S.tab));
    if (S.aprobador) arr = arr.filter((p) => { const a = aprobacion(p); return a && a.por === S.aprobador && (p.estado === 'aprobado' || p.estado === 'pagado'); });
    if (q) arr = arr.filter((p) => [p.proveedor, p.concepto, p.factura].some((x) => String(x || '').toLowerCase().includes(q)));
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
    if (p.estado !== 'aprobado') out.push(`<button class="btn go${cls}" type="button" data-act="aprobado" data-id="${p.id}"${dis}>Se procede</button>`);
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
      list.innerHTML = `<div class="empty"><h3>${S.q ? 'Sin resultados' : 'Nada en ' + esc(lbl)}</h3><p>${S.q ? 'Ningún pago coincide con la búsqueda.' : S.tab === 'revisar' ? 'Todos los pagos ya tienen una decisión.' : 'No hay pagos en este estado.'}</p></div>`;
      foot.innerHTML = '';
      return;
    }
    list.innerHTML = arr.map((p) => {
      const st = ESTADOS[p.estado] ? p.estado : 'revisar';
      const sub = [p.concepto, p.factura ? 'Fact. ' + p.factura : ''].filter(Boolean).map(esc).join(' · ');
      return `<article class="row s-${st}" data-row="${p.id}" tabindex="0">
        <div class="r-main"><div class="r-prov">${TIPO_DOC[p.tipoDoc] ? `<span class="chip doc">${TIPO_DOC[p.tipoDoc]}</span> ` : ''}${esc(p.proveedor || 'Sin proveedor')}</div><div class="r-sub">${sub || '&nbsp;'}${p.archivo ? ` · <span class="clip">${p.tipoDoc ? 'Documento adjunto' : 'Factura adjunta'}</span>` : ''}</div></div>
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
        : `<div class="impact"><span>Hoy quedaría en banco <span class="num ${now < 0 ? 'neg' : ''}">${fmt(now)}</span>.</span><span>Si se procede con este pago, quedaría <span class="num ${after < 0 ? 'neg' : ''}">${fmt(after)}</span>.</span></div>`;
    }
    const hist = (p.historial || []).slice().reverse().map((h) => `<li><span class="pill st-${ESTADOS[h.estado] ? h.estado : 'revisar'}">${(ESTADOS[h.estado] || ESTADOS.revisar).label}</span><span>${esc(personName(h.por))}</span><span class="when">${esc(dtFmt.format(new Date(h.en)))}</span>${h.nota ? `<span>— ${esc(h.nota)}</span>` : ''}</li>`).join('');
    const canDecide = st !== 'pagado';

    let adminBox = '';
    if (isAdmin) {
      let cf = '';
      if (S.confirm === 'delete') cf = `<div class="confirm"><span>¿Eliminar este pago? No se puede deshacer.</span><span class="decide" style="flex:none"><button class="btn sm" type="button" data-confirm="cancel">Cancelar</button><button class="btn sm danger solid" type="button" data-confirm="delete">Eliminar</button></span></div>`;
      if (S.confirm === 'pay') cf = `<div class="confirm pay"><span class="pay-date"><label for="d-fpago">Fecha de pago</label><input type="date" id="d-fpago" value="${esc(S.payDate || todayISO())}" max="${todayISO()}"></span><span>Marcar como pagado${saldo != null ? ` y descontar <b class="num">${fmt(p.valor)}</b> del saldo en banco` : ''}.</span><span class="decide" style="flex:none"><button class="btn sm" type="button" data-confirm="cancel">Cancelar</button>${saldo != null ? '<button class="btn sm" type="button" data-confirm="pay-only">Solo marcar pagado</button>' : ''}<button class="btn sm primary" type="button" data-confirm="pay">${saldo != null ? 'Pagado y descontar' : 'Marcar pagado'}</button></span></div>`;
      adminBox = `<div class="admin-box"><span class="section-lbl">Administración</span>
        <div class="decide">${st === 'aprobado' ? '<button class="btn primary sm" type="button" data-admin="pay">Marcar como pagado</button>' : ''}${st !== 'revisar' ? '<button class="btn sm" type="button" data-act="revisar" data-id="' + p.id + '">Volver a “Por revisar”</button>' : ''}<button class="btn sm" type="button" data-admin="edit">Editar</button><button class="btn sm danger" type="button" data-admin="delete">Eliminar</button></div>${cf}</div>`;
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
        ${isAdmin && p.siigo ? `<div><dt>Siigo</dt><dd>Exportado en comprobante ${esc(p.siigo.tipo)}-${esc(p.siigo.comprobante)}</dd></div>` : ''}
        ${aprobacion(p) && (st === 'aprobado' || st === 'pagado') ? `<div><dt>Aprobado por</dt><dd>${esc(personName(aprobacion(p).por))}, ${esc(dtFmt.format(new Date(aprobacion(p).en)))}</dd></div>` : ''}
        ${p.decididoPor && p.decididoEn ? `<div><dt>Última decisión</dt><dd>${esc(personName(p.decididoPor))}, ${esc(dtFmt.format(new Date(p.decididoEn)))}</dd></div>` : ''}
      </dl>
      ${p.nota ? `<div class="impact"><span class="section-lbl">Nota</span><span>${esc(p.nota)}</span></div>` : ''}
      ${impact}
      ${renderInvoice(p)}
      ${canDecide ? `<div class="field"><label for="d-nota">Comentario de la decisión (opcional)</label><input id="d-nota" autocomplete="off" placeholder="Ej. Pagar la próxima semana" value="${esc(notaPrev)}"></div><div class="decide">${p.estado !== 'aprobado' ? `<button class="btn go" type="button" data-act="aprobado" data-id="${p.id}"${busy.has(p.id) ? ' disabled' : ''}>Se procede con este pago</button>` : ''}${p.estado !== 'pendiente' ? `<button class="btn hold" type="button" data-act="pendiente" data-id="${p.id}"${busy.has(p.id) ? ' disabled' : ''}>Dejar pendiente</button>` : ''}${p.estado !== 'rechazado' ? `<button class="btn no" type="button" data-act="rechazado" data-id="${p.id}"${busy.has(p.id) ? ' disabled' : ''}>Rechazar</button>` : ''}</div>` : ''}
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
    renderLedger(); renderTabs(); renderList(); renderReport();
    if (S.openId) renderDetail();
    renderCartResumen(); renderCartera();
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
      if (ok) toast(estado === 'aprobado' ? `Se procede: ${p.proveedor}` : estado === 'pendiente' ? `Quedó pendiente: ${p.proveedor}` : estado === 'rechazado' ? `Rechazado: ${p.proveedor}` : `Volvió a por revisar: ${p.proveedor}`);
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
  function openForm(id) {
    editingId = id || null;
    const p = id ? S.pagos.find((x) => x.id === id) : null;
    $('#form-title').textContent = p ? 'Editar pago' : 'Agregar pago';
    $('#f-prov').value = p ? p.proveedor || '' : '';
    $('#f-concepto').value = p ? p.concepto || '' : '';
    $('#f-factura').value = p ? p.factura || '' : '';
    $('#f-valor').value = p ? new Intl.NumberFormat('es-CO').format(p.valor || 0) : '';
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
  let masivaActiva = false;
  function openMasiva() {
    if (masivaActiva) { $('#dlg-masiva').showModal(); return; }
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
        nuevos.push({
          id: nuevoId(), proveedor: d.proveedor || f.name.replace(/\.[^.]+$/, ''), concepto: d.concepto, factura: d.factura,
          valor: d.valor || 0, vence: d.vence, estado: 'revisar', nota: '', fechaPago: '', ...adj,
          nit: d.nit || '', cuenta: siigoConf().cuentaProv, cc: matchCentro((r.texto || '') + ' ' + f.name),
          creado: now, creadoPor: uid,
          historial: [{ estado: 'revisar', por: uid, en: now, nota: 'Cargada en lote' + (r.faltan.length ? ' · faltó: ' + r.faltan.join(', ') : '') }],
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
    const btn = $('#form-save'); btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const estado = $('#f-estado').value;
      const data = {
        proveedor: prov, concepto: $('#f-concepto').value.trim(), factura: $('#f-factura').value.trim(),
        valor: Math.round(valor), vence: $('#f-vence').value || '', estado, nota: $('#f-nota').value.trim(),
        fechaPago: estado === 'pagado' ? ($('#f-fpago').value || todayISO()) : '',
        nit: $('#f-nit').value.replace(/\D/g, ''), cuenta: $('#f-cuenta').value, cc: ccDeInput($('#f-cc').value),
      };
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
  function setView(v) {
    S.view = ['rep', 'cart'].includes(v) ? v : 'aprob';
    try { localStorage.setItem('pagos.view', S.view); } catch (e) {}
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
    $('#view-aprob').hidden = S.view !== 'aprob';
    $('#view-rep').hidden = S.view !== 'rep';
    $('#view-cart').hidden = S.view !== 'cart';
    if (S.view === 'rep') renderReport();
    if (S.view === 'cart' && typeof renderCartera === 'function') renderCartera();
  }
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

  // ---------- exportación a Siigo (modelo de importación de comprobantes contables) ----------
  const ENCABEZADO_SIIGO = ['Tipo de comprobante', 'Consecutivo comprobante', 'Fecha de elaboración ', 'Sigla moneda', 'Tasa de cambio', 'Código cuenta contable', 'Identificación tercero', 'Sucursal', 'Código producto', 'Código de bodega', 'Acción', 'Cantidad producto', 'Prefijo', 'Consecutivo', 'No. cuota', 'Fecha vencimiento', 'Código impuesto', 'Código grupo activo fijo', 'Código activo fijo', 'Descripción', 'Código centro/subcentro de costos', 'Débito', 'Crédito', 'Observaciones', 'Base gravable libro compras/ventas  ', 'Base exenta libro compras/ventas', 'Mes de cierre'];
  const ddmmaaaa = (iso) => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };

  function filasSiigo() {
    let a = $('#sg-desde').value, b = $('#sg-hasta').value;
    if (a && b && a > b) [a, b] = [b, a];
    const incluir = $('#sg-incluir').checked;
    return S.pagos
      .filter((p) => p.estado === 'pagado' && fechaPagoDe(p) && (!a || fechaPagoDe(p) >= a) && (!b || fechaPagoDe(p) <= b) && (incluir || !p.siigo))
      .sort((x, y) => fechaPagoDe(x).localeCompare(fechaPagoDe(y)) || String(x.proveedor || '').localeCompare(String(y.proveedor || ''), 'es'))
      .map((p) => {
        const { prefijo, numero } = partirFactura(p.factura);
        const cuenta = p.cuenta || siigoConf().cuentaProv;
        const errores = [], avisos = [];
        if (!p.nit) errores.push('NIT');
        if (!prefijo) errores.push('prefijo');
        else if (prefijo.length > 6) errores.push('prefijo de más de 6 caracteres');
        if (!numero) errores.push('n.º de factura');
        if (CUENTAS_CON_VENCIMIENTO.has(cuenta) && !p.vence) errores.push('vencimiento');
        if (!(Number(p.valor) > 0)) errores.push('valor');
        if (!p.cc) avisos.push('centro de costo');
        if (p.siigo) avisos.push(`ya exportado (comp. ${p.siigo.comprobante})`);
        return { p, prefijo, numero, cuenta, errores, avisos };
      });
  }

  function renderSiigo() {
    const filas = filasSiigo();
    const sc = siigoConf();
    $('#sg-conf').textContent = `Comprobante tipo ${sc.tipo} · crédito a ${sc.cuentaBanco}${sc.cuentaBanco === '11100501' ? ' (Bancolombia cte 2278)' : ''} · ${sc.centros.length ? sc.centros.length + ' centros de costo cargados' : 'sin centros de costo cargados (Usuarios → Siigo)'}`;
    if (!filas.length) {
      $('#sg-tabla').innerHTML = '<p style="margin:12px;color:var(--muted)">No hay pagos marcados como pagados en este periodo' + ($('#sg-incluir').checked ? '' : ' sin exportar') + '.</p>';
      $('#sg-go').disabled = true;
      return;
    }
    const consec = Number($('#sg-consec').value);
    $('#sg-tabla').innerHTML = `<table><thead><tr><th>Comp.</th><th>Fecha pago</th><th>Proveedor</th><th>NIT</th><th>Factura</th><th>Vence</th><th>Centro de costo</th><th style="text-align:right">Valor</th><th>Estado</th></tr></thead><tbody>
      ${filas.map((f, i) => `<tr><td>${consec > 0 ? consec + i : '—'}</td><td>${esc(fmtDate(fechaPagoDe(f.p)))}</td><td>${esc(f.p.proveedor)}</td><td>${esc(f.p.nit || '—')}</td><td>${esc(f.prefijo ? f.prefijo + ' / ' + f.numero : f.p.factura || '—')}</td><td>${esc(f.p.vence ? fmtDate(f.p.vence) : '—')}</td><td>${esc(f.p.cc || '—')}</td><td class="n">${fmt(f.p.valor)}</td>
        <td>${f.errores.length ? `<span class="bulk"><span class="bad">Falta: ${esc(f.errores.join(', '))}</span></span>` : f.avisos.length ? `<span class="bulk"><span class="warn">Sin ${esc(f.avisos.join(', '))}</span></span>` : '<span class="bulk"><span class="ok">Listo</span></span>'} <button class="btn sm ghost" type="button" data-sg-editar="${f.p.id}">Editar</button></td></tr>`).join('')}
      </tbody></table>`;
    const conErrores = filas.filter((f) => f.errores.length).length;
    if (!(consec > 0)) mostrarError('#sg-err', 'Escribe el primer consecutivo del comprobante.');
    else if (conErrores) mostrarError('#sg-err', `${conErrores} ${conErrores === 1 ? 'pago tiene' : 'pagos tienen'} datos obligatorios incompletos. Usa “Completar desde las facturas” o “Editar”.`);
    else mostrarError('#sg-err', '');
    $('#sg-go').disabled = !(consec > 0) || conErrores > 0;
    $('#sg-go').textContent = `Descargar archivo para Siigo (${filas.length} ${filas.length === 1 ? 'comprobante' : 'comprobantes'})`;
  }

  function openSiigo() {
    $('#sg-desde').value = S.rDesde || ''; $('#sg-hasta').value = S.rHasta || '';
    const ult = S.siigo && Number(S.siigo.ultimo);
    if (!$('#sg-consec').value && ult > 0) $('#sg-consec').value = ult + 1;
    renderSiigo();
    $('#dlg-siigo').showModal();
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

  $('#sg-go').addEventListener('click', async () => {
    const filas = filasSiigo();
    const sc = siigoConf();
    let consec = Number($('#sg-consec').value);
    if (!(consec > 0) || !filas.length || filas.some((f) => f.errores.length)) return;
    const tipo = Number(sc.tipo) || 11;
    const filasXls = [ENCABEZADO_SIIGO];
    const asignados = {};
    const vacio = () => new Array(ENCABEZADO_SIIGO.length).fill('');
    for (const f of filas) {
      const p = f.p;
      const fecha = ddmmaaaa(fechaPagoDe(p));
      const desc = (p.concepto || `Pago factura ${f.prefijo}-${f.numero}`).slice(0, 100);
      const obs = `Pago ${p.proveedor} factura ${f.prefijo}-${f.numero}`.slice(0, 300);
      const valor = Math.round(Number(p.valor) || 0);
      // Línea 1: débito a la cuenta del proveedor (cruza la factura)
      const deb = vacio();
      deb[0] = tipo; deb[1] = consec; deb[2] = fecha; deb[5] = Number(f.cuenta); deb[6] = String(p.nit);
      if (CUENTAS_CON_VENCIMIENTO.has(f.cuenta)) { deb[12] = f.prefijo; deb[13] = Number(f.numero); deb[14] = 1; deb[15] = ddmmaaaa(p.vence); }
      deb[19] = desc; deb[20] = p.cc || ''; deb[21] = valor; deb[23] = obs;
      // Línea 2: crédito al banco, mismo tercero
      const cre = vacio();
      cre[0] = tipo; cre[1] = consec; cre[2] = fecha; cre[5] = Number(sc.cuentaBanco); cre[6] = String(p.nit);
      cre[19] = desc; cre[22] = valor; cre[23] = obs;
      filasXls.push(deb, cre);
      asignados[p.id] = consec;
      consec++;
    }
    const ws = XLSX.utils.aoa_to_sheet(filasXls);
    ws['!cols'] = ENCABEZADO_SIIGO.map((h) => ({ wch: Math.max(12, Math.min(28, h.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    const a = $('#sg-desde').value, b = $('#sg-hasta').value;
    XLSX.writeFile(wb, `Siigo comprobantes ${tipo} ${a === b ? a : a + ' a ' + b}.xlsx`);
    const ultimo = consec - 1;
    const ahora = new Date().toISOString();
    try {
      await mutar((d) => {
        for (const x of d.pagos) if (asignados[x.id]) x.siigo = { tipo, comprobante: asignados[x.id], en: ahora };
        d.siigo = { ...(d.siigo || {}), ultimo: Math.max(ultimo, Number((d.siigo || {}).ultimo) || 0) };
      });
      toast(`Archivo generado: comprobantes ${tipo}-${ultimo - filas.length + 1} a ${tipo}-${ultimo}. Súbelo en Siigo.`);
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

  const cobrado = (it) => (it.cobros || []).reduce((t, c) => t + (Number(c.valor) || 0), 0);
  const netoDe = (it) => Number(it.neto) || Number(it.valor) || 0;
  const porCobrarDe = (it) => (it.estado === 'pendiente' || it.estado === 'reclamacion') ? Math.max(netoDe(it) - cobrado(it), 0) : 0;
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
    const cobros = (it.cobros || []).map((c) => `<li><span class="when">${esc(c.fecha ? fmtDate(c.fecha) : 'sin fecha')}</span><span class="num">${fmt(c.valor)}</span><span>${c.historico ? 'histórico (Excel)' : esc(personName(c.por)) + (c.banco ? ' · sumó al banco' : '')}</span></li>`).join('');
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
          <div class="field"><label for="cc-valor">Valor recibido (COP)</label><input id="cc-valor" inputmode="decimal" value="${pend ? new Intl.NumberFormat('es-CO').format(pend) : ''}"></div>
          <label class="check full"><input type="checkbox" id="cc-banco" checked> Sumar este valor al saldo en banco</label>
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

  async function registrarCobro(ev) {
    ev.preventDefault();
    const it = C.items.find((x) => x.id === C.openId);
    if (!it) return;
    const fecha = $('#cc-fecha').value, valor = Math.round(parseMonto($('#cc-valor').value)), alBanco = $('#cc-banco').checked;
    if (!fecha) return mostrarError('#cc-err', 'Elige la fecha en que entró el dinero.');
    if (!(valor > 0)) return mostrarError('#cc-err', 'Escribe el valor recibido.');
    const now = new Date().toISOString();
    try {
      let quedoPagada = false;
      await mutarCartera((d) => {
        const x = d.items.find((y) => y.id === it.id);
        if (!x) return false;
        x.cobros = (x.cobros || []).concat([{ fecha, valor, por: uid, en: now, banco: alBanco }]);
        if (cobrado(x) >= netoDe(x) - 1 && (x.estado === 'pendiente' || x.estado === 'reclamacion')) { x.estado = 'pagado'; quedoPagada = true; }
        x.historial = (x.historial || []).slice(-30).concat([{ por: uid, en: now, nota: `Cobro de ${fmt(valor)} el ${fmtDate(fecha)}${alBanco ? ' (sumado al banco)' : ''}${quedoPagada ? ' · quedó pagada' : ''}` }]);
      });
      if (alBanco && S.banco && typeof S.banco.saldo === 'number') {
        await mutar((d) => { if (d.banco && typeof d.banco.saldo === 'number') d.banco = { ...d.banco, saldo: d.banco.saldo + valor, actualizado: now, por: uid }; });
      }
      toast(`Cobro registrado${alBanco && S.banco ? ': se sumaron ' + fmt(valor) + ' al saldo en banco' : ''}.`);
      render(); renderCartDetalle();
    } catch (e) { mostrarError('#cc-err', msgGitHub(e)); }
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
    const filas = [['Tipo', 'Identificación', 'Cliente', 'Comprobante', 'Fecha elaboración', 'Vencimiento', 'Valor facturado', 'Valor a recibir', 'Cobrado', 'Por cobrar', 'Estado', 'Fecha último cobro', 'Proyecto', 'Descripción', 'Observación']];
    const f = (iso) => (iso ? new Date(iso + 'T12:00:00') : '');
    for (const it of C.items.slice().sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')))) {
      filas.push([CT[it.tipo] || '', it.nit || '', it.cliente || '', it.documento || '', f(it.fecha), f(it.vence), it.valor || 0, netoDe(it), cobrado(it), porCobrarDe(it), CE[it.estado] || it.estado, f(ultimaFechaCobro(it)), it.proyecto || '', it.descripcion || '', it.observacion || '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(filas, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = [10, 14, 34, 14, 12, 12, 16, 16, 16, 16, 12, 14, 20, 50, 40].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cartera');
    XLSX.writeFile(wb, `Cartera ODESA ${todayISO()}.xlsx`, { cellDates: true });
  }

  // Eventos de cartera
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-ctab], [data-crow], [data-cver], [data-cedit], #cc-estado-go, #cc-borrar, #c-btn-add, #c-btn-import, #c-btn-dl');
    if (!t) return;
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
  $('#dlg-cart').addEventListener('close', () => { C.openId = null; C.borrar = false; });
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
  function openUsuarios() { renderUsuarios(); renderClaude(); renderSiigoConf(); renderCobrosConf(); renderRobot(); mostrarError('#user-err', ''); mostrarError('#token-err', ''); mostrarError('#claude-err', ''); $('#user-form').reset(); $('#t-token').value = ''; $('#c-clave').value = ''; $('#dlg-users').showModal(); }

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
    $('#admin-actions').hidden = !isAdmin;
    $('#btn-saldo').hidden = !isAdmin;
    pantalla('#app');
    render();
    await cargarDatos();
    try { await cargarCartera(); } catch (e) { /* la cartera se vuelve a intentar en la próxima sincronización */ }
    render();
    $('#sync').textContent = 'Actualizado ' + new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(new Date());
    setInterval(sincronizar, 30000);
    if (isAdmin) { revisarBuzon(); setInterval(revisarBuzon, 120000); }
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

  // ---------- arranque ----------
  async function iniciar() {
    if (!window.crypto || !crypto.subtle) {
      $('#carga-msg').textContent = 'Este navegador no permite el cifrado necesario. Abre la página desde la dirección https:// publicada en GitHub Pages.';
      return;
    }
    [S.rDesde, S.rHasta] = rangeDates('mes');
    $('#r-desde').value = S.rDesde; $('#r-hasta').value = S.rHasta;
    let v = location.hash === '#reporte' ? 'rep' : '';
    if (!v) { try { v = localStorage.getItem('pagos.view') || ''; } catch (e) {} }
    setView(v || 'aprob');

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
  iniciar();
})();
