// Movimientos de banco de Odesa Bienes y Servicios: el libro auxiliar que exporta World Office Escritorio
// (Cuenta, Tercero, Fecha, Nota, Débitos, Créditos, Saldo) y, para conciliar, el extracto del banco en PDF.
// La conciliación es contra el libro auxiliar (lo que World Office tiene registrado), no contra Siigo: en
// Bienes y Servicios no hay conexión automática, así que lo que falte hay que registrarlo en World Office.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmt, fmtDate, dtFmt, nuevoId } = A;
  const R = 'datos/obs-banco.enc';
  const BASE = () => ({ periodos: [], extractos: [] });
  const V = { datos: null, leido: 0, q: '', periodo: '', cuenta: '', modo: 'movs', mesConc: '' };
  const nf = (n) => Math.round(Number(n) || 0).toLocaleString('es-CO');

  async function leer(forzar) {
    if (V.datos && !forzar && Date.now() - V.leido < 10 * 60e3) return;
    const f = await GH.leer(R);
    V.datos = f ? Object.assign(BASE(), await Cripto.descifrarJSON(A.maestra, f.bytes)) : BASE();
    V.leido = Date.now();
  }
  async function mutar(fn) {
    for (let i = 0; i < 4; i++) {
      const f = await GH.leer(R);
      const d = f ? Object.assign(BASE(), await Cripto.descifrarJSON(A.maestra, f.bytes)) : BASE();
      if (fn(d) === false) return false;
      try { await GH.escribir(R, await Cripto.cifrarJSON(A.maestra, d), f ? f.sha : null); V.datos = d; return true; }
      catch (e) { if (i === 3 || !e.conflicto) throw e; await new Promise((ok) => setTimeout(ok, 700)); }
    }
  }

  function fechaISO(txt) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(txt || ''));
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
  }
  const numero = (s) => Number(String(s || '0').replace(/[^\d.-]/g, '')) || 0;

  // Formato del libro auxiliar: fila 1 "Libro Auxiliar entre DD/MM/AAAA y DD/MM/AAAA", fila 3 encabezados,
  // luego filas con Cuenta (solo en la primera fila de cada cuenta), Tercero, Fecha, Nota, Cheque, Doc Num,
  // Débitos, Créditos, Saldo. Al final trae filas "Total ..." que no son movimientos.
  function parseLibroAuxiliar(rows) {
    const mr = /entre\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+y\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec((rows[1] || []).join(' '));
    const desde = mr ? fechaISO(mr[1]) : '', hasta = mr ? fechaISO(mr[2]) : '';
    const cuentas = new Map();
    let cuentaAct = null;
    for (let i = 4; i < rows.length; i++) {
      const r = rows[i] || [];
      const c0 = String(r[0] || '').trim();
      if (/^Total\b/i.test(c0)) continue;
      if (c0) { cuentaAct = c0; if (!cuentas.has(c0)) cuentas.set(c0, []); }
      if (!cuentaAct) continue;
      const tercero = String(r[1] || '').trim(), fecha = fechaISO(r[2]), nota = String(r[3] || '').trim();
      const cheque = String(r[4] || '').trim(), doc = String(r[5] || '').trim();
      const debito = numero(r[6]), credito = numero(r[7]), saldo = numero(r[8]);
      if (!tercero && !fecha && !nota && !debito && !credito) continue;
      cuentas.get(cuentaAct).push({ tercero, fecha, nota, cheque, doc, debito, credito, saldo });
    }
    const lista = [...cuentas.entries()].map(([cuenta, movimientos]) => ({ cuenta, movimientos }));
    if (!lista.some((c) => c.movimientos.length)) throw new Error('No encontré movimientos. ¿Es el Libro Auxiliar exportado de World Office?');
    return { desde, hasta, cuentas: lista };
  }

  function abrirSubir() {
    let leido = null;
    OBSForm.abrir('Subir libro auxiliar', `
      <div class="field full"><label for="ob-file">Libro auxiliar (Excel de World Office)</label><input type="file" id="ob-file" accept=".xls,.xlsx"></div>
      <div class="full" id="ob-res"></div>`,
    async () => {
      if (!leido) throw new Error('Escoge el archivo del libro auxiliar.');
      await mutar((d) => {
        d.periodos = (d.periodos || []).filter((p) => !(p.desde === leido.desde && p.hasta === leido.hasta));
        d.periodos.push({ id: nuevoId(), desde: leido.desde, hasta: leido.hasta, archivo: leido.archivoNombre, subido: new Date().toISOString(), por: A.uid, cuentas: leido.cuentas });
      });
      V.periodo = leido.desde + '|' + leido.hasta;
    }, 'Guardar movimientos', () => render());
    $('#obs-go').disabled = true;
    $('#ob-file').addEventListener('change', async (ev) => {
      const file = ev.target.files[0]; const res = $('#ob-res'); leido = null; $('#obs-go').disabled = true;
      if (!file) { res.innerHTML = ''; return; }
      if (!window.XLSX) { res.innerHTML = '<p class="rh-asis-falta">No se pudo cargar el lector de Excel. Recarga la página.</p>'; return; }
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
        const r = parseLibroAuxiliar(rows);
        leido = { desde: r.desde, hasta: r.hasta, cuentas: r.cuentas, archivoNombre: file.name };
        const movs = r.cuentas.flatMap((c) => c.movimientos);
        const deb = movs.reduce((s, m) => s + m.debito, 0), cred = movs.reduce((s, m) => s + m.credito, 0);
        const yaExiste = (V.datos.periodos || []).some((p) => p.desde === r.desde && p.hasta === r.hasta);
        res.innerHTML = `<p class="proy-nota">Del <b>${r.desde ? esc(fmtDate(r.desde)) : '?'}</b> al <b>${r.hasta ? esc(fmtDate(r.hasta)) : '?'}</b> · ${r.cuentas.length} ${r.cuentas.length === 1 ? 'cuenta' : 'cuentas'} · ${movs.length} movimientos · entradas ${nf(deb)} · salidas ${nf(cred)}.${yaExiste ? ' <b>Ya había un periodo con este rango; se reemplaza.</b>' : ''}</p>`;
        $('#obs-go').disabled = false;
      } catch (e) { res.innerHTML = `<p class="rh-asis-falta">${esc(e.message || 'No se pudo leer el archivo.')}</p>`; }
    });
  }

  // ---------- extracto del banco (PDF) ----------
  // Cargos que el banco mismo cobra o retiene (4x1000, comisiones, intereses, retenciones por ventas con
  // datáfono) y que normalmente no se escriben uno a uno en World Office: se reconocen solos y aparte,
  // sin bloquear la conciliación del mes.
  const GASTOS_BANCO = [
    [/4X1000|GRAVAMEN|\bGMF\b/, 'Impuesto 4x1000'],
    [/INTERES/, 'Intereses de la cuenta'],
    [/MANEJO TARJETA/, 'Manejo de tarjeta'],
    [/RTE\s*FUENTE/, 'Retefuente (datáfono)'],
    [/RTE\s*ICA/, 'ReteICA (datáfono)'],
    [/RTE\s*IVA|COBRO IVA/, 'IVA sobre servicios del banco'],
    [/COMISION|SERVICIO\b/, 'Comisiones y servicios del banco'],
  ];
  function gastoBanco(desc) {
    const s = String(desc || '').toUpperCase();
    for (const [re, t] of GASTOS_BANCO) if (re.test(s)) return t;
    return null;
  }
  const montoExtracto = (s) => {
    let t = String(s || '').replace(/[$\s]/g, '');
    const neg = /^-|\(.*\)$|-$/.test(t);
    t = t.replace(/[()-]/g, '');
    t = /,\d{2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    const v = Number(t);
    return isFinite(v) ? (neg ? -v : v) : NaN;
  };

  // Extracto de Bancolombia: encabezado "DESDE: AAAA/MM/DD HASTA: AAAA/MM/DD" y un RESUMEN (saldo anterior,
  // total abonos, total cargos, saldo actual); luego renglones "D/MM DESCRIPCIÓN VALOR SALDO" (puede repetir
  // el encabezado de columnas en cada página).
  async function leerExtracto(file) {
    if (typeof Lector === 'undefined' || !Lector.pdfjs) throw new Error('No cargó el lector de PDF. Recarga la página.');
    const lib = await Lector.pdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const lineas = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 40); i++) {
      const items = (await (await pdf.getPage(i)).getTextContent()).items.filter((it) => String(it.str).trim());
      const filas = [];
      for (const it of items) {
        const y = it.transform[5], x = it.transform[4];
        let f = filas.find((r) => Math.abs(r.y - y) < 2.5);
        if (!f) { f = { y, partes: [] }; filas.push(f); }
        f.partes.push({ x, s: String(it.str).trim() });
      }
      filas.sort((a, b) => b.y - a.y).forEach((f) => lineas.push(f.partes.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ')));
    }
    const tx = lineas.join('\n');
    const mr = /DESDE:\s*(\d{4})\/(\d{2})\/(\d{2})\s*HASTA:\s*(\d{4})\/(\d{2})\/(\d{2})/i.exec(tx);
    if (!mr) throw new Error('No reconocí este extracto. ¿Es el estado de cuenta del banco en PDF?');
    const desde = `${mr[1]}-${mr[2]}-${mr[3]}`, hasta = `${mr[4]}-${mr[5]}-${mr[6]}`;
    const tomar = (re) => { const m = re.exec(tx); return m ? montoExtracto(m[1]) : null; };
    const resumen = {
      saldoAnterior: tomar(/SALDO ANTERIOR\s*\$?\s*([\d.,]+)/i),
      totalAbonos: tomar(/TOTAL ABONOS\s*\$?\s*([\d.,]+)/i),
      totalCargos: tomar(/TOTAL CARGOS\s*\$?\s*([\d.,]+)/i),
      saldoActual: tomar(/SALDO ACTUAL\s*\$?\s*([\d.,]+)/i),
    };
    const out = [];
    for (const l of lineas) {
      const m = /^(\d{1,2})\/(\d{1,2})\s+(.+)$/.exec(l);
      if (!m) continue;
      const resto = m[3];
      const montos = [...resto.matchAll(/-?\$?\s?\d{1,3}(?:[.,]\d{3})*\.\d{2}-?/g)].map((x) => x[0]);
      if (montos.length < 2) continue; // se espera valor y saldo
      const desc = resto.slice(0, resto.indexOf(montos[0])).replace(/\s+/g, ' ').trim();
      const valor = montoExtracto(montos[0]), saldo = montoExtracto(montos[montos.length - 1]);
      if (!isFinite(valor) || !desc) continue;
      // El mes puede incluir un día o dos del mes anterior (el extracto empieza en SALDO ANTERIOR del día de corte previo)
      const mesLinea = Number(m[2]) === Number(hasta.slice(5, 7)) ? hasta.slice(0, 7) : `${hasta.slice(0, 4)}-${m[2].padStart(2, '0')}`;
      out.push({ fecha: `${mesLinea}-${m[1].padStart(2, '0')}`, desc, valor, saldo });
    }
    if (!out.length) throw new Error('No encontré movimientos en el extracto.');
    return { desde, hasta, resumen, lineas: out };
  }

  function abrirSubirExtracto() {
    let leido = null;
    OBSForm.abrir('Subir extracto del banco', `
      <div class="field full"><label for="oe-file">Extracto del banco (PDF)</label><input type="file" id="oe-file" accept="application/pdf,.pdf"></div>
      <div class="full" id="oe-res"></div>`,
    async () => {
      if (!leido) throw new Error('Escoge el PDF del extracto.');
      await mutar((d) => {
        d.extractos = (d.extractos || []).filter((p) => !(p.desde === leido.desde && p.hasta === leido.hasta));
        d.extractos.push({ id: nuevoId(), desde: leido.desde, hasta: leido.hasta, archivo: leido.archivoNombre, subido: new Date().toISOString(), por: A.uid, resumen: leido.resumen, lineas: leido.lineas });
      });
      V.modo = 'conc'; V.mesConc = leido.hasta.slice(0, 7);
    }, 'Guardar extracto', () => render());
    $('#obs-go').disabled = true;
    $('#oe-file').addEventListener('change', async (ev) => {
      const file = ev.target.files[0]; const res = $('#oe-res'); leido = null; $('#obs-go').disabled = true;
      if (!file) { res.innerHTML = ''; return; }
      try {
        const r = await leerExtracto(file);
        leido = { ...r, archivoNombre: file.name };
        const yaExiste = (V.datos.extractos || []).some((p) => p.desde === r.desde && p.hasta === r.hasta);
        res.innerHTML = `<p class="proy-nota">Del <b>${esc(fmtDate(r.desde))}</b> al <b>${esc(fmtDate(r.hasta))}</b> · ${r.lineas.length} movimientos · saldo anterior ${fmt(r.resumen.saldoAnterior)} · saldo actual ${fmt(r.resumen.saldoActual)}.${yaExiste ? ' <b>Ya había un extracto con este rango; se reemplaza.</b>' : ''}</p>`;
        $('#obs-go').disabled = false;
      } catch (e) { res.innerHTML = `<p class="rh-asis-falta">${esc(e.message || 'No se pudo leer el archivo.')}</p>`; }
    });
  }

  // ---------- conciliación: cruza el libro auxiliar contra el extracto, mes a mes ----------
  const diasEntre = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  function mesesDisponibles(d) {
    const s = new Set();
    for (const p of d.periodos || []) for (const c of p.cuentas) for (const m of c.movimientos) if (m.fecha) s.add(m.fecha.slice(0, 7));
    for (const e of d.extractos || []) for (const l of e.lineas) if (l.fecha) s.add(l.fecha.slice(0, 7));
    return [...s].sort().reverse();
  }
  function datosMes(d, mes, cuentaFiltro) {
    const ini = mes + '-01', fin = mes + '-31';
    const libro = [];
    for (const p of d.periodos || []) for (const c of p.cuentas) { if (cuentaFiltro && c.cuenta !== cuentaFiltro) continue; for (const m of c.movimientos) if (m.fecha >= ini && m.fecha <= fin) libro.push({ ...m, valor: m.debito - m.credito }); }
    const extracto = (d.extractos || []).find((e) => e.desde <= fin && e.hasta >= ini) || null;
    const lineas = extracto ? extracto.lineas.filter((l) => l.fecha >= ini && l.fecha <= fin) : [];
    const gastosBanco = [], normales = [];
    for (const l of lineas) { const t = gastoBanco(l.desc); if (t) gastosBanco.push({ ...l, tipo: t }); else normales.push({ ...l, usado: false }); }
    const cruzados = [], faltaEnExtracto = [];
    for (const m of libro.slice().sort((a, b) => a.fecha.localeCompare(b.fecha))) {
      const c = normales.filter((l) => !l.usado && Math.abs(l.valor - m.valor) < 1 && m.fecha >= diasEntre(l.fecha, -4) && m.fecha <= diasEntre(l.fecha, 4))
        .sort((a, b) => Math.abs(Date.parse(a.fecha) - Date.parse(m.fecha)) - Math.abs(Date.parse(b.fecha) - Date.parse(m.fecha)))[0];
      if (c) { c.usado = true; cruzados.push({ m, l: c }); } else faltaEnExtracto.push(m);
    }
    const faltaEnLibro = normales.filter((l) => !l.usado);
    const gruposGasto = new Map();
    for (const g of gastosBanco) gruposGasto.set(g.tipo, (gruposGasto.get(g.tipo) || 0) + g.valor);
    return { extracto, cruzados, faltaEnExtracto, faltaEnLibro, gastosBanco, gruposGasto, libroTotal: libro.reduce((s, m) => s + m.valor, 0) };
  }

  function renderConciliacion(d) {
    const meses = mesesDisponibles(d);
    if (!meses.length) return '<div class="empty"><p>Sube el libro auxiliar y el extracto del banco para poder conciliar.</p></div>';
    if (!V.mesConc || !meses.includes(V.mesConc)) V.mesConc = meses[0];
    const cuentas = [...new Set((d.periodos || []).flatMap((p) => p.cuentas.map((c) => c.cuenta)))];
    const r = datosMes(d, V.mesConc, V.cuenta);
    const mesTxt = (m) => { const [y, mm] = m.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, mm - 1, 15)); };
    const barra = `<div class="rh-barra">
        <div class="field"><label for="oc-mes">Mes a conciliar</label><select id="oc-mes">${meses.map((m) => `<option value="${esc(m)}"${m === V.mesConc ? ' selected' : ''}>${esc(mesTxt(m))}</option>`).join('')}</select></div>
        ${cuentas.length > 1 ? `<div class="field"><label for="ob-cuenta">Cuenta</label><select id="ob-cuenta"><option value="">Todas</option>${cuentas.map((c) => `<option value="${esc(c)}"${c === V.cuenta ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>` : ''}
        ${A.isAdmin ? '<button class="btn" type="button" data-obsbanco="subir-extracto">Subir extracto del banco</button>' : ''}
      </div>`;
    if (!r.extracto) {
      return barra + `<div class="empty"><h3>Aún no hay extracto de ${esc(mesTxt(V.mesConc))}</h3><p>${A.isAdmin ? 'Sube el PDF del extracto de ese mes para poder conciliarlo.' : 'La administradora debe subir el extracto de ese mes.'}</p></div>`;
    }
    const conciliado = !r.faltaEnExtracto.length && !r.faltaEnLibro.length;
    const totalGastoBanco = [...r.gruposGasto.values()].reduce((s, v) => s + v, 0);
    return barra + `
      <section class="proy-caja"><h3>${conciliado ? '✔ Mes conciliado' : 'Falta por conciliar'}</h3>
        <p class="proy-nota">Según el libro auxiliar (en el mes): ${fmt(r.libroTotal)} · según el extracto: abonos ${fmt(r.extracto.resumen.totalAbonos)} − cargos ${fmt(r.extracto.resumen.totalCargos)} = ${fmt((r.extracto.resumen.totalAbonos || 0) - (r.extracto.resumen.totalCargos || 0))} · saldo anterior ${fmt(r.extracto.resumen.saldoAnterior)} → saldo actual ${fmt(r.extracto.resumen.saldoActual)}.</p>
        <p class="proy-nota">${r.cruzados.length} movimientos cruzan exactos entre el libro y el extracto.</p>
        ${conciliado ? `<button class="btn primary" type="button" data-obsbanco="informe">Generar informe de conciliación</button>` : ''}
      </section>
      <section class="proy-caja"><h3>Gastos del banco (reconocidos automáticamente) · ${fmt(totalGastoBanco)}</h3>
        <p class="proy-nota">4x1000, comisiones, intereses y retenciones del datáfono: el banco los cobra solo, normalmente no se escriben uno a uno en World Office.</p>
        ${r.gruposGasto.size ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Tipo</th><th class="n">Valor</th></tr></thead><tbody>${[...r.gruposGasto.entries()].sort((a, b) => a[1] - b[1]).map(([t, v]) => `<tr><td>${esc(t)}</td><td class="n">${fmt(v)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="proy-nota"><i>No hubo este mes.</i></p>'}
      </section>
      <section class="proy-caja"><h3>Falta registrar en World Office · ${r.faltaEnLibro.length}</h3>
        <p class="proy-nota">Movimientos del extracto del banco que no aparecen (por ese valor y esa fecha) en el libro auxiliar.</p>
        ${r.faltaEnLibro.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Descripción</th><th class="n">Valor</th></tr></thead><tbody>${r.faltaEnLibro.sort((a, b) => a.fecha.localeCompare(b.fecha)).map((l) => `<tr><td>${esc(fmtDate(l.fecha))}</td><td>${esc(l.desc)}</td><td class="n">${fmt(l.valor)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="proy-nota"><i>No hay pendientes.</i></p>'}
      </section>
      <section class="proy-caja"><h3>Falta en el banco · ${r.faltaEnExtracto.length}</h3>
        <p class="proy-nota">Movimientos del libro auxiliar que no aparecen (por ese valor y esa fecha) en el extracto. Revisa la fecha o el valor con que quedaron registrados en World Office.</p>
        ${r.faltaEnExtracto.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Tercero</th><th>Nota</th><th class="n">Valor</th></tr></thead><tbody>${r.faltaEnExtracto.sort((a, b) => a.fecha.localeCompare(b.fecha)).map((m) => `<tr><td>${esc(fmtDate(m.fecha))}</td><td>${esc(m.tercero)}</td><td>${esc(m.nota)}</td><td class="n">${fmt(m.valor)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="proy-nota"><i>No hay pendientes.</i></p>'}
      </section>`;
  }

  function abrirInforme(d) {
    const r = datosMes(d, V.mesConc, V.cuenta);
    if (!r.extracto) return;
    const totalGastoBanco = [...r.gruposGasto.values()].reduce((s, v) => s + v, 0);
    const mesTxt = (m) => { const [y, mm] = m.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, mm - 1, 15)); };
    OBSForm.abrir(`Informe de conciliación · ${mesTxt(V.mesConc)}`, `
      <div class="full">
        <p><b>Odesa Bienes y Servicios</b> · Conciliación bancaria de ${esc(mesTxt(V.mesConc))}</p>
        <table class="rh-tabla"><tbody>
          <tr><td>Saldo según libro auxiliar al inicio del mes</td><td class="n">${fmt(r.extracto.resumen.saldoAnterior)}</td></tr>
          <tr><td>Movimientos del mes según el libro auxiliar</td><td class="n">${fmt(r.libroTotal)}</td></tr>
          <tr><td>Gastos del banco no registrados en World Office</td><td class="n">${fmt(totalGastoBanco)}</td></tr>
          <tr class="tot"><td>Saldo según el banco al cierre del mes</td><td class="n">${fmt(r.extracto.resumen.saldoActual)}</td></tr>
        </tbody></table>
        <p class="proy-nota">Conciliado el ${esc(dtFmt.format(new Date()))}${r.faltaEnExtracto.length || r.faltaEnLibro.length ? ' · aún con partidas pendientes, revísalas antes de usar este informe.' : ' · sin partidas pendientes.'}</p>
      </div>`,
    async () => {}, 'Cerrar', null, '');
  }

  function render() {
    const d = V.datos || BASE();
    const periodos = (d.periodos || []).slice().sort((a, b) => b.hasta.localeCompare(a.hasta));
    const cuerpo = $('#obsbanco-cuerpo');
    if (!periodos.length) {
      cuerpo.innerHTML = `<div class="empty"><h3>Aún no hay movimientos cargados</h3><p>${A.isAdmin ? 'Sube el libro auxiliar que exportas de World Office.' : 'La administradora debe subir el libro auxiliar.'}</p>${A.isAdmin ? '<button class="btn primary" type="button" data-obsbanco="subir">Subir libro auxiliar</button>' : ''}</div>`;
      return;
    }
    const pestanas = `<div class="quick" role="group" aria-label="Sección"><button class="qbtn" type="button" data-obsbanco-modo="movs" aria-pressed="${V.modo === 'movs'}">Movimientos</button><button class="qbtn" type="button" data-obsbanco-modo="conc" aria-pressed="${V.modo === 'conc'}">Conciliación</button></div>`;
    if (V.modo === 'conc') { cuerpo.innerHTML = pestanas + renderConciliacion(d); return; }
    const clave = (p) => p.desde + '|' + p.hasta;
    if (!V.periodo || !periodos.some((p) => clave(p) === V.periodo)) V.periodo = clave(periodos[0]);
    const per = periodos.find((p) => clave(p) === V.periodo) || periodos[0];
    if (!V.cuenta || !per.cuentas.some((c) => c.cuenta === V.cuenta)) V.cuenta = per.cuentas[0] ? per.cuentas[0].cuenta : '';
    const cuentasSel = V.cuenta ? per.cuentas.filter((c) => c.cuenta === V.cuenta) : per.cuentas;
    const movs = cuentasSel.flatMap((c) => c.movimientos).sort((a, b) => b.fecha.localeCompare(a.fecha));
    const q = V.q.trim().toLowerCase();
    const filtrados = movs.filter((m) => !q || (m.tercero + ' ' + m.nota + ' ' + m.doc).toLowerCase().includes(q));
    const deb = filtrados.reduce((s, m) => s + m.debito, 0), cred = filtrados.reduce((s, m) => s + m.credito, 0);
    // Top terceros por salida (créditos: pagos/egresos) — responde "en qué se gastaron los recursos"
    const porTercero = new Map();
    for (const m of filtrados) { if (!m.credito) continue; const t = m.tercero || '(sin tercero)'; porTercero.set(t, (porTercero.get(t) || 0) + m.credito); }
    const topTerceros = [...porTercero.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    // Totales por mes
    const porMes = new Map();
    for (const m of filtrados) { const k = m.fecha.slice(0, 7); if (!k) continue; const x = porMes.get(k) || { deb: 0, cred: 0 }; x.deb += m.debito; x.cred += m.credito; porMes.set(k, x); }
    const meses = [...porMes.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    cuerpo.innerHTML = pestanas + `
      <div class="rh-barra">
        <div class="field"><label for="ob-periodo">Periodo</label><select id="ob-periodo">${periodos.map((p) => `<option value="${esc(clave(p))}"${clave(p) === V.periodo ? ' selected' : ''}>${esc(fmtDate(p.desde))} a ${esc(fmtDate(p.hasta))}</option>`).join('')}</select></div>
        ${per.cuentas.length > 1 ? `<div class="field"><label for="ob-cuenta">Cuenta</label><select id="ob-cuenta">${per.cuentas.map((c) => `<option value="${esc(c.cuenta)}"${c.cuenta === V.cuenta ? ' selected' : ''}>${esc(c.cuenta)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="ob-buscar">Buscar</label><input id="ob-buscar" value="${esc(V.q)}" placeholder="Tercero, nota o documento" autocomplete="off"></div>
        ${A.isAdmin ? '<button class="btn" type="button" data-obsbanco="subir">Subir nuevo periodo</button>' : ''}
      </div>
      <p class="proy-nota">${filtrados.length} movimientos${q ? ' (filtrados)' : ''} · entradas ${nf(deb)} · salidas ${nf(cred)} · neto ${nf(deb - cred)} · subido el ${esc(dtFmt.format(new Date(per.subido)))}${per.archivo ? ' · ' + esc(per.archivo) : ''}</p>
      <section class="proy-caja"><h3>En qué se gastaron los recursos (top terceros por salida)</h3>
        ${topTerceros.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Tercero</th><th class="n">Total salidas</th></tr></thead><tbody>${topTerceros.map(([t, v]) => `<tr><td>${esc(t)}</td><td class="n">${nf(v)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="proy-nota"><i>No hay salidas en este filtro.</i></p>'}
      </section>
      <section class="proy-caja"><h3>Totales por mes</h3>
        <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Mes</th><th class="n">Entradas</th><th class="n">Salidas</th><th class="n">Neto</th></tr></thead><tbody>${meses.map(([k, x]) => `<tr><td>${esc(k)}</td><td class="n">${nf(x.deb)}</td><td class="n">${nf(x.cred)}</td><td class="n">${nf(x.deb - x.cred)}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section class="proy-caja"><h3>Movimientos</h3>
        <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Tercero</th><th>Nota</th><th>Documento</th><th class="n">Débito</th><th class="n">Crédito</th><th class="n">Saldo</th></tr></thead><tbody>${filtrados.slice(0, 500).map((m) => `<tr><td>${esc(fmtDate(m.fecha) || m.fecha)}</td><td>${esc(m.tercero)}</td><td>${esc(m.nota)}</td><td>${esc(m.doc)}</td><td class="n">${m.debito ? nf(m.debito) : ''}</td><td class="n">${m.credito ? nf(m.credito) : ''}</td><td class="n">${nf(m.saldo)}</td></tr>`).join('')}</tbody></table></div>
        ${filtrados.length > 500 ? `<p class="proy-nota">Mostrando los primeros 500 de ${filtrados.length}. Usa el buscador para acotar.</p>` : ''}
      </section>`;
  }

  async function abrir() {
    $('#obsbanco-cuerpo').innerHTML = '<div class="empty"><h3>Cargando…</h3></div>';
    try { await leer(); render(); }
    catch (e) { $('#obsbanco-cuerpo').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${esc(A.msgGitHub(e))}</p></div>`; }
  }

  document.addEventListener('click', (ev) => {
    if (!$('#view-obsbanco') || $('#view-obsbanco').hidden) return;
    if (ev.target.closest('[data-obsbanco="subir"]')) { abrirSubir(); return; }
    if (ev.target.closest('[data-obsbanco="subir-extracto"]')) { abrirSubirExtracto(); return; }
    if (ev.target.closest('[data-obsbanco="informe"]')) { abrirInforme(V.datos || BASE()); return; }
    const m = ev.target.closest('[data-obsbanco-modo]');
    if (m) { V.modo = m.dataset.obsbancoModo; V.cuenta = ''; render(); }
  });
  document.addEventListener('change', (ev) => {
    if (!$('#view-obsbanco') || $('#view-obsbanco').hidden) return;
    if (ev.target.id === 'ob-periodo') { V.periodo = ev.target.value; V.cuenta = ''; render(); }
    if (ev.target.id === 'ob-cuenta') { V.cuenta = ev.target.value; render(); }
    if (ev.target.id === 'oc-mes') { V.mesConc = ev.target.value; render(); }
  });
  document.addEventListener('input', (ev) => {
    if (!$('#view-obsbanco') || $('#view-obsbanco').hidden) return;
    if (ev.target.id === 'ob-buscar') { V.q = ev.target.value; render(); }
  });

  window.OBSBANCO = { abrir };
})();
