// admin-usuarios — altas, cambios, contraseñas y bajas de cuentas del SGE.
//
// Corre en el servidor con la clave de servicio, así que valida TODO acá:
//   • El administrador puede gestionar cualquier cuenta.
//   • Director/a, secretario/a y la cuenta institucional sólo cuentas de SU
//     escuela, nunca administradores ni cuentas institucionales, y no pueden
//     cambiarse a sí mismos el rol ni el estado.
//   • Un secretario/a no modifica cuentas de director/a.
//   • Nadie puede vincular una cuenta a datos de una escuela que no gestiona.
// Se despliega con verify_jwt = true.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ORIGENES = (Deno.env.get("SGE_ORIGENES") ?? "https://cesar385.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const DOMINIO = Deno.env.get("SGE_EMAIL_DOMINIO") ?? "sge.invalid";
const ROLES = ["admin", "director", "secretario", "preceptor", "docente", "padre", "alumno", "institucion"];
const GESTION = ["director", "secretario", "institucion"];
const CLAVE_MIN = 10;

type Perfil = {
  user_id: string; legacy_id: string; usuario: string; rol: string; estado: string;
  institucion_id: number | null; vinculos: Record<string, unknown>; datos: Record<string, unknown>;
};

function cors(req: Request): Record<string, string> {
  const origen = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origen) ? origen : ORIGENES[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
class Rechazo extends Error {
  constructor(msg: string, public status = 403) { super(msg); }
}

const entero = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
};

function claveValida(c: unknown) {
  const s = String(c ?? "");
  return s.length >= CLAVE_MIN && s.length <= 128 && /[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(s) && /[0-9]/.test(s);
}
// Contraseña temporal legible (sin 0/O, 1/l/I) con letras y números garantizados.
function claveTemporal() {
  const L = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", D = "23456789", T = L + D;
  const r = new Uint32Array(12);
  crypto.getRandomValues(r);
  const c = Array.from(r, (n, i) => (i === 0 ? L : i === 5 ? D : T)[n % (i === 0 ? L.length : i === 5 ? D.length : T.length)]);
  return `${c.slice(0, 4).join("")}-${c.slice(4, 8).join("")}-${c.slice(8).join("")}`;
}
// Si la dirección eligió una contraseña débil (p. ej. el DNI o 4 caracteres),
// se reemplaza por una temporal segura que se le muestra para entregar.
function elegirClave(c: unknown) {
  return claveValida(c) ? { clave: String(c), temporal: null } : (() => { const t = claveTemporal(); return { clave: t, temporal: t }; })();
}

// Sólo se aceptan las claves conocidas, con el tipo correcto.
function limpiarVinculos(v: unknown) {
  const o = (v && typeof v === "object") ? v as Record<string, unknown> : {};
  const r: Record<string, unknown> = {};
  for (const k of ["docenteId", "preceptorId", "alumnoId"]) {
    const n = entero(o[k]);
    if (n !== null) r[k] = n;
  }
  if (Array.isArray(o.hijoIds)) r.hijoIds = [...new Set(o.hijoIds.map(entero).filter((n) => n !== null))];
  if (Array.isArray(o.instituciones)) {
    r.instituciones = o.instituciones
      .map((x) => ({ institucionId: entero((x as any)?.institucionId), docenteId: entero((x as any)?.docenteId) }))
      .filter((x) => x.institucionId !== null && x.docenteId !== null);
  }
  return r;
}

function limpiarDatos(d: unknown) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return {};
  const s = JSON.stringify(d);
  if (s.length > 50_000) throw new Rechazo("Datos demasiado grandes", 400);
  const o = JSON.parse(s);
  for (const k of ["clave", "claveHash", "password", "rol", "estado"]) delete o[k];
  return o;
}

// Instituciones que la cuenta GESTIONA: sólo la que tiene a cargo
// (institucion_id). En las escuelas donde sólo da horas no gestiona cuentas.
async function institucionesDe(admin: SupabaseClient, p: Perfil) {
  const ids = new Set<number>();
  if (p.institucion_id) ids.add(Number(p.institucion_id));
  if (!ids.size) return ids;
  const { data } = await admin.from("instituciones").select("id,estado").in("id", [...ids]);
  return new Set((data ?? []).filter((i) => i.estado === "activa").map((i) => Number(i.id)));
}

// ¿Puede "yo" gestionar una cuenta con este rol en esta institución?
function exigirAlcance(yo: Perfil, misInst: Set<number>, rol: string, inst: number | null) {
  if (yo.rol === "admin") return;
  if (!GESTION.includes(yo.rol)) throw new Rechazo("No tenés permisos para gestionar cuentas");
  if (rol === "admin" || rol === "institucion") throw new Rechazo("Sólo el administrador gestiona ese tipo de cuenta");
  if (yo.rol === "secretario" && rol === "director") throw new Rechazo("Un/a secretario/a no gestiona cuentas de dirección");
  if (inst === null || !misInst.has(inst)) throw new Rechazo("La cuenta no pertenece a tu institución");
}

// Un directivo sólo agrega vínculos con escuelas que gestiona; el resto queda como estaba.
function vinculosPermitidos(yo: Perfil, misInst: Set<number>, nuevos: Record<string, unknown>, viejos: Record<string, unknown>) {
  if (yo.rol === "admin") return nuevos;
  const nuevasInst = ((nuevos.instituciones as any[]) ?? []).filter((x) => misInst.has(x.institucionId));
  const ajenas = ((viejos.instituciones as any[]) ?? []).filter((x) => !misInst.has(Number(x.institucionId)));
  return { ...nuevos, instituciones: [...ajenas, ...nuevasInst] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "Método no permitido" }, 405);
  if (!ORIGENES.includes(req.headers.get("origin") ?? "")) return json(req, { ok: false, error: "Origen no permitido" }, 403);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  try {
    // ¿Quién llama? (token de sesión verificado por Supabase Auth)
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: eu } = await admin.auth.getUser(token);
    if (eu || !u?.user) throw new Rechazo("Sesión inválida", 401);
    const { data: yo } = await admin.from("perfiles").select("*").eq("user_id", u.user.id).single<Perfil>();
    if (!yo || yo.estado !== "activo") throw new Rechazo("Cuenta inactiva", 401);
    const misInst = await institucionesDe(admin, yo);

    const b = await req.json().catch(() => ({}));
    const accion = String(b.accion ?? "");

    if (accion === "crear") {
      const usuario = String(b.usuario ?? "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) throw new Rechazo("Usuario inválido: 3 a 60 letras, números, punto, guion", 400);
      const rol = String(b.rol ?? "");
      if (!ROLES.includes(rol)) throw new Rechazo("Rol inválido", 400);
      const inst = entero(b.institucion_id);
      exigirAlcance(yo, misInst, rol, inst);
      const legacy = String(b.legacy_id ?? "").trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(legacy)) throw new Rechazo("Identificador inválido", 400);
      const { clave, temporal } = elegirClave(b.clave);
      const vinculos = vinculosPermitidos(yo, misInst, limpiarVinculos(b.vinculos), {});

      const { data: nu, error: ec } = await admin.auth.admin.createUser({
        email: `${usuario}@${DOMINIO}`, password: clave, email_confirm: true,
        app_metadata: { sge_rol: rol },
      });
      if (ec || !nu?.user) throw new Rechazo(/already|registered|exists/i.test(ec?.message ?? "") ? "Ese usuario ya existe" : "No se pudo crear la cuenta", 409);
      const { error: ep } = await admin.from("perfiles").insert({
        user_id: nu.user.id, legacy_id: legacy, usuario, rol,
        estado: b.estado === "inactivo" ? "inactivo" : "activo",
        institucion_id: inst, vinculos, datos: limpiarDatos(b.datos), debe_cambiar_clave: true,
      });
      if (ep) {
        await admin.auth.admin.deleteUser(nu.user.id);
        throw new Rechazo("No se pudo crear el perfil (¿identificador repetido?)", 409);
      }
      return json(req, { ok: true, claveTemporal: temporal });
    }

    // El resto de las acciones trabaja sobre una cuenta existente.
    const { data: obj } = await admin.from("perfiles").select("*").eq("legacy_id", String(b.legacy_id ?? "")).single<Perfil>();
    if (!obj) throw new Rechazo("Cuenta no encontrada", 404);
    const propia = obj.user_id === yo.user_id;
    if (!propia) exigirAlcance(yo, misInst, obj.rol, obj.institucion_id);

    if (accion === "actualizar") {
      const c = (b.cambios && typeof b.cambios === "object") ? b.cambios : {};
      const upd: Record<string, unknown> = {};
      if ("datos" in c) upd.datos = limpiarDatos(c.datos);
      if (!propia || yo.rol === "admin") {
        if ("rol" in c && c.rol !== obj.rol) {
          if (propia) throw new Rechazo("No podés cambiar tu propio rol");
          if (!ROLES.includes(c.rol)) throw new Rechazo("Rol inválido", 400);
          upd.rol = c.rol;
        }
        if ("estado" in c && c.estado !== obj.estado) {
          if (propia) throw new Rechazo("No podés desactivar tu propia cuenta");
          upd.estado = c.estado === "inactivo" ? "inactivo" : "activo";
        }
        if ("institucion_id" in c) upd.institucion_id = entero(c.institucion_id);
      }
      // Vínculos: la dirección los gestiona para su escuela, incluido su propio
      // legajo (no le da más acceso del que ya tiene sobre su institución).
      if ("vinculos" in c && (!propia || yo.rol === "admin" || GESTION.includes(yo.rol))) {
        upd.vinculos = vinculosPermitidos(yo, misInst, limpiarVinculos(c.vinculos), obj.vinculos ?? {});
      }
      // El resultado también tiene que quedar dentro del alcance de quien lo cambia.
      if (!propia) exigirAlcance(yo, misInst, String(upd.rol ?? obj.rol), (upd.institucion_id ?? obj.institucion_id) as number | null);
      if (!Object.keys(upd).length) return json(req, { ok: true });
      const { error } = await admin.from("perfiles").update(upd).eq("user_id", obj.user_id);
      if (error) throw new Rechazo("No se pudo guardar", 500);
      if (upd.rol) await admin.auth.admin.updateUserById(obj.user_id, { app_metadata: { sge_rol: upd.rol } });
      return json(req, { ok: true });
    }

    if (accion === "clave") {
      if (propia) throw new Rechazo("Para tu propia contraseña usá 'Cambiar contraseña'", 400);
      const { clave, temporal } = elegirClave(b.clave);
      const { error } = await admin.auth.admin.updateUserById(obj.user_id, { password: clave });
      if (error) throw new Rechazo("No se pudo cambiar la contraseña", 500);
      await admin.rpc("sge_srv_borrar_legado", { p_usuario: obj.usuario });
      await admin.from("perfiles").update({ debe_cambiar_clave: true }).eq("user_id", obj.user_id);
      return json(req, { ok: true, claveTemporal: temporal });
    }

    if (accion === "eliminar") {
      if (propia) throw new Rechazo("No podés eliminar tu propia cuenta");
      const { error } = await admin.auth.admin.deleteUser(obj.user_id); // borra el perfil en cascada
      if (error) throw new Rechazo("No se pudo eliminar", 500);
      return json(req, { ok: true });
    }

    throw new Rechazo("Acción desconocida", 400);
  } catch (e) {
    if (e instanceof Rechazo) return json(req, { ok: false, error: e.message }, e.status);
    console.error(e);
    return json(req, { ok: false, error: "Error interno" }, 500);
  }
});
