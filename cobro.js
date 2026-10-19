// Formulario público de cuentas de cobro y anticipos para contratistas.
// No requiere usuario: el envío se cifra en el celular con la llave pública de la empresa
// (RSA-OAEP + AES-256-GCM) y se deja en el buzón (un repositorio privado de GitHub).
// Solo la aplicación, con la llave privada guardada cifrada, puede abrirlo.
(() => {
  const $ = (s) => document.querySelector(s);
  const tipo = new URLSearchParams(location.search).get('tipo') === 'anticipo' ? 'anticipo' : 'cobro';
  const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  let cfg = null;

  if (tipo === 'anticipo') {
    document.title = 'Solicitud de anticipo ODESA';
    $('#titulo').textContent = 'Solicitud de anticipo';
    $('#lead').textContent = 'Llena tus datos para solicitar el anticipo. Tu solicitud pasa a aprobación y, si se aprueba, se programa el pago.';
    $('#h-cobro').textContent = '¿Para qué es el anticipo?';
    $('#l-desc').textContent = 'Descripción del trabajo o compra';
    $('#descripcion').placeholder = 'Ej. Anticipo 50% mano de obra enchape piscina';
    $('#declaracion').textContent = 'Declaro que la información es verídica y que el anticipo se descontará del valor total del trabajo o compra.';
  }

  // El token del buzón viene ofuscado (no es un secreto: solo permite crear envíos en el buzón).
  function desofuscar(s) {
    const clave = Cripto.enc.encode('odesa-buzon');
    const b = Cripto.unb64(s.split('').reverse().join(''));
    return Cripto.dec.decode(b.map((x, i) => x ^ clave[i % clave.length]));
  }

  async function cargarConfig() {
    try {
      const r = await fetch('cobro-config.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw 0;
      cfg = await r.json();
      if (!cfg.pub || !cfg.owner || !cfg.repo || !cfg.t) throw 0;
    } catch (e) {
      $('#aviso').textContent = 'Este enlace todavía no está activo. Pide a ODESA que te envíe el enlace de nuevo.';
      $('#aviso').hidden = false;
      $('#enviar').disabled = true;
    }
  }

  // ---------- valor ----------
  function monto(v) { const d = String(v || '').replace(/\D/g, ''); return d ? Number(d) : 0; }
  $('#valor').addEventListener('input', () => {
    const n = monto($('#valor').value);
    $('#valor-ver').textContent = n ? money.format(n) : '';
  });

  // ---------- foto de la cédula (se reduce para el envío) ----------
  let fotoDataUrl = '';
  function reducirImagen(file, max, calidad) {
    return new Promise((ok, mal) => {
      const img = new Image();
      img.onload = () => {
        const esc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * esc); c.height = Math.round(img.height * esc);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        ok(c.toDataURL('image/jpeg', calidad));
      };
      img.onerror = () => mal(new Error('imagen'));
      img.src = URL.createObjectURL(file);
    });
  }
  $('#foto').addEventListener('change', async () => {
    const f = $('#foto').files[0];
    fotoDataUrl = '';
    $('#foto-prev').hidden = true;
    if (!f) return;
    try {
      fotoDataUrl = await reducirImagen(f, 1100, 0.62);
      $('#foto-prev').src = fotoDataUrl; $('#foto-prev').hidden = false;
    } catch (e) { error('No pude abrir la foto. Toma otra foto de la cédula.'); }
  });

  // ---------- firma con el dedo ----------
  const lienzo = $('#firma');
  const ctx = lienzo.getContext('2d');
  let firmado = false, dibujando = false, ultimo = null;
  function ajustarLienzo() {
    const r = lienzo.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const copia = firmado ? lienzo.toDataURL() : null;
    lienzo.width = Math.round(r.width * dpr); lienzo.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#12201b';
    if (copia) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = copia; }
  }
  const punto = (ev) => { const r = lienzo.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  lienzo.addEventListener('pointerdown', (ev) => { ev.preventDefault(); dibujando = true; ultimo = punto(ev); lienzo.setPointerCapture(ev.pointerId); });
  lienzo.addEventListener('pointermove', (ev) => {
    if (!dibujando) return;
    const p = punto(ev);
    ctx.beginPath(); ctx.moveTo(ultimo.x, ultimo.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ultimo = p; firmado = true;
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => lienzo.addEventListener(t, () => { dibujando = false; }));
  $('#borrar').addEventListener('click', () => { ctx.clearRect(0, 0, lienzo.width, lienzo.height); firmado = false; });
  window.addEventListener('resize', ajustarLienzo);
  ajustarLienzo();
  function firmaDataUrl() {
    // Firma sobre fondo blanco, recortada a un tamaño liviano
    const c = document.createElement('canvas');
    c.width = 600; c.height = Math.round(600 * lienzo.height / lienzo.width);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(lienzo, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  // ---------- envío ----------
  function error(msg) { const e = $('#err'); e.textContent = msg || ''; e.hidden = !msg; if (msg) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function radicado() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...Cripto.aleatorio(6)].map((b) => abc[b % abc.length]).join('');
  }
  async function cifrarSobre(datos) {
    const pub = await crypto.subtle.importKey('jwk', cfg.pub, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const llave = Cripto.aleatorio(32);
    const k = await Cripto.importarMaestra(llave);
    const ct = await Cripto.cifrarJSON(k, datos);
    const ek = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, llave));
    return JSON.stringify({ v: 1, ek: Cripto.b64(ek), ct: Cripto.b64(ct) });
  }
  async function api(ruta, cuerpo, token) {
    const r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + ruta, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    if (!r.ok) throw { status: r.status };
    return r.json();
  }

  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error('');
    if ($('#sitio').value) return; // relleno automático de robots
    const d = {
      nombre: $('#nombre').value.trim(), cedula: $('#cedula').value.replace(/\D/g, ''), celular: $('#celular').value.replace(/[^\d+]/g, ''),
      proyecto: $('#proyecto').value.trim(), descripcion: $('#descripcion').value.trim(), valor: monto($('#valor').value),
      banco: $('#banco').value, tipoCuenta: $('#tipoCuenta').value, numeroCuenta: $('#numeroCuenta').value.replace(/\s/g, ''),
    };
    if (d.nombre.split(/\s+/).length < 2) return error('Escribe tu nombre completo (nombre y apellido).');
    if (d.cedula.length < 5) return error('Escribe tu número de cédula, solo números.');
    if (d.celular.replace(/\D/g, '').length < 7) return error('Escribe tu número de celular.');
    if (!d.proyecto) return error('Escribe el proyecto u obra.');
    if (d.descripcion.length < 5) return error('Describe el trabajo que estás cobrando.');
    if (!(d.valor >= 1000)) return error('Escribe el valor a cobrar, por ejemplo 1.400.000.');
    if (!d.banco || !d.tipoCuenta || d.numeroCuenta.length < 6) return error('Completa los datos de la cuenta para consignarte.');
    if (!fotoDataUrl) return error('Toma la foto de tu cédula.');
    if (!firmado) return error('Firma con el dedo dentro del recuadro.');
    if (!$('#declaro').checked) return error('Marca la casilla de la declaración para poder enviar.');

    const btn = $('#enviar'); btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const rad = radicado();
      const datos = { v: 1, tipo, radicado: rad, fecha: new Date().toISOString(), ...d, firma: firmaDataUrl(), foto: fotoDataUrl };
      const sobre = await cifrarSobre(datos);
      const partes = [];
      for (let i = 0; i < sobre.length; i += 60000) partes.push(sobre.slice(i, i + 60000));
      const token = desofuscar(cfg.t);
      const issue = await api('/issues', { title: 'Envío ' + rad, body: `buzon-v1 partes=${partes.length}\n` + partes[0] }, token);
      for (let i = 1; i < partes.length; i++) await api(`/issues/${issue.number}/comments`, { body: `parte ${i + 1}\n` + partes[i] }, token);
      $('#form').hidden = true;
      $('#radicado').textContent = rad;
      $('#listo-txt').textContent = `${tipo === 'anticipo' ? 'Solicitud de anticipo' : 'Cuenta de cobro'} por ${money.format(d.valor)}. Te avisaremos cuando sea aprobada.`;
      $('#listo').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      error(e && e.status ? 'No se pudo enviar (error ' + e.status + '). Inténtalo de nuevo en unos minutos o avisa a ODESA.' : 'No se pudo enviar. Revisa tu conexión a internet e inténtalo de nuevo.');
      btn.disabled = false; btn.textContent = 'Enviar';
    }
  });

  cargarConfig();
})();
