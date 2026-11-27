// Formulario genérico compartido por los módulos de Odesa Bienes y Servicios (Inventario, Movimientos de banco).
// Mismo patrón que el formulario genérico de Informes de proyectos (proyectos.js), con su propio diálogo.
(() => {
  const A = window.ODESA;
  if (!A) return;
  const { $, mostrarError, msgGitHub, toast } = A;
  let formOk = null;
  let onDone = null;
  function abrir(tituloTxt, html, ok, boton, onGuardado) {
    $('#obs-titulo').textContent = tituloTxt;
    $('#obs-campos').innerHTML = html;
    $('#obs-go').textContent = boton || 'Guardar'; $('#obs-go').disabled = false;
    mostrarError('#obs-err', '');
    formOk = ok; onDone = onGuardado || null;
    $('#dlg-obs-form').showModal();
  }
  $('#obs-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!formOk) return;
    const b = $('#obs-go'); b.disabled = true;
    try { await formOk(); $('#dlg-obs-form').close(); toast('Guardado.'); if (onDone) onDone(); }
    catch (e) { mostrarError('#obs-err', e.message && !e.status ? e.message : msgGitHub(e)); }
    b.disabled = false;
  });
  window.OBSForm = { abrir };
})();
