// Cifrado de la aplicación (Web Crypto del navegador).
// - Una llave maestra AES-256-GCM cifra todos los datos y facturas.
// - Cada usuario guarda esa llave maestra "envuelta" con su contraseña
//   (PBKDF2-SHA256, 600.000 iteraciones). Sin una contraseña válida no se puede leer nada.
const Cripto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ITER = 600000;

  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  const aleatorio = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function idUsuario(usuario) {
    const h = await crypto.subtle.digest('SHA-256', enc.encode('pagos-odesa:' + usuario.trim().toLowerCase()));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function llaveDeClave(clave, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(clave), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter || ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function importarMaestra(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async function cifrar(llave, bytes) {
    const iv = aleatorio(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, llave, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function descifrar(llave, datos) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: datos.subarray(0, 12) }, llave, datos.subarray(12)));
  }
  async function envolver(rawMaestra, clave) {
    const salt = aleatorio(16);
    const k = await llaveDeClave(clave, salt, ITER);
    return { salt: b64(salt), iter: ITER, llave: b64(await cifrar(k, rawMaestra)) };
  }
  async function desenvolver(entrada, clave) {
    const k = await llaveDeClave(clave, unb64(entrada.salt), entrada.iter || ITER);
    return descifrar(k, unb64(entrada.llave));
  }
  const cifrarJSON = (llave, obj) => cifrar(llave, enc.encode(JSON.stringify(obj)));
  const descifrarJSON = async (llave, datos) => JSON.parse(dec.decode(await descifrar(llave, datos)));

  return { b64, unb64, aleatorio, idUsuario, importarMaestra, cifrar, descifrar, envolver, desenvolver, cifrarJSON, descifrarJSON, enc, dec };
})();
