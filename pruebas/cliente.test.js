// Prueba de la capa cliente (js/sge-supabase.js) con un Supabase falso en memoria.
// Uso: npm i jsdom@24 && node pruebas/cliente.test.js
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const REPO = require('path').resolve(__dirname, '..');
let html = fs.readFileSync(REPO + '/index.html', 'utf8');
// Cargar scripts externos en línea (jsdom no los trae solo)
html = html.replace('<script src="js/sge-config.js"></script>',
  '<script>' + fs.readFileSync(REPO + '/js/sge-config.js', 'utf8')
    .replace("supabaseUrl: ''", "supabaseUrl: 'https://x.supabase.co'").replace("supabaseKey: ''", "supabaseKey: 'pk'") + '</script>');
html = html.replace(/<script src="vendor\/supabase-[^"]+"[^>]*><\/script>/, '<script>window.supabase={createClient:()=>window.__fake}</script>');
html = html.replace('<script src="js/sge-supabase.js"></script>', '<script>' + fs.readFileSync(REPO + '/js/sge-supabase.js', 'utf8') + '</script>');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

// ── Supabase falso ──
const db = {
  instituciones: [{ id: 1, nombre: 'Instituto Regional Federal', cue: '300100', estado: 'activa', datos: {}, actualizado: '2026-01-01T00:00:00Z' }],
  perfiles: [
    { user_id: 'u-dir', legacy_id: '100', usuario: 'dcesar', rol: 'director', estado: 'activo', institucion_id: 1, vinculos: { docenteId: 10 }, datos: { nombre: 'Danderfert Julio Cesar' }, debe_cambiar_clave: false, acepto_privacidad_at: null, actualizado: '2026-01-01T00:00:00Z' },
    { user_id: 'u-doc', legacy_id: '101', usuario: 'doc', rol: 'docente', estado: 'activo', institucion_id: 1, vinculos: { docenteId: 11 }, datos: { nombre: 'Docente Once' }, debe_cambiar_clave: false, acepto_privacidad_at: '2026-01-01', actualizado: '2026-01-01T00:00:00Z' },
  ],
  registros: [
    { institucion_id: 1, coleccion: 'docentes', id: '10', datos: { id: 10, nombre: 'Danderfert, Julio Cesar', cuil: '20-38571769-6', cargo: 'Director/a' }, eliminado: false, actualizado: '2026-01-01T00:00:01Z' },
    { institucion_id: 1, coleccion: 'docentes', id: '11', datos: { id: 11, nombre: 'Docente Once', cargo: 'Profesor/a' }, eliminado: false, actualizado: '2026-01-01T00:00:02Z' },
    { institucion_id: 1, coleccion: 'alumnos', id: '500', datos: { id: 500, nombre: 'Ana', curso: '3°A', dni: '1' }, eliminado: false, actualizado: '2026-01-01T00:00:03Z' },
    { institucion_id: 1, coleccion: 'designaciones', id: '700', datos: { id: 700, docenteId: 10, nroPlaza: '01-0001', cargo: 'Director/a', estado: 'activa', nroExp: 'DC0100-00001-2015' }, eliminado: false, actualizado: '2026-01-01T00:00:04Z' },
  ],
};
const log = [];
let sesion = null, reloj = 10;
const ahora = () => `2026-01-01T00:01:${String(reloj++).padStart(2, '0')}Z`;
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.lim = null; this.rg = null; this.one = false; }
  select() { return this; } eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  gt(c, v) { this.f.push((r) => r[c] > v); return this; } in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
  order() { return this; } limit(n) { this.lim = n; return this; } range(a, b) { this.rg = [a, b]; return this; }
  maybeSingle() { this.one = true; return this; } single() { this.one = true; return this; }
  upsert(rows) { this.op = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(v) { this.op = 'update'; this.val = v; return this; } insert(v) { this.op = 'insert'; this.rows = [v]; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  run() {
    const T = db[this.t];
    if (this.op === 'upsert') {
      for (const r of this.rows) {
        if (this.t === 'registros' && sesion === 'u-doc' && r.coleccion !== 'notas') {
          log.push(['RECHAZO', r.coleccion, r.id]);
          return { error: { code: '42501', message: 'new row violates row-level security policy' } };
        }
      }
      for (const r of this.rows) {
        const i = T.findIndex((x) => x.institucion_id === r.institucion_id && x.coleccion === r.coleccion && x.id === r.id);
        const fila = { ...r, actualizado: ahora() };
        if (i >= 0) T[i] = fila; else T.push(fila);
        log.push(['UPSERT', r.coleccion, r.id, r.eliminado]);
      }
      return { error: null };
    }
    if (this.op === 'update') { T.filter((r) => this.f.every((f) => f(r))).forEach((r) => Object.assign(r, this.val, { actualizado: ahora() })); log.push(['UPDATE', this.t, this.val]); return { error: null }; }
    if (this.op === 'insert') { this.rows.forEach((r) => T.push(r)); return { error: null }; }
    let d = T.filter((r) => this.f.every((f) => f(r)));
    if (this.t === 'registros' && sesion === 'u-doc') d = d.filter((r) => r.coleccion !== 'alumnos' && (r.coleccion !== 'docentes' || r.id === '11'));
    if (this.rg) d = d.slice(this.rg[0], this.rg[1] + 1);
    d = JSON.parse(JSON.stringify(d));
    return this.one ? { data: d.find((p) => p.user_id === sesion) || d[0] || null, error: null } : { data: d, error: null };
  }
}
const fake = {
  auth: {
    async signInWithPassword({ email, password }) {
      const u = email.split('@')[0];
      const p = db.perfiles.find((x) => x.usuario === u);
      if (!p || password !== 'Clave-segura-123') return { error: { status: 400, message: 'Invalid login credentials' } };
      sesion = p.user_id; return { data: {}, error: null };
    },
    async getUser() { return { data: { user: sesion ? { id: sesion } : null } }; },
    async getSession() { return { data: { session: sesion ? { access_token: 'tok' } : null } }; },
    async signOut() { sesion = null; return {}; },
    async updateUser() { return { error: null }; },
    onAuthStateChange() {},
  },
  from: (t) => new Q(t),
  async rpc(n) { log.push(['RPC', n]); return { data: null, error: null }; },
};

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.log('JSDOM ERR', e.message));
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://cesar385.github.io/sge-secundaria/', virtualConsole: vc,
  beforeParse(w) {
    w.__fake = fake;
    w.fetch = async (url, o) => { log.push(['FETCH', url.split('/').pop(), JSON.parse(o.body).accion]); return { json: async () => ({ ok: true }), status: 200 }; };
    w.alert = (m) => log.push(['ALERT', m]); w.confirm = () => true; w.print = () => {};
    w.HTMLCanvasElement.prototype.getContext = () => null;
  } });
const w = dom.window;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) { console.log('FALLA:', m); process.exitCode = 1; } else console.log('ok ', m); };

(async () => {
  await esperar(300);
  const ev = (code) => w.eval(code);
  ok(ev('USUARIOS.length') === 0, 'sin usuarios de demostración en memoria antes del login');
  ok(!w.localStorage.getItem('sge_secundaria_estado_v1'), 'no hay estado en localStorage');
  w.localStorage.setItem('sge_secundaria_estado_v1', '{"viejo":1}');

  // Login con clave incorrecta → intenta login-legado
  w.document.getElementById('inp-user').value = 'dcesar';
  w.document.getElementById('inp-pass').value = 'mala';
  await ev('doLogin()');
  ok(log.some((l) => l[0] === 'FETCH' && l[1] === 'login-legado'), 'clave incorrecta prueba la migración legado');
  ok(w.document.getElementById('login-error').style.display === 'block', 'muestra error de credenciales');

  // Login correcto como director
  w.document.getElementById('inp-user').value = 'DCesar';
  w.document.getElementById('inp-pass').value = 'Clave-segura-123';
  await ev('doLogin()');
  await esperar(100);
  ok(ev('currentUser && currentUser.usuario') === 'dcesar', 'director entra');
  ok(ev('DB.docentes.length') === 2 && ev('DB.alumnos.length') === 1, 'carga los registros permitidos');
  ok(!!w.document.getElementById('sge-consentimiento'), 'pide aceptar la política de privacidad');
  ok(!w.localStorage.getItem('sge_secundaria_estado_v1'), 'borra los datos viejos del navegador tras entrar');
  w.document.getElementById('sge-cons-chk').checked = true;
  w.document.getElementById('sge-cons-si').click();
  await esperar(50);
  ok(log.some((l) => l[0] === 'RPC' && l[1] === 'sge_aceptar_privacidad'), 'registra la aceptación');

  // Cambio de datos → upsert sólo del registro cambiado
  log.length = 0;
  ev("DB.alumnos[0].nombre='Ana María'; guardarEstado();");
  await esperar(1500);
  const ups = log.filter((l) => l[0] === 'UPSERT');
  ok(ups.length === 1 && ups[0][1] === 'alumnos' && ups[0][2] === '500', 'sube sólo el registro modificado (' + JSON.stringify(ups) + ')');
  ok(db.registros.find((r) => r.id === '500').datos.nombre === 'Ana María', 'el servidor tiene el cambio');

  // Alta y baja
  log.length = 0;
  ev("DB.alumnos.push({id:501,nombre:'Beto',curso:'3°A'}); DB.alumnos=DB.alumnos.filter(a=>a.id!==500); INST_DATA[1]=DB; guardarEstado();");
  await esperar(1500);
  ok(log.some((l) => l[0] === 'UPSERT' && l[2] === '501' && l[3] === false), 'alta de registro');
  ok(log.some((l) => l[0] === 'UPSERT' && l[2] === '500' && l[3] === true), 'baja lógica de registro');

  // Nuevo usuario con clave débil → función admin-usuarios crear
  log.length = 0;
  await ev("(async()=>{ const n={id:999,usuario:'nuevo',rol:'docente',nombre:'Nuevo',estado:'activo',institucionId:1,docenteId:11}; await establecerClave(n,'1234'); USUARIOS.push(n); guardarEstado(); })()");
  await esperar(1500);
  ok(log.some((l) => l[0] === 'FETCH' && l[1] === 'admin-usuarios' && l[2] === 'crear'), 'crea la cuenta por la función del servidor');
  ok(!JSON.stringify(ev('USUARIOS')).includes('claveHash'), 'no quedan hashes de contraseñas en memoria');

  // Cambio remoto (otro dispositivo) llega por sondeo
  db.registros.push({ institucion_id: 1, coleccion: 'alumnos', id: '502', datos: { id: 502, nombre: 'Carla', curso: '4°B' }, eliminado: false, actualizado: '2026-01-01T00:09:00Z' });
  ev("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  Object.defineProperty(w.document, 'visibilityState', { value: 'visible', configurable: true });
  w.dispatchEvent(new w.Event('focus'));
  await esperar(300);
  ok(ev('DB.alumnos.some(a=>a.id===502)'), 'recibe cambios de otros dispositivos');

  // Logout limpia todo
  await ev('doLogout()');
  await esperar(100);
  ok(ev('USUARIOS.length') === 0 && ev('Object.keys(INST_DATA).length') === 0, 'al salir no queda nada en memoria');
  ok(Object.keys(w.localStorage).filter((k) => k.startsWith('sge_')).length === 0, 'ni en localStorage');

  // Docente: el servidor rechaza cambios no permitidos y se avisa
  log.length = 0;
  w.document.getElementById('inp-user').value = 'doc';
  w.document.getElementById('inp-pass').value = 'Clave-segura-123';
  await ev('doLogin()');
  await esperar(100);
  ok(ev('currentUser && currentUser.rol') === 'docente', 'docente entra');
  ok(ev('DB.alumnos.length') === 0 && ev('DB.docentes.length') === 1, 'docente sólo recibe lo permitido');
  ev("DB.docentes[0].cargo='Director/a'; guardarEstado();");
  await esperar(1500);
  ok(log.some((l) => l[0] === 'RECHAZO'), 'el servidor rechaza el cambio no permitido');
  const toast = w.document.body.textContent.includes('no se guardaron');
  ok(toast, 'se le avisa al usuario');
  log.length = 0;
  ev("guardarEstado();");
  await esperar(1500);
  ok(!log.some((l) => l[0] === 'RECHAZO'), 'no reintenta en bucle lo rechazado');
  console.log('FIN');
  process.exit();
})();
