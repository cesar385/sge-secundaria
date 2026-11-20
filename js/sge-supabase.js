// ════════════════════════════════════════════════════════════════════════════
// SGE Secundaria — capa segura con Supabase
//
// Reemplaza la sincronización con Google Sheets y el guardado en localStorage:
//   • Login con Supabase Auth (contraseñas con bcrypt en el servidor).
//   • Cada usuario descarga SÓLO lo que las políticas RLS le permiten ver.
//   • Los cambios se suben registro por registro; el servidor rechaza lo que
//     el rol no puede modificar (aunque alguien manipule el navegador).
//   • No queda ninguna copia de los datos en el navegador al cerrar sesión.
//   • Cierre de sesión por inactividad, aceptación de la política de
//     privacidad, descarga de "mis datos" y cierre de sesión en todos los
//     dispositivos.
// Se carga DESPUÉS del código principal y reemplaza algunas de sus funciones.
// ════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const CFG = window.SGE_CONFIG || {};
  if (!window.SGE_SUPABASE_ACTIVO) return;
  if (!window.supabase || !window.supabase.createClient) {
    console.error('SGE: falta la librería de Supabase (vendor/supabase-*.js)');
    return;
  }

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sge-auth' },
  });
  window.sgeSb = sb;

  const DOMINIO = CFG.emailDominio || 'sge.invalid';
  const CLAVE_MIN = 10;
  const COLECCIONES = [
    'docentes','preceptores','designaciones','licencias','notificaciones','reintegros',
    'conceptosPeriodo','traslados','permutas','bajasTramite','certificacionesMedicas',
    'antecedentesAgente','liquidaciones','liqExcluidas','credenciales','competenciasExtra',
    'puntajesCap','solicitudesPlaza','alumnos','notas','asistencias','asistenciasMateria',
    'justificaciones','movimientosAlumnos','pases','materiasAdeudadas','serviciosAlumno',
    'preinscripciones','cursos','plazas','comunicados','diasClase','cierreNotas','configBoletin',
  ];
  const VINCULOS = ['docenteId', 'preceptorId', 'alumnoId', 'hijoIds', 'instituciones'];
  const NO_DATOS = ['id', 'usuario', 'rol', 'estado', 'institucionId', 'claveHash', 'clave', ...VINCULOS];

  // Estado de la sincronización (sólo en memoria)
  let perfilYo = null;
  let baseReg = new Map();      // "inst|col|id" → JSON del registro tal como está en el servidor
  let baseUsr = new Map();      // legacy_id → JSON de la proyección del perfil
  let baseInst = new Map();     // id → JSON de la institución
  const rechazados = new Set(); // cambios que el servidor no aceptó (no se reintentan)
  const clavesPendientes = new WeakMap(); // cuenta → contraseña nueva (sólo hasta enviarla)
  let ultimoTs = null, ultimoTsPerfiles = null;
  let sincronizando = false, otraVuelta = false, temporizador = null, sondeo = null;
  let sesionActiva = false;

  // Arranque: sin datos de demostración en memoria y sin restos del sistema viejo.
  USUARIOS.length = 0;
  INSTITUCIONES.length = 0;
  INST_DATA = {};
  DB = createEmptyInstData();

  const clave = (inst, col, id) => `${inst}|${col}|${id}`;
  const idApp = (legacy) => (/^-?\d{1,15}$/.test(legacy) ? Number(legacy) : legacy);
  const fn = (nombre) => `${CFG.supabaseUrl}/functions/v1/${nombre}`;
  const aviso = (msg, color) => { try { showToast(msg, color || '#991b1b'); } catch (e) { console.warn(msg); } };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function purgarDatosLocalesViejos() {
    try {
      Object.keys(localStorage).forEach((k) => {
        if (/^sge_(secundaria_estado|backup|sesion|dispositivo|sheets|secundaria_sheets)/.test(k)) localStorage.removeItem(k);
      });
    } catch (e) { /* sin acceso a localStorage */ }
  }

  // ── Llamadas a las Edge Functions ────────────────────────────────────────
  async function llamarFuncion(nombre, cuerpo, conSesion) {
    const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
    if (conSesion) {
      const { data } = await sb.auth.getSession();
      if (!data.session) throw new Error('Sesión vencida');
      headers.Authorization = 'Bearer ' + data.session.access_token;
    }
    const r = await fetch(fn(nombre), { method: 'POST', headers, body: JSON.stringify(cuerpo) });
    let j = null;
    try { j = await r.json(); } catch (e) { /* sin cuerpo */ }
    return j || { ok: false, error: 'HTTP ' + r.status };
  }

  // ── Carga inicial (sólo lo permitido por RLS) ─────────────────────────────
  async function traerTodo(tabla, columnas, filtro) {
    const filas = [];
    for (let desde = 0; ; desde += 1000) {
      let q = sb.from(tabla).select(columnas).range(desde, desde + 999);
      if (filtro) q = filtro(q);
      const { data, error } = await q;
      if (error) throw error;
      filas.push(...data);
      if (data.length < 1000) break;
    }
    return filas;
  }

  function usuarioDesdePerfil(p) {
    const u = Object.assign({}, p.datos || {});
    u.id = idApp(p.legacy_id);
    u.usuario = p.usuario;
    u.rol = p.rol;
    u.estado = p.estado;
    u.institucionId = p.institucion_id;
    VINCULOS.forEach((k) => { if (p.vinculos && p.vinculos[k] !== undefined) u[k] = p.vinculos[k]; });
    if (!u.nombre) u.nombre = p.usuario;
    return u;
  }
  function proyeccion(u) {
    const datos = {}, vinculos = {};
    Object.keys(u).forEach((k) => {
      if (VINCULOS.includes(k)) { if (u[k] !== undefined && u[k] !== null) vinculos[k] = u[k]; }
      else if (!NO_DATOS.includes(k)) datos[k] = u[k];
    });
    return { usuario: String(u.usuario || '').toLowerCase(), rol: u.rol, estado: u.estado === 'inactivo' ? 'inactivo' : 'activo',
             institucion_id: u.institucionId == null ? null : Number(u.institucionId), vinculos, datos };
  }
  function institucionDesdeFila(i) {
    return Object.assign({}, i.datos || {}, { id: Number(i.id), nombre: i.nombre, cue: i.cue, estado: i.estado });
  }
  function proyeccionInst(i) {
    const { id, nombre, cue, estado, usuario, clave: _c, claveHash, ...datos } = i;
    return { id: Number(id), nombre, cue: cue || null, estado: estado || 'activa', datos };
  }
  const ordenId = (a, b) => {
    const na = Number(a.id), nb = Number(b.id);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  };

  async function cargarDesdeServidor() {
    const [insts, perfiles, regs] = await Promise.all([
      traerTodo('instituciones', 'id,nombre,cue,estado,datos,actualizado'),
      traerTodo('perfiles', 'user_id,legacy_id,usuario,rol,estado,institucion_id,vinculos,datos,debe_cambiar_clave,acepto_privacidad_at,actualizado'),
      traerTodo('registros', 'institucion_id,coleccion,id,datos,actualizado', (q) => q.eq('eliminado', false).order('institucion_id').order('coleccion').order('id')),
    ]);

    INSTITUCIONES.length = 0;
    insts.forEach((i) => INSTITUCIONES.push(institucionDesdeFila(i)));
    perfiles.filter((p) => p.rol === 'institucion' && p.institucion_id).forEach((p) => {
      const i = INSTITUCIONES.find((x) => x.id === Number(p.institucion_id));
      if (i) i.usuario = p.usuario;
    });

    USUARIOS.length = 0;
    perfiles.filter((p) => p.rol !== 'institucion').forEach((p) => USUARIOS.push(usuarioDesdePerfil(p)));

    const nuevo = {};
    INSTITUCIONES.forEach((i) => { nuevo[i.id] = createEmptyInstData(); });
    regs.forEach((r) => {
      const d = nuevo[r.institucion_id] || (nuevo[r.institucion_id] = createEmptyInstData());
      (d[r.coleccion] || (d[r.coleccion] = [])).push(r.datos);
    });
    Object.values(nuevo).forEach((d) => COLECCIONES.forEach((c) => { if (Array.isArray(d[c])) d[c].sort(ordenId); }));
    INST_DATA = nuevo;

    // Defensa en profundidad: los textos se limpian aunque alguien los haya
    // escrito directamente contra la API.
    try { sgeSanearProfundo(USUARIOS); sgeSanearProfundo(INSTITUCIONES); sgeSanearProfundo(INST_DATA); } catch (e) {}
    // Mismas normalizaciones que hace el sistema al guardar, para que no cuenten como "cambios".
    try { normalizarTodosLosDocentes(); } catch (e) {}
    try { asegurarNroExpDesignacionesTodas(); } catch (e) {}
    try { sgeSanearEstado(); } catch (e) {}

    ultimoTs = regs.reduce((m, r) => (r.actualizado > (m || '') ? r.actualizado : m), ultimoTs);
    ultimoTsPerfiles = perfiles.reduce((m, r) => (r.actualizado > (m || '') ? r.actualizado : m), ultimoTsPerfiles);
    tomarFoto();
    return perfiles;
  }

  // Foto de "lo que hay en el servidor" para saber después qué cambió.
  function tomarFoto() {
    baseReg = new Map();
    Object.keys(INST_DATA).forEach((inst) => COLECCIONES.forEach((col) => {
      (INST_DATA[inst][col] || []).forEach((o) => { if (o && o.id != null) baseReg.set(clave(inst, col, o.id), JSON.stringify(o)); });
    }));
    baseUsr = new Map(USUARIOS.map((u) => [String(u.id), JSON.stringify(proyeccion(u))]));
    baseInst = new Map(INSTITUCIONES.map((i) => [String(i.id), JSON.stringify(proyeccionInst(i))]));
  }

  // ── Subida de cambios ─────────────────────────────────────────────────────
  function programarSync(demora) {
    if (!sesionActiva) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { temporizador = null; sincronizar(); }, demora == null ? 1200 : demora);
  }

  async function sincronizar() {
    if (!sesionActiva) return;
    if (sincronizando) { otraVuelta = true; return; }
    sincronizando = true;
    try {
      try { asegurarNroExpDesignacionesTodas(); } catch (e) {}
      try { sgeSanearEstado(); } catch (e) {}
      await subirRegistros();
      await subirInstituciones();
      await subirUsuarios();
      marcarEstado(true);
    } catch (e) {
      console.warn('SGE: no se pudo sincronizar', e);
      marcarEstado(false);
    } finally {
      sincronizando = false;
      if (otraVuelta) { otraVuelta = false; programarSync(300); }
    }
  }

  async function subirRegistros() {
    const actuales = new Map();
    const cambios = [];
    Object.keys(INST_DATA).forEach((inst) => {
      const d = INST_DATA[inst];
      if (!d || isNaN(Number(inst))) return;
      COLECCIONES.forEach((col) => {
        (d[col] || []).forEach((o) => {
          if (!o || typeof o !== 'object') return;
          if (o.id == null) o.id = uid();
          const k = clave(inst, col, o.id), j = JSON.stringify(o);
          actuales.set(k, j);
          if (baseReg.get(k) !== j && !rechazados.has(k + '\u0000' + j)) {
            cambios.push({ k, j, fila: { institucion_id: Number(inst), coleccion: col, id: String(o.id), datos: o, eliminado: false } });
          }
        });
      });
    });
    baseReg.forEach((j, k) => {
      if (actuales.has(k) || rechazados.has(k + '\u0000baja')) return;
      const [inst, col, ...resto] = k.split('|');
      cambios.push({ k, j: null, fila: { institucion_id: Number(inst), coleccion: col, id: resto.join('|'), datos: JSON.parse(j), eliminado: true } });
    });
    if (!cambios.length) return;

    let rechazos = 0;
    const aplicar = (c) => { if (c.j === null) baseReg.delete(c.k); else baseReg.set(c.k, c.j); };
    for (let i = 0; i < cambios.length; i += 200) {
      const lote = cambios.slice(i, i + 200);
      const { error } = await sb.from('registros').upsert(lote.map((c) => c.fila));
      if (!error) { lote.forEach(aplicar); continue; }
      if (!esRechazo(error)) throw error;
      // Algún registro del lote no está permitido: se prueba uno por uno.
      for (const c of lote) {
        const { error: e1 } = await sb.from('registros').upsert(c.fila);
        if (!e1) { aplicar(c); continue; }
        if (!esRechazo(e1)) throw e1;
        rechazos++;
        rechazados.add(c.k + '\u0000' + (c.j === null ? 'baja' : c.j));
        console.warn('SGE: el servidor rechazó', c.k, e1.message);
      }
    }
    if (rechazos) aviso(`⚠️ ${rechazos} cambio(s) no se guardaron: tu rol no tiene permiso para modificarlos.`);
  }
  const esRechazo = (e) => e && (e.code === '42501' || /row-level security|permission|Sólo|No se puede/i.test(e.message || ''));

  async function subirInstituciones() {
    for (const i of INSTITUCIONES) {
      const p = proyeccionInst(i), j = JSON.stringify(p), id = String(i.id);
      if (baseInst.get(id) === j || rechazados.has('inst' + id + j)) continue;
      const { error } = baseInst.has(id)
        ? await sb.from('instituciones').update({ nombre: p.nombre, cue: p.cue, estado: p.estado, datos: p.datos }).eq('id', p.id)
        : await sb.from('instituciones').insert(p);
      if (error) { rechazados.add('inst' + id + j); aviso('⚠️ No se pudo guardar la institución: ' + error.message); continue; }
      baseInst.set(id, j);
      if (!INST_DATA[id]) INST_DATA[id] = createEmptyInstData();
    }
    // Cuenta de acceso de la escuela (usuario + contraseña de la institución)
    for (const i of INSTITUCIONES) {
      const pw = clavesPendientes.get(i);
      if (!i.usuario || !pw) continue;
      clavesPendientes.delete(i);
      const existe = USUARIOS_INST.has(String(i.id));
      const r = existe
        ? await llamarFuncion('admin-usuarios', { accion: 'clave', legacy_id: 'inst_' + i.id, clave: pw }, true)
        : await llamarFuncion('admin-usuarios', { accion: 'crear', legacy_id: 'inst_' + i.id, usuario: i.usuario, rol: 'institucion',
            institucion_id: i.id, clave: pw, datos: { nombre: i.nombre } }, true);
      if (!r.ok) aviso('⚠️ Cuenta de la institución: ' + (r.error || 'error'));
      else { USUARIOS_INST.add(String(i.id)); if (r.claveTemporal) mostrarClaveTemporal(i.usuario, r.claveTemporal); }
    }
  }
  const USUARIOS_INST = new Set();

  async function subirUsuarios() {
    const actuales = new Map(USUARIOS.map((u) => [String(u.id), u]));
    for (const [id, u] of actuales) {
      const p = proyeccion(u), j = JSON.stringify(p);
      const pw = clavesPendientes.get(u);
      const propia = perfilYo && String(perfilYo.legacy_id) === id;
      if (!baseUsr.has(id)) {
        if (rechazados.has('usr' + id + j)) continue;
        const r = await llamarFuncion('admin-usuarios', Object.assign({ accion: 'crear', legacy_id: id, clave: pw || '' }, p), true);
        clavesPendientes.delete(u);
        if (!r.ok) { rechazados.add('usr' + id + j); aviso('⚠️ No se creó la cuenta "' + esc(u.usuario) + '": ' + esc(r.error)); continue; }
        baseUsr.set(id, j);
        if (r.claveTemporal) mostrarClaveTemporal(u.usuario, r.claveTemporal);
        continue;
      }
      if (baseUsr.get(id) !== j && !rechazados.has('usr' + id + j)) {
        const antes = JSON.parse(baseUsr.get(id));
        if (p.usuario !== antes.usuario) aviso('ℹ️ El nombre de usuario no se puede cambiar: se mantiene "' + esc(antes.usuario) + '".', '#a16207');
        let r;
        const gestion = perfilYo && ['admin', 'director', 'secretario'].includes(perfilYo.rol);
        if (propia && !(gestion && JSON.stringify(p.vinculos) !== JSON.stringify(antes.vinculos))) {
          const { error } = await sb.from('perfiles').update({ datos: p.datos }).eq('user_id', perfilYo.user_id);
          r = error ? { ok: false, error: error.message } : { ok: true };
        } else {
          const cambios = {};
          ['rol', 'estado', 'institucion_id', 'vinculos', 'datos'].forEach((k) => {
            if (JSON.stringify(p[k]) !== JSON.stringify(antes[k])) cambios[k] = p[k];
          });
          r = await llamarFuncion('admin-usuarios', { accion: 'actualizar', legacy_id: id, cambios }, true);
        }
        if (!r.ok) { rechazados.add('usr' + id + j); aviso('⚠️ Cuenta "' + esc(u.usuario) + '": ' + esc(r.error)); }
        else baseUsr.set(id, j);
      }
      if (pw && !propia) {
        clavesPendientes.delete(u);
        const r = await llamarFuncion('admin-usuarios', { accion: 'clave', legacy_id: id, clave: pw }, true);
        if (!r.ok) aviso('⚠️ Contraseña de "' + esc(u.usuario) + '": ' + esc(r.error));
        else if (r.claveTemporal) mostrarClaveTemporal(u.usuario, r.claveTemporal);
      }
    }
    for (const id of [...baseUsr.keys()]) {
      if (actuales.has(id) || rechazados.has('usr-baja' + id)) continue;
      const r = await llamarFuncion('admin-usuarios', { accion: 'eliminar', legacy_id: id }, true);
      if (!r.ok) { rechazados.add('usr-baja' + id); aviso('⚠️ No se eliminó la cuenta: ' + esc(r.error)); }
      else baseUsr.delete(id);
    }
  }

  function mostrarClaveTemporal(usuario, temporal) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(15,23,42,.7);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:22px;font-family:inherit">
      <div style="font-size:17px;font-weight:800;color:#1a3a5c;margin-bottom:8px">🔐 Contraseña temporal</div>
      <div style="font-size:13px;color:#475569;line-height:1.5;margin-bottom:12px">La contraseña indicada no era segura (mínimo ${CLAVE_MIN} caracteres con letras y números), así que se generó una temporal para <strong>${esc(usuario)}</strong>. Entregásela en persona: la va a tener que cambiar al ingresar.</div>
      <div style="font-family:monospace;font-size:22px;font-weight:800;letter-spacing:2px;text-align:center;background:#f1f5f9;border-radius:8px;padding:12px;margin-bottom:14px;user-select:all">${esc(temporal)}</div>
      <div style="text-align:right"><button class="btn btn-primary">Listo, ya la anoté</button></div></div>`;
    ov.querySelector('button').onclick = () => ov.remove();
    document.body.appendChild(ov);
  }

  // ── Cambios hechos desde otros dispositivos ──────────────────────────────
  function editando() {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    const mc = document.querySelector('.main-content');
    return !!(mc && mc.querySelector('.form-actions')) || !!document.getElementById('sge-cambio-clave');
  }

  async function traerCambiosRemotos() {
    if (!sesionActiva || sincronizando || document.visibilityState === 'hidden') return;
    try {
      let q = sb.from('registros').select('institucion_id,coleccion,id,datos,eliminado,actualizado').order('actualizado').limit(1000);
      if (ultimoTs) q = q.gt('actualizado', ultimoTs);
      const { data, error } = await q;
      if (error) throw error;
      let hubo = false;
      for (const r of data) {
        ultimoTs = r.actualizado > (ultimoTs || '') ? r.actualizado : ultimoTs;
        const k = clave(r.institucion_id, r.coleccion, r.id);
        const d = INST_DATA[r.institucion_id] || (INST_DATA[r.institucion_id] = createEmptyInstData());
        const lista = d[r.coleccion] || (d[r.coleccion] = []);
        const idx = lista.findIndex((o) => o && String(o.id) === String(r.id));
        const local = idx >= 0 ? JSON.stringify(lista[idx]) : undefined;
        if (local !== undefined && local !== baseReg.get(k)) continue; // hay cambios locales sin subir: ganan los locales
        if (r.eliminado) {
          if (idx >= 0) { lista.splice(idx, 1); hubo = true; }
          baseReg.delete(k);
        } else {
          const nuevo = sgeSanearProfundo(r.datos);
          const j = JSON.stringify(nuevo);
          if (j !== local) { if (idx >= 0) lista[idx] = nuevo; else lista.push(nuevo); hubo = true; }
          baseReg.set(k, j);
        }
      }
      hubo = (await traerPerfilesRemotos()) || hubo;
      if (hubo && currentUser && !editando()) {
        if (currentInstitucionId != null && INST_DATA[currentInstitucionId]) DB = INST_DATA[currentInstitucionId];
        try { navigate(currentSection); } catch (e) {}
      }
      marcarEstado(true);
    } catch (e) {
      marcarEstado(false);
    }
  }

  // Cambios en cuentas (roles, vínculos, bajas) hechos por la dirección u otro dispositivo.
  async function traerPerfilesRemotos() {
    let q = sb.from('perfiles').select('user_id,legacy_id,usuario,rol,estado,institucion_id,vinculos,datos,actualizado').order('actualizado');
    if (ultimoTsPerfiles) q = q.gt('actualizado', ultimoTsPerfiles);
    const { data, error } = await q;
    if (error || !data) return false;
    let hubo = false;
    for (const p of data) {
      ultimoTsPerfiles = p.actualizado > (ultimoTsPerfiles || '') ? p.actualizado : ultimoTsPerfiles;
      if (perfilYo && p.user_id === perfilYo.user_id && p.estado !== 'activo') {
        window.doLogout('⊘ Tu cuenta fue desactivada. Contactá a la dirección.');
        return false;
      }
      if (p.rol === 'institucion') continue;
      const id = String(p.legacy_id), nuevo = usuarioDesdePerfil(p);
      const idx = USUARIOS.findIndex((u) => String(u.id) === id);
      if (idx >= 0 && JSON.stringify(proyeccion(USUARIOS[idx])) !== baseUsr.get(id)) continue; // cambios locales pendientes
      if (idx >= 0) Object.assign(USUARIOS[idx], nuevo); else USUARIOS.push(nuevo);
      baseUsr.set(id, JSON.stringify(proyeccion(idx >= 0 ? USUARIOS[idx] : nuevo)));
      hubo = true;
    }
    return hubo;
  }

  function marcarEstado(ok) {
    let b = document.getElementById('sge-estado-sync');
    if (ok) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'sge-estado-sync';
      b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fef3c7;color:#854d0e;border-top:1px solid #fcd34d;padding:8px 14px;font-size:13px;text-align:center';
      b.textContent = '📴 Sin conexión con el servidor: los cambios se guardarán al volver la conexión (no cierres la pestaña).';
      document.body.appendChild(b);
    }
  }

  // ── Login / sesión ───────────────────────────────────────────────────────
  function errorLogin(msg) {
    const e = document.getElementById('login-error');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
  }

  window.doLogin = async function () {
    const u = (document.getElementById('inp-user').value || '').trim().toLowerCase();
    const p = document.getElementById('inp-pass').value || '';
    const e = document.getElementById('login-error');
    if (e) e.style.display = 'none';
    if (!u || !p) return errorLogin('⚠️ Ingresá usuario y contraseña');
    const btn = document.querySelector('#login-screen button[onclick*="doLogin"]');
    const txt = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Ingresando…'; }
    try {
      const email = `${u}@${DOMINIO}`;
      let r = await sb.auth.signInWithPassword({ email, password: p });
      if (r.error && r.error.status !== 429) {
        // ¿Cuenta del sistema anterior que todavía no pasó su contraseña?
        const l = await llamarFuncion('login-legado', { usuario: u, clave: p }, false);
        if (l.ok) r = await sb.auth.signInWithPassword({ email, password: p });
        else if (l.error === 'bloqueado') return errorLogin('⛔ Demasiados intentos fallidos. Esperá 15 minutos.');
        else if (l.error === 'clave_debil') return errorLogin('🔐 Tu contraseña anterior no cumple el mínimo de seguridad. Pedile a la dirección que te asigne una nueva.');
      }
      if (r.error) {
        return errorLogin(r.error.status === 429 ? '⛔ Demasiados intentos. Esperá unos minutos.' : '⚠️ Usuario o contraseña incorrectos');
      }
      document.getElementById('inp-pass').value = '';
      await entrar();
    } catch (err) {
      console.error(err);
      errorLogin('📴 No se pudo conectar con el servidor. Revisá tu conexión.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = txt; }
    }
  };

  async function entrar() {
    const { data: ud } = await sb.auth.getUser();
    if (!ud || !ud.user) return false;
    const { data: yo, error } = await sb.from('perfiles').select('*').eq('user_id', ud.user.id).maybeSingle();
    if (error || !yo) { await sb.auth.signOut(); errorLogin('⚠️ La cuenta no tiene perfil en el sistema. Contactá a la dirección.'); return false; }
    if (yo.estado !== 'activo') { await sb.auth.signOut(); errorLogin('⊘ Este usuario está inactivo. Contactá al administrador.'); return false; }
    perfilYo = yo;
    const perfiles = await cargarDesdeServidor();
    USUARIOS_INST.clear();
    perfiles.filter((p) => p.rol === 'institucion').forEach((p) => USUARIOS_INST.add(String(p.institucion_id)));
    if (INSTITUCIONES.length) purgarDatosLocalesViejos();

    let tipo, cuenta;
    if (yo.rol === 'institucion') {
      tipo = 'inst';
      cuenta = INSTITUCIONES.find((i) => i.id === Number(yo.institucion_id));
    } else {
      tipo = 'usuario';
      cuenta = USUARIOS.find((x) => String(x.id) === String(yo.legacy_id));
    }
    if (!cuenta) { await sb.auth.signOut(); errorLogin('⚠️ No se pudo abrir la cuenta.'); return false; }
    const bloq = tipo === 'usuario' ? sgeInstitucionBloqueada(cuenta) : (cuenta.estado !== 'activa' ? cuenta : null);
    if (bloq) { await sb.auth.signOut(); errorLogin(`⊘ La institución "${bloq.nombre}" está ${bloq.estado}. Contactá al administrador.`); return false; }

    sesionActiva = true;
    _entrarConCuenta(tipo, cuenta);
    agregarBotonPrivacidad();
    iniciarSondeo();
    reiniciarInactividad();
    if (!yo.acepto_privacidad_at) pedirConsentimiento();
    else if (yo.debe_cambiar_clave) setTimeout(sgePedirCambioClaveObligatorio, 300);
    return true;
  }

  function iniciarSondeo() {
    clearInterval(sondeo);
    sondeo = setInterval(traerCambiosRemotos, Math.max(10, CFG.sondeoSeg || 20) * 1000);
  }

  // Al cerrar sesión no queda nada en memoria ni en el navegador.
  const doLogoutOriginal = window.doLogout;
  window.doLogout = async function (motivo) {
    if (sesionActiva) { clearTimeout(temporizador); await sincronizar(); }
    sesionActiva = false;
    clearInterval(sondeo);
    try { doLogoutOriginal(); } catch (e) {}
    try { await sb.auth.signOut(); } catch (e) {}
    perfilYo = null;
    USUARIOS.length = 0; INSTITUCIONES.length = 0; INST_DATA = {}; DB = createEmptyInstData();
    baseReg = new Map(); baseUsr = new Map(); baseInst = new Map(); rechazados.clear();
    ultimoTs = null; ultimoTsPerfiles = null;
    const p = document.getElementById('sge-privacidad-btn'); if (p) p.remove();
    if (typeof motivo === 'string') errorLogin(motivo);
  };

  // ── Reemplazos de funciones del sistema original ─────────────────────────
  window.guardarEstado = function () { programarSync(); return true; };
  window.guardarEstadoInmediato = function () { programarSync(0); };
  window.cargarEstadoGuardado = function () { return false; };
  window.borrarEstadoGuardado = function () { return true; };
  window.autoguardadoTick = function () { if (sesionActiva) programarSync(); };
  window.recordarSesion = async function () {};
  window.olvidarSesion = function () {};
  window.restaurarSesionRecordada = async function () { return false; };
  window.sgeClaveEsDemo = function () { return false; };
  window.actualizarBannerSheets = function () {};
  window.sincronizarSheets = async function () { return false; };
  window.sheetsConfigurado = function () { return false; };
  window.sheetsListoParaUsar = function () { return false; };

  // Contraseñas: nunca se calculan ni guardan hashes en el navegador.
  window.establecerClave = async function (cuenta, claveNueva) {
    if (!cuenta) return;
    delete cuenta.clave;
    delete cuenta.claveHash;
    const esPropia = (_sgeCuentaActual && _sgeCuentaActual.cuenta === cuenta) ||
      (perfilYo && String(cuenta.id) === String(perfilYo.legacy_id)) ||
      (perfilYo && perfilYo.rol === 'institucion' && Number(cuenta.id) === Number(perfilYo.institucion_id) && !cuenta.rol);
    if (!esPropia) { clavesPendientes.set(cuenta, String(claveNueva || '')); programarSync(); return; }
    await cambiarMiClave(claveNueva);
  };
  window.sgeRegistrarClavePendiente = function (cuenta, claveNueva) {
    if (cuenta && claveNueva) { clavesPendientes.set(cuenta, String(claveNueva)); programarSync(); }
  };

  function validarMiClave(c) {
    if (c.length < CLAVE_MIN) return `La contraseña debe tener al menos ${CLAVE_MIN} caracteres.`;
    if (!/[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(c) || !/[0-9]/.test(c)) return 'La contraseña debe combinar letras y números.';
    if (perfilYo && c.toLowerCase().includes(perfilYo.usuario.toLowerCase())) return 'La contraseña no puede contener tu nombre de usuario.';
    return null;
  }
  async function cambiarMiClave(c) {
    const err = validarMiClave(String(c || ''));
    if (err) { aviso('⚠️ ' + err); throw new Error(err); }
    const { error } = await sb.auth.updateUser({ password: c });
    if (error) { aviso('⚠️ No se pudo cambiar la contraseña: ' + error.message); throw error; }
    await sb.from('perfiles').update({ debe_cambiar_clave: false }).eq('user_id', perfilYo.user_id);
    perfilYo.debe_cambiar_clave = false;
  }

  window.sgeGuardarCambioClaveObligatorio = async function () {
    const c1 = (document.getElementById('sge-cc-1') || {}).value || '';
    const c2 = (document.getElementById('sge-cc-2') || {}).value || '';
    const err = document.getElementById('sge-cc-err');
    const mal = (m) => { err.textContent = m; err.style.display = 'block'; };
    const v = validarMiClave(c1);
    if (v) return mal(v);
    if (c1 !== c2) return mal('Las contraseñas no coinciden.');
    try { await cambiarMiClave(c1); } catch (e) { return mal(e.message || 'No se pudo cambiar la contraseña.'); }
    const ov = document.getElementById('sge-cambio-clave'); if (ov) ov.remove();
    aviso('🔑 Contraseña actualizada', '#166534');
  };
  const pedirCambioOriginal = window.sgePedirCambioClaveObligatorio;
  window.sgePedirCambioClaveObligatorio = function () {
    pedirCambioOriginal();
    const ov = document.getElementById('sge-cambio-clave');
    if (!ov) return;
    const t = ov.querySelector('div > div:nth-child(2)');
    if (t) t.textContent = `Por seguridad tenés que elegir una contraseña nueva y personal (mínimo ${CLAVE_MIN} caracteres, con letras y números). No la compartas con nadie.`;
  };

  // Vínculo familia ⇄ alumno: lo valida el servidor (con freno de intentos).
  window.ptVincular = async function () {
    const dni = luaGet('pt-v-dni'), cod = luaGet('pt-v-cod').trim().toUpperCase();
    if (!dni || !cod) { aviso('Ingresá el DNI y el código.'); return; }
    const { data, error } = await sb.rpc('sge_vincular_hijo', { p_dni: dni, p_codigo: cod });
    if (error) { aviso(error.message); return; }
    if (!data || !data.ok) { aviso('DNI o código incorrectos.'); return; }
    await cargarDesdeServidor();
    const yo = USUARIOS.find((x) => String(x.id) === String(perfilYo.legacy_id));
    if (yo) { currentUser = yo; if (_sgeCuentaActual) _sgeCuentaActual.cuenta = yo; }
    currentInstitucionId = yo && yo.institucionId; DB = INST_DATA[currentInstitucionId] || createEmptyInstData();
    padreHijoSel = data.alumnoId;
    aviso('✅ Vinculaste a ' + esc(data.nombre) + '.', '#166534');
    navigate('resumen');
  };
  window.ptDesvincularOk = async function (uid_, alId) {
    const { error } = await sb.rpc('sge_desvincular_familiar', { p_padre: String(uid_), p_alumno: alId });
    if (error) { aviso(error.message); return; }
    const u = USUARIOS.find((x) => x.id === uid_);
    if (u) { u.hijoIds = (u.hijoIds || []).filter((i) => i !== alId); baseUsr.set(String(u.id), JSON.stringify(proyeccion(u))); }
    aviso('Vínculo eliminado.', '#166534'); closeModal();
    if (ptFam()) { if (padreHijoSel === alId) padreHijoSel = null; navigate('hijos'); } else navigate('familia');
  };
  const ptCodigoOriginal = window.ptCodigo;
  window.ptCodigo = function (al, nuevo) {
    if (!perfilYo || perfilYo.rol !== 'alumno') return ptCodigoOriginal(al, nuevo);
    if (al.codigoVinculo && !nuevo) return al.codigoVinculo;
    sb.rpc('sge_codigo_vinculo', { p_nuevo: !!nuevo }).then(({ data, error }) => {
      if (error) { aviso(error.message); return; }
      al.codigoVinculo = data;
      const k = clave(currentInstitucionId, 'alumnos', al.id);
      baseReg.set(k, JSON.stringify(al));
      if (currentSection === 'familia') navigate('familia');
    });
    return al.codigoVinculo || '······';
  };

  // Los "reset" borraban todo el sistema: en el servidor no se permiten desde la pantalla.
  window.confirmarReset = function () {
    alert('Por seguridad, el reseteo de datos está deshabilitado en la versión con servidor.\nSi necesitás borrar datos, hacelo desde el panel de Supabase con un backup previo.');
  };

  // ── Política de privacidad y derechos del titular (Ley 25.326) ────────────
  function pedirConsentimiento() {
    if (document.getElementById('sge-consentimiento')) return;
    const ov = document.createElement('div');
    ov.id = 'sge-consentimiento';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(15,23,42,.8);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:520px;width:100%;padding:24px;font-family:inherit;max-height:90vh;overflow:auto">
      <div style="font-size:18px;font-weight:800;color:#1a3a5c;margin-bottom:10px">🔒 Tus datos personales</div>
      <div style="font-size:13.5px;color:#334155;line-height:1.55">
        <p style="margin-bottom:8px">El SGE trata datos personales de agentes, estudiantes y familias <strong>sólo para la gestión escolar</strong> (Ley 25.326 de Protección de Datos Personales y Ley 26.061 de Protección Integral de Niñas, Niños y Adolescentes).</p>
        <ul style="margin:0 0 8px 18px">
          <li>Cada persona accede únicamente a la información que su función requiere.</li>
          <li>Los datos de salud y de menores tienen acceso restringido.</li>
          <li>Todas las modificaciones quedan registradas.</li>
          <li>Podés pedir acceso, rectificación o supresión de tus datos a la dirección de la escuela.</li>
          <li>No compartas tu contraseña ni la información a la que accedés por tu función (deber de confidencialidad, art. 10).</li>
        </ul>
        <p><a href="privacidad.html" target="_blank" rel="noopener">Leer la política de privacidad completa</a></p>
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13.5px;margin:14px 0"><input type="checkbox" id="sge-cons-chk" style="margin-top:3px"> Leí la política de privacidad y me comprometo a usar los datos sólo para mi función.</label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="sge-cons-no">No acepto (salir)</button>
        <button class="btn btn-primary" id="sge-cons-si">Aceptar y continuar</button>
      </div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('#sge-cons-no').onclick = () => { ov.remove(); window.doLogout('Para usar el sistema es necesario aceptar la política de privacidad.'); };
    ov.querySelector('#sge-cons-si').onclick = async () => {
      if (!ov.querySelector('#sge-cons-chk').checked) { aviso('Marcá la casilla para continuar.'); return; }
      const { error } = await sb.rpc('sge_aceptar_privacidad');
      if (error) { aviso('No se pudo registrar la aceptación: ' + error.message); return; }
      perfilYo.acepto_privacidad_at = new Date().toISOString();
      ov.remove();
      if (perfilYo.debe_cambiar_clave) setTimeout(sgePedirCambioClaveObligatorio, 200);
    };
  }

  function agregarBotonPrivacidad() {
    if (document.getElementById('sge-privacidad-btn')) return;
    const cont = document.querySelector('.topbar-user') || document.querySelector('.topbar');
    if (!cont) return;
    const b = document.createElement('button');
    b.id = 'sge-privacidad-btn';
    b.className = 'btn-logout';
    b.textContent = '🔒 Mi cuenta';
    b.onclick = abrirMiCuenta;
    cont.insertBefore(b, cont.firstChild);
  }

  function abrirMiCuenta() {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:22px;font-family:inherit">
      <div style="font-size:17px;font-weight:800;color:#1a3a5c;margin-bottom:4px">🔒 Mi cuenta</div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:14px">Usuario: <strong>${esc(perfilYo && perfilYo.usuario)}</strong></div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-ghost" data-a="clave">🔑 Cambiar mi contraseña</button>
        <button class="btn btn-ghost" data-a="datos">📥 Descargar mis datos (derecho de acceso)</button>
        <button class="btn btn-ghost" data-a="global">🚪 Cerrar sesión en todos mis dispositivos</button>
        <a class="btn btn-ghost" href="privacidad.html" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">📄 Política de privacidad</a>
        <button class="btn btn-primary" data-a="cerrar">Cerrar</button>
      </div></div>`;
    ov.onclick = async (ev) => {
      const a = ev.target && ev.target.dataset && ev.target.dataset.a;
      if (!a && ev.target !== ov) return;
      ov.remove();
      if (a === 'clave') sgePedirCambioClaveObligatorio();
      if (a === 'datos') descargarMisDatos();
      if (a === 'global') { await sb.auth.signOut({ scope: 'global' }).catch(() => {}); window.doLogout('Se cerró la sesión en todos tus dispositivos.'); }
    };
    document.body.appendChild(ov);
  }

  // Exporta lo que el sistema tiene sobre la persona (su cuenta y sus registros).
  function descargarMisDatos() {
    const u = currentUser || {};
    const mios = {};
    Object.keys(INST_DATA).forEach((inst) => COLECCIONES.forEach((col) => {
      (INST_DATA[inst][col] || []).forEach((o) => {
        const propio =
          (col === 'docentes' && (o.id === u.docenteId || (u.instituciones || []).some((v) => v.docenteId === o.id))) ||
          (col === 'preceptores' && o.id === u.preceptorId) ||
          (col === 'alumnos' && o.id === u.alumnoId) ||
          (u.docenteId != null && o.docenteId === u.docenteId) ||
          (u.preceptorId != null && o.preceptorId === u.preceptorId) ||
          (u.alumnoId != null && o.alumnoId === u.alumnoId);
        if (propio) ((mios[inst] = mios[inst] || {})[col] = mios[inst][col] || []).push(o);
      });
    }));
    const salida = {
      generado: new Date().toISOString(),
      aviso: 'Datos personales del titular según Ley 25.326 art. 14. Uso personal.',
      cuenta: { usuario: perfilYo.usuario, rol: perfilYo.rol, institucion: perfilYo.institucion_id,
                aceptoPrivacidad: perfilYo.acepto_privacidad_at, datos: perfilYo.datos },
      registros: mios,
    };
    const blob = new Blob([JSON.stringify(salida, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mis-datos-sge-${perfilYo.usuario}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── Cierre por inactividad ───────────────────────────────────────────────
  let tInactivo = null;
  function reiniciarInactividad() {
    if (!sesionActiva) return;
    clearTimeout(tInactivo);
    tInactivo = setTimeout(() => {
      if (sesionActiva) window.doLogout(`⏱️ Se cerró la sesión por ${CFG.inactividadMin || 30} minutos de inactividad.`);
    }, (CFG.inactividadMin || 30) * 60 * 1000);
  }
  ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach((ev) =>
    document.addEventListener(ev, reiniciarInactividad, { passive: true, capture: true }));

  // Si la sesión se invalida desde el servidor (cuenta borrada, cierre global…)
  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT' && sesionActiva) window.doLogout('La sesión terminó. Ingresá nuevamente.');
  });
  window.addEventListener('online', () => { if (sesionActiva) { programarSync(0); traerCambiosRemotos(); } });
  window.addEventListener('focus', () => { if (sesionActiva) traerCambiosRemotos(); });
  // Si quedan cambios sin subir, el navegador pregunta antes de cerrar la pestaña.
  window.addEventListener('beforeunload', (ev) => {
    if (sesionActiva && (sincronizando || temporizador)) { programarSync(0); ev.preventDefault(); ev.returnValue = ''; }
  });

  // Reabre la sesión si el navegador ya tenía una válida (token de Supabase).
  (async function arrancar() {
    purgarDatosLocalesViejosSiCorresponde();
    const btn = document.querySelector('#login-screen button[onclick*="doLogin"]');
    const { data } = await sb.auth.getSession();
    if (!data.session) return;
    const txt = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Cargando…'; }
    try { await entrar(); } catch (e) { console.error(e); errorLogin('📴 No se pudo conectar con el servidor.'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = txt; } }
  })();
  // Los datos del sistema viejo se borran del navegador recién después de un
  // primer ingreso exitoso al servidor (ver entrar()); acá sólo se borran las
  // llaves de sesión viejas, que ya no sirven.
  function purgarDatosLocalesViejosSiCorresponde() {
    try { ['sge_sesion_v1', 'sge_sheets_token_v2', 'sge_dispositivo_v1'].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
  }
})();
