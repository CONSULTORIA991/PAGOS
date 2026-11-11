// Conciliación bancaria (parte 1): movimientos del banco (CSV de la Sucursal Virtual Negocios o PDF) contra Siigo.
// Los movimientos de bancos de Siigo los sube el computador de contabilidad (bancos-siigo.js) a datos/bancos.enc.
// Lo que se carga del banco y las cuentas se guardan en datos/conciliacion.enc (cifrado). Solo la administradora carga.
// Parte 2 (pendiente): registrar los faltantes y subirlos a Siigo.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, esc, fmt, fmtDate, toast, msgGitHub, todayISO } = A;
  const R_BANCOS = 'datos/bancos.enc', R_CONC = 'datos/conciliacion.enc';
  const K = { siigo: null, conc: null, sha: null, cuenta: '', mes: '', leido: 0, cargando: false, vista: 'faltan' };
  const isAdmin = () => !!A.isAdmin;
  // Cuenta conocida por defecto (las demás se agregan con "+ Agregar cuenta")
  // nitBanco y ccGastos: tercero y centro de costo de los gastos bancarios (como se han registrado en Siigo)
  const CUENTAS_BASE = [{ id: '2278', numero: '548-820522-78', nombre: 'Bancolombia ···2278', siigo: ['11100501'], formas: [3687, 3685, 3684], nitBanco: '890903938', ccGastos: 'ADMON-1' }];
  const concBase = () => ({ cuentas: CUENTAS_BASE.map((c) => ({ ...c })), movs: {}, cargues: [], reg: {} });
  // Cuentas de gastos bancarios en Siigo (las que ODESA ya usa en el comprobante 11)
  const GASTO_CTA = { gmf: ['53050506', 'Gravamen financiero (4 x 1.000)'], comision: ['53050503', 'Comisiones bancarias'], interes: ['53052001', 'Intereses'] };
  const tipoGasto = (m) => (/4X1000|GRAVAMEN|GMF/i.test(m.desc) || m.cod === '3339' ? 'gmf' : /INTERES/i.test(m.desc) || m.cod === '7251' ? 'interes' : 'comision');

  async function leer(forzar) {
    if (K.conc && !forzar && Date.now() - K.leido < 5 * 60e3) return;
    const [fb, fc] = await Promise.all([GH.leer(R_BANCOS), GH.leer(R_CONC)]);
    K.siigo = fb ? await Cripto.descifrarJSON(A.maestra, fb.bytes) : null;
    K.sha = fc ? fc.sha : null;
    K.conc = Object.assign(concBase(), fc ? await Cripto.descifrarJSON(A.maestra, fc.bytes) : {});
    // Cuentas guardadas antes de que existieran algunos campos: se completan con los de base
    K.conc.cuentas = (K.conc.cuentas || []).map((c) => ({ ...(CUENTAS_BASE.find((b) => b.id === c.id) || {}), ...c }));
    K.leido = Date.now();
  }
  async function mutar(fn) {
    for (let i = 0; i < 4; i++) {
      const fc = await GH.leer(R_CONC);
      const c = Object.assign(concBase(), fc ? await Cripto.descifrarJSON(A.maestra, fc.bytes) : {});
      if (fn(c) === false) return false;
      c.editado = { en: new Date().toISOString(), por: A.uid };
      try { K.sha = await GH.escribir(R_CONC, await Cripto.cifrarJSON(A.maestra, c), fc ? fc.sha : null); K.conc = { ...c, cuentas: (c.cuentas || []).map((x) => ({ ...(CUENTAS_BASE.find((b) => b.id === x.id) || {}), ...x })) }; return true; }
      catch (e) { if (i === 3 || !e.conflicto) throw e; await new Promise((ok) => setTimeout(ok, 700)); }
    }
  }

  // ---------- lectura de archivos del banco ----------
  const soloDig = (s) => String(s || '').replace(/\D/g, '');
  // CSV Bancolombia Sucursal Virtual Negocios: cuenta, oficina, , AAAAMMDD, , valor, código, descripción, 0,
  function leerCSV(txt) {
    const out = [];
    for (const l of txt.split(/\r?\n/)) {
      const c = l.split(',').map((x) => x.trim());
      if (c.length < 8 || !/^\d{8}$/.test(c[3]) || !isFinite(Number(c[5]))) continue;
      out.push({ cuentaNum: c[0], fecha: `${c[3].slice(0, 4)}-${c[3].slice(4, 6)}-${c[3].slice(6, 8)}`, valor: Number(c[5]), cod: c[6], desc: c[7].replace(/\s+/g, ' ') });
    }
    return out;
  }
  // PDF (extracto o movimientos): renglones con fecha y valor; se revisan antes de guardar
  async function leerPDF(file, anio) {
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
    const num = (s) => { let t = s.replace(/[$\s]/g, ''); const neg = /^-|\(.*\)$|-$/.test(t); t = t.replace(/[()-]/g, ''); if (/,\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, ''); const v = Number(t); return isFinite(v) ? (neg ? -v : v) : NaN; };
    const out = [];
    for (const l of lineas) {
      const m = l.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s+(.+)$/) || l.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(.+)$/);
      if (!m) continue;
      let d, mes, y;
      if (m[1].length === 4) { y = m[1]; mes = m[2]; d = m[3]; } else { d = m[1]; mes = m[2]; y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(anio); }
      const resto = m[4];
      const montos = [...resto.matchAll(/-?\(?\$?\s?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\)?-?/g)].map((x) => x[0]);
      if (!montos.length) continue;
      const desc = resto.slice(0, resto.indexOf(montos[0])).replace(/\s+/g, ' ').trim();
      const valor = num(montos[0]);
      if (!isFinite(valor) || !desc) continue;
      out.push({ cuentaNum: '', fecha: `${y}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`, valor, cod: '', desc: desc.slice(0, 60), saldo: montos.length > 1 ? num(montos[montos.length - 1]) : null });
    }
    return out;
  }

  // ---------- sugerencias por código de transacción (Bancolombia) o por la descripción ----------
  const SUG = [
    [/^(3339)$/, /4X1000|GRAVAMEN|GMF/, 'gmf', '4 x 1.000 (GMF)'],
    [/^(7251|1102|1103)$/, /INTERES(ES)? DE SOBREGIRO|COMISION|CUOTA DE MANEJO|IVA COMIS/, 'banco', 'Gasto bancario'],
    [/^(742)$/, /PAGO AUTOM TC|TARJETA|TC VISA|TC MASTER/, 'tc', 'Pago de tarjeta de crédito'],
    [/^(9278)$/, /NOMIN/, 'nomina', 'Pago de nómina'],
    [/^(3286)$/, /APORTES EN LINEA|PILA|SOI /, 'pila', 'Seguridad social (planilla)'],
    [/^(8106)$/, /REINTEGRO|DEVOLUCION/, 'reintegro', 'Devolución de un pago'],
    [/^(2504)$/, /PAGO DE PROV|CONSIGNACION|ABONO|TRANSFERENCIA DE/, 'cobro', 'Cobro de un cliente'],
    [/^(9729|7160)$/, /PAGO A PROV/, 'proveedor', 'Pago a proveedor o anticipo'],
  ];
  function sugerencia(m) {
    for (const [rc, rd, k, t] of SUG) if (rc.test(String(m.cod || '')) || rd.test(String(m.desc || '').toUpperCase())) return { k, t };
    if (/PSE/.test(String(m.desc).toUpperCase())) return { k: 'servicio', t: 'Pago de servicio (PSE)' };
    return m.valor > 0 ? { k: 'entrada', t: 'Entrada por identificar' } : { k: 'salida', t: 'Salida por identificar' };
  }

  // ---------- cruce ----------
  const masDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const finMes = (mes) => { const [y, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
  function cruzar(cuenta, mes) {
    const ini = mes + '-01', fin = finMes(mes);
    const banco = (K.conc.movs[cuenta.id] || []).filter((m) => m.fecha >= ini && m.fecha <= fin);
    const claves = new Set([...(cuenta.siigo || []), ...(cuenta.formas || []).map((f) => 'F:' + f)]);
    const siigo = ((K.siigo && K.siigo.filas) || []).filter((f) => claves.has(String(f[2])) && f[0] >= masDias(ini, -7) && f[0] <= masDias(fin, 7))
      .map((f, i) => ({ i, fecha: f[0], comp: f[1], valor: f[3], nit: f[4], nombre: f[5], det: f[6], usado: false }));
    const cruzados = [], faltan = [];
    for (const m of banco.slice().sort((a, b) => a.fecha.localeCompare(b.fecha))) {
      const c = siigo.filter((s) => !s.usado && Math.abs(s.valor - m.valor) < 1 && m.fecha >= masDias(s.fecha, -4) && m.fecha <= masDias(s.fecha, 6))
        .sort((a, b) => Math.abs(Date.parse(a.fecha) - Date.parse(m.fecha)) - Math.abs(Date.parse(b.fecha) - Date.parse(m.fecha)))[0];
      if (c) { c.usado = true; cruzados.push({ m, s: c }); } else faltan.push({ m, sug: sugerencia(m), reg: (K.conc.reg || {})[m.id] || null });
    }
    const transito = siigo.filter((s) => !s.usado && s.fecha >= ini && s.fecha <= fin);
    const registrados = faltan.filter((f) => f.reg);
    return { banco, cruzados, faltan: faltan.filter((f) => !f.reg), registrados, transito };
  }

  // ---------- pantalla ----------
  const mesTxt = (mes) => { const [y, m] = mes.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 15)); };
  const suma = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const plural = (n, uno, varios) => `${n.toLocaleString('es-CO')} ${n === 1 ? uno : varios}`;
  const fCorta = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d)).replace('.', ''); };

  async function abrir() {
    if (K.cargando) return;
    K.cargando = true;
    if (!K.mes) K.mes = todayISO().slice(0, 7);
    $('#conc-cuerpo').innerHTML = '<div class="empty"><h3>Cargando la conciliación…</h3></div>';
    try { await leer(); await refrescarEnvios(); render(); }
    catch (e) { $('#conc-cuerpo').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${esc(msgGitHub(e))}</p></div>`; }
    K.cargando = false;
  }

  function render() {
    const cuentas = K.conc.cuentas || [];
    if (!cuentas.some((c) => c.id === K.cuenta)) K.cuenta = (cuentas[0] || {}).id || '';
    const cta = cuentas.find((c) => c.id === K.cuenta);
    const pasos = [['Cargar los movimientos', 'Sube el CSV de la Sucursal Virtual Negocios (o un PDF). Puedes cargar cada día; lo repetido no se duplica.'], ['Cuadra los cruza', 'Busca cada movimiento en Siigo (recibos de pago, recibos de caja y comprobantes) por valor y fecha.'], ['Registrar lo que falta', 'Toca "Registrar" en cada faltante: queda en Cuadra y sube solo a Siigo. A la hora siguiente aparece cruzado.'], ['Cerrar el mes', 'Muy pronto: con el extracto, comparar el saldo final y descargar la conciliación en PDF.']];
    const cab = `
      <div class="rh-barra"><div class="grupo"><div class="field"><label for="conc-mes">Mes</label><input type="month" id="conc-mes" value="${esc(K.mes)}" max="${todayISO().slice(0, 7)}"></div></div>
        <div class="grupo">${cta ? '<button class="btn" type="button" data-conc="pdf">Descargar PDF</button>' : ''}${isAdmin() ? '<button class="btn primary" type="button" data-conc="cargar">Cargar movimientos (CSV o PDF)</button>' : ''}</div></div>
      <section class="cj-camino" aria-label="Cómo funciona"><h3>Así se trabaja</h3><ol>${pasos.map(([t, d], i) => `<li class="${i < 3 ? 'hecho' : ''}"><b><span>${i + 1}</span>${t}</b><small>${d}</small></li>`).join('')}</ol></section>
      <nav class="proy-tabs" role="tablist" aria-label="Cuentas de banco">${cuentas.map((c) => `<button type="button" role="tab" class="proy-tab" data-conc-cta="${esc(c.id)}" aria-selected="${c.id === K.cuenta}">${esc(c.nombre)}</button>`).join('')}${isAdmin() ? '<button type="button" class="proy-tab" data-conc="cuenta-nueva">+ Agregar cuenta</button>' : ''}</nav>`;
    if (!cta) { $('#conc-cuerpo').innerHTML = cab + '<div class="empty"><p>Agrega una cuenta de banco para empezar.</p></div>'; return; }
    const r = cruzar(cta, K.mes);
    const ult = (K.conc.movs[cta.id] || []).reduce((m, x) => (x.fecha > m ? x.fecha : m), '');
    const sig = K.siigo ? K.siigo.ultimos || {} : null;
    const faltaV = suma(r.faltan, (x) => x.m.valor);
    let cuerpo;
    if (!r.banco.length) {
      cuerpo = `<div class="empty"><h3>No hay movimientos del banco cargados para ${esc(mesTxt(K.mes))}</h3><p>${isAdmin() ? 'Descarga el CSV de la Sucursal Virtual Negocios y súbelo con "Cargar movimientos".' : 'La administradora aún no ha cargado los movimientos de este mes.'}${ult ? ` Lo último cargado de esta cuenta llega hasta el ${esc(fmtDate(ult))}.` : ''}</p></div>`;
    } else {
      const estado = r.faltan.length ? (r.faltan.length > r.banco.length / 4 ? 'rojo' : 'amarillo') : 'verde';
      const grupos = new Map();
      for (const f of r.faltan) { const g = grupos.get(f.sug.k) || { t: f.sug.t, l: [] }; g.l.push(f); grupos.set(f.sug.k, g); }
      const gl = [...grupos.values()].sort((a, b) => b.l.length - a.l.length);
      const maxF = r.banco.reduce((m, x) => (x.fecha > m ? x.fecha : m), '');
      cuerpo = `
        <div class="proy-frase"><h2>${esc(cta.nombre)}: de ${plural(r.banco.length, 'movimiento', 'movimientos')} del banco en ${esc(mesTxt(K.mes))}, ${r.cruzados.length.toLocaleString('es-CO')} ya ${r.cruzados.length === 1 ? 'está' : 'están'} en Siigo. ${r.faltan.length ? `Faltan ${plural(r.faltan.length, 'por registrar', 'por registrar')}.` : 'No falta nada.'}</h2><span class="proy-estado ${estado}">${estado === 'verde' ? 'Al día' : `Faltan ${r.faltan.length}`}</span></div>
        <p class="proy-nota">Movimientos del banco hasta el ${esc(fmtDate(maxF))}.${sig ? ` En Siigo, el último recibo de pago se creó el ${esc(fmtDate(sig.RP || ''))}, el último recibo de caja el ${esc(fmtDate(sig.RC || ''))} y el último comprobante el ${esc(fmtDate(sig.CC || ''))}. Datos de Siigo actualizados el ${esc(new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(K.siigo.actualizado))).replace(/\.$/, '')}.` : ' Aún no llegan los datos de bancos de Siigo: el computador de contabilidad los sube cada hora.'}</p>
        <section class="pk-grid">
          <div class="pk"><span class="pk-t">Movimientos del banco</span><span class="pk-v">${r.banco.length.toLocaleString('es-CO')}</span><span class="pk-a">Entradas ${fmt(suma(r.banco.filter((x) => x.valor > 0), (x) => x.valor))} · salidas ${fmt(-suma(r.banco.filter((x) => x.valor < 0), (x) => x.valor))}</span></div>
          <div class="pk"><span class="pk-t">Ya están en Siigo</span><span class="pk-v pos">${r.cruzados.length.toLocaleString('es-CO')}</span><span class="pk-a">${Math.round(r.cruzados.length / r.banco.length * 100)} % de los movimientos</span><span class="pk-b"><span class="verde" style="width:${(r.cruzados.length / r.banco.length * 100).toFixed(1)}%"></span></span></div>
          <div class="pk ${r.faltan.length ? 'mal' : ''}"><span class="pk-t">Faltan en Siigo</span><span class="pk-v">${r.faltan.length.toLocaleString('es-CO')}</span><span class="pk-a">Neto ${fmt(faltaV)}</span></div>
          <div class="pk"><span class="pk-t">En Siigo y no en el banco</span><span class="pk-v">${r.transito.length.toLocaleString('es-CO')}</span><span class="pk-a">${fmt(suma(r.transito, (x) => x.valor))} · pueden ser de otra cuenta o de otro día</span></div>
        </section>
        <nav class="quick" role="group" aria-label="Ver">${[['faltan', `Faltan en Siigo (${r.faltan.length})`], ['registrados', `Registrados, subiendo a Siigo (${r.registrados.length})`], ['transito', `En Siigo y no en el banco (${r.transito.length})`], ['cruzados', `Ya cruzados (${r.cruzados.length})`]].map(([k, t]) => `<button class="qbtn" type="button" data-conc-ver="${k}" aria-pressed="${K.vista === k}">${t}</button>`).join('')}</nav>
        ${K.vista === 'faltan' ? (gl.length ? gl.map((g) => {
          const k = g.l[0].sug.k, lote = (k === 'gmf' || k === 'banco') && isAdmin();
          return `<section class="proy-caja"><div class="pr-cab"><div><h3>${esc(g.t)} · ${g.l.length}</h3><p class="proy-nota">Total ${fmt(suma(g.l, (x) => x.m.valor))}. ${{ gmf: 'Se registran todos juntos: un comprobante por día, a la cuenta 53050506.', banco: 'Comisiones e intereses: se registran todos juntos a gastos bancarios.', cobro: 'Entró plata de un cliente. Por ahora márcalo como revisado; el registro del recibo de caja viene en el siguiente paso.', proveedor: 'Toca "Registrar": si es un pago que ya está en Cuadra lo reconozco; si no, escoges si es pago de factura o anticipo.', nomina: 'Pago a un empleado: márcalo como revisado (la nómina se registra en Siigo Nómina).', reintegro: 'El banco devolvió un pago: márcalo como revisado junto con el pago original.' }[k] || 'Toca "Registrar" para escoger qué es.'}</p></div>
              ${lote ? `<button class="btn primary" type="button" data-conc="gastos" data-grupo="${esc(k)}">Registrar los ${g.l.length} en Siigo</button>` : ''}</div>
            <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>En el banco dice</th><th class="n">Valor</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${g.l.map((f) => `<tr><td>${esc(fCorta(f.m.fecha))}</td><td>${esc(f.m.desc)}</td><td class="n ${f.m.valor < 0 ? 'neg' : 'okv'}">${fmt(f.m.valor)}</td>${isAdmin() ? `<td class="n"><button class="btn sm${lote ? '' : ' primary'}" type="button" data-conc-reg="${esc(f.m.id)}">${lote ? 'Otro' : 'Registrar'}</button></td>` : ''}</tr>`).join('')}</tbody></table></div></section>`;
        }).join('') : '<p class="proy-nota">✓ Todos los movimientos del banco de este mes están en Siigo o ya se registraron.</p>')
        : K.vista === 'registrados' ? seccionRegistrados(r)
        : K.vista === 'transito' ? `<section class="proy-caja"><h3>En Siigo pero no en el banco</h3><p class="proy-nota">Registrados en Siigo en esta cuenta (o con su forma de pago) que no aparecen en lo cargado del banco. Pueden ser de otro día, de otra cuenta o un error de cuenta en Siigo.</p>${r.transito.length ? `<div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Comprobante</th><th>Tercero</th><th class="n">Valor</th></tr></thead><tbody>${r.transito.map((s) => `<tr><td>${esc(fCorta(s.fecha))}</td><td>${esc(s.comp)}</td><td>${esc(s.nombre || s.nit || s.det)}</td><td class="n">${fmt(s.valor)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="proy-nota">Nada.</p>'}</section>`
        : `<section class="proy-caja"><h3>Ya cruzados</h3><p class="proy-nota">Movimientos del banco que coinciden en valor y fecha (hasta 4 días antes o 6 después) con un documento de Siigo.</p><div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha banco</th><th>En el banco dice</th><th>En Siigo</th><th class="n">Valor</th></tr></thead><tbody>${r.cruzados.map((c) => `<tr><td>${esc(fCorta(c.m.fecha))}</td><td>${esc(c.m.desc)}</td><td>${esc(c.s.comp)}${c.s.nombre ? ' · ' + esc(c.s.nombre) : ''}</td><td class="n">${fmt(c.m.valor)}</td></tr>`).join('')}</tbody></table></div></section>`}`;
    }
    const cfg = isAdmin() ? `<details class="pres-det"><summary>Configuración de esta cuenta</summary><p class="proy-nota">Número ${esc(cta.numero || '—')} · cuentas de Siigo: ${esc((cta.siigo || []).join(', ') || '—')} · formas de pago de Siigo: ${esc((cta.formas || []).map((f) => ((K.siigo && K.siigo.formas) || []).find((x) => x.id === f)).filter(Boolean).map((x) => x.nombre).join(', ') || '—')}.</p><button class="btn" type="button" data-conc="cuenta-editar">Cambiar</button></details>` : '';
    $('#conc-cuerpo').innerHTML = cab + cuerpo + cfg;
  }

  // ---------- registrar lo que falta (parte 2) ----------
  const B = () => A.banco;
  const ESTADO_ENVIO = { pendiente: ['amarillo', 'Esperando al computador de la oficina'], enviando: ['amarillo', 'Creándose en Siigo'], listo: ['verde', 'Creado en Siigo'], error: ['rojo', 'No se pudo subir'] };
  function seccionRegistrados(r) {
    if (!r.registrados.length) return '<p class="proy-nota">Aún no has registrado movimientos de este mes desde aquí.</p>';
    const env = new Map((K.envios || []).map((e) => [e.id, e]));
    return `<section class="proy-caja"><h3>Registrados desde la conciliación</h3><p class="proy-nota">Cuando Siigo los tenga (el computador revisa cada hora), pasan solos a "Ya cruzados".</p>
      <div class="rh-tabla-wrap"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>En el banco dice</th><th class="n">Valor</th><th>Qué se hizo</th><th>En Siigo</th></tr></thead><tbody>${r.registrados.map((f) => {
        const g = f.reg, e = g.envioId ? env.get(g.envioId) : null;
        const est = e ? ESTADO_ENVIO[e.estado] || ['gris', e.estado] : g.tipo === 'revisado' ? ['gris', 'No se sube'] : ['gris', g.error ? 'Pendiente: ' + g.error : 'Sin subir'];
        const hechos = e && e.hechos && e.hechos.length ? ' · ' + e.hechos.map((h) => h.nombre || h.numero).join(', ') : '';
        const prob = e && e.estado === 'error' ? `<br><span class="sub">${esc([...(e.problemas || []), e.error || ''].filter(Boolean).join(' · ').slice(0, 200))}</span>` : '';
        return `<tr><td>${esc(fCorta(f.m.fecha))}</td><td>${esc(f.m.desc)}</td><td class="n">${fmt(f.m.valor)}</td><td>${esc(g.texto || '')}</td><td><span class="pr-chip ${est[0]}">${esc(est[1])}${esc(hechos)}</span>${prob}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;
  }
  async function refrescarEnvios() { try { K.envios = await B().envios(); } catch (e) { /* sin conexión: se reintenta luego */ } }
  async function marcarReg(movIds, datos) {
    await mutar((c) => { c.reg = c.reg || {}; for (const id of movIds) c.reg[id] = { ...datos, en: new Date().toISOString(), por: A.uid }; });
  }
  const movDe = (id) => { for (const l of Object.values(K.conc.movs || {})) { const m = l.find((x) => x.id === id); if (m) return m; } return null; };
  const ctaActual = () => (K.conc.cuentas || []).find((c) => c.id === K.cuenta);
  const palabras = (s) => new Set(String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^PAGO (A|DE) (PROVE?|NOMIN)\s*/, '').split(/[^A-Z0-9]+/).filter((w) => w.length > 2 && !['SAS', 'LTDA', 'S.A.S', 'DEL', 'LOS', 'LAS'].includes(w)));
  function provSugerido(m) {
    const p = palabras(m.desc); let mejor = null, pts = 0;
    for (const x of B().proveedores()) { let n = 0; for (const w of palabras(x.nombre)) if (p.has(w)) n++; if (n > pts) { pts = n; mejor = x; } }
    return mejor;
  }
  function abrirRegistro(movId) {
    const m = movDe(movId), cta = ctaActual();
    if (!m || !cta) return;
    const sale = m.valor < 0, v = Math.abs(m.valor), sug = sugerencia(m);
    const cands = sale ? B().pagosAbiertos().filter((p) => Math.abs((Number(p.valor) || 0) - v) < 1) : [];
    const prov = sale ? provSugerido(m) : null;
    const centros = B().centros();
    const listo = B().siigoListo();
    $('#conc-dlg-titulo').textContent = `Registrar: ${m.desc}`;
    $('#conc-dlg-res').innerHTML = `<p class="proy-nota">${esc(cta.nombre)} · ${esc(fmtDate(m.fecha))} · <b class="${sale ? 'neg' : 'pos'}">${fmt(m.valor)}</b>. ${esc(sug.t)}.</p>
      ${!listo ? '<p class="proy-aviso">Faltan las credenciales de Siigo (Usuarios → Conexión con Siigo): se guarda en Cuadra pero no sube.</p>' : ''}
      ${cands.length ? `<section class="proy-caja"><h3>¿Es uno de estos pagos de Cuadra?</h3><p class="proy-nota">Tienen el mismo valor y aún no están pagados. Si es uno, queda pagado con la fecha del banco y sube a Siigo.</p>
        ${cands.map((p) => `<div class="conc-cand"><span><b>${esc(p.proveedor)}</b><br><span class="sub">${esc(p.concepto || '')}${p.factura ? ' · ' + esc(p.factura) : ''} · ${esc({ aprobado: 'aprobado', pendiente: 'pendiente', revisar: 'por revisar' }[p.estado] || p.estado)}</span></span><button class="btn primary" type="button" data-conc="existente" data-pago="${esc(p.id)}" data-mov="${esc(m.id)}">Sí, es este</button></div>`).join('')}</section>` : ''}
      ${sale ? `<section class="proy-caja"><h3>${cands.length ? 'No, es un pago nuevo' : 'Pago hecho fuera de Cuadra'}</h3>
        <div class="grid">
          <div class="field"><label for="cr-tipo">¿Qué fue?</label><select id="cr-tipo"><option value="factura">Pago de una factura</option><option value="anticipo">Anticipo</option></select></div>
          <div class="field"><label for="cr-prov">Proveedor</label><input id="cr-prov" list="cr-provs" value="${esc(prov ? prov.nombre : '')}" autocomplete="off"><datalist id="cr-provs">${B().proveedores().map((x) => `<option value="${esc(x.nombre)}">${esc(x.nit)}</option>`).join('')}</datalist></div>
          <div class="field"><label for="cr-nit">NIT o cédula</label><input id="cr-nit" inputmode="numeric" value="${esc(prov ? prov.nit : '')}" autocomplete="off"></div>
          <div class="field" data-solo="factura"><label for="cr-fact">Factura (prefijo-número)</label><input id="cr-fact" placeholder="Ej. FE-2210" autocomplete="off"></div>
          <div class="field" data-solo="factura"><label for="cr-vence">Vencimiento de la factura</label><input id="cr-vence" type="date" value="${esc(m.fecha)}"></div>
          <div class="field"><label for="cr-cc">Obra (centro de costo)</label><input id="cr-cc" list="cr-ccs" autocomplete="off" placeholder="Ej. 100068-1 · LAGOMAR"><datalist id="cr-ccs">${centros.map((c) => `<option value="${esc(c.codigo + ' · ' + c.nombre)}"></option>`).join('')}</datalist></div>
          <div class="field full"><label for="cr-concepto">Concepto</label><input id="cr-concepto" value="${esc(m.desc.replace(/^PAGO A PROVE?\s*/i, 'Pago a '))}"></div>
          <div class="field full"><label for="cr-sop">Soporte del pago (opcional)</label><input id="cr-sop" type="file" accept="application/pdf,image/*"></div>
        </div>
        <p class="proy-nota" id="cr-asi"></p>
        <div class="form-actions"><button class="btn primary" type="button" data-conc="nuevo" data-mov="${esc(m.id)}">Registrar y subir a Siigo</button></div></section>` : ''}
      <section class="proy-caja"><h3>Otra cosa</h3><p class="proy-nota">Si ya está en Siigo de otra forma, o lo vas a registrar directamente allá, márcalo como revisado para que no siga en la lista.</p>
        <div class="field"><label for="cr-nota">Nota</label><input id="cr-nota" placeholder="Ej. Nómina de octubre, registrada en Siigo Nómina"></div>
        <div class="form-actions"><button class="btn" type="button" data-conc="revisado" data-mov="${esc(m.id)}">Marcar como revisado</button></div></section>
      <p class="proy-aviso" id="cr-err" hidden></p>`;
    const asiento = () => {
      const t = $('#cr-tipo'); if (!t) return;
      const ant = t.value === 'anticipo';
      document.querySelectorAll('[data-solo="factura"]').forEach((x) => { x.hidden = ant; });
      $('#cr-asi').innerHTML = `Así queda en Siigo (comprobante de pagos): débito <b>${ant ? '13300501 Anticipos a proveedores' : '22050501 Proveedores'}</b>${ant ? '' : ' cruzando la factura'} · crédito <b>${esc((cta.siigo || [])[0] || '')} ${esc(cta.nombre)}</b> · ${fmt(v)}.`;
    };
    const t = $('#cr-tipo'); if (t) { t.addEventListener('change', asiento); asiento(); }
    const pv = $('#cr-prov'); if (pv) pv.addEventListener('change', () => { const x = B().proveedores().find((y) => y.nombre === pv.value); if (x) $('#cr-nit').value = x.nit; });
    if (!$('#dlg-conc').open) $('#dlg-conc').showModal();
  }
  const errReg = (msg) => { const e = $('#cr-err'); if (e) { e.textContent = msg; e.hidden = !msg; } };
  async function registrarExistente(pagoId, movId) {
    const m = movDe(movId), cta = ctaActual();
    const r = await B().pagarExistente(pagoId, { fecha: m.fecha, cuentaBanco: (cta.siigo || [])[0], movId });
    await marcarReg([movId], { tipo: 'existente', pagoId, envioId: r.envioId || '', error: r.error || '', texto: r.caja ? 'Caja menor marcada como reembolsada (se sube con el comprobante 14)' : 'Pago de Cuadra marcado como pagado' });
    terminarReg(r.error);
  }
  async function registrarNuevo(movId) {
    const m = movDe(movId), cta = ctaActual();
    const tipo = $('#cr-tipo').value, proveedor = $('#cr-prov').value.trim(), nit = $('#cr-nit').value.replace(/\D/g, '');
    const factura = $('#cr-fact').value.trim().toUpperCase(), vence = $('#cr-vence').value, cc = $('#cr-cc').value.trim(), concepto = $('#cr-concepto').value.trim();
    if (!proveedor || nit.length < 5) return errReg('Escribe el proveedor y su NIT o cédula.');
    if (tipo === 'factura' && !/^[A-Z0-9]{1,6}-?\d+$/.test(factura.replace(/\s+/g, ''))) return errReg('Escribe la factura con prefijo y número, por ejemplo FE-2210.');
    const file = $('#cr-sop').files[0] || null;
    const r = await B().nuevoPago({ tipo, proveedor, nit, factura, vence, cc, concepto, valor: Math.abs(m.valor), fecha: m.fecha, movId, cuentaBanco: (cta.siigo || [])[0] }, file);
    await marcarReg([movId], { tipo, pagoId: r.id, envioId: r.envioId || '', error: r.error || '', texto: `${tipo === 'anticipo' ? 'Anticipo' : 'Pago de factura ' + factura} a ${proveedor}` });
    terminarReg(r.error);
  }
  async function registrarRevisado(movId) {
    const nota = ($('#cr-nota').value || '').trim();
    await marcarReg([movId], { tipo: 'revisado', texto: 'Revisado' + (nota ? ': ' + nota : '') });
    terminarReg('');
  }
  async function terminarReg(error) {
    $('#dlg-conc').close();
    toast(error ? `Quedó registrado en Cuadra, pero no subió a Siigo: ${error}` : 'Listo. Quedó en la cola: el computador de la oficina lo sube a Siigo en unos minutos.');
    await refrescarEnvios();
    render();
  }
  // Gastos bancarios del mes (4 x 1.000, comisiones, intereses): un comprobante por día
  function abrirGastos(grupo) {
    const cta = ctaActual();
    const r = cruzar(cta, K.mes);
    const l = r.faltan.filter((f) => f.sug.k === grupo && f.m.valor < 0);
    if (!l.length) return;
    const dias = new Map();
    for (const f of l) { const d = dias.get(f.m.fecha) || []; d.push(f); dias.set(f.m.fecha, d); }
    const nit = cta.nitBanco || '', cc = cta.ccGastos || '', banco = (cta.siigo || [])[0];
    $('#conc-dlg-titulo').textContent = `Registrar ${l.length} ${grupo === 'gmf' ? 'cobros del 4 x 1.000' : 'gastos bancarios'}`;
    $('#conc-dlg-res').innerHTML = `<p class="proy-nota">Se crean <b>${dias.size} ${dias.size === 1 ? 'comprobante' : 'comprobantes'}</b> (uno por día) con el tercero del banco${nit ? ' (NIT ' + esc(nit) + ')' : ''} y el centro de costo ${esc(cc || '—')}, como se han registrado antes en Siigo.</p>
      ${!nit ? '<p class="proy-aviso">Falta el NIT del banco en la configuración de esta cuenta.</p>' : ''}
      <div class="rh-tabla-wrap" style="max-height:300px;overflow:auto"><table class="rh-tabla"><thead><tr><th>Día</th><th>Débito</th><th class="n">Valor</th></tr></thead><tbody>${[...dias.entries()].map(([d, fs]) => fs.map((f) => `<tr><td>${esc(fCorta(d))}</td><td>${esc(GASTO_CTA[tipoGasto(f.m)].join(' '))}</td><td class="n">${fmt(-f.m.valor)}</td></tr>`).join('')).join('')}</tbody></table></div>
      <p class="proy-nota">Crédito: ${esc(banco)} ${esc(cta.nombre)} por el total de cada día · total ${fmt(-suma(l, (f) => f.m.valor))}.</p>
      <p class="proy-aviso" id="cr-err" hidden></p>
      <div class="form-actions"><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="button" data-conc="gastos-ok" data-grupo="${esc(grupo)}"${nit && B().siigoListo() ? '' : ' disabled'}>Subir a Siigo</button></div>`;
    if (!$('#dlg-conc').open) $('#dlg-conc').showModal();
  }
  async function registrarGastos(grupo) {
    const cta = ctaActual();
    const l = cruzar(cta, K.mes).faltan.filter((f) => f.sug.k === grupo && f.m.valor < 0);
    const dias = new Map();
    for (const f of l) { const d = dias.get(f.m.fecha) || []; d.push(f); dias.set(f.m.fecha, d); }
    const nit = cta.nitBanco, cc = cta.ccGastos || '', banco = (cta.siigo || [])[0];
    const comps = [...dias.entries()].map(([fecha, fs]) => {
      const lineas = fs.map((f) => ({ cuenta: GASTO_CTA[tipoGasto(f.m)][0], nit, cc, prefijo: '', numero: '', vence: '', descripcion: f.m.desc.slice(0, 100), debito: Math.round(-f.m.valor), credito: 0 }));
      const tot = lineas.reduce((s, x) => s + x.debito, 0);
      lineas.push({ cuenta: banco, nit, cc, prefijo: '', numero: '', vence: '', descripcion: `${grupo === 'gmf' ? 'GMF' : 'Gastos bancarios'} del ${fmtDate(fecha)}`, debito: 0, credito: tot });
      return { fecha, lineas, observaciones: `${grupo === 'gmf' ? 'Gravamen financiero' : 'Gastos bancarios'} ${cta.nombre} del ${fmtDate(fecha)} (conciliación bancaria, Cuadra)` };
    });
    const envioId = await B().comprobante(comps);
    await marcarReg(l.map((f) => f.m.id), { tipo: 'gasto', envioId, texto: grupo === 'gmf' ? 'GMF registrado' : 'Gasto bancario registrado' });
    terminarReg('');
  }

  // ---------- cargar movimientos ----------
  let previa = null;
  function abrirCarga() {
    const dlg = $('#dlg-conc');
    $('#conc-dlg-titulo').textContent = 'Cargar movimientos del banco';
    $('#conc-dlg-res').innerHTML = `<p class="proy-nota">Sube el CSV tal como lo descarga la Sucursal Virtual Negocios (sin abrirlo en Excel), o un PDF de movimientos o del extracto. Antes de guardar te muestro lo que leí.</p>
      <div class="field"><label for="conc-file">Archivo CSV o PDF</label><input id="conc-file" type="file" accept=".csv,text/csv,application/pdf,.pdf"></div>
      <div id="conc-previa"></div>`;
    previa = null;
    $('#conc-file').addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      const box = $('#conc-previa'); box.innerHTML = '<p class="proy-nota">Leyendo…</p>';
      try {
        const esPDF = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
        const movs = esPDF ? await leerPDF(f, Number(K.mes.slice(0, 4))) : leerCSV(new TextDecoder('latin1').decode(await f.arrayBuffer()));
        if (!movs.length) { box.innerHTML = `<p class="proy-aviso">No encontré movimientos en el archivo. ${esPDF ? 'Este formato de PDF todavía no lo conozco: mándamelo y lo agrego.' : 'Revisa que sea el CSV de la Sucursal Virtual Negocios.'}</p>`; return; }
        const num = soloDig(movs[0].cuentaNum);
        const cuentas = K.conc.cuentas || [];
        let cta = num ? cuentas.find((c) => soloDig(c.numero) === num || num.endsWith(c.id)) : null;
        if (!cta) cta = cuentas.find((c) => c.id === K.cuenta);
        const fechas = movs.map((m) => m.fecha).sort();
        previa = { movs, archivo: f.name, tipo: esPDF ? 'pdf' : 'csv' };
        box.innerHTML = `<p class="proy-nota"><b>${plural(movs.length, 'movimiento', 'movimientos')}</b> del ${esc(fmtDate(fechas[0]))} al ${esc(fmtDate(fechas[fechas.length - 1]))} · entradas ${fmt(suma(movs.filter((m) => m.valor > 0), (m) => m.valor))} · salidas ${fmt(-suma(movs.filter((m) => m.valor < 0), (m) => m.valor))}${num ? ` · cuenta ${esc(movs[0].cuentaNum)}` : ''}.</p>
          <div class="field"><label for="conc-cta-sel">Cuenta</label><select id="conc-cta-sel">${cuentas.map((c) => `<option value="${esc(c.id)}"${cta && cta.id === c.id ? ' selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
          ${esPDF ? '<p class="proy-aviso">Lectura de PDF en prueba: revisa que las fechas y los valores estén bien antes de guardar.</p>' : ''}
          <div class="rh-tabla-wrap" style="max-height:280px;overflow:auto"><table class="rh-tabla"><thead><tr><th>Fecha</th><th>Descripción</th><th class="n">Valor</th></tr></thead><tbody>${movs.slice(0, 200).map((m) => `<tr><td>${esc(fmtDate(m.fecha))}</td><td>${esc(m.desc)}</td><td class="n ${m.valor < 0 ? 'neg' : 'okv'}">${fmt(m.valor)}</td></tr>`).join('')}</tbody></table></div>
          <div class="form-actions"><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="button" data-conc="guardar">Guardar movimientos</button></div>`;
      } catch (e) { box.innerHTML = `<p class="proy-aviso">${esc(e.message || 'No se pudo leer el archivo.')}</p>`; }
    });
    if (!dlg.open) dlg.showModal();
  }
  // Junta sin duplicar: si un renglón idéntico (fecha, valor, código, descripción) ya está, no se repite
  async function guardarCarga() {
    if (!previa) return;
    const cid = $('#conc-cta-sel').value;
    let nuevos = 0;
    await mutar((c) => {
      const ya = c.movs[cid] || [];
      const cuenta = new Map();
      for (const m of ya) { const k = [m.fecha, m.valor, m.cod, m.desc].join('|'); cuenta.set(k, (cuenta.get(k) || 0) + 1); }
      const vistos = new Map();
      for (const m of previa.movs) {
        const k = [m.fecha, m.valor, m.cod, m.desc].join('|');
        const n = (vistos.get(k) || 0) + 1; vistos.set(k, n);
        if (n > (cuenta.get(k) || 0)) { ya.push({ id: A.nuevoId(), fecha: m.fecha, valor: m.valor, cod: m.cod, desc: m.desc, ...(m.saldo != null ? { saldo: m.saldo } : {}), origen: previa.tipo }); nuevos++; }
      }
      c.movs[cid] = ya;
      c.cargues = [...(c.cargues || []), { en: new Date().toISOString(), por: A.uid, cuenta: cid, archivo: previa.archivo.slice(0, 80), leidos: previa.movs.length, nuevos }].slice(-200);
    });
    $('#dlg-conc').close();
    K.cuenta = cid;
    const meses = [...new Set(previa.movs.map((m) => m.fecha.slice(0, 7)))].sort();
    if (!meses.includes(K.mes)) K.mes = meses[meses.length - 1];
    toast(nuevos ? `Listo: ${plural(nuevos, 'movimiento nuevo', 'movimientos nuevos')}${previa.movs.length - nuevos ? ` (${previa.movs.length - nuevos} ya estaban)` : ''}.` : 'Esos movimientos ya estaban cargados.');
    previa = null;
    render();
  }

  // ---------- cuentas ----------
  function abrirCuenta(editar) {
    const c = editar ? (K.conc.cuentas || []).find((x) => x.id === K.cuenta) || {} : {};
    const cuentasSiigo = [...new Set(((K.siigo && K.siigo.filas) || []).map((f) => f[2]).filter((k) => /^11/.test(k)))].sort();
    const formas = (K.siigo && K.siigo.formas) || [];
    $('#conc-dlg-titulo').textContent = editar ? 'Cambiar cuenta de banco' : 'Agregar cuenta de banco';
    $('#conc-dlg-res').innerHTML = `<p class="proy-nota">Dime cómo se llama la cuenta y con qué se registra en Siigo, para que Cuadra sepa con qué cruzar sus movimientos.</p>
      <div class="field"><label for="cc-nombre">Nombre</label><input id="cc-nombre" value="${esc(c.nombre || '')}" placeholder="Ej. Banco de Bogotá ···3762"></div>
      <div class="field"><label for="cc-numero">Número de la cuenta</label><input id="cc-numero" value="${esc(c.numero || '')}" inputmode="numeric" placeholder="Como sale en el CSV o en el extracto"></div>
      <fieldset class="field"><legend>Cuentas contables en Siigo</legend><div class="proy-checks">${cuentasSiigo.map((k) => `<label><input type="checkbox" data-cc-siigo="${esc(k)}"${(c.siigo || []).includes(k) ? ' checked' : ''}> ${esc(k)}</label>`).join('') || '<span class="proy-nota">Aún no hay datos de Siigo.</span>'}</div></fieldset>
      <fieldset class="field"><legend>Formas de pago de Siigo que salen de esta cuenta</legend><div class="proy-checks">${formas.map((f) => `<label><input type="checkbox" data-cc-forma="${f.id}"${(c.formas || []).includes(f.id) ? ' checked' : ''}> ${esc(f.nombre)} <span class="sub">· ${f.n} recibos, último ${esc(fmtDate(f.ult))}</span></label>`).join('')}</div></fieldset>
      <p class="proy-aviso" id="cc-err" hidden></p>
      <div class="form-actions"><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="button" data-conc="cuenta-guardar" data-editar="${editar ? '1' : ''}">Guardar</button></div>`;
    if (!$('#dlg-conc').open) $('#dlg-conc').showModal();
  }
  async function guardarCuenta(editar) {
    const nombre = $('#cc-nombre').value.trim(), numero = $('#cc-numero').value.trim();
    const siigo = [...document.querySelectorAll('[data-cc-siigo]:checked')].map((x) => x.dataset.ccSiigo);
    const formas = [...document.querySelectorAll('[data-cc-forma]:checked')].map((x) => Number(x.dataset.ccForma));
    const err = $('#cc-err');
    if (!nombre || soloDig(numero).length < 4) { err.textContent = 'Escribe el nombre y el número de la cuenta.'; err.hidden = false; return; }
    if (!siigo.length && !formas.length) { err.textContent = 'Escoge al menos una cuenta contable o una forma de pago de Siigo.'; err.hidden = false; return; }
    const id = editar ? K.cuenta : soloDig(numero).slice(-4);
    await mutar((c) => {
      const l = c.cuentas || [];
      if (!editar && l.some((x) => x.id === id)) return false;
      const nueva = { id, numero, nombre, siigo, formas };
      c.cuentas = editar ? l.map((x) => (x.id === id ? nueva : x)) : [...l, nueva];
    });
    K.cuenta = id;
    $('#dlg-conc').close();
    render();
  }

  // ---------- PDF ----------
  function pdf() {
    const cta = (K.conc.cuentas || []).find((c) => c.id === K.cuenta);
    if (!cta || typeof InformePDF === 'undefined') return;
    const r = cruzar(cta, K.mes);
    const tabla = (cab, filas) => `<table><thead><tr>${cab.map((c, i) => `<th${i === cab.length - 1 ? ' class="n"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>${filas.join('')}</tbody></table>`;
    const h = `<div class="frase ${r.faltan.length ? 'amarillo' : 'verde'}"><span>${esc(cta.nombre)}: de ${plural(r.banco.length, 'movimiento', 'movimientos')} del banco, ${r.cruzados.length} ya están en Siigo y faltan ${r.faltan.length}.</span></div>
      <div class="kpis"><div><span>Movimientos del banco</span><b>${r.banco.length}</b></div><div><span>Ya en Siigo</span><b>${r.cruzados.length}</b></div><div><span>Faltan en Siigo</span><b>${r.faltan.length}</b><span>neto ${fmt(suma(r.faltan, (x) => x.m.valor))}</span></div><div><span>En Siigo y no en el banco</span><b>${r.transito.length}</b></div></div>
      <h2>Faltan en Siigo</h2>${r.faltan.length ? tabla(['Fecha', 'En el banco dice', 'Sugerencia', 'Valor'], r.faltan.map((f) => `<tr><td>${esc(fmtDate(f.m.fecha))}</td><td>${esc(f.m.desc)}</td><td>${esc(f.sug.t)}</td><td class="n">${fmt(f.m.valor)}</td></tr>`)) : '<p>Nada.</p>'}
      <h2>En Siigo pero no en el banco</h2>${r.transito.length ? tabla(['Fecha', 'Comprobante', 'Tercero', 'Valor'], r.transito.map((s) => `<tr><td>${esc(fmtDate(s.fecha))}</td><td>${esc(s.comp)}</td><td>${esc(s.nombre || s.nit)}</td><td class="n">${fmt(s.valor)}</td></tr>`)) : '<p>Nada.</p>'}
      <h2 class="salto">Ya cruzados</h2>${tabla(['Fecha', 'En el banco dice', 'En Siigo', 'Valor'], r.cruzados.map((c) => `<tr><td>${esc(fmtDate(c.m.fecha))}</td><td>${esc(c.m.desc)}</td><td>${esc(c.s.comp)}</td><td class="n">${fmt(c.m.valor)}</td></tr>`))}`;
    InformePDF.abrir({ titulo: `Conciliación · ${cta.nombre}`, subtitulo: [`Cuenta ${cta.numero || ''} · Siigo ${(cta.siigo || []).join(', ')}`, mesTxt(K.mes)], cuerpo: h, archivo: `Conciliacion ${cta.id} ${K.mes}` });
  }

  // ---------- eventos ----------
  $('#view-conc').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-conc], [data-conc-cta], [data-conc-ver], [data-conc-reg]');
    if (!t) return;
    if (t.dataset.concCta) { K.cuenta = t.dataset.concCta; render(); return; }
    if (t.dataset.concVer) { K.vista = t.dataset.concVer; if (K.vista === 'registrados') refrescarEnvios().then(render); render(); return; }
    if (t.dataset.concReg) { abrirRegistro(t.dataset.concReg); return; }
    const a = t.dataset.conc;
    if (a === 'gastos') abrirGastos(t.dataset.grupo);
    else if (a === 'cargar') abrirCarga();
    else if (a === 'cuenta-nueva') abrirCuenta(false);
    else if (a === 'cuenta-editar') abrirCuenta(true);
    else if (a === 'pdf') pdf();
  });
  $('#view-conc').addEventListener('change', (ev) => { if (ev.target.id === 'conc-mes' && ev.target.value) { K.mes = ev.target.value; render(); } });
  $('#dlg-conc').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-conc]');
    if (!t) return;
    // Un solo clic: el botón queda deshabilitado mientras se guarda (evita registros dobles)
    const run = (fn) => { if (t.disabled) return; t.disabled = true; const txt = t.textContent; t.textContent = 'Guardando…'; Promise.resolve().then(fn).catch((e) => { errReg(msgGitHub(e)); toast(msgGitHub(e)); }).finally(() => { t.disabled = false; t.textContent = txt; }); };
    const a = t.dataset.conc;
    if (a === 'guardar') run(guardarCarga);
    if (a === 'cuenta-guardar') run(() => guardarCuenta(!!t.dataset.editar));
    if (a === 'existente') run(() => registrarExistente(t.dataset.pago, t.dataset.mov));
    if (a === 'nuevo') run(() => registrarNuevo(t.dataset.mov));
    if (a === 'revisado') run(() => registrarRevisado(t.dataset.mov));
    if (a === 'gastos-ok') run(() => registrarGastos(t.dataset.grupo));
  });

  window.CONC = { abrir };
})();
