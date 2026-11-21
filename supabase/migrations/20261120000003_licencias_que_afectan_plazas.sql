-- La dirección de una escuela también ve (sólo lectura) las licencias
-- cargadas en OTRA escuela que tienen asociada alguna plaza de la suya.
-- Ej.: un docente trabaja en dos escuelas; la otra dirección carga la
-- licencia y le asocia también la plaza de acá.

create or replace function private.lic_afecta_mis_plazas(p_datos jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from jsonb_array_elements_text(
             case when jsonb_typeof(p_datos->'plazaIds') = 'array' then p_datos->'plazaIds' else '[]'::jsonb end) pid
      join public.registros p
        on p.coleccion = 'plazas' and not p.eliminado and p.id = pid
     where private.es_gestion(p.institucion_id))
$$;
grant execute on function private.lic_afecta_mis_plazas(jsonb) to authenticated;

drop policy if exists reg_ver on public.registros;
create policy reg_ver on public.registros for select to authenticated using (
     private.es_gestion(institucion_id)
  or (private.grupo(coleccion) = 'institucional' and private.pertenece(institucion_id)
      and private.inst_activa(institucion_id))
  or (private.grupo(coleccion) = 'agente' and private.es_mio(institucion_id, docente_id, preceptor_id))
  or (private.grupo(coleccion) = 'alumno' and private.puede_ver_alumno(institucion_id, alumno_id))
  or (coleccion = 'licencias' and private.lic_afecta_mis_plazas(datos))
);
-- Escritura: sin cambios. Sólo la escuela donde se cargó la licencia la modifica o aprueba.
