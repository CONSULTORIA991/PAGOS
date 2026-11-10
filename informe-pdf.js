// Informes en PDF: arma una hoja carta con el logo de ODESA y abre "Imprimir" del navegador,
// donde se escoge "Guardar como PDF". Lo usan todas las secciones (proyectos, pagos, cartera, cajas, RRHH).
'use strict';
window.InformePDF = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CSS = `
    @page { size: letter; margin: 14mm 14mm 16mm; @bottom-right { content: "Página " counter(page) " de " counter(pages); font: 8pt 'IBM Plex Sans', Arial, sans-serif; color: #56607a; } }
    * { box-sizing: border-box; }
    body { margin: 0; color: #121a2e; font: 9.5pt/1.45 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 3px solid #002796; padding-bottom: 8px; margin-bottom: 12px; }
    .cab img { height: 40px; } .cab .t { text-align: right; } .cab h1 { margin: 0; font-size: 15pt; } .cab .s { color: #56607a; }
    h2 { font-size: 11.5pt; margin: 14px 0 6px; color: #002796; break-after: avoid; }
    .frase { display: flex; justify-content: space-between; gap: 12px; align-items: center; border-radius: 6px; padding: 8px 12px; font-size: 11pt; font-weight: 600; background: #e2e9f5; }
    .frase.rojo { background: #fbe2df; } .frase.amarillo { background: #fbedd5; } .frase.verde { background: #dff2e6; }
    .frase .e { white-space: nowrap; font-size: 9.5pt; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
    .kpis div { border: 1px solid #d6dcea; border-radius: 6px; padding: 6px 8px; } .kpis span { color: #56607a; display: block; } .kpis b { font-size: 11pt; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    th { background: #e3eafb; color: #002796; text-align: left; padding: 4px 6px; font-size: 8.5pt; }
    td { padding: 4px 6px; border-bottom: 1px solid #e6eaf3; vertical-align: top; }
    tr { break-inside: avoid; }
    .n { text-align: right; white-space: nowrap; } .neg { color: #b02a20; } .pos, .okv { color: #1a7343; } .sub { color: #56607a; font-size: 8pt; }
    tr.sec td { background: #f3f5fb; font-weight: 700; font-size: 8.5pt; text-transform: uppercase; color: #002796; }
    tr.tot td { font-weight: 700; border-top: 1.5px solid #121a2e; }
    .chip { padding: 1px 7px; border-radius: 999px; font-weight: 600; font-size: 8.5pt; }
    .chip.rojo { background: #fbe2df; color: #8a1f17; } .chip.amarillo { background: #fbedd5; color: #6e4100; } .chip.verde { background: #dff2e6; color: #14593a; } .chip.gris { background: #e7eaed; color: #5a6670; }
    ul { margin: 4px 0; padding-left: 16px; } .nota { color: #56607a; font-size: 8.5pt; }
    .salto { break-before: page; }
    .pie { margin-top: 14px; border-top: 1px solid #d6dcea; padding-top: 6px; color: #56607a; font-size: 8pt; }`;

  // titulo, subtitulo (líneas), cuerpo (HTML ya escapado), nombre del archivo sugerido
  function abrir({ titulo, subtitulo = [], cuerpo, archivo }) {
    const A = window.ODESA || {};
    const yo = A.conf && A.conf.usuarios && A.conf.usuarios[A.uid];
    const quien = (yo && (yo.nombre || yo.usuario)) || '';
    const cuando = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date());
    const pie = `Generado con Cuadra el ${cuando}${quien ? ' por ' + quien : ''}`;
    const logo = new URL('logo-odesa.svg', location.href).href;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(archivo || titulo)}</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
      <style>${CSS}</style></head>
      <body><div class="cab"><img src="${logo}" alt="ODESA"><div class="t"><h1>${esc(titulo)}</h1>${subtitulo.map((s) => `<div class="s">${esc(s)}</div>`).join('')}</div></div>
      ${cuerpo}<p class="pie">${esc(pie)}.</p></body></html>`;
    let fr = document.getElementById('informe-pdf-marco');
    if (fr) fr.remove();
    fr = document.createElement('iframe');
    fr.id = 'informe-pdf-marco';
    fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(fr);
    const d = fr.contentDocument;
    d.open(); d.write(html); d.close();
    const imprimir = () => { const t0 = document.title; if (archivo) document.title = archivo; try { fr.contentWindow.focus(); fr.contentWindow.print(); } finally { setTimeout(() => { document.title = t0; }, 1000); } };
    // Espera el logo y las letras (máximo 2,5 s)
    const img = d.querySelector('img');
    const listo = Promise.all([
      img && !img.complete ? new Promise((ok) => { img.onload = img.onerror = ok; }) : null,
      d.fonts ? d.fonts.ready : null,
    ]);
    Promise.race([listo, new Promise((ok) => setTimeout(ok, 2500))]).then(imprimir);
    if (A.toast) A.toast('Se abrió la ventana de impresión: escoge "Guardar como PDF".');
  }
  return { abrir, esc };
})();
