-- ════════════════════════════════════════════════════════════════════════════
-- SGE Secundaria — esquema seguro en Supabase (Postgres + Row Level Security)
--
-- Objetivo: que CADA usuario reciba del servidor sólo los datos que le
-- corresponden según su rol e institución (Ley 25.326 art. 9 y 10; Ley 26.061
-- art. 22; OWASP A01 "Broken Access Control"). Las contraseñas las maneja
-- Supabase Auth (bcrypt + sal, nunca llegan a estas tablas).
--
-- Modelo:
--   instituciones  → una fila por escuela
--   perfiles       → una fila por cuenta (vinculada a auth.users)
--   registros      → cada registro de cada colección de cada institución
--                    (docentes, alumnos, notas, licencias, …) como JSONB, con
--                    columnas calculadas (docente_id, alumno_id, curso) que
--                    usan las políticas para decidir quién lo ve.
--   auditoria      → registro inalterable de quién cambió qué y cuándo.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ── Utilidades ─────────────────────────────────────────────────────────────
create or replace function private.a_bigint(t text) returns bigint
language sql immutable parallel safe as $$
  select case when t ~ '^-?[0-9]{1,18}$' then t::bigint end
$$;

-- Grupo de cada colección del sistema. Una colección desconocida no se acepta.
create or replace function private.grupo(col text) returns text
language sql immutable parallel safe as $$
  select case
    when col in ('docentes','preceptores','designaciones','licencias','notificaciones',
                 'reintegros','conceptosPeriodo','traslados','permutas','bajasTramite',
                 'certificacionesMedicas','antecedentesAgente','liquidaciones',
                 'liqExcluidas','credenciales','competenciasExtra','puntajesCap',
                 'solicitudesPlaza') then 'agente'
    when col in ('alumnos','notas','asistencias','asistenciasMateria','justificaciones',
                 'movimientosAlumnos','pases','materiasAdeudadas','serviciosAlumno',
                 'preinscripciones') then 'alumno'
    when col in ('cursos','plazas','comunicados','diasClase','cierreNotas','configBoletin')
                 then 'institucional'
  end
$$;

-- Trámites que un agente o familia puede iniciar, pero sólo un directivo aprueba.
create or replace function private.es_tramite(col text) returns boolean
language sql immutable parallel safe as $$
  select col in ('licencias','solicitudesPlaza','traslados','permutas','bajasTramite',
                 'certificacionesMedicas','reintegros','credenciales','justificaciones',
                 'antecedentesAgente','competenciasExtra','puntajesCap')
$$;

-- Estados que sólo puede fijar la dirección (aprobado, emitido, etc.).
create or replace function private.estado_resuelto(e text) returns boolean
language sql immutable parallel safe as $$
  select coalesce(lower(e),'') ~ '^(aprob|activ|emitid|actualiz|justific|autoriz|otorg|resuel|finaliz|cerrad|rechaz|denegad)'
$$;

-- ── Tablas ─────────────────────────────────────────────────────────────────
create table public.instituciones (
  id          bigint primary key,
  nombre      text not null,
  cue         text,
  estado      text not null default 'activa',
  datos       jsonb not null default '{}'::jsonb,
  actualizado timestamptz not null default now()
);

create table public.perfiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  legacy_id      text not null unique,          -- id que usa la aplicación
  usuario        text not null unique,
  rol            text not null check (rol in ('admin','director','secretario','preceptor',
                                              'docente','padre','alumno','institucion')),
  estado         text not null default 'activo' check (estado in ('activo','inactivo')),
  institucion_id bigint references public.instituciones(id) on delete set null,
  -- Vínculos que definen QUÉ datos ve la cuenta. Sólo los cambia la dirección
  -- o el administrador (función admin-usuarios), nunca el propio usuario.
  -- { docenteId, preceptorId, alumnoId, hijoIds:[…], instituciones:[{institucionId,docenteId}] }
  vinculos       jsonb not null default '{}'::jsonb,
  -- Datos que el propio usuario puede editar (nombre, datosPersonales, turnoCargo…)
  datos          jsonb not null default '{}'::jsonb,
  debe_cambiar_clave   boolean not null default false,
  acepto_privacidad_at timestamptz,
  actualizado    timestamptz not null default now()
);
create index perfiles_institucion_idx on public.perfiles(institucion_id);

create table public.registros (
  institucion_id bigint not null references public.instituciones(id) on delete cascade,
  coleccion      text   not null check (private.grupo(coleccion) is not null),
  id             text   not null,
  datos          jsonb  not null,
  eliminado      boolean not null default false,
  -- Dueño del registro (agente) — para que cada docente/preceptor vea lo suyo
  docente_id bigint generated always as (
    case
      when coleccion = 'docentes' then private.a_bigint(id)
      when coleccion = 'liquidaciones' then
        case when datos->>'sujetoTipo' = 'docente' then private.a_bigint(datos->>'sujetoId') end
      when coleccion = 'credenciales' then
        case when datos->>'campo' = 'docenteId' then private.a_bigint(datos->>'personaId') end
      else private.a_bigint(datos->>'docenteId')
    end) stored,
  preceptor_id bigint generated always as (
    case
      when coleccion = 'preceptores' then private.a_bigint(id)
      when coleccion = 'liquidaciones' then
        case when datos->>'sujetoTipo' = 'preceptor' then private.a_bigint(datos->>'sujetoId') end
      when coleccion = 'credenciales' then
        case when datos->>'campo' = 'preceptorId' then private.a_bigint(datos->>'personaId') end
      else private.a_bigint(datos->>'preceptorId')
    end) stored,
  -- Alumno al que pertenece (para familias, alumnos y docentes del curso)
  alumno_id bigint generated always as (
    case when coleccion = 'alumnos' then private.a_bigint(id)
         else private.a_bigint(datos->>'alumnoId') end) stored,
  curso          text generated always as (datos->>'curso') stored,
  actualizado    timestamptz not null default now(),
  actualizado_por uuid,
  primary key (institucion_id, coleccion, id)
);
create index registros_actualizado_idx on public.registros(actualizado);
create index registros_docente_idx  on public.registros(institucion_id, docente_id)  where docente_id is not null;
create index registros_precep_idx   on public.registros(institucion_id, preceptor_id) where preceptor_id is not null;
create index registros_alumno_idx   on public.registros(institucion_id, alumno_id)   where alumno_id is not null;

create table public.auditoria (
  id             bigserial primary key,
  fecha          timestamptz not null default now(),
  user_id        uuid,
  usuario        text,
  accion         text not null,           -- INSERT / UPDATE / DELETE / BAJA
  tabla          text not null,
  institucion_id bigint,
  coleccion      text,
  registro_id    text,
  campos         text[]                   -- sólo los NOMBRES de los campos cambiados (minimización)
);
create index auditoria_inst_fecha_idx on public.auditoria(institucion_id, fecha desc);

-- Contraseñas del sistema anterior (SHA-256 sin sal). Se usan UNA sola vez
-- para pasar la cuenta a Supabase Auth y se borran. Nadie las puede leer.
create table private.claves_legado (
  usuario  text primary key,
  hash     text not null
);
-- Intentos fallidos (login legado, vinculación de hijos) para frenar fuerza bruta.
create table private.intentos (
  id      bigserial primary key,
  clave   text not null,                  -- p.ej. 'login:usuario' o 'vinculo:<uuid>'
  fecha   timestamptz not null default now()
);
create index intentos_clave_fecha_idx on private.intentos(clave, fecha);

-- ── Quién es el usuario actual ─────────────────────────────────────────────
create or replace function private.yo() returns public.perfiles
language sql stable security definer set search_path = '' as $$
  select p.* from public.perfiles p
  where p.user_id = auth.uid() and p.estado = 'activo'
$$;

create or replace function private.rol() returns text
language sql stable security definer set search_path = '' as $$
  select (private.yo()).rol
$$;

create or replace function private.es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((private.yo()).rol = 'admin', false)
$$;

-- Instituciones de la cuenta: la base + las vinculadas (multi-institución).
create or replace function private.mis_instituciones() returns setof bigint
language sql stable security definer set search_path = '' as $$
  with y as (select * from private.yo())
  select institucion_id from y where institucion_id is not null
  union
  select (v->>'institucionId')::bigint
  from y, jsonb_array_elements(coalesce(y.vinculos->'instituciones','[]'::jsonb)) v
  where (v->>'institucionId') ~ '^[0-9]+$'
$$;

create or replace function private.pertenece(inst bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.mis_instituciones() i where i = inst)
$$;

-- La institución no puede estar suspendida (salvo para el administrador).
create or replace function private.inst_activa(inst bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select estado = 'activa' from public.instituciones where id = inst), false)
$$;

-- Dirección / secretaría / cuenta institucional: gestión completa de SU institución.
create or replace function private.es_gestion(inst bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.es_admin()
      or (private.rol() in ('director','secretario','institucion')
          and private.pertenece(inst) and private.inst_activa(inst))
$$;

create or replace function private.es_rol_en(r text, inst bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.rol() = r and private.pertenece(inst) and private.inst_activa(inst)
$$;

-- Legajos de agente (docente) de la cuenta en una institución.
create or replace function private.mis_docentes(inst bigint) returns setof bigint
language sql stable security definer set search_path = '' as $$
  with y as (select * from private.yo())
  select private.a_bigint(y.vinculos->>'docenteId') from y
   where y.institucion_id = inst and private.a_bigint(y.vinculos->>'docenteId') is not null
  union
  select private.a_bigint(v->>'docenteId')
  from y, jsonb_array_elements(coalesce(y.vinculos->'instituciones','[]'::jsonb)) v
  where private.a_bigint(v->>'institucionId') = inst and private.a_bigint(v->>'docenteId') is not null
$$;

create or replace function private.mis_preceptores(inst bigint) returns setof bigint
language sql stable security definer set search_path = '' as $$
  select private.a_bigint(y.vinculos->>'preceptorId') from private.yo() y
   where y.institucion_id = inst and private.a_bigint(y.vinculos->>'preceptorId') is not null
$$;

-- Alumnos de la cuenta: el propio (rol alumno) o los hijos (rol padre).
create or replace function private.mis_alumnos(inst bigint) returns setof bigint
language sql stable security definer set search_path = '' as $$
  with y as (select * from private.yo() where institucion_id = inst)
  select private.a_bigint(y.vinculos->>'alumnoId') from y
   where y.rol = 'alumno' and private.a_bigint(y.vinculos->>'alumnoId') is not null
  union
  select private.a_bigint(h) from y, jsonb_array_elements_text(coalesce(y.vinculos->'hijoIds','[]'::jsonb)) h
   where y.rol = 'padre' and private.a_bigint(h) is not null
$$;

-- Cursos en los que el/la docente tiene una designación vigente.
create or replace function private.mis_cursos(inst bigint) returns setof text
language sql stable security definer set search_path = '' as $$
  select r.curso from public.registros r
   where r.institucion_id = inst and r.coleccion = 'designaciones' and not r.eliminado
     and r.docente_id in (select private.mis_docentes(inst))
     and coalesce(r.datos->>'estado','activa') in ('activa','licencia')
     and coalesce(r.curso,'') <> ''
  union
  select c from public.registros r, jsonb_array_elements_text(
           case when jsonb_typeof(r.datos->'cursos') = 'array' then r.datos->'cursos' else '[]'::jsonb end) c
   where r.institucion_id = inst and r.coleccion = 'docentes' and not r.eliminado
     and r.docente_id in (select private.mis_docentes(inst))
$$;

-- ¿Puede la cuenta ver los datos de este alumno? (Ley 26.061: sólo quien lo necesita)
create or replace function private.puede_ver_alumno(inst bigint, alumno bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.es_gestion(inst)
      or private.es_rol_en('preceptor', inst)
      or (private.es_rol_en('docente', inst) and alumno is not null and exists (
            select 1 from public.registros a
             where a.institucion_id = inst and a.coleccion = 'alumnos' and a.alumno_id = alumno
               and a.curso in (select private.mis_cursos(inst))))
      or (private.rol() in ('padre','alumno') and private.inst_activa(inst)
          and alumno in (select private.mis_alumnos(inst)))
$$;

create or replace function private.es_mio(inst bigint, doc bigint, prec bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.inst_activa(inst) and (
         (doc  is not null and doc  in (select private.mis_docentes(inst)))
      or (prec is not null and prec in (select private.mis_preceptores(inst))))
$$;

grant execute on all functions in schema private to authenticated;

-- ── Row Level Security ────────────────────────────────────────────────────
alter table public.instituciones enable row level security;
alter table public.perfiles      enable row level security;
alter table public.registros     enable row level security;
alter table public.auditoria     enable row level security;
alter table private.claves_legado enable row level security;
alter table private.intentos      enable row level security;

revoke all on public.instituciones, public.perfiles, public.registros, public.auditoria from anon;
revoke all on public.instituciones, public.perfiles, public.registros, public.auditoria from authenticated;
grant select, update                 on public.instituciones to authenticated;
grant insert                         on public.instituciones to authenticated;
grant select, update                 on public.perfiles      to authenticated;
grant select, insert, update, delete on public.registros     to authenticated;
grant select                         on public.auditoria     to authenticated;

-- INSTITUCIONES
create policy inst_ver on public.instituciones for select to authenticated
  using (private.es_admin() or private.pertenece(id));
create policy inst_alta on public.instituciones for insert to authenticated
  with check (private.es_admin());
create policy inst_editar on public.instituciones for update to authenticated
  using (private.es_gestion(id)) with check (private.es_gestion(id));

-- PERFILES (altas, bajas, roles y vínculos: sólo por la función admin-usuarios)
create policy perfil_ver on public.perfiles for select to authenticated
  using (
    user_id = auth.uid()
    or private.es_admin()
    or (institucion_id is not null and private.es_gestion(institucion_id))
    or exists (select 1 from jsonb_array_elements(coalesce(vinculos->'instituciones','[]'::jsonb)) v
               where private.a_bigint(v->>'institucionId') is not null
                 and private.es_gestion(private.a_bigint(v->>'institucionId')))
    -- el alumno ve a los familiares vinculados con él
    or (rol = 'padre' and institucion_id is not null and exists (
          select 1 from private.mis_alumnos(institucion_id) a
           where private.rol() = 'alumno' and vinculos->'hijoIds' @> to_jsonb(a)))
  );
create policy perfil_editar_propio on public.perfiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- REGISTROS
create policy reg_ver on public.registros for select to authenticated using (
     private.es_gestion(institucion_id)
  or (private.grupo(coleccion) = 'institucional' and private.pertenece(institucion_id)
      and private.inst_activa(institucion_id))
  or (private.grupo(coleccion) = 'agente' and private.es_mio(institucion_id, docente_id, preceptor_id))
  or (private.grupo(coleccion) = 'alumno' and private.puede_ver_alumno(institucion_id, alumno_id))
);

create policy reg_alta on public.registros for insert to authenticated with check (
     private.es_gestion(institucion_id)
  or (private.es_rol_en('preceptor', institucion_id)
      and (private.grupo(coleccion) = 'alumno' or coleccion in ('comunicados','diasClase')))
  or (coleccion in ('notas','asistencias','asistenciasMateria')
      and private.es_rol_en('docente', institucion_id)
      and private.puede_ver_alumno(institucion_id, alumno_id))
  or (private.es_tramite(coleccion) and private.grupo(coleccion) = 'agente'
      and private.es_mio(institucion_id, docente_id, preceptor_id))
  or (coleccion = 'justificaciones' and private.rol() in ('padre','alumno')
      and private.puede_ver_alumno(institucion_id, alumno_id))
);

create policy reg_editar on public.registros for update to authenticated
  using (
       private.es_gestion(institucion_id)
    or (private.es_rol_en('preceptor', institucion_id)
        and (private.grupo(coleccion) = 'alumno' or coleccion in ('comunicados','diasClase')))
    or (coleccion in ('notas','asistencias','asistenciasMateria')
        and private.es_rol_en('docente', institucion_id)
        and private.puede_ver_alumno(institucion_id, alumno_id))
    or ((private.es_tramite(coleccion) or coleccion in ('notificaciones','docentes','preceptores'))
        and private.grupo(coleccion) = 'agente'
        and private.es_mio(institucion_id, docente_id, preceptor_id))
    or (coleccion = 'justificaciones' and private.rol() in ('padre','alumno')
        and private.puede_ver_alumno(institucion_id, alumno_id))
  )
  with check (
       private.es_gestion(institucion_id)
    or (private.es_rol_en('preceptor', institucion_id)
        and (private.grupo(coleccion) = 'alumno' or coleccion in ('comunicados','diasClase')))
    or (coleccion in ('notas','asistencias','asistenciasMateria')
        and private.es_rol_en('docente', institucion_id)
        and private.puede_ver_alumno(institucion_id, alumno_id))
    or ((private.es_tramite(coleccion) or coleccion in ('notificaciones','docentes','preceptores'))
        and private.grupo(coleccion) = 'agente'
        and private.es_mio(institucion_id, docente_id, preceptor_id))
    or (coleccion = 'justificaciones' and private.rol() in ('padre','alumno')
        and private.puede_ver_alumno(institucion_id, alumno_id))
  );

-- Borrado físico: sólo el administrador. El resto usa la baja lógica (eliminado = true).
create policy reg_borrar on public.registros for delete to authenticated
  using (private.es_admin());

-- AUDITORÍA: sólo lectura, para el administrador y la dirección de cada escuela.
create policy audit_ver on public.auditoria for select to authenticated
  using (private.es_admin() or (institucion_id is not null and private.es_gestion(institucion_id)));

-- ── Reglas de negocio que el navegador no puede saltear ────────────────────
-- SECURITY INVOKER a propósito: current_user distingue al navegador ('authenticated')
-- de una función del servidor (RPC / Edge Function).
create or replace function private.guardia_registros() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  -- current_user <> 'authenticated': lo hace una función del servidor (RPC/Edge Function), no el navegador.
  gestion boolean := auth.uid() is null or current_user <> 'authenticated'
                     or private.es_gestion(new.institucion_id);
  protegidos text[] := array['cargo','horas','estado','rolInstitucional','materia','fechaIngreso',
                             'escalafon','cursos','antiguedad','otrasInstituciones','cbu'];
  k text;
begin
  new.actualizado := now();
  new.actualizado_por := auth.uid();
  if gestion then return new; end if;

  -- Trámites: quien los inicia no puede darlos por aprobados.
  if private.es_tramite(new.coleccion) then
    if private.estado_resuelto(new.datos->>'estado') and
       (tg_op = 'INSERT' or coalesce(old.datos->>'estado','') is distinct from coalesce(new.datos->>'estado','')) then
      raise exception 'Sólo la dirección puede resolver este trámite' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and private.estado_resuelto(old.datos->>'estado') and old.datos is distinct from new.datos then
      raise exception 'El trámite ya fue resuelto y no se puede modificar' using errcode = '42501';
    end if;
  end if;

  -- Notificaciones: el destinatario sólo puede marcarlas como leídas.
  if new.coleccion = 'notificaciones' and tg_op = 'UPDATE' then
    if (new.datos - array['leida','leido','vista','fechaLectura']) is distinct from
       (old.datos - array['leida','leido','vista','fechaLectura']) or new.eliminado <> old.eliminado then
      raise exception 'Sólo se puede marcar la notificación como leída' using errcode = '42501';
    end if;
  end if;

  -- Legajo propio: datos personales sí; cargo, horas, situación, CBU, etc. no.
  if new.coleccion in ('docentes','preceptores') and tg_op = 'UPDATE' then
    foreach k in array protegidos loop
      if old.datos ? k then new.datos := jsonb_set(new.datos, array[k], old.datos->k);
      else new.datos := new.datos - k; end if;
    end loop;
    new.eliminado := old.eliminado;
  end if;
  return new;
end $$;

create trigger registros_guardia before insert or update on public.registros
  for each row execute function private.guardia_registros();

-- Perfil propio: sólo datos personales y aceptación de la política de privacidad.
-- SECURITY INVOKER a propósito: current_user distingue al navegador ('authenticated')
-- de una función del servidor (RPC / Edge Function).
create or replace function private.guardia_perfiles() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.actualizado := now();
  if auth.uid() is null or current_user <> 'authenticated' or private.es_admin() then return new; end if;
  if new.rol is distinct from old.rol or new.estado is distinct from old.estado
     or new.institucion_id is distinct from old.institucion_id
     or new.vinculos is distinct from old.vinculos
     or new.usuario is distinct from old.usuario or new.legacy_id is distinct from old.legacy_id
     or (old.debe_cambiar_clave = false and new.debe_cambiar_clave = true) then
    raise exception 'Estos datos de la cuenta sólo los modifica la dirección o el administrador'
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger perfiles_guardia before update on public.perfiles
  for each row execute function private.guardia_perfiles();

-- La dirección puede editar los datos de su escuela, pero no suspenderla/reactivarla.
-- SECURITY INVOKER a propósito: current_user distingue al navegador ('authenticated')
-- de una función del servidor (RPC / Edge Function).
create or replace function private.guardia_instituciones() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.actualizado := now();
  if auth.uid() is null or current_user <> 'authenticated' or private.es_admin() then return new; end if;
  if new.estado is distinct from old.estado or new.id is distinct from old.id then
    raise exception 'Sólo el administrador cambia el estado de una institución' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger instituciones_guardia before update on public.instituciones
  for each row execute function private.guardia_instituciones();

-- ── Auditoría (Ley 25.326 art. 9: seguridad y trazabilidad) ────────────────
create or replace function private.auditar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fila jsonb := to_jsonb(coalesce(new, old));
  campos text[];
  accion text := tg_op;
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'registros' then
      select array_agg(k) into campos from (
        select k from jsonb_object_keys(new.datos || old.datos) k
         where (new.datos->k) is distinct from (old.datos->k)) s;
      if new.eliminado and not old.eliminado then accion := 'BAJA'; end if;
    else
      select array_agg(k) into campos from (
        select k from jsonb_object_keys(to_jsonb(new)) k
         where k <> 'actualizado' and (to_jsonb(new)->k) is distinct from (to_jsonb(old)->k)) s;
    end if;
    if campos is null and accion = 'UPDATE' then return null; end if;
  end if;
  insert into public.auditoria(user_id, usuario, accion, tabla, institucion_id, coleccion, registro_id, campos)
  values (auth.uid(),
          (select usuario from public.perfiles where user_id = auth.uid()),
          accion, tg_table_name,
          case tg_table_name when 'instituciones' then (fila->>'id')::bigint
                             else private.a_bigint(fila->>'institucion_id') end,
          fila->>'coleccion',
          case tg_table_name when 'perfiles' then fila->>'legacy_id' else fila->>'id' end,
          campos);
  return null;
end $$;

create trigger registros_auditoria after insert or update or delete on public.registros
  for each row execute function private.auditar();
create trigger perfiles_auditoria after insert or update or delete on public.perfiles
  for each row execute function private.auditar();
create trigger instituciones_auditoria after insert or update or delete on public.instituciones
  for each row execute function private.auditar();

-- ── Acciones puntuales (RPC) ───────────────────────────────────────────────
-- Vincular un hijo/a con DNI + código (máx. 5 intentos fallidos por hora).
create or replace function public.sge_vincular_hijo(p_dni text, p_codigo text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  y public.perfiles;
  al record;
  v_clave text := 'vinculo:' || auth.uid();
begin
  select * into y from private.yo();
  if y.user_id is null or y.rol <> 'padre' then
    raise exception 'Sólo una cuenta de familia puede vincular alumnos' using errcode = '42501';
  end if;
  if (select count(*) from private.intentos where clave = v_clave and fecha > now() - interval '1 hour') >= 5 then
    raise exception 'Demasiados intentos. Probá de nuevo en una hora.' using errcode = '42501';
  end if;
  select r.institucion_id, r.alumno_id, r.datos->>'nombre' as nombre into al
    from public.registros r
   where r.coleccion = 'alumnos' and not r.eliminado
     and (y.institucion_id is null or r.institucion_id = y.institucion_id)
     and regexp_replace(coalesce(r.datos->>'dni',''), '\D', '', 'g') = regexp_replace(coalesce(p_dni,''), '\D', '', 'g')
     and upper(coalesce(r.datos->>'codigoVinculo','')) = upper(trim(coalesce(p_codigo,'')))
     and length(trim(coalesce(p_codigo,''))) >= 6
   limit 1;
  if al.alumno_id is null then
    insert into private.intentos(clave) values (v_clave);
    return jsonb_build_object('ok', false, 'error', 'DNI o código incorrectos');
  end if;
  update public.perfiles set
    institucion_id = coalesce(institucion_id, al.institucion_id),
    vinculos = jsonb_set(vinculos, '{hijoIds}',
      (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from (
         select x from jsonb_array_elements(coalesce(vinculos->'hijoIds','[]'::jsonb)) x
         union select to_jsonb(al.alumno_id)) s))
   where user_id = y.user_id;
  return jsonb_build_object('ok', true, 'alumnoId', al.alumno_id, 'nombre', al.nombre,
                            'institucionId', al.institucion_id);
end $$;

-- Quitar el vínculo familia ⇄ alumno (lo puede hacer la familia, el alumno o la dirección).
create or replace function public.sge_desvincular_familiar(p_padre text, p_alumno bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  y public.perfiles; p public.perfiles;
begin
  select * into y from private.yo();
  select * into p from public.perfiles where legacy_id = p_padre and rol = 'padre';
  if y.user_id is null or p.user_id is null then
    raise exception 'Cuenta no encontrada' using errcode = '42501';
  end if;
  if not (y.user_id = p.user_id
          or (y.rol = 'alumno' and y.institucion_id = p.institucion_id
              and private.a_bigint(y.vinculos->>'alumnoId') = p_alumno)
          or (p.institucion_id is not null and private.es_gestion(p.institucion_id))) then
    raise exception 'No podés modificar este vínculo' using errcode = '42501';
  end if;
  update public.perfiles set vinculos = jsonb_set(vinculos, '{hijoIds}',
      (select coalesce(jsonb_agg(x), '[]'::jsonb)
         from jsonb_array_elements(coalesce(vinculos->'hijoIds','[]'::jsonb)) x
        where private.a_bigint(x #>> '{}') is distinct from p_alumno))
   where user_id = p.user_id;
  return jsonb_build_object('ok', true);
end $$;

-- Código de vinculación del propio alumno (lo genera si no existe o si se pide uno nuevo).
create or replace function public.sge_codigo_vinculo(p_nuevo boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare
  y public.perfiles; cod text; letras text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
begin
  select * into y from private.yo();
  if y.user_id is null or y.rol <> 'alumno' or private.a_bigint(y.vinculos->>'alumnoId') is null then
    raise exception 'Sólo disponible para cuentas de alumno' using errcode = '42501';
  end if;
  select datos->>'codigoVinculo' into cod from public.registros
   where institucion_id = y.institucion_id and coleccion = 'alumnos'
     and alumno_id = private.a_bigint(y.vinculos->>'alumnoId');
  if cod is null or cod = '' or p_nuevo then
    cod := '';
    for i in 0..7 loop cod := cod || substr(letras, (get_byte(b, i) % 32) + 1, 1); end loop;
    update public.registros set datos = jsonb_set(datos, '{codigoVinculo}', to_jsonb(cod))
     where institucion_id = y.institucion_id and coleccion = 'alumnos'
       and alumno_id = private.a_bigint(y.vinculos->>'alumnoId');
  end if;
  return cod;
end $$;

-- Aceptación informada de la política de privacidad (Ley 25.326 art. 5 y 6).
create or replace function public.sge_aceptar_privacidad() returns void
language sql security definer set search_path = '' as $$
  update public.perfiles set acepto_privacidad_at = now() where user_id = auth.uid();
$$;

revoke all on function public.sge_vincular_hijo(text,text), public.sge_desvincular_familiar(text,bigint),
                public.sge_codigo_vinculo(boolean), public.sge_aceptar_privacidad() from public, anon;
grant execute on function public.sge_vincular_hijo(text,text), public.sge_desvincular_familiar(text,bigint),
                public.sge_codigo_vinculo(boolean), public.sge_aceptar_privacidad() to authenticated;

-- Limpieza periódica sugerida (pg_cron): intentos viejos y auditoría > 10 años.
-- select cron.schedule('sge-limpieza', '0 4 * * *', $$
--   delete from private.intentos where fecha < now() - interval '7 days';
--   delete from public.auditoria where fecha < now() - interval '10 years'; $$);
