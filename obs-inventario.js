// Inventario de Odesa Bienes y Servicios: fotos del inventario (existencias a una fecha de corte),
// subidas desde la "Hoja de Conteo" que exporta World Office Escritorio. Guarda el historial de fotos
// para poder comparar existencias entre fechas más adelante.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmtDate, dtFmt, nuevoId } = A;
  const R = 'datos/obs-inventario.enc';
  const V = { datos: null, leido: 0, q: '', fecha: '' };
  const nf = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-CO');

  async function leer(forzar) {
    if (V.datos && !forzar && Date.now() - V.leido < 10 * 60e3) return;
    const f = await GH.leer(R);
    V.datos = f ? await Cripto.descifrarJSON(A.maestra, f.bytes) : { snapshots: [] };
    V.leido = Date.now();
  }
  async function mutar(fn) {
    for (let i = 0; i < 4; i++) {
      const f = await GH.leer(R);
      const d = f ? await Cripto.descifrarJSON(A.maestra, f.bytes) : { snapshots: [] };
      if (fn(d) === false) return false;
      try { await GH.escribir(R, await Cripto.cifrarJSON(A.maestra, d), f ? f.sha : null); V.datos = d; return true; }
      catch (e) { if (i === 3 || !e.conflicto) throw e; await new Promise((ok) => setTimeout(ok, 700)); }
    }
  }

  function fechaISO(txt) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(txt || ''));
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
  }

  // Formato de la Hoja de Conteo: fila 0 título con la fecha de corte, fila 1 encabezados, luego un árbol:
  // columna 0 = categoría, columna 1 = subcategoría, columna 2 = "código descripción" del producto (hoja),
  // columna 3 = unidad, columna 4 = existencias. Las categorías y subcategorías se repiten en las filas de abajo.
  function parseInventario(rows) {
    const fecha = fechaISO((rows[0] || []).join(' '));
    const items = [];
    let g1 = '', g2 = '';
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i] || [];
      const c0 = String(r[0] || '').trim(), c1 = String(r[1] || '').trim(), c2 = String(r[2] || '').trim(), c3 = String(r[3] || '').trim();
      if (!c0 && !c1 && !c2 && !c3 && String(r[4] || '') === '') continue;
      if (c0) { g1 = c0; g2 = ''; }
      else if (c1) { g2 = c1; }
      // Las filas sin "Desc" (c2) son el subtotal que el archivo deja al cerrar cada subcategoría, no un producto.
      if (c2) {
        const cm = /^(\S+)\s+(.+)$/.exec(c2);
        const existencias = Number(String(r[4] || '0').replace(/,/g, '')) || 0;
        items.push({ g1, g2, codigo: cm ? cm[1] : '', desc: cm ? cm[2] : c2, unidad: c3, existencias });
      }
    }
    if (!items.length) throw new Error('No encontré productos en el archivo. ¿Es la Hoja de Conteo de existencias de World Office?');
    return { fecha, items };
  }

  function abrirSubir() {
    let leido = null;
    OBSForm.abrir('Subir inventario', `
      <div class="field full"><label for="oi-file">Hoja de Conteo (Excel de World Office)</label><input type="file" id="oi-file" accept=".xls,.xlsx"></div>
      <div class="full" id="oi-res"></div>`,
    async () => {
      if (!leido) throw new Error('Escoge el archivo de existencias.');
      await mutar((d) => {
        d.snapshots = (d.snapshots || []).filter((s) => s.fecha !== leido.fecha);
        d.snapshots.push({ id: nuevoId(), fecha: leido.fecha, archivo: leido.archivoNombre, subido: new Date().toISOString(), por: A.uid, items: leido.items });
      });
      V.fecha = leido.fecha;
    }, 'Guardar inventario', () => render());
    $('#obs-go').disabled = true;
    $('#oi-file').addEventListener('change', async (ev) => {
      const file = ev.target.files[0]; const res = $('#oi-res'); leido = null; $('#obs-go').disabled = true;
      if (!file) { res.innerHTML = ''; return; }
      if (!window.XLSX) { res.innerHTML = '<p class="rh-asis-falta">No se pudo cargar el lector de Excel. Recarga la página.</p>'; return; }
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
        const r = parseInventario(rows);
        leido = { fecha: r.fecha, items: r.items, archivoNombre: file.name };
        const totalExist = r.items.reduce((s, it) => s + it.existencias, 0);
        const cats = new Set(r.items.map((it) => it.g1)).size;
        const yaExiste = (V.datos.snapshots || []).some((s) => s.fecha === r.fecha);
        res.innerHTML = `<p class="proy-nota">Corte al <b>${r.fecha ? esc(fmtDate(r.fecha)) : 'sin fecha detectada'}</b> · ${r.items.length} productos · ${cats} categorías · ${nf(totalExist)} unidades en existencia.${yaExiste ? ' <b>Ya había una foto con esta fecha; se reemplaza.</b>' : ''}</p>`;
        $('#obs-go').disabled = false;
      } catch (e) { res.innerHTML = `<p class="rh-asis-falta">${esc(e.message || 'No se pudo leer el archivo.')}</p>`; }
    });
  }

  function render() {
    const d = V.datos || { snapshots: [] };
    const snaps = (d.snapshots || []).slice().sort((a, b) => b.fecha.localeCompare(a.fecha));
    const cuerpo = $('#obsinv-cuerpo');
    if (!snaps.length) {
      cuerpo.innerHTML = `<div class="empty"><h3>Aún no hay inventario cargado</h3><p>${A.isAdmin ? 'Sube la Hoja de Conteo que exportas de World Office.' : 'La administradora debe subir el inventario.'}</p>${A.isAdmin ? '<button class="btn primary" type="button" data-obsinv="subir">Subir inventario</button>' : ''}</div>`;
      return;
    }
    if (!V.fecha || !snaps.some((s) => s.fecha === V.fecha)) V.fecha = snaps[0].fecha;
    const snap = snaps.find((s) => s.fecha === V.fecha) || snaps[0];
    const q = V.q.trim().toLowerCase();
    const coincide = (it) => !q || (it.codigo + ' ' + it.desc + ' ' + it.g1 + ' ' + it.g2).toLowerCase().includes(q);
    const items = snap.items.filter(coincide);
    const total = snap.items.reduce((s, it) => s + it.existencias, 0);
    const totalFiltrado = items.reduce((s, it) => s + it.existencias, 0);
    const porG1 = new Map();
    for (const it of items) {
      if (!porG1.has(it.g1)) porG1.set(it.g1, new Map());
      const porG2 = porG1.get(it.g1);
      const key = it.g2 || '';
      if (!porG2.has(key)) porG2.set(key, []);
      porG2.get(key).push(it);
    }
    const tablaItems = (l) => `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Código</th><th>Descripción</th><th>Unidad</th><th class="n">Existencias</th></tr></thead><tbody>${l.map((it) => `<tr><td>${esc(it.codigo)}</td><td>${esc(it.desc)}</td><td>${esc(it.unidad)}</td><td class="n">${nf(it.existencias)}</td></tr>`).join('')}</tbody></table></div>`;
    const grupos = [...porG1.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g1, porG2]) => {
      const itsG1 = [...porG2.values()].flat();
      const subgrupos = [...porG2.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g2, l]) => g2
        ? `<details class="rh-acc"><summary>${esc(g2)} · ${l.length} ítems · ${nf(l.reduce((s, it) => s + it.existencias, 0))} uds</summary>${tablaItems(l)}</details>`
        : tablaItems(l)).join('');
      return `<details class="rh-acc"><summary><b>${esc(g1 || 'Sin categoría')}</b> · ${itsG1.length} ítems · ${nf(itsG1.reduce((s, it) => s + it.existencias, 0))} uds</summary>${subgrupos}</details>`;
    }).join('');
    cuerpo.innerHTML = `
      <div class="rh-barra">
        <div class="field"><label for="oi-buscar">Buscar</label><input id="oi-buscar" value="${esc(V.q)}" placeholder="Código, descripción o categoría" autocomplete="off"></div>
        <div class="field"><label for="oi-fecha">Corte</label><select id="oi-fecha">${snaps.map((s) => `<option value="${esc(s.fecha)}"${s.fecha === V.fecha ? ' selected' : ''}>${esc(fmtDate(s.fecha) || s.fecha)}</option>`).join('')}</select></div>
        ${A.isAdmin ? '<button class="btn" type="button" data-obsinv="subir">Subir nuevo inventario</button>' : ''}
      </div>
      <p class="proy-nota">${items.length} de ${snap.items.length} productos · ${nf(totalFiltrado)} unidades${q ? ' (filtradas)' : ''} de ${nf(total)} en total · subido el ${esc(dtFmt.format(new Date(snap.subido)))}${snap.archivo ? ' · ' + esc(snap.archivo) : ''}</p>
      ${grupos || '<div class="empty"><p>No hay productos con esa búsqueda.</p></div>'}`;
  }

  async function abrir() {
    $('#obsinv-cuerpo').innerHTML = '<div class="empty"><h3>Cargando…</h3></div>';
    try { await leer(); render(); }
    catch (e) { $('#obsinv-cuerpo').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${esc(A.msgGitHub ? A.msgGitHub(e) : e.message)}</p></div>`; }
  }

  document.addEventListener('click', (ev) => {
    if (!$('#view-obsinv') || $('#view-obsinv').hidden) return;
    if (ev.target.closest('[data-obsinv="subir"]')) abrirSubir();
  });
  document.addEventListener('change', (ev) => {
    if (!$('#view-obsinv') || $('#view-obsinv').hidden) return;
    if (ev.target.id === 'oi-fecha') { V.fecha = ev.target.value; render(); }
  });
  document.addEventListener('input', (ev) => {
    if (!$('#view-obsinv') || $('#view-obsinv').hidden) return;
    if (ev.target.id === 'oi-buscar') { V.q = ev.target.value; render(); }
  });

  window.OBSINV = { abrir };
})();
