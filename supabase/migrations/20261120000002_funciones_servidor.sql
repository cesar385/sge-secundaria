-- Funciones que SÓLO pueden llamar las Edge Functions (rol service_role).
-- Nadie desde el navegador puede ejecutarlas.

-- Verifica una contraseña del sistema anterior (SHA-256 sin sal) con freno de
-- fuerza bruta: 5 intentos fallidos cada 15 minutos por usuario.
-- Si coincide devuelve el user_id. La Edge Function borra el hash viejo recién
-- cuando la contraseña quedó guardada en Supabase Auth (sge_srv_borrar_legado).
create or replace function public.sge_srv_legado(p_usuario text, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_clave text := 'login:' || lower(coalesce(p_usuario,''));
  v_hash text;
  v_user uuid;
begin
  if (select count(*) from private.intentos
       where clave = v_clave and fecha > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'bloqueado');
  end if;
  select hash into v_hash from private.claves_legado where usuario = lower(p_usuario);
  select user_id into v_user from public.perfiles where usuario = lower(p_usuario) and estado = 'activo';
  if v_hash is null or v_user is null or v_hash <> lower(coalesce(p_hash,'')) then
    insert into private.intentos(clave) values (v_clave);
    return jsonb_build_object('ok', false, 'error', 'credenciales');
  end if;
  delete from private.intentos where clave = v_clave;
  return jsonb_build_object('ok', true, 'user_id', v_user);
end $$;

-- Guarda hashes del sistema anterior durante la importación.
create or replace function public.sge_srv_guardar_legado(p_usuario text, p_hash text) returns void
language sql security definer set search_path = '' as $$
  insert into private.claves_legado(usuario, hash) values (lower(p_usuario), lower(p_hash))
  on conflict (usuario) do update set hash = excluded.hash;
$$;

-- Borra un hash viejo (cuando la dirección le asigna una contraseña nueva).
create or replace function public.sge_srv_borrar_legado(p_usuario text) returns void
language sql security definer set search_path = '' as $$
  delete from private.claves_legado where usuario = lower(p_usuario);
$$;

revoke all on function public.sge_srv_legado(text,text), public.sge_srv_guardar_legado(text,text),
                public.sge_srv_borrar_legado(text) from public, anon, authenticated;
grant execute on function public.sge_srv_legado(text,text), public.sge_srv_guardar_legado(text,text),
                public.sge_srv_borrar_legado(text) to service_role;
