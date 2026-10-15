// Acceso a los archivos del repositorio mediante la API de GitHub.
// Los mensajes de commit son siempre genéricos: el repositorio es público.
const GH = (() => {
  const API = 'https://api.github.com';
  let cfg = { owner: '', repo: '', branch: 'main', token: '' };

  function configurar(c) { cfg = { owner: c.owner, repo: c.repo, branch: c.branch || 'main', token: c.token || '' }; }
  function actual() { return { ...cfg }; }

  // Deduce el repositorio cuando la página está publicada en <usuario>.github.io/<repo>/
  function desdeUbicacion() {
    const host = location.hostname.toLowerCase();
    if (!host.endsWith('.github.io')) return null;
    const owner = host.slice(0, -'.github.io'.length);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    const repo = seg && !/\.html?$/i.test(seg) ? seg : owner + '.github.io';
    return { owner, repo };
  }

  function cabeceras(extra) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (cfg.token) h.Authorization = 'Bearer ' + cfg.token;
    return Object.assign(h, extra || {});
  }
  const urlArchivo = (ruta) => `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${ruta.split('/').map(encodeURIComponent).join('/')}`;

  async function error(r) {
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch (e) {}
    return { status: r.status, message: msg, conflicto: r.status === 409 || (r.status === 422 && /sha/i.test(msg)) };
  }

  // Devuelve { sha, bytes, etag } | null si no existe | { sinCambios: true } si el etag coincide.
  async function leer(ruta, opciones) {
    const op = opciones || {};
    const r = await fetch(urlArchivo(ruta) + '?ref=' + encodeURIComponent(cfg.branch), {
      headers: cabeceras(op.etag ? { 'If-None-Match': op.etag } : null), cache: 'no-store',
    });
    if (r.status === 304) return { sinCambios: true };
    if (r.status === 404) return null;
    if (!r.ok) throw await error(r);
    const j = await r.json();
    let contenido = (j.content || '').replace(/\n/g, '');
    if (!contenido && j.size > 0) {
      const rb = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/git/blobs/${j.sha}`, { headers: cabeceras(), cache: 'no-store' });
      if (!rb.ok) throw await error(rb);
      contenido = (await rb.json()).content.replace(/\n/g, '');
    }
    return { sha: j.sha, bytes: Cripto.unb64(contenido), etag: r.headers.get('ETag') };
  }

  // Lectura antes de iniciar sesión (sin token). Si la API no responde, usa la copia publicada en Pages.
  async function leerPublico(ruta) {
    try {
      return await leer(ruta);
    } catch (e) {
      const r = await fetch(ruta + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw e;
      return { sha: null, bytes: new Uint8Array(await r.arrayBuffer()) };
    }
  }

  async function escribir(ruta, bytes, sha) {
    const cuerpo = { message: 'Actualización', content: Cripto.b64(bytes), branch: cfg.branch };
    if (sha) cuerpo.sha = sha;
    const r = await fetch(urlArchivo(ruta), { method: 'PUT', headers: cabeceras({ 'Content-Type': 'application/json' }), body: JSON.stringify(cuerpo) });
    if (!r.ok) throw await error(r);
    return (await r.json()).content.sha;
  }

  async function borrar(ruta) {
    const f = await leer(ruta);
    if (!f || !f.sha) return;
    const r = await fetch(urlArchivo(ruta), { method: 'DELETE', headers: cabeceras({ 'Content-Type': 'application/json' }), body: JSON.stringify({ message: 'Actualización', sha: f.sha, branch: cfg.branch }) });
    if (!r.ok && r.status !== 404) throw await error(r);
  }

  // Comprueba que el token puede escribir en el repositorio.
  async function verificar() {
    const r = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}`, { headers: cabeceras(), cache: 'no-store' });
    if (r.status === 404) return { ok: false, motivo: 'No encontré el repositorio o el token no tiene acceso a él.' };
    if (r.status === 401) return { ok: false, motivo: 'El token no es válido o ya venció.' };
    if (!r.ok) return { ok: false, motivo: 'GitHub respondió con un error (' + r.status + ').' };
    const j = await r.json();
    if (j.permissions && j.permissions.push === false) return { ok: false, motivo: 'El token no tiene permiso de escritura (Contents: Read and write).' };
    return { ok: true, privado: j.private };
  }

  return { configurar, actual, desdeUbicacion, leer, leerPublico, escribir, borrar, verificar };
})();
