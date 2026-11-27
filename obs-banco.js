// Movimientos de banco de Odesa Bienes y Servicios: el libro auxiliar que exporta World Office Escritorio
// (Cuenta, Tercero, Fecha, Nota, Débitos, Créditos, Saldo). Por ahora es un informe de lo registrado en los
// libros (en qué se gastaron los recursos); la conciliación contra el extracto del banco en PDF es la fase 2.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmtDate, dtFmt, nuevoId } = A;
  const R = 'datos/obs-banco.enc';
  const V = { datos: null, leido: 0, q: '', periodo: '', cuenta: '' };
  const nf = (n) => Math.round(Number(n) || 0).toLocaleString('es-CO');

  async function leer(forzar) {
    if (V.datos && !forzar && Date.now() - V.leido < 10 * 60e3) return;
    const f = await GH.leer(R);
    V.datos = f ? await Cripto.descifrarJSON(A.maestra, f.bytes) : { periodos: [] };
    V.leido = Date.now();
  }
  async function mutar(fn) {
    for (let i = 0; i < 4; i++) {
      const f = await GH.leer(R);
      const d = f ? await Cripto.descifrarJSON(A.maestra, f.bytes) : { periodos: [] };
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

  function render() {
    const d = V.datos || { periodos: [] };
    const periodos = (d.periodos || []).slice().sort((a, b) => b.hasta.localeCompare(a.hasta));
    const cuerpo = $('#obsbanco-cuerpo');
    if (!periodos.length) {
      cuerpo.innerHTML = `<div class="empty"><h3>Aún no hay movimientos cargados</h3><p>${A.isAdmin ? 'Sube el libro auxiliar que exportas de World Office.' : 'La administradora debe subir el libro auxiliar.'}</p>${A.isAdmin ? '<button class="btn primary" type="button" data-obsbanco="subir">Subir libro auxiliar</button>' : ''}</div>`;
      return;
    }
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
    cuerpo.innerHTML = `
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
    if (ev.target.closest('[data-obsbanco="subir"]')) abrirSubir();
  });
  document.addEventListener('change', (ev) => {
    if (!$('#view-obsbanco') || $('#view-obsbanco').hidden) return;
    if (ev.target.id === 'ob-periodo') { V.periodo = ev.target.value; V.cuenta = ''; render(); }
    if (ev.target.id === 'ob-cuenta') { V.cuenta = ev.target.value; render(); }
  });
  document.addEventListener('input', (ev) => {
    if (!$('#view-obsbanco') || $('#view-obsbanco').hidden) return;
    if (ev.target.id === 'ob-buscar') { V.q = ev.target.value; render(); }
  });

  window.OBSBANCO = { abrir };
})();
