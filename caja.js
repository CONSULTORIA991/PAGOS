// Enlace personal del responsable de una caja menor.
// Cada soporte (foto o PDF) se cifra en el celular con la llave pública de ODESA y se guarda en el buzón
// privado; al enviar, se deja la relación (lista de soportes + notas) también cifrada. Solo ODESA puede abrirla.
// Este enlace no da acceso a nada más de la aplicación.
(() => {
  const $ = (s) => document.querySelector(s);
  let cfg = null, persona = null, estado = null;

  // El enlace trae: id del responsable, su nombre y un código de verificación
  function leerEnlace() {
    try {
      const h = decodeURIComponent(location.hash.slice(1));
      const j = JSON.parse(Cripto.dec.decode(Cripto.unb64(h.replace(/-/g, '+').replace(/_/g, '/'))));
      if (j.i && j.s && j.n) return j;
    } catch (e) {}
    return null;
  }
  function desofuscar(s) {
    const clave = Cripto.enc.encode('odesa-buzon');
    return Cripto.dec.decode(Cripto.unb64(s.split('').reverse().join('')).map((x, i) => x ^ clave[i % clave.length]));
  }
  const CLAVE_LOCAL = () => 'caja.' + persona.i;
  function guardarLocal() { try { localStorage.setItem(CLAVE_LOCAL(), JSON.stringify(estado)); } catch (e) {} }
  function cargarLocal() {
    try { const j = JSON.parse(localStorage.getItem(CLAVE_LOCAL()) || 'null'); if (j && j.rid) return j; } catch (e) {}
    return { rid: [...Cripto.aleatorio(9)].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join(''), soportes: [] };
  }
  function error(m) { $('#err').textContent = m || ''; $('#err').hidden = !m; }

  // ---------- cifrado con la llave pública ----------
  let pubKey = null;
  async function sobre(bytes) {
    if (!pubKey) pubKey = await crypto.subtle.importKey('jwk', cfg.pub, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const llave = Cripto.aleatorio(32);
    const ct = await Cripto.cifrar(await Cripto.importarMaestra(llave), bytes);
    const ek = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, llave));
    return JSON.stringify({ v: 1, ek: Cripto.b64(ek), ct: Cripto.b64(ct) });
  }
  async function api(ruta, metodo, cuerpo) {
    const r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${ruta}`, {
      method: metodo || 'GET',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + desofuscar(cfg.t), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (!r.ok) throw { status: r.status };
    return r.status === 204 ? null : r.json();
  }

  // ---------- imágenes ----------
  function reducir(file, max, calidad) {
    return new Promise((ok, mal) => {
      const img = new Image();
      img.onload = () => {
        const e = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * e); c.height = Math.round(img.height * e);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob((b) => (b ? ok(b) : mal(new Error('imagen'))), 'image/jpeg', calidad);
      };
      img.onerror = () => mal(new Error('imagen'));
      img.src = URL.createObjectURL(file);
    });
  }
  async function miniatura(blob) {
    const b = await reducir(new File([blob], 'x.jpg'), 140, 0.6);
    return new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
  }

  // ---------- render ----------
  function render() {
    const n = estado.soportes.length;
    $('#r-n').textContent = `${n} ${n === 1 ? 'soporte' : 'soportes'}`;
    $('#r-fecha').textContent = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
    $('#sops').innerHTML = estado.soportes.map((s, i) => `
      <div class="sop">${s.mini ? `<img src="${s.mini}" alt="Soporte ${i + 1}">` : '<span class="pdfi">PDF</span>'}
        <div><input data-nota="${i}" value="${(s.nota || '').replace(/"/g, '&quot;')}" placeholder="¿Para qué fue? (ej. gasolina camioneta)" maxlength="120"><span class="est ${s.ruta ? 'ok' : s.error ? 'bad' : ''}">${s.ruta ? '✓ Subido' : s.error ? 'No se pudo subir. Toca Reintentar.' : 'Subiendo…'}</span></div>
        <div style="display:grid;gap:6px">${s.error ? `<button class="btn sm" type="button" data-reintentar="${i}">Reintentar</button>` : ''}<button class="btn sm ghost" type="button" data-quitar="${i}" aria-label="Quitar soporte">Quitar</button></div>
      </div>`).join('');
    const subiendo = estado.soportes.some((s) => !s.ruta);
    $('#enviar').disabled = !n || subiendo;
    $('#enviar').textContent = subiendo ? 'Esperando que terminen de subir…' : n ? `Enviar relación (${n} ${n === 1 ? 'soporte' : 'soportes'})` : 'Agrega al menos un soporte';
  }

  const pendientes = new Map(); // índice → archivo original (solo en esta sesión, para reintentar)
  async function subir(s, file) {
    try {
      const esPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (esPdf && file.size > 8 * 1024 * 1024) throw new Error('El PDF pesa más de 8 MB.');
      const blob = esPdf ? file : await reducir(file, 1700, 0.72);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const contenido = await sobre(bytes);
      const ruta = `cajas/${persona.i}/${estado.rid}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`;
      await api('/contents/' + ruta, 'PUT', { message: 'soporte', content: Cripto.b64(Cripto.enc.encode(contenido)) });
      s.ruta = ruta; s.tipo = esPdf ? 'application/pdf' : 'image/jpeg'; s.error = false;
    } catch (e) {
      s.error = true;
      if (e && e.status === 403) error('El buzón todavía no permite guardar soportes. Avisa a ODESA.');
    }
    guardarLocal(); render();
  }
  async function agregar(files) {
    error('');
    for (const f of files) {
      if (!/^image\//.test(f.type) && !/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') continue;
      const s = { nota: '', mini: '', ruta: '' };
      try { if (/^image\//.test(f.type)) s.mini = await miniatura(f); } catch (e) {}
      estado.soportes.push(s);
      pendientes.set(s, f);
      guardarLocal(); render();
      await subir(s, f);
    }
  }
  $('#cam').addEventListener('change', (e) => { agregar([...e.target.files]); e.target.value = ''; });
  $('#gal').addEventListener('change', (e) => { agregar([...e.target.files]); e.target.value = ''; });
  document.addEventListener('input', (e) => {
    if (e.target.dataset.nota == null) return;
    estado.soportes[Number(e.target.dataset.nota)].nota = e.target.value;
    guardarLocal();
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.reintentar != null) { const s = estado.soportes[Number(t.dataset.reintentar)]; const f = pendientes.get(s); if (f) { s.error = false; render(); await subir(s, f); } else error('Vuelve a agregar ese soporte.'); }
    if (t.dataset.quitar != null) {
      const i = Number(t.dataset.quitar), s = estado.soportes[i];
      estado.soportes.splice(i, 1); guardarLocal(); render();
      if (s.ruta) { try { const f = await api('/contents/' + s.ruta); await api('/contents/' + s.ruta, 'DELETE', { message: 'quitar', sha: f.sha }); } catch (x) {} }
    }
  });

  $('#enviar').addEventListener('click', async () => {
    const btn = $('#enviar');
    if (!estado.soportes.length || estado.soportes.some((s) => !s.ruta)) return;
    btn.disabled = true; btn.textContent = 'Enviando…'; error('');
    try {
      const rad = estado.rid.slice(0, 6).toUpperCase();
      const relacion = { v: 1, tipo: 'caja', responsable: persona.i, secreto: persona.s, nombre: persona.n, rid: estado.rid, radicado: rad, fecha: new Date().toISOString(), soportes: estado.soportes.map((s) => ({ ruta: s.ruta, nota: s.nota || '', tipo: s.tipo })) };
      const cuerpo = await sobre(Cripto.enc.encode(JSON.stringify(relacion)));
      await api('/issues', 'POST', { title: 'Caja ' + rad, body: 'buzon-caja-v1\n' + cuerpo });
      const n = estado.soportes.length;
      try { localStorage.removeItem(CLAVE_LOCAL()); } catch (e) {}
      estado = cargarLocal();
      $('#trabajo').hidden = true; $('#listo').hidden = false;
      $('#radicado').textContent = rad;
      $('#listo-txt').textContent = `Se enviaron ${n} ${n === 1 ? 'soporte' : 'soportes'}. ODESA leerá los datos y te asignará el número de la caja.`;
    } catch (e) {
      error('No se pudo enviar. Revisa tu conexión a internet e inténtalo de nuevo.');
      btn.disabled = false; render();
    }
  });
  $('#nueva').addEventListener('click', () => { $('#listo').hidden = true; $('#trabajo').hidden = false; render(); });

  // ---------- arranque ----------
  (async () => {
    persona = leerEnlace();
    if (!persona) { $('#aviso').textContent = 'Este enlace no es válido. Pide a ODESA que te lo envíe de nuevo.'; $('#aviso').hidden = false; return; }
    $('#titulo').textContent = 'Caja menor · ' + persona.n;
    try {
      const r = await fetch('cobro-config.json?t=' + Date.now(), { cache: 'no-store' });
      cfg = await r.json();
      if (!cfg.pub || !cfg.t) throw 0;
    } catch (e) { $('#aviso').textContent = 'El servicio de cajas menores no está activo. Avisa a ODESA.'; $('#aviso').hidden = false; return; }
    estado = cargarLocal();
    estado.soportes = estado.soportes.filter((s) => s.ruta); // los que no alcanzaron a subir se vuelven a agregar
    guardarLocal();
    $('#trabajo').hidden = false;
    render();
  })();
})();
