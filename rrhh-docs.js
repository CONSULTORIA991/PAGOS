// Documentos de Recursos humanos: contratos (indefinido, término fijo, obra o labor), citación y acta de
// descargos, memorando de suspensión, carta de no prórroga, carta de terminación y certificado laboral.
// Cada documento se arma como una lista de bloques y se convierte en Word (.docx) con la librería "docx".
// Si falta un dato, sale resaltado en amarillo entre ⟦ ⟧ para completarlo a mano.
// Funciona en el navegador (window.RRHHDocs) y en Node (module.exports) para sacar los borradores.
(function (raiz) {
  // ---------- empresas ----------
  const EMPRESAS = {
    odesa: { razon: 'ODESA CARIBE S.A.S.', nit: '900.409.543-1', dir: 'Calle 93 No. 49C-274', tel: '313 506 1040', ciudad: 'Barranquilla', rep: 'JOSE FERNANDO PUCHE PERNETT', repCC: '72.001.413' },
    obs: { razon: 'ODESA BIENES Y SERVICIOS S.A.S.', nit: '901.724.020', dir: 'Calle 93 No. 49C-274', tel: '', ciudad: 'Barranquilla', rep: 'DORIAN ALBERTO FLOREZ CASTRO', repCC: '72.303.668' },
  };
  const empresaDoc = (nombre) => (/OBS|BIENES/i.test(String(nombre || '')) ? EMPRESAS.obs : EMPRESAS.odesa);

  // ---------- números y fechas en letras ----------
  const U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
  const D = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
  function menorMil(n) {
    if (n === 100) return 'CIEN';
    const c = Math.floor(n / 100), r = n % 100;
    let s = c ? C[c] : '';
    if (r) s += (s ? ' ' : '') + (r < 30 ? U[r] : D[Math.floor(r / 10)] + (r % 10 ? ' Y ' + U[r % 10] : ''));
    return s;
  }
  // "apocope" UNO → UN delante de MIL, MILLÓN(ES), PESOS, DÍAS…
  const un = (s) => s.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/UNO$/, 'UN');
  function letras(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (n === 0) return 'CERO';
    const mill = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000;
    const p = [];
    if (mill) p.push(mill === 1 ? 'UN MILLÓN' : un(letras(mill)) + ' MILLONES');
    if (miles) p.push(miles === 1 ? 'MIL' : un(menorMil(miles)) + ' MIL');
    if (resto) p.push(menorMil(resto));
    return p.join(' ');
  }
  const cifra = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO').replace(/,/g, '.');
  const pesos = (n) => `${un(letras(n))}${Math.round(n) % 1e6 === 0 && n >= 1e6 ? ' DE' : ''} PESOS M/CTE (${cifra(n)})`;
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const partes = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
  const minus = (s) => s.toLowerCase().replace(/^./, (c) => c);
  // 14 de octubre de 2026
  const fecha = (iso) => { const p = partes(iso); return p ? `${p.d} de ${MESES[p.m - 1]} de ${p.y}` : null; };
  // catorce (14) de octubre de 2026
  const fechaLetras = (iso) => { const p = partes(iso); return p ? `${minus(p.d === 1 ? 'primero' : letras(p.d))} (${p.d}) de ${MESES[p.m - 1]} de ${p.y}` : null; };
  // a los catorce (14) días del mes de octubre de 2026
  const alosDias = (iso) => { const p = partes(iso); return p ? `a los ${minus(un(letras(p.d)))} (${p.d}) ${p.d === 1 ? 'día' : 'días'} del mes de ${MESES[p.m - 1]} de ${p.y}` : null; };
  const nLetras = (n, sing, plur) => `${minus(un(letras(n)))} (${n}) ${n === 1 ? sing : plur}`;
  function sumarDias(iso, n) { const p = partes(iso); if (!p) return ''; const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return d.toISOString().slice(0, 10); }
  function sumarMeses(iso, n) { const p = partes(iso); if (!p) return ''; const d = new Date(Date.UTC(p.y, p.m - 1 + n, p.d - 1)); return d.toISOString().slice(0, 10); }

  // ---------- datos ----------
  const falta = (etq) => `⟦${etq}⟧`;
  const v = (x, etq) => (x === undefined || x === null || String(x).trim() === '' ? falta(etq) : String(x));
  function genero(e) {
    const f = String((e || {}).sexo || '').toUpperCase() === 'F';
    return f
      ? { T: 'LA TRABAJADORA', de: 'de LA TRABAJADORA', a: 'a LA TRABAJADORA', id: 'identificada', sr: 'Señora', est: 'Estimada', o: 'a', el: 'la' }
      : { T: 'EL TRABAJADOR', de: 'de EL TRABAJADOR', a: 'a EL TRABAJADOR', id: 'identificado', sr: 'Señor', est: 'Estimado', o: 'o', el: 'el' };
  }
  const TIPO_TXT = { indefinido: 'Término indefinido', fijo: 'Término fijo', obra: 'Obra o labor' };
  // Acepta lo que ya tenga guardado el empleado ("Término fijo", "Obra o labor"…)
  function tipoContrato(e) {
    const t = String((e || {}).contrato || '').toLowerCase();
    if (/fijo/.test(t)) return 'fijo';
    if (/obra|labor/.test(t)) return 'obra';
    if (/indefinido/.test(t)) return 'indefinido';
    return '';
  }
  // Duración en meses de un contrato fijo (de ingreso a fin)
  function mesesEntre(ini, fin) {
    const a = partes(ini), b = partes(fin); if (!a || !b) return 0;
    return Math.round(((b.y - a.y) * 12 + (b.m - a.m) + (b.d - a.d + 1) / 30) * 10) / 10;
  }

  // ---------- bloques ----------
  const T = (t) => ({ k: 't', t });            // título centrado
  const S = (t) => ({ k: 's', t });            // subtítulo (negrilla, izquierda)
  const P = (t, o) => ({ k: 'p', t, ...(o || {}) }); // párrafo justificado; **negrilla**
  const L = (items) => ({ k: 'l', items });    // lista
  const TB = (filas) => ({ k: 'tb', filas });  // tabla de dos columnas
  const F = (cols) => ({ k: 'f', cols });      // firmas lado a lado
  const SALTO = { k: 'br' };
  const ESP = { k: 'esp' };

  const ORD = ['PRIMERA', 'SEGUNDA', 'TERCERA', 'CUARTA', 'QUINTA', 'SEXTA', 'SÉPTIMA', 'OCTAVA', 'NOVENA', 'DÉCIMA', 'DÉCIMA PRIMERA', 'DÉCIMA SEGUNDA', 'DÉCIMA TERCERA', 'DÉCIMA CUARTA', 'DÉCIMA QUINTA', 'DÉCIMA SEXTA'];
  function clausulas(lista) {
    const out = [];
    lista.filter(Boolean).forEach(([tit, ...pars], i) => {
      pars.forEach((x, j) => {
        if (typeof x === 'object') out.push(x);
        else out.push(P(j === 0 ? `**${ORD[i]}.- ${tit}:** ${x}` : x));
      });
    });
    return out;
  }
  function firmaEmpleador(emp) { return [`**EL EMPLEADOR**`, `**${emp.rep}**`, `C.C. No. ${emp.repCC}`, `Representante legal`, emp.razon]; }
  function firmaTrabajador(e, g) { return [`**${g.T}**`, `**${v(e.nombre, 'NOMBRE')}**`, `C.C. No. ${v(e.cedula, 'CÉDULA')}`]; }
  function encabezadoCarta(emp, e, g, fechaDoc, asunto) {
    return [
      P(`${emp.ciudad}, ${v(fecha(fechaDoc), 'FECHA')}`),
      ESP,
      P(`${g.sr}`), P(`**${v(e.nombre, 'NOMBRE')}**`), P(`C.C. ${v(e.cedula, 'CÉDULA')}`), P(`Cargo: ${v(e.cargo, 'CARGO')}`), P(`${v(e.direccion, 'DIRECCIÓN')}`), P(emp.ciudad),
      ESP,
      P(`**Asunto: ${asunto}**`),
      ESP,
      P(`${g.est} ${g.sr.toLowerCase()}:`),
    ];
  }
  function recibido(e, g, testigos) {
    const out = [ESP, F([[`______________________________`, ...firmaEmpleadorCorta()], [`______________________________`, `**Recibido: ${v(e.nombre, 'NOMBRE')}**`, `C.C. ${v(e.cedula, 'CÉDULA')}`, `Fecha de recibido: ____________`]])];
    if (testigos) out.push(ESP, P(`Si ${g.el} trabajador${g.o === 'a' ? 'a' : ''} se niega a firmar, firman dos testigos:`, { pequeno: true }), F([[`______________________________`, 'Testigo 1', 'C.C.'], [`______________________________`, 'Testigo 2', 'C.C.']]));
    return out;
  }
  let _emp = null; // empresa del documento en curso (para la firma corta)
  function firmaEmpleadorCorta() { return [`**${_emp.rep}**`, `Representante legal`, _emp.razon]; }

  // ---------- contratos ----------
  function contrato(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e), tipo = x.tipo || tipoContrato(e) || 'indefinido';
    const sal = Number(e.salario) || 0, smmlv = Number(x.smmlv) || 1750905, aux = Number(x.aux) || 249095;
    const conAux = e.aux !== false && sal > 0 && sal <= 2 * smmlv;
    const meses = tipo === 'fijo' ? mesesEntre(e.ingreso, e.contratoFin) : 0;
    const dPrueba = Number(e.prueba) || (tipo === 'fijo' && meses ? Math.min(60, Math.floor(meses * 30 / 5)) : 60);
    const pruebaTxt = dPrueba >= 60 && dPrueba % 30 === 0 ? nLetras(dPrueba / 30, 'mes', 'meses') : nLetras(dPrueba, 'día calendario', 'días calendario');
    const titulo = { indefinido: 'CONTRATO INDIVIDUAL DE TRABAJO A TÉRMINO INDEFINIDO', fijo: `CONTRATO INDIVIDUAL DE TRABAJO A TÉRMINO FIJO${meses && meses < 12 ? ' INFERIOR A UN AÑO' : ''}`, obra: 'CONTRATO INDIVIDUAL DE TRABAJO POR DURACIÓN DE LA OBRA O LABOR CONTRATADA' }[tipo];
    const salTxt = sal ? pesos(sal) : falta('SALARIO');
    const esMinimo = sal === smmlv;
    const durTxt = meses ? (Number.isInteger(meses) ? nLetras(meses, 'mes', 'meses').toUpperCase() : `${String(meses).replace('.', ',')} MESES`) : falta('DURACIÓN EN MESES');
    const fil = [
      ['INFORMACIÓN DEL EMPLEADOR', ''],
      ['NOMBRE', emp.razon], ['NIT', emp.nit], ['DIRECCIÓN', emp.dir], ['TELÉFONO', emp.tel || '______________________________'], ['REPRESENTANTE LEGAL', emp.rep], ['C.C.', emp.repCC],
      [g.o === 'a' ? 'INFORMACIÓN DE LA TRABAJADORA' : 'INFORMACIÓN DEL TRABAJADOR', ''],
      ['NOMBRE', v(e.nombre, 'NOMBRE COMPLETO')], ['C.C.', `${v(e.cedula, 'CÉDULA')}${e.expedida ? ' de ' + e.expedida : ''}`], ['TELÉFONO', v(e.telefono, 'TELÉFONO')], ['DIRECCIÓN', v(e.direccion, 'DIRECCIÓN')],
      ['CARGO A DESEMPEÑAR', v(e.cargo, 'CARGO')], ['TIPO DE CONTRATO', tipo === 'fijo' ? `Término fijo – ${durTxt.toLowerCase()}` : TIPO_TXT[tipo]],
      ['SALARIO BÁSICO', sal ? `${esMinimo ? 'Un (1) salario mínimo legal mensual vigente – ' : ''}${cifra(sal)} mensuales` : falta('SALARIO')],
      ['AUXILIO DE TRANSPORTE', conAux ? 'El legal vigente' : 'No aplica'],
      ['PERIODO DE PRUEBA', pruebaTxt.replace(/^./, (c) => c.toUpperCase())],
      ['FECHA DE INICIO DE LABORES', v(fechaLetras(e.ingreso), 'FECHA DE INGRESO').replace(/^./, (c) => c.toUpperCase())],
      ...(tipo === 'fijo' ? [['FECHA DE TERMINACIÓN', v(fechaLetras(e.contratoFin), 'FECHA DE TERMINACIÓN').replace(/^./, (c) => c.toUpperCase())]] : []),
      ...(tipo === 'obra' ? [['OBRA O LABOR', v(e.obra, 'DESCRIPCIÓN DE LA OBRA O LABOR')]] : []),
      ['LUGAR DE TRABAJO', v(e.lugar, 'LUGAR DE TRABAJO')],
      ['AFILIACIONES', `EPS: ${v(e.eps, 'EPS')} · Pensión: ${v(e.afp, 'FONDO DE PENSIONES')} · ARL: ${v(e.arl, 'ARL')} (riesgo ${['', 'I', 'II', 'III', 'IV', 'V'][e.riesgo || 1]}) · Caja: ${v(e.ccf, 'CAJA DE COMPENSACIÓN')} · Cesantías: ${v(e.cesantias, 'FONDO DE CESANTÍAS')}`],
    ];
    const cuerpo = clausulas([
      ['OBJETO Y OBLIGACIONES', `EL EMPLEADOR contrata los servicios personales ${g.de} para que se desempeñe como **${v(e.cargo, 'CARGO').toUpperCase()}**. ${g.T} se obliga a:`,
        L([
          'Poner al servicio del empleador toda su capacidad normal de trabajo, en forma exclusiva, en el desempeño de las funciones propias del oficio mencionado y en las labores anexas y complementarias del mismo, de conformidad con las órdenes e instrucciones que le imparta el empleador o sus representantes.',
          'No prestar directa ni indirectamente servicios laborales a otros empleadores, ni trabajar por cuenta propia en el mismo oficio, durante la vigencia de este contrato.',
          'Laborar la jornada ordinaria en los turnos y dentro de las horas señaladas por el empleador, pudiendo hacer éste ajustes o cambios de horario cuando lo estime conveniente.',
          'Cumplir las normas, procedimientos e instrucciones del Sistema de Gestión de Seguridad y Salud en el Trabajo (SG-SST) y usar de forma permanente y adecuada los elementos de protección personal suministrados por el empleador.',
          'Cuidar y conservar las herramientas, equipos, materiales e insumos que se le entreguen, y restituirlos en buen estado, salvo el deterioro natural.',
          'Cumplir el Reglamento Interno de Trabajo y las políticas de la empresa.',
        ]),
        `**PARÁGRAFO:** Las funciones detalladas del cargo se encuentran descritas en el Anexo 1 – Funciones del cargo, el cual hace parte integral del presente contrato. ${g.T} manifiesta estar en condiciones óptimas de salud para desempeñar las labores para las cuales es contratad${g.o}, lo cual será verificado mediante el examen médico ocupacional de ingreso.`],
      ['SALARIO', `EL EMPLEADOR pagará ${g.a} por la prestación de sus servicios la suma de ${salTxt} mensuales${esMinimo ? ', equivalente a un (1) salario mínimo legal mensual vigente, el cual se ajustará automáticamente conforme a los incrementos que decrete el Gobierno Nacional' : ''}, pagaderos por quincenas vencidas. ${conAux ? `Adicionalmente, EL EMPLEADOR reconocerá el auxilio de transporte legal vigente, que para el año ${(partes(e.ingreso) || { y: new Date().getFullYear() }).y} corresponde a ${pesos(aux)} mensuales, mientras ${g.T} tenga derecho a él según la ley. ` : ''}Dentro de este pago se encuentra incluida la remuneración de los descansos dominicales y festivos de que tratan los Capítulos I y II del Título VII del Código Sustantivo del Trabajo.`,
        `**PARÁGRAFO:** Las partes acuerdan que los pagos que EL EMPLEADOR haga por mera liberalidad, o para facilitar el desempeño de las funciones (como viáticos ocasionales, auxilios o bonificaciones no habituales), no constituyen salario, conforme a los artículos 128 y 130 del Código Sustantivo del Trabajo.`],
      ['PRESTACIONES SOCIALES Y SEGURIDAD SOCIAL', `${g.T} tendrá derecho a todas las prestaciones sociales de ley, proporcionales al tiempo laborado, a saber: cesantías, intereses sobre las cesantías, prima de servicios, vacaciones y dotación de calzado y vestido de labor, en los términos del Código Sustantivo del Trabajo. Así mismo, EL EMPLEADOR afiliará ${g.a} al Sistema de Seguridad Social Integral (salud, pensión y riesgos laborales – ARL, según el nivel de riesgo de la actividad) y a la Caja de Compensación Familiar, en las entidades indicadas en el encabezado, y efectuará los aportes correspondientes conforme a la ley.`],
      ['JORNADA DE TRABAJO', `${g.T} se obliga a laborar la jornada ordinaria máxima legal vigente de cuarenta y dos (42) horas semanales (Ley 2101 de 2021), distribuidas así: ${v(e.horario, 'HORARIO, ej. lunes a viernes de 7:00 a.m. a 12:00 m. y de 1:00 p.m. a 4:24 p.m.')}, salvo estipulación expresa y escrita en contrario, en los turnos y dentro de las horas señalados por EL EMPLEADOR, pudiendo éste hacer los ajustes o cambios de horario cuando lo estime conveniente. Por acuerdo expreso o tácito de las partes, podrán repartirse las horas de la jornada ordinaria en la forma prevista en la ley, teniendo en cuenta que los tiempos de descanso entre las secciones de la jornada no se computan dentro de la misma.`],
      ['TRABAJO SUPLEMENTARIO', `Todo trabajo suplementario o en horas extras y todo trabajo en día domingo o festivo se remunerará conforme a la ley, así como los correspondientes recargos nocturnos. Para el reconocimiento y pago del trabajo suplementario, dominical o festivo, EL EMPLEADOR o sus representantes deben autorizarlo previamente por escrito. Cuando la necesidad de este trabajo se presente de manera imprevista o inaplazable, deberá ejecutarse y darse cuenta de él por escrito, a la mayor brevedad, a EL EMPLEADOR o a sus representantes. En consecuencia, EL EMPLEADOR no reconocerá ningún trabajo suplementario o en días de descanso legalmente obligatorio que no haya sido autorizado previamente o avisado inmediatamente, como queda dicho.`],
      ['PERIODO DE PRUEBA', `Los primeros ${pruebaTxt} del presente contrato se consideran como período de prueba${tipo === 'fijo' ? ', el cual no excede la quinta parte del término inicialmente pactado (artículo 78 del Código Sustantivo del Trabajo)' : ''} y, por consiguiente, cualquiera de las partes podrá dar por terminado el contrato unilateralmente, en cualquier momento durante dicho período, sin previo aviso y sin lugar a indemnización alguna.`],
      tipo === 'indefinido' && ['DURACIÓN', `El presente contrato se celebra a TÉRMINO INDEFINIDO y tendrá vigencia mientras subsistan las causas que le dieron origen y la materia del trabajo. ${g.T} podrá darlo por terminado mediante aviso escrito a EL EMPLEADOR con una antelación no inferior a treinta (30) días, para que éste lo reemplace (artículo 47 del Código Sustantivo del Trabajo).`],
      tipo === 'fijo' && ['DURACIÓN', `El presente contrato se celebra a TÉRMINO FIJO por un plazo de ${durTxt}, contados a partir de la fecha de inicio de labores indicada en el encabezado, es decir, hasta el ${v(fechaLetras(e.contratoFin), 'FECHA DE TERMINACIÓN')}. Si antes de la fecha de vencimiento del término estipulado ninguna de las partes avisa por escrito a la otra su determinación de no prorrogar el contrato, con una antelación no inferior a treinta (30) días, éste se entenderá renovado por un período igual al inicialmente pactado, en los términos del artículo 46 del Código Sustantivo del Trabajo.`,
        `**PARÁGRAFO:** Por tratarse de un contrato inferior a un (1) año, solo podrá prorrogarse sucesivamente hasta por tres (3) períodos iguales o inferiores, al cabo de los cuales el término de renovación no podrá ser inferior a un (1) año, y así sucesivamente.`],
      tipo === 'obra' && ['DURACIÓN', `El presente contrato se celebra por el tiempo que dure la realización de la obra o labor contratada, que consiste en: **${v(e.obra, 'DESCRIPCIÓN DE LA OBRA O LABOR (proyecto, cliente y lugar)')}**. El contrato terminará cuando concluya la obra o la labor para la cual fue contratad${g.o} ${g.T}, o la etapa de la misma que le corresponda, sin que haya lugar a indemnización, conforme a los artículos 45 y 61 literal d) del Código Sustantivo del Trabajo.`,
        `**PARÁGRAFO:** EL EMPLEADOR informará por escrito ${g.a} la terminación de la obra o labor contratada. Si ${g.T} es trasladad${g.o} a otra obra de EL EMPLEADOR, dejará constancia escrita mediante otrosí al presente contrato.`],
      ['TERMINACIÓN UNILATERAL', `Son justas causas para dar por terminado unilateralmente este contrato, por cualquiera de las partes, las establecidas en los artículos 62 y 63 del Código Sustantivo del Trabajo, en el Reglamento Interno de Trabajo y en la ley laboral. La terminación sin justa causa dará lugar a la indemnización prevista en el artículo 64 del Código Sustantivo del Trabajo.`],
      ['TRASLADOS', `Las partes podrán convenir que el trabajo se preste en lugar distinto del inicialmente contratado (distintas obras, sedes o instalaciones de clientes de EL EMPLEADOR), siempre que tales traslados no desmejoren las condiciones laborales o de remuneración ${g.de}, ni impliquen perjuicios para ${g.el === 'la' ? 'ella' : 'él'}. Los gastos que se originen con el traslado serán cubiertos por EL EMPLEADOR. ${g.T} se obliga a aceptar los cambios de oficio que decida EL EMPLEADOR dentro de su poder subordinante, siempre que se respeten sus condiciones laborales y no se le causen perjuicios, sin que se afecte su honor, dignidad y derechos mínimos.`],
      ['CONFIDENCIALIDAD Y PROPIEDAD DE LA INFORMACIÓN', `Toda información suministrada por EL EMPLEADOR ${g.a}, y la conocida por ${g.el === 'la' ? 'ella' : 'él'} con ocasión del desarrollo del cargo, incluida la relativa a clientes, obras, precios e instalaciones, será confidencial para todos los efectos legales y contractuales, a menos que EL EMPLEADOR le dé por escrito otro carácter. Los diseños, planos, documentos, bases de datos y demás materiales desarrollados como resultado de su trabajo son propiedad exclusiva de EL EMPLEADOR, y ${g.T} no podrá retirarlos ni usarlos en su propio beneficio.`],
      ['DATOS PERSONALES', `${g.T} autoriza a EL EMPLEADOR para tratar sus datos personales, incluidos los de salud necesarios para el SG-SST, con la finalidad de administrar la relación laboral, pagar salarios y prestaciones, y efectuar las afiliaciones y aportes a la seguridad social, conforme a la Ley 1581 de 2012.`],
      ['FORMALIDAD', `El presente contrato reemplaza en su integridad y deja sin efecto cualquier otro contrato verbal o escrito celebrado entre las partes con anterioridad. Las modificaciones que se acuerden al presente contrato se anotarán a continuación de su texto o mediante otrosí firmado por las partes.`],
    ]);
    const funciones = String(e.funciones || '').split(/\r?\n/).map((s) => s.replace(/^\s*[-•*\d.)]+\s*/, '').trim()).filter(Boolean);
    _emp = emp;
    return {
      nombre: `Contrato ${TIPO_TXT[tipo].toLowerCase()} - ${e.nombre || 'trabajador'}`,
      bloques: [
        T(titulo), T(`CELEBRADO ENTRE ${emp.razon} Y ${v(e.nombre, 'NOMBRE DEL TRABAJADOR')}`),
        TB(fil),
        P(`Entre los suscritos a saber: **${emp.rep}**, identificado con cédula de ciudadanía N° ${emp.repCC}, en nombre y representación de **${emp.razon}**, con NIT ${emp.nit}, quien en adelante se denominará EL EMPLEADOR, por una parte, y por otra parte **${v(e.nombre, 'NOMBRE')}**, ${g.id} con cédula de ciudadanía N° ${v(e.cedula, 'CÉDULA')}${e.expedida ? ' de ' + e.expedida : ''}, quien en adelante se denominará ${g.T}, se celebra el presente contrato individual de trabajo ${tipo === 'fijo' ? 'a término fijo' : tipo === 'obra' ? 'por duración de la obra o labor contratada' : 'a término indefinido'}, el cual se regirá por las siguientes cláusulas:`),
        ...cuerpo,
        P(`Para constancia se firma en la ciudad de ${emp.ciudad} ${v(alosDias(x.fechaFirma || e.ingreso), 'FECHA DE FIRMA')}, en dos (2) ejemplares del mismo tenor y valor.`),
        ESP, ESP,
        F([['______________________________', ...firmaEmpleador(emp)], ['______________________________', ...firmaTrabajador(e, g)]]),
        SALTO,
        T('ANEXO 1 – FUNCIONES DEL CARGO'), T(v(e.cargo, 'CARGO').toUpperCase()),
        L(funciones.length ? funciones : [falta('FUNCIÓN 1'), falta('FUNCIÓN 2'), falta('FUNCIÓN 3')]),
        L(['Usar de manera permanente los elementos de protección personal y cumplir las normas de seguridad y salud en el trabajo.', 'Reportar de inmediato todo accidente, incidente o condición insegura.', 'Las demás funciones afines y complementarias que le sean asignadas por EL EMPLEADOR, acordes con la naturaleza del cargo.']),
        ESP, ESP,
        F([['______________________________', `**${g.T}**`, `**${v(e.nombre, 'NOMBRE')}**`, `C.C. ${v(e.cedula, 'CÉDULA')}`]]),
      ],
    };
  }

  // ---------- proceso disciplinario ----------
  function citacion(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e), s = x.susp || {};
    return {
      nombre: `Citación a descargos - ${e.nombre}`,
      bloques: [
        ...encabezadoCarta(emp, e, g, x.fechaDoc, 'Citación a diligencia de descargos'),
        P(`Por medio de la presente, ${emp.razon} le cita a diligencia de descargos el día **${v(fecha(s.descargosFecha), 'FECHA DE LA DILIGENCIA')}** a las **${v(s.descargosHora, 'HORA')}**, en ${v(s.descargosLugar, 'LUGAR (oficina de la empresa)')}, para que rinda su versión sobre los siguientes hechos:`),
        P(v(s.hechos, 'HECHOS: qué pasó, cuándo y dónde, con fechas')),
        P(`Estos hechos podrían constituir incumplimiento de ${v(s.falta, 'OBLIGACIÓN O PROHIBICIÓN INCUMPLIDA (artículo del Reglamento Interno de Trabajo, del contrato o del CST)')}, y de comprobarse, podrían dar lugar a una sanción disciplinaria conforme al Reglamento Interno de Trabajo.`),
        P(`En la diligencia usted podrá explicar lo ocurrido, presentar las pruebas que considere y estar acompañad${g.o} de hasta dos (2) compañeros de trabajo. Si no puede asistir por una razón justificada, avísenos antes de la fecha para reprogramarla. Si no asiste sin justificación, la empresa entenderá que renuncia a esta oportunidad de ser escuchad${g.o} y decidirá con las pruebas disponibles.`),
        P('Atentamente,'),
        ...recibido(e, g, true),
      ],
    };
  }
  function actaDescargos(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e), s = x.susp || {};
    const linea = '________________________________________________________________________________';
    return {
      nombre: `Acta de descargos - ${e.nombre}`,
      bloques: [
        T('ACTA DE DILIGENCIA DE DESCARGOS'),
        TB([['EMPRESA', emp.razon], ['TRABAJADOR', `${v(e.nombre, 'NOMBRE')} · C.C. ${v(e.cedula, 'CÉDULA')}`], ['CARGO', v(e.cargo, 'CARGO')], ['FECHA Y HORA', `${v(fecha(s.descargosFecha), 'FECHA')} · ${v(s.descargosHora, 'HORA')}`], ['LUGAR', v(s.descargosLugar, 'LUGAR')], ['ASISTENTES POR LA EMPRESA', '______________________________'], ['ACOMPAÑANTES DEL TRABAJADOR', '______________________________']]),
        P(`Se deja constancia de que ${g.el} trabajador${g.o === 'a' ? 'a' : ''} fue citad${g.o} con anticipación, se le informaron los hechos y se le indicó que puede explicar lo ocurrido y aportar pruebas.`),
        S('Hechos informados'), P(v(s.hechos, 'HECHOS')),
        S('Preguntas y respuestas'),
        P('1. ¿Conoce sus funciones y el Reglamento Interno de Trabajo? R/ ' + linea),
        P('2. ¿Qué tiene para decir sobre los hechos informados? R/ ' + linea), P(linea), P(linea),
        P('3. ¿Tiene pruebas o testigos que quiera aportar? R/ ' + linea),
        P('4. ¿Desea agregar algo más? R/ ' + linea),
        P('No siendo otro el objeto de la diligencia, se cierra y se firma por quienes intervinieron.'),
        ESP,
        F([['______________________________', '**Por la empresa**', 'Nombre:', 'Cargo:'], ['______________________________', `**${g.T}**`, v(e.nombre, 'NOMBRE'), `C.C. ${v(e.cedula, 'CÉDULA')}`]]),
      ],
    };
  }
  function memorandoSuspension(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e), s = x.susp || {};
    const dias = Number(s.dias) || 0, fin = s.fin || (s.inicio && dias ? sumarDias(s.inicio, dias - 1) : ''), reintegro = fin ? sumarDias(fin, 1) : '';
    return {
      nombre: `Memorando de suspensión - ${e.nombre}`,
      bloques: [
        ...encabezadoCarta(emp, e, g, x.fechaDoc, 'Memorando de suspensión disciplinaria del contrato de trabajo'),
        P(`Por medio de la presente, ${emp.razon} le comunica la decisión de **suspender su contrato de trabajo como sanción disciplinaria**, por los siguientes hechos:`),
        P(v(s.hechos, 'HECHOS: qué pasó, cuándo y dónde')),
        P(`Estos hechos constituyen incumplimiento de ${v(s.falta, 'OBLIGACIÓN O PROHIBICIÓN INCUMPLIDA (artículo del Reglamento Interno de Trabajo, del contrato o del CST)')}.`),
        P(`Antes de tomar esta decisión, usted fue escuchad${g.o} en diligencia de descargos realizada el ${v(fecha(s.descargosFecha), 'FECHA DE LOS DESCARGOS')}. La empresa analizó sus explicaciones y las pruebas, y concluyó que la falta está demostrada y que no fue justificada.`),
        P(`La suspensión será de **${dias ? nLetras(dias, 'día', 'días') : falta('NÚMERO DE DÍAS')}**, desde el **${v(fecha(s.inicio), 'FECHA DE INICIO')}** hasta el **${v(fecha(fin), 'FECHA FINAL')}**, ambas fechas incluidas. Deberá reintegrarse a sus labores el **${v(fecha(reintegro), 'FECHA DE REINTEGRO')}** en su horario habitual.`),
        P(`Durante la suspensión no se presta el servicio ni se paga salario (artículos 51 y 53 del Código Sustantivo del Trabajo), y ese tiempo puede descontarse para liquidar vacaciones y cesantías. Su afiliación a la seguridad social se mantiene y la novedad se reportará en la planilla de aportes como suspensión temporal del contrato (SLN).`),
        P(`Esta sanción se aplica conforme al Reglamento Interno de Trabajo y a los artículos 112 y 115 del Código Sustantivo del Trabajo. Si no está de acuerdo, puede presentar sus objeciones por escrito dentro de los tres (3) días hábiles siguientes al recibo de esta comunicación. Copia de este memorando se archiva en su hoja de vida.`),
        P('Atentamente,'),
        ...recibido(e, g, true),
      ],
    };
  }

  // ---------- fin del contrato ----------
  const MOTIVOS = {
    vencimiento: 'Vencimiento del término fijo pactado',
    obra: 'Terminación de la obra o labor contratada',
    renuncia: 'Renuncia del trabajador',
    mutuo: 'Mutuo acuerdo',
    justa: 'Despido con justa causa',
    sinjusta: 'Despido sin justa causa',
    prueba: 'Terminación en período de prueba',
  };
  function noProrroga(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e);
    const fin = x.fin || e.contratoFin;
    return {
      nombre: `Preaviso de no prórroga - ${e.nombre}`,
      bloques: [
        ...encabezadoCarta(emp, e, g, x.fechaDoc, 'Preaviso de terminación del contrato a término fijo (no prórroga)'),
        P(`Por medio de la presente, y de conformidad con el artículo 46 del Código Sustantivo del Trabajo, ${emp.razon} le informa, con una antelación no inferior a treinta (30) días, su decisión de **no prorrogar** el contrato de trabajo a término fijo suscrito con usted, con fecha de inicio el ${v(fecha(e.ingreso), 'FECHA DE INGRESO')}.`),
        P(`En consecuencia, su contrato terminará el **${v(fecha(fin), 'FECHA DE VENCIMIENTO')}**, por vencimiento del plazo pactado (literal c) del artículo 61 del Código Sustantivo del Trabajo). Ese día será su último día de labores.`),
        P(`Al terminar el contrato se le pagará la liquidación final de salarios y prestaciones sociales, se le entregará la orden para el examen médico ocupacional de egreso y el certificado laboral, y se le informará el estado de pago de sus aportes a la seguridad social.`),
        P('Agradecemos su trabajo y compromiso durante este tiempo.'),
        P('Atentamente,'),
        ...recibido(e, g, true),
      ],
    };
  }
  function cartaTerminacion(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e), r = x.retiro || {};
    const f = v(fecha(r.fecha || e.retiro), 'FECHA DE TERMINACIÓN');
    const m = r.motivo || 'vencimiento';
    const asunto = m === 'renuncia' ? 'Aceptación de renuncia' : m === 'mutuo' ? 'Terminación del contrato de trabajo por mutuo acuerdo' : 'Terminación del contrato de trabajo';
    const cuerpo = {
      vencimiento: [P(`Como le fue informado mediante comunicación del ${v(fecha(r.preaviso), 'FECHA DEL PREAVISO')}, su contrato de trabajo a término fijo termina el **${f}**, por vencimiento del plazo pactado, conforme al literal c) del artículo 61 y al artículo 46 del Código Sustantivo del Trabajo.`)],
      obra: [P(`Le informamos que la obra o labor para la cual fue contratad${g.o}, consistente en ${v(e.obra, 'OBRA O LABOR')}, ha concluido en lo que corresponde a sus funciones. Por lo tanto, su contrato de trabajo por duración de la obra o labor termina el **${f}**, conforme al literal d) del artículo 61 del Código Sustantivo del Trabajo.`)],
      renuncia: [P(`Acusamos recibo de su carta de renuncia presentada el ${v(fecha(r.fechaRenuncia), 'FECHA DE LA CARTA DE RENUNCIA')}. ${emp.razon} acepta su renuncia, y su último día de labores será el **${f}**.`)],
      mutuo: [P(`Las partes, de común acuerdo y de manera libre y voluntaria, deciden dar por terminado el contrato de trabajo a partir del **${f}**, conforme al literal b) del artículo 61 del Código Sustantivo del Trabajo. ${g.T} firma esta comunicación en señal de aceptación.`)],
      justa: [
        P(`${emp.razon} le comunica la decisión de dar por terminado su contrato de trabajo **con justa causa** a partir del **${f}**, por los siguientes hechos:`),
        P(v(r.hechos, 'HECHOS: qué pasó, cuándo y dónde')),
        P(`Estos hechos configuran la justa causa prevista en ${v(r.causal, 'CAUSAL: numeral del literal a) del artículo 62 del CST y/o artículo del Reglamento Interno de Trabajo')}. Antes de esta decisión, usted fue escuchad${g.o} en diligencia de descargos realizada el ${v(fecha(r.descargosFecha), 'FECHA DE LOS DESCARGOS')}, y sus explicaciones no justificaron la falta.`),
      ],
      sinjusta: [P(`${emp.razon} le comunica su decisión de dar por terminado unilateralmente y **sin justa causa** su contrato de trabajo a partir del **${f}**. En consecuencia, junto con la liquidación final se le pagará la indemnización prevista en el artículo 64 del Código Sustantivo del Trabajo.`)],
      prueba: [P(`${emp.razon} le comunica que, haciendo uso de la facultad del artículo 80 del Código Sustantivo del Trabajo, da por terminado su contrato de trabajo durante el período de prueba, a partir del **${f}**, sin lugar a indemnización.`)],
    }[m] || [];
    return {
      nombre: `${asunto} - ${e.nombre}`,
      bloques: [
        ...encabezadoCarta(emp, e, g, x.fechaDoc, asunto),
        ...cuerpo,
        P(`**Liquidación:** se le pagarán los salarios y prestaciones sociales causados hasta la fecha de terminación (cesantías, intereses, prima de servicios y vacaciones pendientes), mediante transferencia a su cuenta de nómina.`),
        P(`**Seguridad social:** conforme al parágrafo 1 del artículo 65 del Código Sustantivo del Trabajo, le informamos que sus aportes a seguridad social y parafiscales se encuentran pagados hasta ${v(r.aportesHasta, 'MES DEL ÚLTIMO PAGO, ej. octubre de 2026')}. Se anexan los comprobantes de pago de los últimos tres (3) meses.`),
        P(`**Examen médico de egreso:** debe presentarse a realizar el examen médico ocupacional de egreso dentro de los cinco (5) días hábiles siguientes a la terminación del contrato. La orden se le entrega con esta carta.`),
        P(`**Entrega de elementos:** le solicitamos entregar las herramientas, equipos, dotación, carné y demás elementos de la empresa que tenga a su cargo. Junto con la liquidación se le entregará el certificado laboral.`),
        P('Agradecemos sus servicios.'),
        P('Atentamente,'),
        ...(m === 'mutuo'
          ? [ESP, F([['______________________________', ...firmaEmpleador(emp)], ['______________________________', `**${g.T} (acepto)**`, `**${v(e.nombre, 'NOMBRE')}**`, `C.C. ${v(e.cedula, 'CÉDULA')}`]])]
          : recibido(e, g, true)),
      ],
    };
  }
  function certificado(x) {
    const { e } = x, emp = _emp = empresaDoc(e.empresa), g = genero(e);
    const tipo = tipoContrato(e), sigue = !e.retiro || e.retiro >= (x.fechaDoc || '');
    return {
      nombre: `Certificado laboral - ${e.nombre}`,
      bloques: [
        ESP, T(`EL SUSCRITO REPRESENTANTE LEGAL DE ${emp.razon}`), T(`NIT ${emp.nit}`), ESP, T('CERTIFICA'), ESP,
        P(`Que ${g.el === 'la' ? 'la señora' : 'el señor'} **${v(e.nombre, 'NOMBRE')}**, ${g.id} con cédula de ciudadanía N° ${v(e.cedula, 'CÉDULA')}${e.expedida ? ' de ' + e.expedida : ''}, ${sigue ? 'labora' : 'laboró'} en esta empresa desde el ${v(fecha(e.ingreso), 'FECHA DE INGRESO')}${sigue ? '' : ` hasta el ${v(fecha(e.retiro), 'FECHA DE RETIRO')}`}, desempeñando el cargo de **${v(e.cargo, 'CARGO').toUpperCase()}**, mediante contrato de trabajo ${tipo ? TIPO_TXT[tipo].toLowerCase().replace('término', 'a término').replace('obra o labor', 'por obra o labor') : falta('TIPO DE CONTRATO')}${x.conSalario !== false ? `, con un salario básico mensual de ${pesos(Number(e.salario) || 0)}` : ''}.`),
        P(`Se expide a solicitud de${g.el === 'la' ? ' la' : 'l'} interesad${g.o} en ${emp.ciudad}, el ${v(fecha(x.fechaDoc), 'FECHA')}.`),
        ESP, ESP,
        F([['______________________________', `**${emp.rep}**`, `C.C. ${emp.repCC}`, 'Representante legal', emp.razon]]),
      ],
    };
  }

  const TIPOS = {
    contrato: { titulo: 'Contrato de trabajo', fn: contrato },
    citacion: { titulo: 'Citación a descargos', fn: citacion },
    acta: { titulo: 'Acta de descargos', fn: actaDescargos },
    suspension: { titulo: 'Memorando de suspensión', fn: memorandoSuspension },
    noprorroga: { titulo: 'Preaviso de no prórroga', fn: noProrroga },
    terminacion: { titulo: 'Carta de terminación', fn: cartaTerminacion },
    certificado: { titulo: 'Certificado laboral', fn: certificado },
  };

  // ---------- Word ----------
  function aWord(doc, X, op) {
    op = op || {};
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, PageBreak, Header, Footer, PageNumber, ShadingType, ImageRun } = X;
    const FUENTE = 'Arial', TAM = 21; // 10,5 pt
    // **negrilla** y ⟦falta⟧ (resaltado amarillo)
    function runs(txt, base) {
      const out = []; let bold = false;
      for (const trozo of String(txt).split(/(\*\*|⟦[^⟧]*⟧)/)) {
        if (trozo === '**') { bold = !bold; continue; }
        if (!trozo) continue;
        if (trozo.startsWith('⟦')) out.push(new TextRun({ text: trozo, bold: true, highlight: 'yellow', font: FUENTE, size: TAM, ...(base || {}) }));
        else out.push(new TextRun({ text: trozo, bold: bold || (base && base.bold), font: FUENTE, size: (base && base.size) || TAM }));
      }
      return out;
    }
    const sinBorde = { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } };
    const hijos = [];
    for (const b of doc.bloques) {
      if (b.k === 't') hijos.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: runs(b.t, { bold: true, size: 23 }) }));
      else if (b.k === 's') hijos.push(new Paragraph({ spacing: { before: 120, after: 60 }, children: runs(b.t, { bold: true }) }));
      else if (b.k === 'p') hijos.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 140, line: 276 }, children: runs(b.t, b.pequeno ? { size: 18 } : null) }));
      else if (b.k === 'esp') hijos.push(new Paragraph({ children: [] }));
      else if (b.k === 'br') hijos.push(new Paragraph({ children: [new PageBreak()] }));
      else if (b.k === 'l') b.items.forEach((it, i) => hijos.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, indent: { left: 540, hanging: 360 }, spacing: { after: 80, line: 276 }, children: runs(`${String.fromCharCode(97 + i)}) ${it}`) })));
      else if (b.k === 'tb') {
        hijos.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.filas.map(([a, c]) => {
            const seccion = !c;
            return new TableRow({ children: seccion
              ? [new TableCell({ columnSpan: 2, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'D9E2DE' }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: runs(a, { bold: true, size: 19 }) })] })]
              : [new TableCell({ width: { size: 32, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: runs(a, { bold: true, size: 18 }) })] }), new TableCell({ width: { size: 68, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: runs(c, { size: 18 }) })] })] });
          }),
        }));
        hijos.push(new Paragraph({ children: [] }));
      } else if (b.k === 'f') {
        hijos.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE }, borders: sinBorde,
          rows: [new TableRow({ children: b.cols.map((col) => new TableCell({ borders: sinBorde, width: { size: Math.floor(100 / b.cols.length), type: WidthType.PERCENTAGE }, children: col.map((l) => new Paragraph({ children: runs(l, { size: 19 }) })) })) })],
        }));
      }
    }
    return new Document({
      creator: (op.emp || EMPRESAS.odesa).razon, title: doc.nombre,
      styles: { default: { document: { run: { font: FUENTE, size: TAM } } } },
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1300, bottom: 1200, left: 1500, right: 1500 } } },
        // Logo de ODESA arriba a la izquierda (si cargó)
        ...(op.logo && ImageRun ? { headers: { default: new Header({ children: [new Paragraph({ children: [new ImageRun({ data: op.logo.data, transformation: { width: op.logo.w, height: op.logo.h } })] })] }) } } : {}),
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], font: FUENTE, size: 16, color: '777777' })] })] }) },
        children: hijos,
      }],
    });
  }
  function documento(tipo, x) {
    const t = TIPOS[tipo]; if (!t) throw new Error('Tipo de documento desconocido: ' + tipo);
    return t.fn({ fechaDoc: new Date().toISOString().slice(0, 10), ...x });
  }
  const crearDocumento = aWord;
  // Logo de ODESA (logo-odesa.svg) convertido a PNG en el navegador; si falla, el documento sale sin logo
  let logoCache = null;
  async function cargarLogo() {
    if (logoCache !== null) return logoCache;
    try {
      if (typeof document === 'undefined') throw new Error('sin navegador');
      const svg = await (await fetch('logo-odesa.svg', { cache: 'force-cache' })).text();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = url; });
      const W = 1092, H = Math.round(W * 1686 / 5462);
      const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      const png = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      logoCache = { data: new Uint8Array(await png.arrayBuffer()), w: 160, h: Math.round(160 * 1686 / 5462) };
    } catch (e) { logoCache = false; }
    return logoCache;
  }
  async function blob(tipo, x) {
    const X = raiz.docx; if (!X) throw new Error('No cargó el generador de Word. Recarga la página.');
    const d = documento(tipo, x);
    const op = { emp: empresaDoc(((x || {}).e || {}).empresa), logo: await cargarLogo() };
    return { nombre: d.nombre, blob: await X.Packer.toBlob(crearDocumento(d, X, op)) };
  }
  async function buffer(tipo, x, X) {
    const d = documento(tipo, x);
    return { nombre: d.nombre, buffer: await X.Packer.toBuffer(crearDocumento(d, X)) };
  }
  // Varios documentos en un solo Word (para los borradores de revisión)
  async function bufferVarios(lista, X) {
    const bloques = [];
    lista.forEach(([tipo, x, portada], i) => { const d = documento(tipo, x); if (i) bloques.push(SALTO); if (portada) bloques.push({ k: 's', t: portada }); bloques.push(...d.bloques); });
    return X.Packer.toBuffer(crearDocumento({ nombre: 'Borradores', bloques }, X));
  }

  const api = { EMPRESAS, empresaDoc, TIPOS, MOTIVOS, TIPO_TXT, tipoContrato, documento, blob, buffer, bufferVarios, letras, pesos, fecha, fechaLetras, sumarDias, sumarMeses, mesesEntre };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.RRHHDocs = api;
})(typeof window !== 'undefined' ? window : globalThis);
