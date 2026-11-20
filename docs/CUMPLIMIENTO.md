# Cumplimiento normativo — SGE Secundaria

Este documento relaciona cada obligación con la medida que la cubre. Las medidas **técnicas** las implementa el sistema; las **organizativas** las tiene que hacer la institución responsable (no se resuelven con código).

> No es asesoramiento legal. Antes de usar el sistema con datos reales, la dirección o el área legal del CGE debería revisar la columna "Pendiente".

## Ley 25.326 de Protección de los Datos Personales

| Artículo | Obligación | Medida en el SGE | Pendiente (organizativo) |
|---|---|---|---|
| 2 y 7 | Los datos de salud son **sensibles** y tienen protección especial. | Certificados y licencias médicas: sólo la persona titular y la dirección/secretaría de su escuela (RLS). El preceptor y otros docentes no los ven. | — |
| 4 | Calidad: datos adecuados, pertinentes y no excesivos para la finalidad. | Cada rol recibe el mínimo de datos necesario (docente: sólo sus cursos). El registro de auditoría guarda los **nombres** de los campos cambiados, no sus valores. | Revisar qué campos del legajo son realmente necesarios. |
| 5 y 6 | Consentimiento e **información** al titular. | Al primer ingreso se muestra la política de privacidad y se registra la aceptación (`perfiles.acepto_privacidad_at`). | Completar los datos marcados en `privacidad.html`. Para estudiantes menores de edad, informar a las familias por los canales habituales de la escuela. |
| 8 | Datos de salud: los establecimientos pueden tratarlos respetando el secreto profesional. | Acceso restringido (ver art. 7). | — |
| 9 | **Seguridad** y confidencialidad: medidas técnicas y organizativas. | Ver `SECURITY.md`: RLS, bcrypt, cifrado en tránsito, freno de intentos, cierre por inactividad, auditoría, CSP, sin datos en el navegador. | Backups de Supabase activados; procedimiento de incidentes conocido por la dirección. |
| 10 | **Deber de confidencialidad** de quienes acceden. | Se recuerda en el aviso de privacidad, que hay que aceptar para usar el sistema. | Incluirlo en la notificación de funciones del personal. |
| 11 | Cesión sólo con consentimiento o por ley. | No hay exportaciones masivas fuera de la dirección; la descarga de "mis datos" sólo incluye datos propios. | — |
| 12 | Transferencia internacional. | Los datos están en Supabase (São Paulo, Brasil). | **Documentar la base legal** de la transferencia (p. ej. cláusulas contractuales modelo de la AAIP con el proveedor) o evaluar alojamiento local. |
| 14 | Derecho de **acceso** (10 días corridos). | *Mi cuenta → Descargar mis datos* (JSON con la cuenta y los registros propios). | Circuito para pedidos de terceros (p. ej. familias de estudiantes sin cuenta). |
| 16 | Rectificación, actualización y **supresión** (5 días hábiles). | La dirección corrige o da de baja desde el sistema; queda auditado. | Circuito de pedidos y plazos. |
| 21 y 22 | Registro de bases de datos; las bases públicas se crean por norma general publicada. | — | **Inscribir la base / contar con el acto administrativo** que la crea (CGE o Dirección Departamental). |

## Ley 26.061 de Protección Integral de Niñas, Niños y Adolescentes

| Artículo | Obligación | Medida en el SGE |
|---|---|---|
| 10 | Derecho a la vida privada e intimidad familiar. | Los datos de un estudiante sólo los ven: la escuela (dirección, secretaría, preceptoría), los docentes de **su curso**, su familia vinculada y el propio estudiante. |
| 22 | Prohibición de exponer o divulgar datos que permitan identificar a niñas, niños y adolescentes. | No hay vistas públicas ni enlaces compartibles; el vínculo familia–estudiante exige DNI + código personal, con bloqueo tras 5 intentos fallidos por hora. |
| 3 | Interés superior. | El estudiante puede ver qué familiares están vinculados a su cuenta y quitar vínculos, o pedirle a la escuela que lo haga. |

## Resolución AAIP 47/2018 (medidas de seguridad recomendadas)

| Área | Medida |
|---|---|
| Control de acceso | Usuarios individuales, roles, mínimo privilegio, bajas inmediatas (`estado = 'inactivo'`). |
| Autenticación | Contraseñas con sal (bcrypt), longitud mínima, cambio obligatorio inicial, bloqueo por intentos. |
| Registro de eventos | Tabla `auditoria` inalterable desde el cliente. |
| Comunicaciones | HTTPS obligatorio (GitHub Pages + Supabase). |
| Copias de respaldo | Backups del proyecto Supabase (activar en el panel). |
| Incidentes | Procedimiento en `SECURITY.md`. |

## OWASP

El detalle control por control está en `SECURITY.md` (OWASP Top 10 – 2021).

## Checklist antes de usar datos reales

- [ ] Proyecto de Supabase creado en una organización a nombre de la institución (no personal).
- [ ] Migraciones aplicadas y *Security Advisor* sin alertas.
- [ ] Pruebas de `supabase/tests` en verde.
- [ ] Datos de `privacidad.html` completados (responsable, contacto, plazos).
- [ ] Base legal de la transferencia internacional documentada (art. 12).
- [ ] Acto administrativo / registro de la base (art. 21–22).
- [ ] Backups activados.
- [ ] Secreto `SGE_IMPORT_TOKEN` borrado después de migrar.
- [ ] Planilla de Google Sheets y Apps Script anteriores archivados y sin acceso público.
