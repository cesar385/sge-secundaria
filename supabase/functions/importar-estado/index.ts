// importar-estado — migración ÚNICA desde el SGE anterior (backup JSON).
//
// Recibe el backup { USUARIOS, INSTITUCIONES, INST_DATA } que el SGE descarga
// desde "Backup" y lo carga en Supabase:
//   • instituciones (sin usuario/contraseña de la escuela)
//   • registros (cada elemento de cada colección)
//   • cuentas: se crean en Supabase Auth con una contraseña aleatoria; el hash
//     viejo queda guardado aparte para que cada persona pase su contraseña la
//     primera vez que entra (ver login-legado). Las contraseñas en texto plano
//     que hubiera en el backup se convierten a hash y se descartan.
//
// Protección: exige el encabezado x-sge-import-token igual al secreto
// SGE_IMPORT_TOKEN, y se niega si la base ya tiene datos (salvo reemplazar:true).
// BORRÁ EL SECRETO SGE_IMPORT_TOKEN APENAS TERMINES LA MIGRACIÓN.
// Se despliega con verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2";

const DOMINIO = Deno.env.get("SGE_EMAIL_DOMINIO") ?? "sge.invalid";
const ORIGENES = (Deno.env.get("SGE_ORIGENES") ?? "https://cesar385.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const COLECCIONES = new Set([
  "docentes", "preceptores", "designaciones", "licencias", "notificaciones", "reintegros",
  "conceptosPeriodo", "traslados", "permutas", "bajasTramite", "certificacionesMedicas",
  "antecedentesAgente", "liquidaciones", "liqExcluidas", "credenciales", "competenciasExtra",
  "puntajesCap", "solicitudesPlaza", "alumnos", "notas", "asistencias", "asistenciasMateria",
  "justificaciones", "movimientosAlumnos", "pases", "materiasAdeudadas", "serviciosAlumno",
  "preinscripciones", "cursos", "plazas", "comunicados", "diasClase", "cierreNotas", "configBoletin",
]);
const ROLES = new Set(["admin", "director", "secretario", "preceptor", "docente", "padre", "alumno"]);

function cors(req: Request): Record<string, string> {
  const origen = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origen) ? origen : ORIGENES[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sge-import-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
async function sha256(t: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function iguales(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function claveAleatoria() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a));
}
const entero = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const secreto = Deno.env.get("SGE_IMPORT_TOKEN") ?? "";
  if (secreto.length < 24 || !iguales(req.headers.get("x-sge-import-token") ?? "", secreto)) {
    return json(req, { ok: false, error: "No autorizado" }, 401);
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } });

  const b = await req.json().catch(() => null);
  const est = b?.estado ?? b;
  if (!est || !Array.isArray(est.USUARIOS) || !Array.isArray(est.INSTITUCIONES) || typeof est.INST_DATA !== "object") {
    return json(req, { ok: false, error: "El cuerpo no es un backup del SGE" }, 400);
  }
  const { count } = await admin.from("registros").select("*", { count: "exact", head: true });
  if ((count ?? 0) > 0 && b?.reemplazar !== true) {
    return json(req, { ok: false, error: "La base ya tiene datos. Enviá reemplazar:true sólo si sabés lo que hacés." }, 409);
  }

  const informe = { instituciones: 0, registros: 0, cuentas: 0, omitidos: [] as string[] };

  // 1) Instituciones (sin credenciales)
  for (const i of est.INSTITUCIONES) {
    const id = entero(i?.id);
    if (id === null) { informe.omitidos.push(`institución sin id: ${i?.nombre}`); continue; }
    const { usuario: _u, clave: _c, claveHash: _h, id: _i, nombre, cue, estado, ...resto } = i;
    const { error } = await admin.from("instituciones").upsert({
      id, nombre: String(nombre ?? `Institución ${id}`), cue: cue ?? null,
      estado: estado === "activa" || !estado ? "activa" : String(estado), datos: resto,
    });
    if (error) informe.omitidos.push(`institución ${id}: ${error.message}`); else informe.instituciones++;
  }

  // 2) Registros, en lotes
  for (const [k, data] of Object.entries(est.INST_DATA as Record<string, Record<string, unknown[]>>)) {
    const inst = entero(k);
    if (inst === null) continue;
    const filas: Record<string, unknown>[] = [];
    for (const [col, lista] of Object.entries(data ?? {})) {
      if (!COLECCIONES.has(col) || !Array.isArray(lista)) continue;
      lista.forEach((o: any, idx) => {
        if (!o || typeof o !== "object") return;
        const id = o.id !== undefined && o.id !== null ? String(o.id) : `__${idx}`;
        filas.push({ institucion_id: inst, coleccion: col, id, datos: o });
      });
    }
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500);
      const { error } = await admin.from("registros").upsert(lote);
      if (error) informe.omitidos.push(`registros inst ${inst} lote ${i}: ${error.message}`);
      else informe.registros += lote.length;
    }
  }

  // 3) Cuentas
  const { data: existentes } = await admin.from("perfiles").select("usuario");
  const ya = new Set((existentes ?? []).map((p) => p.usuario));
  const cuentas: { legacy: string; usuario: string; rol: string; estado: string; inst: number | null;
                   vinculos: Record<string, unknown>; datos: Record<string, unknown>; hash: string | null }[] = [];
  for (const u of est.USUARIOS) {
    const usuario = String(u?.usuario ?? "").trim().toLowerCase();
    if (!usuario || !ROLES.has(u?.rol)) { informe.omitidos.push(`cuenta inválida: ${u?.usuario}`); continue; }
    const hash = u.claveHash ? String(u.claveHash) : (u.clave ? await sha256(String(u.clave)) : null);
    const vinculos: Record<string, unknown> = {};
    for (const c of ["docenteId", "preceptorId", "alumnoId"]) if (entero(u[c]) !== null) vinculos[c] = entero(u[c]);
    if (Array.isArray(u.hijoIds)) vinculos.hijoIds = u.hijoIds.map(entero).filter((n: number | null) => n !== null);
    if (Array.isArray(u.instituciones)) vinculos.instituciones = u.instituciones
      .map((x: any) => ({ institucionId: entero(x?.institucionId), docenteId: entero(x?.docenteId) }))
      .filter((x: any) => x.institucionId !== null && x.docenteId !== null);
    const { id, usuario: _u, rol, estado, institucionId, claveHash: _h, clave: _c,
            docenteId: _d, preceptorId: _p, alumnoId: _a, hijoIds: _hi, instituciones: _in, ...datos } = u;
    cuentas.push({ legacy: String(id), usuario, rol, estado: estado === "inactivo" ? "inactivo" : "activo",
                   inst: entero(institucionId), vinculos, datos, hash });
  }
  for (const i of est.INSTITUCIONES) {
    if (!i?.usuario || entero(i.id) === null) continue;
    const hash = i.claveHash ? String(i.claveHash) : (i.clave ? await sha256(String(i.clave)) : null);
    cuentas.push({ legacy: `inst_${i.id}`, usuario: String(i.usuario).trim().toLowerCase(), rol: "institucion",
                   estado: i.estado === "activa" ? "activo" : "inactivo", inst: entero(i.id),
                   vinculos: {}, datos: { nombre: i.nombre }, hash });
  }
  for (const c of cuentas) {
    if (ya.has(c.usuario)) { informe.omitidos.push(`ya existía: ${c.usuario}`); continue; }
    const { data: nu, error: ec } = await admin.auth.admin.createUser({
      email: `${c.usuario}@${DOMINIO}`, password: claveAleatoria(), email_confirm: true,
      app_metadata: { sge_rol: c.rol },
    });
    if (ec || !nu?.user) { informe.omitidos.push(`cuenta ${c.usuario}: ${ec?.message}`); continue; }
    const { error: ep } = await admin.from("perfiles").insert({
      user_id: nu.user.id, legacy_id: c.legacy, usuario: c.usuario, rol: c.rol, estado: c.estado,
      institucion_id: c.inst, vinculos: c.vinculos, datos: c.datos,
    });
    if (ep) {
      await admin.auth.admin.deleteUser(nu.user.id);
      informe.omitidos.push(`perfil ${c.usuario}: ${ep.message}`);
      continue;
    }
    if (c.hash) await admin.rpc("sge_srv_guardar_legado", { p_usuario: c.usuario, p_hash: c.hash });
    ya.add(c.usuario);
    informe.cuentas++;
  }

  return json(req, { ok: true, informe });
});
