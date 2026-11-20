// Configuración pública del SGE Secundaria.
// La "publishable key" (o anon key) de Supabase es PÚBLICA por diseño: lo que
// protege los datos son las políticas RLS de la base, no esta clave.
// NUNCA pongas acá la "service_role" / "secret" key.
window.SGE_CONFIG = {
  // Completar con los datos del proyecto (Supabase → Project Settings → API).
  // Mientras supabaseUrl quede vacío, el sistema sigue funcionando como antes
  // (Google Sheets), para poder migrar sin cortar el servicio.
  supabaseUrl: '',
  supabaseKey: '',

  // Dominio ficticio para los usuarios (Supabase Auth usa e-mail como login).
  // ".invalid" está reservado: nunca se le envía un correo a nadie.
  emailDominio: 'sge.invalid',

  // Cierre automático de sesión por inactividad (minutos).
  inactividadMin: 30,

  // Cada cuántos segundos se buscan cambios hechos desde otros dispositivos.
  sondeoSeg: 20,
};
window.SGE_SUPABASE_ACTIVO = !!(window.SGE_CONFIG.supabaseUrl && window.SGE_CONFIG.supabaseKey);
