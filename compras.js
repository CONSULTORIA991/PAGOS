// Facturas de compra: el Excel de documentos recibidos de la DIAN contra Siigo.
// - La administradora sube el Excel de un periodo (lo que llaman "el token"); se guardan solo las facturas y notas
//   RECIBIDAS, por CUFE, en datos/facturas-compra.enc. Lo repetido no se duplica.
// - El computador de contabilidad publica en datos/compras-siigo.enc lo que ya está en Siigo (compras-siigo.js):
//   facturas de compra por NIT y número, historial por proveedor, cuentas con su rubro del informe de proyectos,
//   retenciones y formas de pago.
// - "Registrar compra" deja en la cola de Siigo (marca "fc") la factura de compra con sus renglones, IVA, retenciones,
//   forma de pago y centro de costo; si se cruza un anticipo, también el comprobante 20. Si se pide, pasa a
//   Proveedores (por revisar) para pagarla por Cuadra.
// Regla: la cuenta del gasto o costo debe tener rubro en el informe de proyectos, para que el informe salga bien.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmt, fmtDate, toast, msgGitHub, todayISO } = A;
  const R_SIIGO = 'datos/compras-siigo.enc', R_FC = 'datos/facturas-compra.enc', R_PCONF = 'datos/proyectos-conf.enc';
  const F = { siigo: null, d: null, mapa: {}, mes: '', vista: 'pend', q: '', leido: 0, cargando: false, envios: [], timer: null };
  const isAdmin = () => !!A.isAdmin;
  const C = () => A.compras;
  const base = () => ({ docs: {}, cargues: [], reg: {}, ign: {}, apr: {} });
  const dig = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const suma = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const plural = (n, uno, varios) => `${n.toLocaleString('es-CO')} ${n === 1 ? uno : varios}`;
  const mesTxt = (mes) => { const [y, m] = mes.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 15)); };
  const fCorta = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d)).replace('.', ''); };
  const masDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const titulo = (r) => { const s = String(r || '').toLowerCase().replace('electrica', 'eléctrica').replace('tuberia', 'tubería').replace('garantias', 'garantías').replace('viaticos', 'viáticos'); return s.charAt(0).toUpperCase() + s.slice(1); };

  async function leer(forzar) {
    if (F.d && !forzar && Date.now() - F.leido < 5 * 60e3) return;
    const [fs, fd, fp] = await Promise.all([GH.leer(R_SIIGO), GH.leer(R_FC), GH.leer(R_PCONF)]);
    F.siigo = fs ? await Cripto.descifrarJSON(A.maestra, fs.bytes) : null;
    F.d = Object.assign(base(), fd ? await Cripto.descifrarJSON(A.maestra, fd.bytes) : {});
    try { F.mapa = fp ? ((await Cripto.descifrarJSON(A.maestra, fp.bytes)).mapa || {}) : {}; } catch (e) { F.mapa = {}; }
    F.leido = Date.now();
    indices();
  }
  async function mutar(fn) {
    for (let i = 0; i < 4; i++) {
      const fd = await GH.leer(R_FC);
      const d = Object.assign(base(), fd ? await Cripto.descifrarJSON(A.maestra, fd.bytes) : {});
      if (fn(d) === false) return false;
      d.editado = { en: new Date().toISOString(), por: A.uid };
      try { await GH.escribir(R_FC, await Cripto.cifrarJSON(A.maestra, d), fd ? fd.sha : null); F.d = d; return true; }
      catch (e) { if (i === 3 || !e.conflicto) throw e; await new Promise((ok) => setTimeout(ok, 700)); }
    }
  }

  // ---------- índices: Siigo, cajas menores y pagos de Cuadra ----------
  let IDX = new Map(), OTROS = new Map(), CUENTAS = new Map();
  function indices() {
    IDX = new Map(); OTROS = new Map(); CUENTAS = new Map();
    for (const x of (F.siigo && F.siigo.fcs) || []) { const k = x[0] + '|' + x[1]; if (!IDX.has(k)) IDX.set(k, x); }
    for (const x of (F.siigo && F.siigo.otros) || []) { const k = x[0] + '|' + x[1]; if (!OTROS.has(k)) OTROS.set(k, x); }
    for (const [c, n, r] of (F.siigo && F.siigo.cuentas) || []) CUENTAS.set(c, { nombre: n, rubro: r });
    // Lo que la administradora reclasificó en el informe de proyectos manda
    for (const [c, r] of Object.entries(F.mapa || {})) { if (!/^\d{8}$/.test(c) || /^4/.test(c)) continue; if (r === 'NO INCLUIR') { CUENTAS.delete(c); continue; } CUENTAS.set(c, { nombre: (CUENTAS.get(c) || {}).nombre || '', rubro: r === 'MANO DE OBRA DIRECTA' ? 'SALARIOS OPERATIVOS PROYECTO' : r }); }
  }
  const rubroDe = (c) => (CUENTAS.get(String(c)) || {}).rubro || '';
  const ctaTxt = (c) => { const x = CUENTAS.get(String(c)); return x ? `${c} · ${x.nombre}${x.rubro ? ' — ' + titulo(x.rubro) : ''}` : String(c || ''); };
  const claves = (doc) => [doc.nit + '|' + dig(doc.f), doc.nit + '|' + dig(String(doc.p || '') + String(doc.f || ''))];
  // Pagos de Cuadra y soportes de cajas menores con la misma factura
  function enCuadra(doc) {
    const n = dig(doc.f), out = { pago: null, caja: null };
    for (const p of C().pagos()) {
      if (p.tipoDoc === 'caja') { for (const s of p.soportes || []) if (String(s.nit || '').replace(/\D/g, '') === doc.nit && dig(s.numero) === n) out.caja = p; continue; }
      if (String(p.nit || '').replace(/\D/g, '') === doc.nit && dig(p.factura) === n && p.tipoDoc !== 'anticipo') out.pago = p;
    }
    return out;
  }
  // estado: siigo | enviando | error | caja | ign | pend ; nc = nota crédito
  function estadoDe(cufe, doc) {
    const reg = F.d.reg[cufe];
    if (doc.t !== 'F') { const s = claves(doc).map((k) => IDX.get(k)).find(Boolean); return { k: 'nc', s }; }
    if (reg && reg.estado === 'siigo') return { k: 'siigo', fc: reg.fc, reg };
    const s = claves(doc).map((k) => IDX.get(k)).find(Boolean);
    if (s) return { k: 'siigo', fc: s[2], saldo: s[5], s };
    const o = claves(doc).map((k) => OTROS.get(k)).find(Boolean);
    if (o) return { k: 'siigo', fc: o[2], comp: true };
    if (reg && reg.estado === 'enviando') {
      const e = F.envios.find((x) => x.id === reg.envioId);
      if (e && e.estado === 'error') return { k: 'error', reg, e };
      if (e && e.estado === 'listo') return { k: 'siigo', fc: (e.hechos.find((h) => h.i === 0) || {}).nombre || 'Siigo', reg };
      return { k: 'enviando', reg, e };
    }
    if (reg && reg.estado === 'error') return { k: 'error', reg, e: F.envios.find((x) => x.id === reg.envioId) };
    if (F.d.ign[cufe]) return { k: 'ign', ign: F.d.ign[cufe] };
    const cu = enCuadra(doc);
    if (cu.caja) return { k: 'caja', caja: cu.caja };
    return { k: 'pend', pago: cu.pago };
  }

  // ---------- Excel de la DIAN ----------
  const TIPOS = { 'factura electrónica': 'F', 'factura electronica': 'F', 'nota de crédito electrónica': 'NC', 'nota de credito electronica': 'NC', 'nota de débito electrónica': 'ND', 'nota de debito electronica': 'ND' };
  const IMP_OTROS = ['ICA', 'IC', 'INC', 'Timbre', 'INC Bolsas', 'IN Carbono', 'IN Combustibles', 'IC Datos', 'ICL', 'INPP', 'IBUA', 'ICUI'];
  function fechaISO(v) {
    if (typeof v === 'number' && window.XLSX) { const p = XLSX.SSF.parse_date_code(v); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
    const s = String(v || '').trim();
    let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }
  const numX = (v) => (typeof v === 'number' ? v : Number(String(v || '').replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')) || 0);
  function leerExcel(buf) {
    if (!window.XLSX) throw new Error('No cargó el lector de Excel. Recarga la página.');
    const wb = XLSX.read(buf, { type: 'array' });
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    const hi = filas.findIndex((r) => r.some((c) => /CUFE/i.test(String(c))));
    if (hi < 0) throw new Error('Este archivo no parece el Excel de documentos de la DIAN (no encontré la columna CUFE/CUDE).');
    const H = filas[hi].map((c) => String(c).trim());
    const col = (n) => H.findIndex((h) => h.toLowerCase() === n.toLowerCase());
    const ix = { tipo: col('Tipo de documento'), cufe: H.findIndex((h) => /CUFE/i.test(h)), folio: col('Folio'), pref: col('Prefijo'), fp: col('Forma de Pago'), fecha: col('Fecha Emisión'), nit: col('NIT Emisor'), nom: col('Nombre Emisor'), nitR: col('NIT Receptor'), iva: col('IVA'), tot: col('Total'), grupo: col('Grupo') };
    if (ix.fecha < 0) ix.fecha = H.findIndex((h) => /fecha emisi/i.test(h));
    const otros = IMP_OTROS.map(col).filter((i) => i >= 0);
    const out = {}; let total = 0, omitidos = 0;
    for (const r of filas.slice(hi + 1)) {
      const cufe = String(r[ix.cufe] || '').trim();
      if (!cufe) continue;
      total++;
      const t = TIPOS[String(r[ix.tipo] || '').trim().toLowerCase()];
      if (!t || (ix.grupo >= 0 && !/recibido/i.test(String(r[ix.grupo])))) { omitidos++; continue; }
      out[cufe] = { t, p: String(r[ix.pref] || '').trim(), f: String(r[ix.folio] || '').trim(), d: fechaISO(r[ix.fecha]), nit: String(r[ix.nit] || '').replace(/\D/g, ''), n: String(r[ix.nom] || '').replace(/\s+/g, ' ').trim(),
        iva: r2(numX(r[ix.iva])), otros: r2(suma(otros, (i) => numX(r[i]))), tot: r2(numX(r[ix.tot])), fp: String(r[ix.fp] || '').trim() };
    }
    return { docs: out, total, omitidos };
  }
  async function cargar(file) {
    const r = leerExcel(await file.arrayBuffer());
    const n = Object.keys(r.docs).length;
    if (!n) throw new Error(`El archivo tiene ${r.total} documentos pero ninguno es una factura o nota recibida.`);
    let nuevos = 0;
    const fechas = Object.values(r.docs).map((x) => x.d).filter(Boolean).sort();
    await mutar((d) => {
      nuevos = 0;
      for (const [k, x] of Object.entries(r.docs)) { if (!d.docs[k]) nuevos++; d.docs[k] = x; }
      d.cargues = [{ en: new Date().toISOString(), por: A.uid, archivo: file.name.slice(0, 80), docs: n, nuevos, desde: fechas[0], hasta: fechas[fechas.length - 1] }, ...(d.cargues || [])].slice(0, 60);
    });
    F.mes = fechas[fechas.length - 1].slice(0, 7);
    toast(`${plural(n, 'factura o nota recibida', 'facturas y notas recibidas')}: ${nuevos ? plural(nuevos, 'nueva', 'nuevas') : 'ninguna nueva'} (lo repetido no se duplica).`);
  }

  // ---------- pantalla ----------
  async function abrir() {
    if (F.cargando) return;
    F.cargando = true;
    $('#fcomp-cuerpo').innerHTML = '<div class="empty"><h3>Cargando las facturas de compra…</h3></div>';
    try {
      await leer();
      await refrescarEnvios();
      const meses = mesesCon();
      if (!F.mes || !meses.includes(F.mes)) F.mes = meses[0] || todayISO().slice(0, 7);
      render();
      vigilar();
    } catch (e) { $('#fcomp-cuerpo').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${esc(msgGitHub(e))}</p></div>`; }
    F.cargando = false;
  }
  const mesesCon = () => [...new Set(Object.values(F.d.docs).map((x) => (x.d || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  async function refrescarEnvios() { try { F.envios = (await C().envios()).filter((e) => e.marca === 'fc'); } catch (e) { /* luego */ } }
  // Mientras haya facturas subiendo, se revisa cada 15 s
  function vigilar() {
    clearInterval(F.timer);
    F.timer = setInterval(async () => {
      if ($('#view-fcomp').hidden) { clearInterval(F.timer); return; }
      const sub = Object.values(F.d.reg || {}).some((r) => r.estado === 'enviando' && !['listo', 'error'].includes((F.envios.find((e) => e.id === r.envioId) || {}).estado));
      if (!sub) return;
      await refrescarEnvios();
      try { await leer(true); } catch (e) { return; }
      if (!$('#dlg-fcomp').open) render();
    }, 15000);
  }

  function filasMes() {
    const q = F.q.trim().toUpperCase();
    return Object.entries(F.d.docs).filter(([, x]) => (x.d || '').slice(0, 7) === F.mes)
      .map(([cufe, doc]) => ({ cufe, doc, st: estadoDe(cufe, doc) }))
      .filter((r) => !q || (r.doc.n + ' ' + r.doc.nit + ' ' + r.doc.p + '-' + r.doc.f).toUpperCase().includes(q))
      .sort((a, b) => (a.doc.d < b.doc.d ? 1 : a.doc.d > b.doc.d ? -1 : a.doc.n.localeCompare(b.doc.n)));
  }
  function cobertura() {
    const l = (F.d.cargues || []).filter((c) => c.desde && c.hasta);
    if (!l.length) return '';
    const rangos = l.map((c) => [c.desde, c.hasta]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), un = [];
    for (const r of rangos) { const u = un[un.length - 1]; if (u && r[0] <= masDias(u[1], 1)) { if (r[1] > u[1]) u[1] = r[1]; } else un.push([...r]); }
    return un.map(([a, b]) => `${fmtDate(a)} al ${fmtDate(b)}`).join(' · ');
  }
  function sugerido(doc) {
    const ap = (F.d.apr || {})[doc.nit], h = ((F.siigo && F.siigo.hist) || {})[doc.nit];
    const cuenta = (ap && ap.cuenta) || (h && h.cuentas[0]) || '', cc = (ap && ap.cc) || (h && h.cc) || '';
    return { cuenta, cc, rets: (ap && ap.rets) || (h && h.rets) || [], pago: (ap && ap.pago) || (h && h.pago) || null, de: ap ? 'cuadra' : h ? 'siigo' : '', h };
  }
  function render() {
    const meses = mesesCon(), cob = cobertura();
    const pasos = [['Subir el Excel de la DIAN', 'En la DIAN, Documentos → Recibidos, filtra el periodo y descarga el Excel. Súbelo aquí: lo repetido no se duplica.'], ['Cuadra lo cruza con Siigo', 'Cada factura se busca en Siigo por NIT y número (facturas de compra y comprobantes). También mira las cajas menores.'], ['Registrar las que faltan', 'Revisa cuenta, obra, retenciones y forma de pago (vienen sugeridas) y súbela a Siigo.'], ['Pagarlas por Cuadra', 'Las de crédito pasan a Proveedores para aprobarlas y pagarlas; la conciliación cruza el pago con la factura.']];
    const cab = `
      <div class="rh-barra"><div class="grupo">${meses.length ? `<div class="field"><label for="fc-mes">Mes</label><select id="fc-mes">${meses.map((m) => `<option value="${m}"${m === F.mes ? ' selected' : ''}>${esc(mesTxt(m))}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="fc-q">Buscar</label><input id="fc-q" type="search" value="${esc(F.q)}" placeholder="Proveedor, NIT o factura"></div></div>
        <div class="grupo">${isAdmin() ? '<button class="btn primary" type="button" data-fc="cargar">Subir Excel de la DIAN</button><input type="file" id="fc-file" accept=".xlsx,.xls" hidden>' : ''}</div></div>
      <section class="cj-camino" aria-label="Cómo funciona"><h3>Así se trabaja</h3><ol>${pasos.map(([t, d], i) => `<li class="hecho"><b><span>${i + 1}</span>${t}</b><small>${d}</small></li>`).join('')}</ol></section>`;
    if (!meses.length) {
      $('#fcomp-cuerpo').innerHTML = cab + `<div class="empty"><h3>Aún no hay facturas cargadas</h3><p>${isAdmin() ? 'Sube el Excel de documentos recibidos de la DIAN de un mes (por ejemplo octubre).' : 'La administradora aún no ha cargado el Excel de la DIAN.'}</p></div>`;
      return;
    }
    const todas = filasMes();
    const g = (k) => todas.filter((r) => r.st.k === k);
    const pend = g('pend'), siigo = g('siigo'), env = [...g('enviando'), ...g('error')], caja = g('caja'), nc = g('nc'), ign = g('ign');
    const facturas = todas.filter((r) => r.doc.t === 'F');
    const conSaldo = siigo.filter((r) => r.st.saldo >= 1 && !enCuadra(r.doc).pago);
    const estado = pend.length ? (pend.length > facturas.length / 4 ? 'rojo' : 'amarillo') : 'verde';
    const sig = F.siigo;
    const vistas = [['pend', `Por registrar (${pend.length})`], ['env', `Subiendo o con error (${env.length})`], ['caja', `En cajas menores (${caja.length})`], ['siigo', `Ya en Siigo (${siigo.length})`], ['nc', `Notas crédito (${nc.length})`], ['ign', `No se registran (${ign.length})`]];
    if (!vistas.some(([k]) => k === F.vista)) F.vista = 'pend';
    let lista;
    if (F.vista === 'pend') lista = seccionPend(pend);
    else if (F.vista === 'siigo') lista = seccionSiigo(siigo, conSaldo);
    else if (F.vista === 'env') lista = seccionEnv(env);
    else if (F.vista === 'caja') lista = tabla(caja, 'En cajas menores', 'Están como soporte de una caja menor en Cuadra. Se suben a Siigo con el comprobante 14 de la caja: no las registres aquí para no duplicarlas.', (r) => `<span class="pr-chip amarillo">Caja ${esc((r.st.caja.caja || {}).numero || '')} · ${esc((r.st.caja.caja || {}).responsable || r.st.caja.proveedor || '')}</span>`);
    else if (F.vista === 'nc') lista = tabla(nc, 'Notas crédito', 'Notas crédito y débito de proveedores. Por ahora se registran en Siigo directamente; aquí ves si ya están.', (r) => r.st.s ? `<span class="pr-chip verde">En Siigo · ${esc(r.st.s[2])}</span>` : '<span class="pr-chip gris">Revisar en Siigo</span>');
    else lista = tabla(ign, 'No se registran', 'Las marcaste para no registrar (por ejemplo, una factura repetida o que no es de ODESA).', (r) => `<span class="sub">${esc(r.st.ign.motivo || '')}</span>${isAdmin() ? ` <button class="btn sm ghost" type="button" data-fc="designorar" data-cufe="${esc(r.cufe)}">Volver a registrar</button>` : ''}`);
    $('#fcomp-cuerpo').innerHTML = cab + `
      <div class="proy-frase"><h2>${esc(mesTxt(F.mes))}: llegaron ${plural(facturas.length, 'factura', 'facturas')} de proveedores; ${siigo.length.toLocaleString('es-CO')} ya ${siigo.length === 1 ? 'está' : 'están'} en Siigo. ${pend.length ? `Faltan ${pend.length} por registrar.` : 'No falta ninguna.'}</h2><span class="proy-estado ${estado}">${estado === 'verde' ? 'Al día' : `Faltan ${pend.length}`}</span></div>
      <p class="proy-nota">${cob ? `Excel de la DIAN cargado del ${esc(cob)}.` : ''} ${sig ? `Datos de Siigo del ${esc(new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(sig.comprasEn || sig.actualizado)))}: una factura registrada hace poco en Siigo puede tardar hasta 4 horas en aparecer.` : 'Aún no llegan los datos de compras de Siigo: el computador de contabilidad los sube cada hora.'}</p>
      <section class="pk-grid">
        <div class="pk"><span class="pk-t">Facturas recibidas</span><span class="pk-v">${facturas.length.toLocaleString('es-CO')}</span><span class="pk-a">${fmt(suma(facturas, (r) => r.doc.tot))} con IVA</span></div>
        <div class="pk"><span class="pk-t">Ya en Siigo</span><span class="pk-v pos">${siigo.length.toLocaleString('es-CO')}</span><span class="pk-a">${facturas.length ? Math.round(siigo.length / facturas.length * 100) : 0} % de las facturas</span><span class="pk-b"><span class="verde" style="width:${facturas.length ? (siigo.length / facturas.length * 100).toFixed(1) : 0}%"></span></span></div>
        <div class="pk ${pend.length ? 'mal' : ''}"><span class="pk-t">Por registrar</span><span class="pk-v">${pend.length.toLocaleString('es-CO')}</span><span class="pk-a">${fmt(suma(pend, (r) => r.doc.tot))}</span></div>
        <div class="pk"><span class="pk-t">En cajas menores</span><span class="pk-v">${caja.length.toLocaleString('es-CO')}</span><span class="pk-a">Van con el comprobante 14</span></div>
      </section>
      <nav class="quick" role="group" aria-label="Ver">${vistas.map(([k, t]) => `<button class="qbtn" type="button" data-fc-ver="${k}" aria-pressed="${F.vista === k}">${t}</button>`).join('')}</nav>
      ${lista}
      <details class="pres-det"><summary>Cargues del Excel de la DIAN</summary><ul class="proy-cuentas">${(F.d.cargues || []).slice(0, 15).map((c) => `<li><span>${esc(fmtDate(c.en.slice(0, 10)))} · ${esc(c.archivo)} · del ${esc(fmtDate(c.desde))} al ${esc(fmtDate(c.hasta))}</span><b>${c.docs} (${c.nuevos} nuevas)</b></li>`).join('')}</ul></details>`;
  }
  const filaDoc = (r) => `<td>${esc(fCorta(r.doc.d))}</td><td>${esc(r.doc.n)}<br><span class="sub">NIT ${esc(r.doc.nit)}</span></td><td>${esc(r.doc.p ? r.doc.p + '-' : '')}${esc(r.doc.f.replace(new RegExp('^' + r.doc.p.replace(/[^A-Z0-9]/gi, '')), '') || r.doc.f)}</td><td class="n">${fmt(r.doc.tot)}</td>`;
  function tabla(l, tit, nota, extra) {
    return `<section class="proy-caja"><h3>${esc(tit)}</h3><p class="proy-nota">${esc(nota)}</p>${l.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th><th class="n">Total</th><th></th></tr></thead><tbody>${l.map((r) => `<tr>${filaDoc(r)}<td>${extra(r)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="proy-nota">Nada en este mes.</p>'}</section>`;
  }
  function seccionPend(l) {
    if (!l.length) return '<p class="proy-nota">✓ Todas las facturas de este mes están en Siigo, en una caja menor o marcadas para no registrar.</p>';
    return `<section class="proy-caja"><h3>Por registrar en Siigo · ${l.length}</h3><p class="proy-nota">Debajo de cada una va lo que sugiero (de sus compras anteriores en Siigo o de lo que registraste aquí). Toca "Registrar compra" para revisarlo y subirla.</p>
      <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th><th class="n">Total</th><th>Sugerido</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${l.map((r) => {
        const s = sugerido(r.doc), rb = rubroDe(s.cuenta);
        const sug = s.cuenta ? `${esc(s.cuenta)} ${rb ? '→ ' + esc(titulo(rb)) : '<span class="neg">sin rubro</span>'}${s.cc ? '<br><span class="sub">' + esc(C().ccTexto(s.cc)) + '</span>' : ''}` : '<span class="sub">Proveedor nuevo: escoges la cuenta</span>';
        return `<tr>${filaDoc(r)}<td>${sug}${r.st.pago ? '<br><span class="pr-chip azul">Ya está en Proveedores</span>' : ''}</td>${isAdmin() ? `<td class="n"><button class="btn sm primary" type="button" data-fc="registrar" data-cufe="${esc(r.cufe)}">Registrar compra</button></td>` : ''}</tr>`;
      }).join('')}</tbody></table></div></section>`;
  }
  function seccionSiigo(l, conSaldo) {
    return `${conSaldo.length && isAdmin() ? `<section class="proy-caja"><div class="pr-cab"><div><h3>En Siigo con saldo, sin pago en Cuadra · ${conSaldo.length}</h3><p class="proy-nota">Facturas que se deben en Siigo y no están en Proveedores. Pásalas para que los jefes las aprueben y se paguen por Cuadra.</p></div>
        <button class="btn primary" type="button" data-fc="pasar-todas">Pasar las ${conSaldo.length} a Proveedores</button></div></section>` : ''}
      ${tabla(l, 'Ya en Siigo', 'Encontradas en Siigo por NIT y número de factura.', (r) => {
        const cu = enCuadra(r.doc).pago;
        return `<span class="pr-chip verde">${esc(r.st.fc)}</span>${r.st.saldo >= 1 ? `<br><span class="sub">Saldo ${fmt(r.st.saldo)}</span>` : r.st.s ? '<br><span class="sub">Pagada</span>' : ''}${cu ? `<br><span class="pr-chip azul">En Proveedores: ${esc({ revisar: 'por revisar', aprobado: 'aprobada', pendiente: 'pendiente', pagado: 'pagada' }[cu.estado] || cu.estado)}</span>` : r.st.saldo >= 1 && isAdmin() ? ` <button class="btn sm" type="button" data-fc="pasar" data-cufe="${esc(r.cufe)}">Pasar a Proveedores</button>` : ''}`;
      })}`;
  }
  function seccionEnv(l) {
    return tabla(l, 'Subiendo a Siigo o con error', 'El computador de la oficina las crea en Siigo en 1–2 minutos. Si algo falla, corrígelo y vuelve a enviar.', (r) => {
      const e = r.st.e;
      if (r.st.k === 'enviando') return `<span class="pr-chip amarillo">${e && e.estado === 'enviando' ? 'Creándose en Siigo…' : 'Esperando al computador de la oficina…'}</span>`;
      const prob = e ? [...(e.problemas || []), e.error || ''].filter(Boolean).join(' · ') : 'No se pudo subir.';
      return `<span class="pr-chip rojo">No se subió</span><br><span class="sub">${esc(prob.slice(0, 260))}</span>${isAdmin() ? `<br><button class="btn sm primary" type="button" data-fc="registrar" data-cufe="${esc(r.cufe)}">Corregir y volver a enviar</button>` : ''}`;
    });
  }

  // ---------- registrar compra ----------
  const R = { cufe: null, lineas: [], adj: null, pdfCC: '' };
  const taxes = (tipo) => ((F.siigo && F.siigo.taxes) || []).filter((t) => t.tipo === tipo);
  function idIVA(pct) {
    const l = taxes('IVA').filter((t) => t.pct === pct);
    return (l.find((t) => (pct === 19 && t.id === 9412) || (pct === 5 && t.id === 9577)) || l[0] || {}).id || 0;
  }
  const pctIVA = (id) => (taxes('IVA').find((t) => t.id === Number(id)) || {}).pct || 0;
  // Renglones a partir de los valores de la DIAN: separa lo gravado al 19 % (o 5 %) de lo que no tiene IVA
  // Descripción como la usa ODESA en Siigo: número de la factura y nombre de la cuenta ("C-2331814 Transporte terrestre")
  const factDe = (doc) => { const p = doc.p || (String(doc.f).match(/^[A-Z]+/i) || [''])[0]; const n = dig(doc.f) || doc.f; return p ? `${p}-${n}` : n; };
  const descDe = (doc, cuenta, sinIva) => `${factDe(doc)} ${((CUENTAS.get(String(cuenta)) || {}).nombre || 'Compra')}${sinIva ? ' (sin IVA)' : ''}`.slice(0, 120);
  function renglonesDe(doc, s) {
    const l = (base, iva, sin) => ({ cuenta: s.cuenta, descripcion: descDe(doc, s.cuenta, sin), auto: true, sin, base, iva });
    const sinIva = r2(doc.tot - doc.iva);
    if (doc.iva < 1) return [l(sinIva, 0, false)];
    for (const pct of [19, 5]) {
      const g = r2(doc.iva / (pct / 100)), resto = r2(sinIva - g);
      if (Math.abs(resto) <= 1) return [l(sinIva, idIVA(pct), false)];
      if (pct === 19 && resto > 1) return [l(g, idIVA(19), false), l(resto, 0, true)];
    }
    return [l(sinIva, idIVA(19), false)];
  }
  function calc() {
    const rets = ['#fr-rf', '#fr-ica', '#fr-riva'].map((s) => { const v = $(s) && $(s).value; if (!v) return null; const t = ((F.siigo && F.siigo.taxes) || []).find((x) => String(x.id) === v); return t ? { id: t.id, nombre: t.nombre, pct: t.pct, tipo: t.tipo } : null; }).filter(Boolean);
    let base = 0, iva = 0, ret = 0;
    const det = rets.map((r) => ({ ...r, valor: 0 }));
    for (const l of R.lineas) {
      const b = r2(l.base), vi = l.iva ? r2(b * pctIVA(l.iva) / 100) : 0;
      base += b; iva += vi;
      det.forEach((r) => { const v = r.tipo === 'ReteIVA' ? r2(vi * r.pct / 100) : r2(b * r.pct / (r.tipo === 'ReteICA' ? 1000 : 100)); r.valor = r2(r.valor + v); ret += v; });
    }
    const total = r2(base + iva - ret);
    const cruces = [...document.querySelectorAll('[data-frant]:checked')].map((c) => {
      const x = (R.ants || []).find((a) => a.id === c.dataset.frant); const inp = document.querySelector(`[data-frantv="${c.dataset.frant}"]`);
      return x ? { anticipoId: x.id, prefijo: x.prefijo, numero: x.numero, vence: x.vence, valor: Math.min(Number(String(inp.value).replace(/\D/g, '')) || 0, x.saldo), factura: x.factura } : null;
    }).filter(Boolean);
    const mp = $('#fr-antm-doc') && $('#fr-antm-doc').value.trim(), mv = $('#fr-antm-val') && Number($('#fr-antm-val').value.replace(/\D/g, ''));
    if (mp && mv > 0) { const pf = C().partirFactura(mp); cruces.push({ anticipoId: 'manual', prefijo: pf.prefijo, numero: pf.numero, vence: '', valor: mv, factura: mp.toUpperCase() }); }
    return { base: r2(base), iva: r2(iva), ret: r2(ret), rets: det, total, cruces, totalCruces: suma(cruces, (c) => c.valor) };
  }
  function opcRet(tipo, sel, nada, porMil) {
    return `<option value="">${nada}</option>` + taxes(tipo).map((t) => `<option value="${t.id}"${sel.includes(t.id) ? ' selected' : ''}>${esc(t.nombre)}${porMil ? ' (por mil)' : ''}</option>`).join('');
  }
  function abrirRegistro(cufe) {
    const doc = F.d.docs[cufe];
    if (!doc) return;
    const s = sugerido(doc), cu = enCuadra(doc), centros = C().centros();
    R.cufe = cufe; R.adj = null; R.pdfCC = '';
    const prev = (F.d.reg[cufe] || {}).envio; // lo que se envió antes (si falló, para corregir)
    R.lineas = prev ? prev.items.map((x) => ({ ...x })) : renglonesDe(doc, s);
    R.ants = C().anticipos(doc.nit);
    // Formas de pago: las que se usan en las compras (más usadas primero); las demás, aparte
    const uso = (F.siigo && F.siigo.formasUso) || {};
    const formas = ((F.siigo && F.siigo.formas) || []).filter((f) => f.tipo === 'Proveedor' && !/ajuste|causaci/i.test(f.nombre)).sort((a, b) => (uso[b.id] || 0) - (uso[a.id] || 0));
    const usadas = formas.filter((f) => uso[f.id]), otras = formas.filter((f) => !uso[f.id]);
    const credito = formas.find((f) => f.id === 3688) || formas.find((f) => f.vence);
    const forma0 = prev ? prev.pago.id : (s.pago && formas.some((f) => f.id === s.pago) ? s.pago : (credito || {}).id);
    const cc0 = prev ? prev.cc : (cu.pago && cu.pago.cc) || s.cc || '';
    const rets0 = prev ? prev.retenciones.map((r) => r.id) : s.rets;
    $('#fcomp-dlg-titulo').textContent = `Registrar compra: ${doc.n}`;
    $('#fcomp-dlg-res').innerHTML = `
      <p class="proy-nota">Factura <b>${esc(doc.p ? doc.p + '-' : '')}${esc(doc.f)}</b> · NIT ${esc(doc.nit)} · emitida el ${esc(fmtDate(doc.d))} · ${doc.fp === '2' ? 'a crédito' : doc.fp === '1' ? 'de contado' : ''} según la DIAN · <b>Total ${fmt(doc.tot)}</b> (IVA ${fmt(doc.iva)}${doc.otros ? ', otros impuestos ' + fmt(doc.otros) : ''}).</p>
      ${!C().siigoListo() ? '<p class="proy-aviso">Faltan las credenciales de Siigo (Usuarios → Conexión con Siigo): no se puede subir.</p>' : ''}
      ${s.de ? `<p class="proy-aviso conc-aprendido">Lo llené con ${s.de === 'cuadra' ? 'lo que registraste antes aquí para este proveedor' : `sus compras anteriores en Siigo (${s.h.n} ${s.h.n === 1 ? 'factura' : 'facturas'}, la última ${esc(s.h.fc)} del ${esc(fmtDate(s.h.ult))})`}. Revísalo: Cuadra recuerda lo que cambies.</p>` : '<p class="proy-aviso">Es la primera compra de este proveedor: escoge la cuenta y la obra.</p>'}
      ${cu.pago ? `<p class="proy-nota">Esta factura ya está en Proveedores (${esc(cu.pago.concepto || '')}, ${esc(fmt(cu.pago.valor))}).${cu.pago.archivo ? ' Tiene la factura adjunta.' : ''} No se crea otro pago.</p>` : ''}
      <div class="grid">
        <div class="field"><label for="fr-fecha">Fecha de la factura</label><input id="fr-fecha" type="date" value="${esc(prev ? prev.fecha : doc.d)}"></div>
        <div class="field"><label for="fr-forma">Forma de pago</label><select id="fr-forma">${[usadas, otras].map((g, i) => { const o = g.map((f) => `<option value="${f.id}"${f.id === forma0 ? ' selected' : ''}>${esc(f.nombre)}${f.vence ? ' (queda por pagar)' : ''}</option>`).join(''); return i && usadas.length && o ? `<optgroup label="Otras formas de pago de Siigo">${o}</optgroup>` : o; }).join('')}</select></div>
        <div class="field" id="fr-vence-w"><label for="fr-vence">Vence</label><input id="fr-vence" type="date" value="${esc(prev ? prev.vence : masDias(doc.d, 30))}"></div>
        <div class="field"><label for="fr-cc">Obra (centro de costo)</label><input id="fr-cc" list="fr-ccs" autocomplete="off" value="${esc(cc0 ? C().ccTexto(cc0) : '')}" placeholder="Ej. 100068-1 · LAGOMAR"><datalist id="fr-ccs">${centros.map((c) => `<option value="${esc(c.codigo + ' · ' + c.nombre)}"></option>`).join('')}</datalist><span class="hint" id="fr-cc-hint"></span></div>
        <div class="field full"><label for="fr-pdf">La factura en PDF (opcional)</label><input id="fr-pdf" type="file" accept="application/pdf,image/*"><span class="hint">Si la adjuntas, la leo para buscar la obra y queda guardada con el pago en Proveedores.</span></div>
      </div>
      <section class="proy-caja"><h3>Renglones</h3><p class="proy-nota">La cuenta define el rubro del informe de proyectos. Solo aparecen cuentas que tienen rubro.</p>
        <datalist id="fr-ctas">${[...CUENTAS.entries()].map(([c]) => `<option value="${esc(ctaTxt(c))}"></option>`).join('')}</datalist>
        <div id="fr-lineas"></div><button class="btn sm" type="button" data-fr="mas">+ Agregar renglón</button></section>
      <div class="grid">
        <div class="field"><label for="fr-rf">Retención en la fuente</label><select id="fr-rf">${opcRet('Retefuente', rets0, 'Sin retención en la fuente')}</select></div>
        <div class="field"><label for="fr-ica">Retención de ICA</label><select id="fr-ica">${opcRet('ReteICA', rets0, 'Sin ReteICA', true)}</select></div>
        <div class="field"><label for="fr-riva">ReteIVA</label><select id="fr-riva">${opcRet('ReteIVA', rets0, 'Sin ReteIVA')}</select></div>
      </div>
      <section class="proy-caja" id="fr-ants-w"><h3>Anticipos por cruzar</h3>${R.ants.length ? R.ants.map((x) => `<label class="check" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="checkbox" data-frant="${esc(x.id)}"> ${esc(x.factura || 'Anticipo')} · pagado ${esc(fmtDate(x.fecha || ''))} · saldo ${fmt(x.saldo)}${x.prefijo && x.numero ? '' : ' <span class="neg">(sin prefijo/número)</span>'} <span>Cruzar</span><input data-frantv="${esc(x.id)}" inputmode="numeric" style="width:130px" value="${esc(x.saldo.toLocaleString('es-CO'))}"></label>`).join('') : '<p class="proy-nota">Este proveedor no tiene anticipos pagados por Cuadra pendientes de cruzar.</p>'}
        <details><summary>Cruzar un anticipo que está solo en Siigo</summary><div class="grid"><div class="field"><label for="fr-antm-doc">Documento del anticipo (prefijo-número)</label><input id="fr-antm-doc" placeholder="Ej. CC-2410"></div><div class="field"><label for="fr-antm-val">Valor a cruzar</label><input id="fr-antm-val" inputmode="numeric"></div></div></details></section>
      <label class="check" id="fr-prov-w"><input type="checkbox" id="fr-prov"${cu.pago ? ' disabled' : ' checked'}> Pasarla a Proveedores (por revisar) para pagarla por Cuadra</label>
      <div id="fr-resumen"></div>
      <p class="proy-aviso" id="fr-err" hidden></p>
      <div class="form-actions"><button class="btn" type="button" data-fr="ignorar">No registrar</button><button class="btn primary" type="button" data-fr="enviar">Registrar en Siigo</button></div>`;
    pintarLineas(); resumen();
    if (!$('#dlg-fcomp').open) $('#dlg-fcomp').showModal();
  }
  function pintarLineas() {
    $('#fr-lineas').innerHTML = R.lineas.map((l, i) => {
      const rb = rubroDe(l.cuenta);
      return `<div class="fr-linea" data-i="${i}">
        <div class="field"><label>Cuenta</label><input data-frl="cuenta" list="fr-ctas" value="${esc(l.cuenta ? ctaTxt(l.cuenta) : '')}" placeholder="Escribe el código o el nombre" autocomplete="off"><span class="hint ${l.cuenta && !rb ? 'neg' : ''}">${l.cuenta ? (rb ? 'Rubro: ' + esc(titulo(rb)) : 'Esta cuenta no tiene rubro en el informe de proyectos: caería en "Sin clasificar".') : ''}</span></div>
        <div class="field"><label>Descripción</label><input data-frl="descripcion" value="${esc(l.descripcion)}"></div>
        <div class="field"><label>Valor antes de IVA</label><input data-frl="base" inputmode="decimal" value="${esc(l.base.toLocaleString('es-CO'))}"></div>
        <div class="field"><label>IVA</label><select data-frl="iva"><option value="0">Sin IVA</option>${taxes('IVA').filter((t) => t.pct > 0 && [9412, 9577].includes(t.id)).map((t) => `<option value="${t.id}"${Number(l.iva) === t.id ? ' selected' : ''}>${esc(t.nombre)}</option>`).join('')}</select></div>
        ${R.lineas.length > 1 ? `<button class="btn sm ghost" type="button" data-fr="quitar" data-i="${i}">Quitar</button>` : ''}</div>`;
    }).join('');
  }
  function resumen() {
    const doc = F.d.docs[R.cufe]; if (!doc) return;
    const c = calc();
    const forma = ((F.siigo && F.siigo.formas) || []).find((f) => String(f.id) === $('#fr-forma').value) || {};
    $('#fr-vence-w').hidden = !forma.vence;
    $('#fr-ants-w').hidden = !forma.vence;
    $('#fr-prov-w').hidden = !forma.vence;
    const conIva = r2(c.base + c.iva), dif = r2(conIva - doc.tot);
    const porPagar = r2(c.total - (forma.vence ? c.totalCruces : 0));
    $('#fr-resumen').innerHTML = `<div class="preview"><table><tbody>
      <tr><td>Valor antes de IVA</td><td class="n">${fmt(c.base)}</td></tr><tr><td>+ IVA</td><td class="n">${fmt(c.iva)}</td></tr>
      <tr><td><b>Total de la factura</b> ${Math.abs(dif) <= 1 ? '<span class="pr-chip verde">cuadra con la DIAN</span>' : `<span class="pr-chip rojo">la DIAN dice ${fmt(doc.tot)} (diferencia ${fmt(dif)})</span>`}</td><td class="n"><b>${fmt(conIva)}</b></td></tr>
      ${c.rets.map((r) => `<tr><td>− ${esc(r.nombre)}${r.tipo === 'ReteICA' ? ' (por mil)' : ''}</td><td class="n">${fmt(r.valor)}</td></tr>`).join('')}
      <tr><td><b>Neto a pagar al proveedor</b></td><td class="n"><b>${fmt(c.total)}</b></td></tr>
      ${forma.vence ? c.cruces.map((x) => `<tr><td>− Anticipo ${esc(x.factura || '')} cruzado</td><td class="n">${fmt(x.valor)}</td></tr>`).join('') : ''}
      ${forma.vence && c.cruces.length ? `<tr><td><b>Queda por pagar</b></td><td class="n"><b>${fmt(porPagar)}</b></td></tr>` : ''}
    </tbody></table></div><p class="proy-nota">En Siigo: factura de compra a ${esc(forma.nombre || '—')}${forma.vence ? ` (22050501, vence ${esc(fmtDate($('#fr-vence').value || ''))})` : ''}${c.cruces.length && forma.vence ? ' y un comprobante 20 que cruza el anticipo' : ''}.</p>`;
    const b = document.querySelector('[data-fr="enviar"]'); if (b) { delete b.dataset.sure; b.textContent = 'Registrar en Siigo'; }
  }
  const errR = (m) => { const e = $('#fr-err'); if (e) { e.textContent = m || ''; e.hidden = !m; } };
  async function leerPDF(file) {
    if (typeof Lector === 'undefined' || !Lector.pdfjs || !/pdf/i.test(file.type || file.name)) return '';
    const lib = await Lector.pdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    let t = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 4); i++) t += ' ' + (await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ');
    return t;
  }
  async function enviar(btn) {
    errR('');
    const doc = F.d.docs[R.cufe];
    const c = calc();
    const forma = ((F.siigo && F.siigo.formas) || []).find((f) => String(f.id) === $('#fr-forma').value);
    const cc = C().ccDeInput($('#fr-cc').value), fecha = $('#fr-fecha').value, vence = $('#fr-vence').value;
    if (!C().siigoListo()) return errR('Faltan las credenciales de Siigo (Usuarios → Conexión con Siigo).');
    if (!cc) return errR('Escoge la obra (centro de costo) de la lista.');
    if (!fecha) return errR('Escribe la fecha de la factura.');
    if (!forma) return errR('Escoge la forma de pago.');
    if (forma.vence && !vence) return errR('Escribe el vencimiento.');
    for (const l of R.lineas) {
      if (!/^\d{8}$/.test(l.cuenta)) return errR('Cada renglón necesita una cuenta de 8 dígitos (escógela de la lista).');
      if (!rubroDe(l.cuenta)) return errR(`La cuenta ${l.cuenta} no tiene rubro en el informe de proyectos. Escoge otra o clasifícala primero en Informes de proyectos.`);
      if (!(l.base > 0)) return errR('Cada renglón necesita un valor mayor que cero.');
    }
    if (Math.abs(r2(c.base + c.iva) - doc.tot) > 1) return errR(`El total (${fmt(c.base + c.iva)}) no cuadra con la DIAN (${fmt(doc.tot)}). Ajusta los renglones o el IVA.`);
    if (forma.vence && c.totalCruces > c.total) return errR('Los anticipos a cruzar suman más que el neto de la factura.');
    if (forma.vence && c.cruces.some((x) => !x.prefijo || !x.numero)) return errR('Un anticipo marcado no tiene prefijo y número.');
    if (!btn.dataset.sure) { btn.dataset.sure = '1'; btn.textContent = '¿Crear la factura de compra en Siigo? Toca de nuevo'; setTimeout(() => { if (btn.dataset.sure) { delete btn.dataset.sure; btn.textContent = 'Registrar en Siigo'; } }, 7000); return; }
    delete btn.dataset.sure; btn.disabled = true; btn.textContent = 'Enviando a la cola…';
    try {
      const file = $('#fr-pdf').files[0];
      const adjunto = file ? await C().subirArchivo(file) : null;
      const pref = doc.p || (String(doc.f).match(/^[A-Z]+/i) || [''])[0];
      const fc = {
        cufe: R.cufe, fecha, vence: forma.vence ? vence : fecha, nit: doc.nit, nombre: doc.n, prefijo: String(pref).toUpperCase().slice(0, 6), numero: dig(doc.f) || doc.f, cc,
        totalDian: doc.tot, items: R.lineas.map((l) => ({ cuenta: l.cuenta, descripcion: l.descripcion, base: r2(l.base), iva: Number(l.iva) || 0 })),
        retenciones: c.rets.map((r) => ({ id: r.id, nombre: r.nombre, pct: r.pct, tipo: r.tipo })), pago: { id: forma.id, nombre: forma.nombre, vence: !!forma.vence },
        proveedores: !!(forma.vence && $('#fr-prov').checked && !$('#fr-prov').disabled), ...(adjunto ? { adjunto } : {}),
      };
      const id = await C().encolar({ marca: 'fc', tipo: 'FC', fc, cruces: forma.vence ? c.cruces.map((x) => ({ anticipoId: x.anticipoId, prefijo: x.prefijo, numero: x.numero, vence: x.vence, valor: x.valor })) : [] });
      // Lo aprendido para este proveedor (manda sobre el historial de Siigo)
      await mutar((d) => {
        const r = d.reg[R.cufe];
        if (r && r.estado === 'siigo') return false;
        d.reg[R.cufe] = { estado: 'enviando', envioId: id, en: new Date().toISOString(), por: A.uid, envio: fc };
        d.apr = d.apr || {}; d.apr[doc.nit] = { cuenta: fc.items[0].cuenta, cc, rets: fc.retenciones.map((r) => r.id), pago: forma.id, en: new Date().toISOString().slice(0, 10) };
        delete d.ign[R.cufe];
      });
      await refrescarEnvios();
      $('#dlg-fcomp').close();
      toast('Factura en cola: el computador de la oficina la crea en Siigo en 1–2 minutos.');
      render(); vigilar();
    } catch (e) { errR(e.message && !e.status ? e.message : msgGitHub(e)); }
    btn.disabled = false; btn.textContent = 'Registrar en Siigo';
  }

  // ---------- pasar a Proveedores lo que se debe en Siigo ----------
  async function pasar(cufes) {
    const l = cufes.map((k) => ({ cufe: k, doc: F.d.docs[k] })).map((r) => ({ ...r, st: estadoDe(r.cufe, r.doc) })).filter((r) => r.st.s && r.st.saldo >= 1 && !enCuadra(r.doc).pago);
    if (!l.length) return toast('Nada por pasar.');
    const n = await C().pasarAProveedores(l.map((r) => ({ proveedor: r.doc.n, nit: r.doc.nit, factura: `${r.st.s[7] || r.doc.p}${r.st.s[7] || r.doc.p ? '-' : ''}${r.st.s[1] || dig(r.doc.f)}`, valor: Math.round(r.st.saldo), vence: masDias(r.st.s[3], 30) > todayISO() ? masDias(r.st.s[3], 30) : todayISO(), cc: r.st.s[6] ? C().ccDeInput(r.st.s[6]) : '', fc: r.st.s[2], concepto: `Factura ${r.doc.p ? r.doc.p + '-' : ''}${r.doc.f}` })));
    toast(`${plural(n, 'factura pasó', 'facturas pasaron')} a Proveedores (por revisar).`);
    render();
  }

  // ---------- eventos ----------
  document.addEventListener('click', async (ev) => {
    const ver = ev.target.closest('[data-fc-ver]');
    if (ver) { F.vista = ver.dataset.fcVer; render(); return; }
    const b = ev.target.closest('[data-fc]');
    if (b) {
      const a = b.dataset.fc;
      if (a === 'cargar') { $('#fc-file').click(); return; }
      if (a === 'registrar') { abrirRegistro(b.dataset.cufe); return; }
      if (a === 'designorar') { await mutar((d) => { delete d.ign[b.dataset.cufe]; }); render(); return; }
      if (a === 'pasar') { b.disabled = true; try { await pasar([b.dataset.cufe]); } catch (e) { toast(msgGitHub(e)); } b.disabled = false; return; }
      if (a === 'pasar-todas') {
        if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '¿Pasarlas todas? Toca de nuevo'; setTimeout(() => { if (b.dataset.sure) { delete b.dataset.sure; render(); } }, 6000); return; }
        b.disabled = true;
        try { await pasar(filasMes().filter((r) => r.st.k === 'siigo').map((r) => r.cufe)); } catch (e) { toast(msgGitHub(e)); }
        return;
      }
    }
    const r = ev.target.closest('[data-fr]');
    if (r && $('#dlg-fcomp').contains(r)) {
      const a = r.dataset.fr;
      if (a === 'mas') { R.lineas.push({ cuenta: R.lineas[0] ? R.lineas[0].cuenta : '', descripcion: '', base: 0, iva: 0 }); pintarLineas(); resumen(); }
      if (a === 'quitar') { R.lineas.splice(Number(r.dataset.i), 1); pintarLineas(); resumen(); }
      if (a === 'enviar') await enviar(r);
      if (a === 'ignorar') {
        if (!r.dataset.sure) { r.dataset.sure = '1'; r.textContent = '¿No registrarla? Toca de nuevo'; setTimeout(() => { if (r.dataset.sure) { delete r.dataset.sure; r.textContent = 'No registrar'; } }, 6000); return; }
        const motivo = prompt('¿Por qué no se registra? (queda anotado)', 'Repetida / no es de ODESA') || '';
        await mutar((d) => { d.ign[R.cufe] = { en: new Date().toISOString(), por: A.uid, motivo: motivo.slice(0, 120) }; });
        $('#dlg-fcomp').close(); render();
      }
    }
  });
  document.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.id === 'fc-file' && t.files[0]) {
      const f = t.files[0]; t.value = '';
      $('#fcomp-cuerpo').insertAdjacentHTML('afterbegin', '<p class="proy-aviso" id="fc-leyendo">Leyendo el Excel…</p>');
      try { await cargar(f); } catch (e) { toast(e.message && !e.status ? e.message : msgGitHub(e)); }
      render(); return;
    }
    if (t.id === 'fc-mes') { F.mes = t.value; render(); return; }
    if (!$('#dlg-fcomp').contains(t)) return;
    if (t.dataset.frl) {
      const i = Number(t.closest('.fr-linea').dataset.i), l = R.lineas[i];
      if (t.dataset.frl === 'cuenta') { l.cuenta = (t.value.match(/^\s*(\d{8})/) || [])[1] || ''; if (l.auto) l.descripcion = descDe(F.d.docs[R.cufe], l.cuenta, l.sin); pintarLineas(); }
      else if (t.dataset.frl === 'base') { l.base = r2(A.parseMonto ? A.parseMonto(t.value) : Number(t.value.replace(/\./g, '').replace(',', '.'))); t.value = l.base.toLocaleString('es-CO'); }
      else if (t.dataset.frl === 'iva') l.iva = Number(t.value) || 0;
      else { l.descripcion = t.value; l.auto = false; }
      resumen(); return;
    }
    if (t.id === 'fr-pdf' && t.files[0]) {
      try {
        const txt = await leerPDF(t.files[0]);
        const cc = txt ? C().matchCentro(txt) : '';
        $('#fr-cc-hint').textContent = cc ? `La factura menciona ${C().ccTexto(cc)}: la puse como obra.` : txt ? 'Leí la factura pero no menciona una obra que reconozca.' : '';
        if (cc) $('#fr-cc').value = C().ccTexto(cc);
      } catch (e) { $('#fr-cc-hint').textContent = 'No pude leer el PDF; escoge la obra.'; }
      return;
    }
    resumen();
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'fc-q') { F.q = ev.target.value; const pos = ev.target.selectionStart; render(); const q = $('#fc-q'); q.focus(); q.setSelectionRange(pos, pos); return; }
    if ($('#dlg-fcomp').contains(ev.target) && /^fr-(antm|rf|ica|riva)/.test(ev.target.id || '') || ev.target.dataset.frantv) resumen();
  });

  window.FCOMP = { abrir, _leerExcel: leerExcel };
})();
