# Seguridad del SGE Secundaria

## Cómo reportar una vulnerabilidad

No abras un *issue* público. Escribí a **[correo del responsable]** con una descripción y, si podés, los pasos para reproducirla. Se responde dentro de los 5 días hábiles. Si la falla expone datos personales, se trata como incidente (ver más abajo).

## Arquitectura

```
Navegador (GitHub Pages)                       Supabase (región sa-east-1)
┌────────────────────────┐   HTTPS + JWT    ┌───────────────────────────────────┐
│ index.html             │ ───────────────▶ │ Auth  → contraseñas bcrypt, JWT   │
│ js/sge-supabase.js     │                  │ Postgres + RLS                    │
│  · sólo memoria        │ ◀─────────────── │  · instituciones / perfiles /     │
│  · nada en localStorage│  sólo filas que  │    registros / auditoria          │
└────────────────────────┘  el rol puede ver│ Edge Functions (clave de servicio)│
                                            │  · admin-usuarios                 │
                                            │  · login-legado                   │
                                            │  · importar-estado (una vez)      │
                                            └───────────────────────────────────┘
```

**Principio central:** el navegador no es de confianza. Todo control de acceso está en la base de datos (políticas RLS y *triggers*) o en las Edge Functions. Si alguien manipula el JavaScript, igual sólo puede leer y escribir lo que su rol permite.

## Controles (OWASP Top 10 – 2021)

| Riesgo OWASP | Antes | Ahora |
|---|---|---|
| **A01 Control de acceso roto** | El servidor de Apps Script entregaba el estado COMPLETO de todas las escuelas a cualquier usuario logueado; los permisos se chequeaban sólo en el navegador. | RLS por fila: cada rol recibe sólo lo suyo (ver matriz). Los *triggers* impiden que un docente se apruebe su propia licencia, cambie su cargo o CBU, o se asigne otro rol. Altas, roles y vínculos de cuentas sólo por `admin-usuarios`, que valida el alcance de quien llama. |
| **A02 Fallas criptográficas** | SHA-256 **sin sal** calculado en el navegador; el hash viajaba y se comparaba como si fuera la contraseña. Datos personales en texto plano en `localStorage`. | Supabase Auth (bcrypt con sal, del lado del servidor). Los hashes viejos se usan una sola vez y se borran. No se guardan datos en el navegador; al entrar se borran los restos del sistema anterior. |
| **A03 Inyección** | Saneamiento de `< > "` al escribir. | Se mantiene, y además se sanea todo lo que llega del servidor antes de mostrarlo. Consultas parametrizadas (PostgREST). Funciones SQL con `search_path = ''`. |
| **A04 Diseño inseguro** | Lógica de negocio sólo en el cliente. | Reglas críticas (estados de trámites, campos protegidos del legajo) en *triggers*. Reseteos masivos deshabilitados en la interfaz. |
| **A05 Configuración insegura** | Sin CSP. | CSP restrictiva (`object-src 'none'`, `base-uri 'none'`, `connect-src` limitado), `referrer` deshabilitado, CORS de las Edge Functions limitado al dominio del sistema. |
| **A06 Componentes vulnerables** | — | `supabase-js` alojado en el repo (sin CDN de terceros) con verificación SRI (`integrity`). Actualizar con el procedimiento de abajo. |
| **A07 Fallas de autenticación** | Sin límite de intentos; contraseñas de 4 caracteres; el DNI como contraseña inicial; contraseñas demo publicadas. | Freno de intentos (Supabase Auth + 5 intentos/15 min en el login legado). Mínimo 10 caracteres con letras y números; si la dirección elige una débil, se genera una temporal. Cambio obligatorio en el primer ingreso. Cierre por inactividad (30 min) y "cerrar sesión en todos mis dispositivos". |
| **A08 Integridad de datos** | El último que guardaba pisaba todo el estado. | Escritura por registro; el servidor fija `actualizado` y `actualizado_por`. |
| **A09 Registro y monitoreo** | Sin auditoría. | Tabla `auditoria` (quién, cuándo, qué registro y qué campos) llenada por *triggers*, inalterable desde el cliente; visible para la dirección de cada escuela y el administrador. |
| **A10 SSRF** | — | No aplica (las Edge Functions no hacen pedidos a URLs que manda el usuario). |

## Matriz de acceso

| Rol | Datos de su escuela | Legajo / designaciones / licencias | Datos de salud | Estudiantes | Cuentas |
|---|---|---|---|---|---|
| Administrador | Todas las escuelas | Todo | Todo | Todo | Todas |
| Director/a, secretario/a, cuenta institucional | Todo (lectura y escritura) | Todo | Todo | Todo | Las de su escuela (no admin); secretaría no toca dirección |
| Preceptor/a | Cursos, comunicados | Sólo lo propio | Sólo lo propio | Todos los de su escuela | Sólo la propia |
| Docente | Cursos, plazas, comunicados | Sólo lo propio; puede iniciar trámites, no aprobarlos | Sólo lo propio | Sólo sus cursos (notas y asistencia) | Sólo la propia |
| Familia | Comunicados | — | — | Sólo hijos/as vinculados | Sólo la propia |
| Estudiante | Comunicados | — | — | Sólo lo propio | Propia + familia vinculada |

Si la institución está suspendida, nadie de esa escuela ve nada (salvo el administrador).

## Pruebas

```bash
# Políticas RLS: 49 casos contra Postgres local (no toca Supabase)
PGHOST=... PGPORT=... PGUSER=postgres ./supabase/tests/correr.sh

# Capa cliente: 23 casos con un Supabase simulado
npm i jsdom@24 && node pruebas/cliente.test.js
```

Correlas antes de cada cambio en `supabase/migrations/` o `js/sge-supabase.js`.

## Operación

- **Claves:** la *publishable/anon key* en `js/sge-config.js` es pública por diseño. La *service_role key* **nunca** va al repositorio ni al navegador: sólo existe como variable de las Edge Functions.
- **Backups:** activá los backups diarios de Supabase (o *Point in Time Recovery*). Probá restaurar al menos una vez por año.
- **Actualizar supabase-js:** `npm pack @supabase/supabase-js@X`, copiar `dist/umd/supabase.js` a `vendor/supabase-X.js`, recalcular el SRI con `openssl dgst -sha384 -binary vendor/supabase-X.js | openssl base64 -A` y actualizar la etiqueta `<script>` de `index.html`.
- **Revisión periódica:** en Supabase → *Advisors → Security* no debe haber alertas. Revisar la auditoría y las cuentas inactivas cada trimestre.
- **Bajas de personal:** desactivar la cuenta el mismo día (deja de ver datos al instante, porque las políticas exigen `estado = 'activo'`).

## Incidentes de seguridad

1. Contener: desactivar las cuentas comprometidas; si hace falta, rotar las claves del proyecto (Settings → API).
2. Evaluar con la tabla `auditoria` qué datos y qué personas se vieron afectados.
3. Documentar y notificar siguiendo la Resolución AAIP 47/2018 (Anexo I, punto de incidentes), e informar a las personas afectadas.
4. Corregir la causa y agregar una prueba que la cubra.

## Límites conocidos

- La interfaz sigue usando `onclick` y estilos en línea, por eso la CSP necesita `'unsafe-inline'`. Reducirlo requiere refactorizar el `index.html`.
- La CSP se aplica con `<meta>` (GitHub Pages no permite cabeceras propias), así que no se puede usar `frame-ancestors`. Si se necesita, publicar detrás de un proxy que agregue cabeceras.
- Los cambios entre dispositivos llegan por sondeo (cada 20 s). Si dos personas editan el mismo registro al mismo tiempo, gana la última.
