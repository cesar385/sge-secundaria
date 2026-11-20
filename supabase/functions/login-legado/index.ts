// login-legado — pasa UNA cuenta del sistema anterior a Supabase Auth.
//
// El SGE viejo guardaba las contraseñas como SHA-256 sin sal. No se pueden
// convertir a bcrypt sin conocer la contraseña, así que la primera vez que
// cada persona ingresa:
//   1. El navegador intenta el login normal de Supabase y falla.
//   2. Llama a esta función con usuario + contraseña (por HTTPS).
//   3. Si coincide con el hash viejo, se guarda como contraseña de Supabase
//      Auth (bcrypt con sal) y el hash viejo se BORRA para siempre.
//   4. El navegador repite el login normal, que ahora funciona.
// Máximo 5 intentos fallidos cada 15 minutos por usuario.
//
// Se despliega con verify_jwt = false (todavía no hay sesión).
import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGENES = (Deno.env.get("SGE_ORIGENES") ?? "https://cesar385.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Contraseñas de demostración publicadas en el código viejo: obligan a cambiarla.
const HASHES_DEMO = new Set([
  "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9",
  "9b8769a4a742959a2d0298c36fb70623f2dfacda8436237df08d8dfd5b37374c",
  "ee63c6506c68d4613b9553820393f22db66a1dbc9ba6dc5640df9fce741e6258",
]);

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

async function sha256(texto: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "metodo" }, 405);
  if (!ORIGENES.includes(req.headers.get("origin") ?? "")) {
    return json(req, { ok: false, error: "origen" }, 403);
  }

  let usuario = "", clave = "";
  try {
    const b = await req.json();
    usuario = String(b.usuario ?? "").trim().toLowerCase();
    clave = String(b.clave ?? "");
  } catch { /* cuerpo inválido */ }
  if (!/^[a-z0-9._-]{2,60}$/.test(usuario) || !clave || clave.length > 200) {
    return json(req, { ok: false, error: "credenciales" }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Se comparan ambos formatos: la contraseña tal cual y recortada (el login viejo usaba .trim()).
  const hashes = [...new Set([await sha256(clave), await sha256(clave.trim())])];
  let res: { ok: boolean; user_id?: string; error?: string } | null = null;
  for (const h of hashes) {
    const { data, error } = await admin.rpc("sge_srv_legado", { p_usuario: usuario, p_hash: h });
    if (error) return json(req, { ok: false, error: "servidor" }, 500);
    res = data;
    if (res?.ok || res?.error === "bloqueado") break;
  }
  if (!res?.ok) {
    // Mismo mensaje para "no existe" y "clave incorrecta" (no revela qué usuarios existen).
    return json(req, { ok: false, error: res?.error === "bloqueado" ? "bloqueado" : "credenciales" },
      res?.error === "bloqueado" ? 429 : 401);
  }

  const esDemo = hashes.some((h) => HASHES_DEMO.has(h));
  const corta = clave.length < 10;
  const { error: e1 } = await admin.auth.admin.updateUserById(res.user_id!, { password: clave });
  if (e1) {
    // P. ej. la contraseña vieja no cumple el mínimo de Supabase Auth: la cuenta
    // queda como estaba y la dirección tiene que asignarle una contraseña nueva.
    const debil = /password/i.test(e1.message ?? "");
    return json(req, { ok: false, error: debil ? "clave_debil" : "servidor" }, debil ? 422 : 500);
  }
  await admin.rpc("sge_srv_borrar_legado", { p_usuario: usuario });
  if (esDemo || corta) {
    await admin.from("perfiles").update({ debe_cambiar_clave: true }).eq("user_id", res.user_id!);
  }
  return json(req, { ok: true });
});
