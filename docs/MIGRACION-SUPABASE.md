# Migración del SGE a Supabase — paso a paso

Tiempo estimado: 1 hora. Mientras `js/sge-config.js` no tenga URL y clave, el sistema sigue funcionando como antes (Google Sheets), así que se puede preparar todo sin cortar el servicio.

## 0. Antes de empezar

1. Entrá al SGE actual como administrador y descargá un **backup** (Configuración → Respaldo local (JSON) → **Descargar backup ahora**). Guardalo en un lugar seguro: tiene datos personales.
2. Avisá a los usuarios que la primera vez que entren después del cambio el sistema les va a pedir aceptar la política de privacidad y, a algunos, cambiar la contraseña.

## 1. Crear el proyecto

1. En <https://supabase.com/dashboard> → **New project**.
   - Nombre: `sge-secundaria` · Región: **South America (São Paulo)** · Contraseña de la base: una larga, guardala en un gestor de contraseñas.
   - Idealmente en una organización a nombre de la institución, no personal.
2. **Authentication → Sign In / Providers → Email**:
   - Desactivá **Allow new users to sign up** (las cuentas sólo las crea la dirección).
   - Desactivá **Confirm email** (los correos son ficticios, `usuario@sge.invalid`).
   - **Minimum password length: 10**. Requisitos: letras y dígitos.
   - Si el plan lo permite, activá **Leaked password protection**.
3. **Authentication → Sessions**: *Inactivity timeout* 12 h (el sistema además cierra a los 30 min sin uso).

## 2. Base de datos

En **SQL Editor**, ejecutá en orden el contenido de:

1. `supabase/migrations/20261120000001_esquema_seguro.sql`
2. `supabase/migrations/20261120000002_funciones_servidor.sql`
3. `supabase/migrations/20261120000003_licencias_que_afectan_plazas.sql`

(o con la CLI: `supabase link --project-ref <ref> && supabase db push`).

Después, en **Advisors → Security Advisor** no debería aparecer ninguna alerta crítica.

## 3. Edge Functions

Con la CLI (`npm i -g supabase`, luego `supabase login` y `supabase link --project-ref <ref>`):

```bash
supabase functions deploy admin-usuarios
supabase functions deploy login-legado    --no-verify-jwt
supabase functions deploy importar-estado --no-verify-jwt

# Orígenes permitidos (tu GitHub Pages)
supabase secrets set SGE_ORIGENES=https://cesar385.github.io
# Token de importación de un solo uso (generalo al azar)
supabase secrets set SGE_IMPORT_TOKEN=$(openssl rand -base64 33)
supabase secrets list   # anotá el token para el paso 5
```

Sin CLI: **Edge Functions → Deploy a new function → Via Editor**, pegá cada `index.ts`. En `login-legado` e `importar-estado` desactivá *Verify JWT*. Los secretos se cargan en **Edge Functions → Secrets**.

## 4. Conectar el sitio

En **Project Settings → API** copiá la *Project URL* y la *publishable key* (o *anon key*) y completá `js/sge-config.js`:

```js
supabaseUrl: 'https://XXXXXXXX.supabase.co',
supabaseKey: 'sb_publishable_...',
```

⚠️ Nunca pongas la *service_role/secret key* en el repositorio.

## 5. Importar los datos (una sola vez)

1. Publicá el sitio con los cambios (subí los archivos a GitHub).
2. Abrí `https://cesar385.github.io/sge-secundaria/migrar.html`.
3. Elegí el archivo de backup del paso 0 (o "usar los datos guardados en este navegador" si estás en la computadora donde trabajás siempre).
4. Pegá el token `SGE_IMPORT_TOKEN` y tocá **Importar**. Revisá el informe: instituciones, registros, cuentas y omitidos.
5. **Borrá el secreto**: `supabase secrets unset SGE_IMPORT_TOKEN` (o desde el panel). Sin el secreto, la función de importación queda inutilizable.

## 6. Primer ingreso de cada persona

- Entran con el **mismo usuario y contraseña** de siempre. La primera vez, el sistema verifica la contraseña vieja, la pasa a Supabase Auth con bcrypt y borra el hash viejo.
- Si la contraseña era de demostración o tenía menos de 10 caracteres, se les pide una nueva.
- Si la contraseña vieja no cumple el mínimo de Supabase Auth, la dirección le asigna una nueva desde Usuarios (el sistema genera una temporal segura si la elegida es débil).

## 7. Cierre del sistema anterior

1. Comprobá con dos o tres usuarios de distintos roles que ven lo que corresponde.
2. En la planilla de Google Sheets: **Extensiones → Apps Script → Implementar → Gestionar implementaciones → Archivar**. Quitá el acceso público a la planilla.
3. Guardá el backup del paso 0 cifrado (o borralo cuando ya no haga falta).
4. Completá el checklist de `docs/CUMPLIMIENTO.md`.

## Volver atrás

Si algo sale mal antes del paso 7, dejá `supabaseUrl` vacío en `js/sge-config.js` y publicá: el sistema vuelve a usar Google Sheets.
