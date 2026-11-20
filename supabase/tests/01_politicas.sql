-- Pruebas de las políticas de acceso (correr después de 00_mock_supabase.sql y la migración).
-- Cada bloque se ejecuta "como" un usuario distinto y falla si ve o puede hacer algo indebido.
\set ON_ERROR_STOP 1

insert into auth.users(id) values
 ('00000000-0000-0000-0000-00000000000a'),  -- admin
 ('00000000-0000-0000-0000-0000000000d1'),  -- director inst 1
 ('00000000-0000-0000-0000-0000000000c1'),  -- docente inst 1 (docente 10, curso 3°A)
 ('00000000-0000-0000-0000-0000000000c2'),  -- docente inst 2 (docente 20)
 ('00000000-0000-0000-0000-0000000000e1'),  -- preceptor inst 1 (preceptor 5)
 ('00000000-0000-0000-0000-0000000000f1'),  -- padre de alumno 100
 ('00000000-0000-0000-0000-0000000000a1');  -- alumno 100

insert into public.instituciones(id,nombre,estado) values (1,'Instituto Regional Federal','activa'),(2,'EPJA N°8','activa');

insert into public.perfiles(user_id,legacy_id,usuario,rol,institucion_id,vinculos) values
 ('00000000-0000-0000-0000-00000000000a','1','admin','admin',null,'{}'),
 ('00000000-0000-0000-0000-0000000000d1','2','dir','director',1,'{"docenteId":12}'),
 ('00000000-0000-0000-0000-0000000000c1','3','doc','docente',1,'{"docenteId":10}'),
 ('00000000-0000-0000-0000-0000000000c2','4','doc2','docente',2,'{"docenteId":20}'),
 ('00000000-0000-0000-0000-0000000000e1','5','prec','preceptor',1,'{"preceptorId":5}'),
 ('00000000-0000-0000-0000-0000000000f1','6','padre','padre',1,'{"hijoIds":[100]}'),
 ('00000000-0000-0000-0000-0000000000a1','7','alu','alumno',1,'{"alumnoId":100}');

insert into public.registros(institucion_id,coleccion,id,datos) values
 (1,'docentes','10','{"nombre":"Docente Diez","cargo":"Profesor/a","cbu":"111","dni":"1"}'),
 (1,'docentes','11','{"nombre":"Docente Once","cargo":"Profesor/a"}'),
 (1,'docentes','12','{"nombre":"Directora","cargo":"Director/a"}'),
 (1,'designaciones','500','{"docenteId":10,"curso":"3°A","estado":"activa"}'),
 (1,'designaciones','501','{"docenteId":11,"curso":"4°B","estado":"activa"}'),
 (1,'licencias','600','{"docenteId":10,"estado":"pendiente"}'),
 (1,'licencias','601','{"docenteId":11,"estado":"aprobada","diagnostico":"privado"}'),
 (1,'certificacionesMedicas','700','{"docenteId":11,"detalle":"privado"}'),
 (1,'notificaciones','800','{"docenteId":10,"texto":"hola","leida":false}'),
 (1,'alumnos','100','{"nombre":"Alumno Cien","curso":"3°A","dni":"47.300.100","codigoVinculo":"ABCDEF12"}'),
 (1,'alumnos','101','{"nombre":"Alumno CientoUno","curso":"4°B","dni":"47.300.101","codigoVinculo":"ZZZZZZ99"}'),
 (1,'notas','900','{"alumnoId":100,"nota":8}'),
 (1,'notas','901','{"alumnoId":101,"nota":6}'),
 (1,'comunicados','1000','{"curso":"3°A","texto":"Reunión"}'),
 (2,'alumnos','200','{"nombre":"Alumno EPJA","curso":"1°"}'),
 (2,'docentes','20','{"nombre":"Docente EPJA"}');

create or replace function public.t_como(u text) returns void language sql as
  $$ select set_config('request.jwt.claim.sub', u, false) $$;
create or replace function public.t_ids(col text) returns text language sql as
  $$ select coalesce(string_agg(institucion_id||':'||id, ',' order by institucion_id, id), '') from public.registros where coleccion = col $$;
create or replace function public.t_eq(got text, want text, msg text) returns void language plpgsql as
  $$ begin if got is distinct from want then raise exception 'FALLA %: obtuve [%] esperaba [%]', msg, got, want; end if;
     raise notice 'ok  %', msg; end $$;
grant execute on function public.t_como(text), public.t_ids(text), public.t_eq(text,text,text) to authenticated;

set role authenticated;

-- ── Admin: ve todo ──
select t_como('00000000-0000-0000-0000-00000000000a');
select t_eq(t_ids('alumnos'), '1:100,1:101,2:200', 'admin ve alumnos de todas las escuelas');

-- ── Director inst 1 ──
select t_como('00000000-0000-0000-0000-0000000000d1');
select t_eq(t_ids('alumnos'), '1:100,1:101', 'director ve sólo alumnos de su escuela');
select t_eq(t_ids('certificacionesMedicas'), '1:700', 'director ve certificados médicos de su escuela');
select t_eq((select count(*)::text from public.perfiles), '5', 'director ve las cuentas de su escuela (no el admin)');
update public.registros set datos = jsonb_set(datos,'{estado}','"aprobada"') where coleccion='licencias' and id='600';
select t_eq((select datos->>'estado' from public.registros where coleccion='licencias' and id='600'), 'aprobada', 'director aprueba licencia');
update public.registros set datos = jsonb_set(datos,'{estado}','"pendiente"') where coleccion='licencias' and id='600';

-- ── Docente inst 1 (docente 10, curso 3°A) ──
select t_como('00000000-0000-0000-0000-0000000000c1');
select t_eq(t_ids('alumnos'), '1:100', 'docente ve sólo alumnos de sus cursos');
select t_eq(t_ids('notas'), '1:900', 'docente ve sólo notas de sus alumnos');
select t_eq(t_ids('licencias'), '1:600', 'docente ve sólo sus licencias');
select t_eq(t_ids('certificacionesMedicas'), '', 'docente NO ve certificados médicos ajenos');
select t_eq(t_ids('docentes'), '1:10', 'docente ve sólo su legajo');
select t_eq(t_ids('comunicados'), '1:1000', 'docente ve comunicados de su escuela');
select t_eq((select count(*)::text from public.perfiles), '1', 'docente ve sólo su propia cuenta');
-- carga nota a su alumno: sí
update public.registros set datos = jsonb_set(datos,'{nota}','9') where coleccion='notas' and id='900';
select t_eq((select datos->>'nota' from public.registros where coleccion='notas' and id='900'), '9', 'docente modifica nota de su alumno');
-- nota a alumno de otro curso: no
do $$ begin
  insert into public.registros(institucion_id,coleccion,id,datos) values (1,'notas','999','{"alumnoId":101,"nota":1}');
  raise exception 'FALLA: docente cargó nota a alumno ajeno';
exception when insufficient_privilege then raise notice 'ok  docente no carga notas a alumnos ajenos'; end $$;
-- autoaprobarse una licencia: no
do $$ begin
  update public.registros set datos = jsonb_set(datos,'{estado}','"aprobada"') where coleccion='licencias' and id='600';
  raise exception 'FALLA: docente aprobó su propia licencia';
exception when insufficient_privilege then raise notice 'ok  docente no puede aprobar su licencia'; end $$;
-- pedir licencia nueva: sí (pendiente)
insert into public.registros(institucion_id,coleccion,id,datos) values (1,'licencias','602','{"docenteId":10,"estado":"pendiente"}');
select t_eq(t_ids('licencias'), '1:600,1:602', 'docente pide licencia nueva');
-- pedir licencia a nombre de otro: no
do $$ begin
  insert into public.registros(institucion_id,coleccion,id,datos) values (1,'licencias','603','{"docenteId":11,"estado":"pendiente"}');
  raise exception 'FALLA: docente pidió licencia por otro';
exception when insufficient_privilege then raise notice 'ok  docente no pide licencias por otro'; end $$;
-- editar su legajo: datos personales sí, cargo/CBU no
update public.registros set datos = datos || '{"telefono":"123","cargo":"Director/a","cbu":"999"}' where coleccion='docentes' and id='10';
select t_eq((select datos->>'telefono'||'|'||(datos->>'cargo')||'|'||(datos->>'cbu') from public.registros where coleccion='docentes' and id='10'),
            '123|Profesor/a|111', 'docente edita su teléfono pero no su cargo ni CBU');
-- notificación: marcar leída sí, cambiar texto no
update public.registros set datos = jsonb_set(datos,'{leida}','true') where coleccion='notificaciones' and id='800';
do $$ begin
  update public.registros set datos = jsonb_set(datos,'{texto}','"otro"') where coleccion='notificaciones' and id='800';
  raise exception 'FALLA: docente editó texto de notificación';
exception when insufficient_privilege then raise notice 'ok  docente sólo marca notificaciones como leídas'; end $$;
-- cambiar su propio rol: no
do $$ begin
  update public.perfiles set rol = 'admin' where user_id = auth.uid();
  raise exception 'FALLA: docente se hizo admin';
exception when insufficient_privilege then raise notice 'ok  docente no puede cambiar su rol'; end $$;
do $$ begin
  update public.perfiles set vinculos = '{"docenteId":11}' where user_id = auth.uid();
  raise exception 'FALLA: docente cambió sus vínculos';
exception when insufficient_privilege then raise notice 'ok  docente no puede cambiar sus vínculos'; end $$;
-- borrar físicamente: no (no falla, pero no borra nada)
delete from public.registros where coleccion='notas' and id='900';
select t_eq(t_ids('notas'), '1:900', 'docente no borra físicamente');
select t_eq((select count(*)::text from public.auditoria), '0', 'docente no lee la auditoría');

-- ── Docente de OTRA escuela ──
select t_como('00000000-0000-0000-0000-0000000000c2');
select t_eq(t_ids('alumnos'), '', 'docente de EPJA sin cursos no ve alumnos');
select t_eq(t_ids('docentes'), '2:20', 'docente de EPJA ve sólo su legajo');
select t_eq(t_ids('comunicados'), '', 'docente de EPJA no ve comunicados de otra escuela');

-- ── Preceptor inst 1 ──
select t_como('00000000-0000-0000-0000-0000000000e1');
select t_eq(t_ids('alumnos'), '1:100,1:101', 'preceptor ve alumnos de su escuela');
select t_eq(t_ids('certificacionesMedicas'), '', 'preceptor NO ve datos de salud de docentes');
select t_eq(t_ids('docentes'), '', 'preceptor NO ve legajos de docentes');

-- ── Familia (padre de 100) ──
select t_como('00000000-0000-0000-0000-0000000000f1');
select t_eq(t_ids('alumnos'), '1:100', 'familia ve sólo a su hijo/a');
select t_eq(t_ids('notas'), '1:900', 'familia ve sólo notas de su hijo/a');
select t_eq(t_ids('docentes'), '', 'familia no ve legajos');
do $$ begin
  update public.registros set datos = jsonb_set(datos,'{nota}','10') where coleccion='notas' and id='900';
  if found then raise exception 'FALLA: familia cambió una nota'; end if;
  raise notice 'ok  familia no modifica notas';
end $$;
select t_eq((select (sge_vincular_hijo('47.300.101','XXXXXX00'))->>'ok'), 'false', 'vínculo con código incorrecto rechazado');
select t_eq((select (sge_vincular_hijo('47300101','zzzzzz99'))->>'ok'), 'true', 'vínculo con DNI + código correcto');
select t_eq(t_ids('alumnos'), '1:100,1:101', 'familia ve al hijo recién vinculado');
select sge_vincular_hijo('1','AAAAAAAA'), sge_vincular_hijo('1','AAAAAAAA'), sge_vincular_hijo('1','AAAAAAAA'), sge_vincular_hijo('1','AAAAAAAA');
do $$ begin
  perform sge_vincular_hijo('1','AAAAAAAA');
  raise exception 'FALLA: no frenó la fuerza bruta';
exception when insufficient_privilege then raise notice 'ok  bloqueo tras 5 intentos fallidos'; end $$;

-- ── Alumno 100 ──
select t_como('00000000-0000-0000-0000-0000000000a1');
select t_eq(t_ids('alumnos'), '1:100', 'alumno ve sólo su ficha');
select t_eq(t_ids('notas'), '1:900', 'alumno ve sólo sus notas');
select t_eq((select string_agg(usuario, ',' order by usuario) from public.perfiles), 'alu,padre', 'alumno ve a su familia vinculada');
select t_eq(length(sge_codigo_vinculo(true))::text, '8', 'alumno regenera su código');

-- ── Institución suspendida ──
reset role;
update public.instituciones set estado = 'suspendida' where id = 1;
set role authenticated;
select t_como('00000000-0000-0000-0000-0000000000c1');
select t_eq(t_ids('notas'), '', 'escuela suspendida: el docente no ve nada');
select t_como('00000000-0000-0000-0000-0000000000d1');
select t_eq(t_ids('alumnos'), '', 'escuela suspendida: la dirección no ve nada');
reset role;
update public.instituciones set estado = 'activa' where id = 1;

-- ── Anónimo ──
set role anon;
do $$ begin
  perform 1 from public.registros;
  raise exception 'FALLA: anónimo leyó registros';
exception when insufficient_privilege then raise notice 'ok  anónimo no accede a nada'; end $$;
reset role;

-- ── Funciones de servidor: sólo service_role ──
select t_como('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
do $$ begin
  perform sge_srv_legado('doc', 'x');
  raise exception 'FALLA: un usuario llamó a una función de servidor';
exception when insufficient_privilege then raise notice 'ok  funciones de servidor no accesibles desde el navegador'; end $$;
reset role;
select sge_srv_guardar_legado('doc', encode(sha256('vieja'::bytea), 'hex'));
set role service_role;
select t_eq((sge_srv_legado('DOC', 'malo'))->>'error', 'credenciales', 'login legado rechaza hash incorrecto');
select t_eq((sge_srv_legado('doc', encode(sha256('vieja'::bytea), 'hex')))->>'ok', 'true', 'login legado acepta el hash correcto');
select sge_srv_legado('doc','m'), sge_srv_legado('doc','m'), sge_srv_legado('doc','m'), sge_srv_legado('doc','m'), sge_srv_legado('doc','m');
select t_eq((sge_srv_legado('doc', encode(sha256('vieja'::bytea), 'hex')))->>'error', 'bloqueado', 'login legado bloquea tras 5 fallos');
reset role;

select t_eq((select (count(*) > 0)::text from public.auditoria where accion = 'UPDATE' and coleccion = 'notas'), 'true', 'cambios quedan auditados');
select 'TODAS LAS PRUEBAS PASARON' as resultado;
