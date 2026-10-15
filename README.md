# Pagos por Aprobar

Aplicación web para revisar y aprobar pagos a proveedores: saldo en banco, lo que quedaría después de los pagos aprobados, facturas adjuntas y reporte de pagos realizados por fechas.

## Seguridad

- El repositorio es público, pero **todos los datos se guardan cifrados** (AES-256-GCM) en la carpeta `datos/`. Sin usuario y contraseña son archivos ilegibles.
- Cada usuario tiene su propia contraseña. La llave de cifrado se protege con esa contraseña (PBKDF2-SHA256, 600.000 iteraciones). **Usen contraseñas largas** (mínimo 10 caracteres; mejor una frase).
- Los mensajes de commit son siempre "Actualización" y los nombres de las facturas no se ven.
- El token de GitHub que usa la app para guardar cambios también se guarda cifrado.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La aplicación |
| `estilos.css` | Diseño |
| `app.js` | Lógica de la aplicación |
| `cripto.js` | Cifrado |
| `github.js` | Lectura y escritura en el repositorio |
| `lector.js` | Lectura automática de facturas (lector propio y, opcional, Claude) |
| `manifest.webmanifest`, `icono.svg` | Para instalarla como app en el celular |
| `datos/` | Se crea sola al activar la app. Todo cifrado. **No la edites a mano.** |

## Publicar en GitHub (una sola vez)

1. En github.com crea un repositorio nuevo, **público**, por ejemplo `pagos`.
2. En el repositorio: **Add file → Upload files** y arrastra todos los archivos de esta carpeta (todos van sueltos, sin subcarpetas). Luego **Commit changes**.
3. **Settings → Pages** → en *Branch* elige `main` y carpeta `/ (root)` → **Save**. En uno o dos minutos la app queda en `https://<tu-usuario>.github.io/pagos/`.

## Crear el token (una sola vez)

1. En GitHub: foto de perfil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. *Repository access*: **Only select repositories** → elige solo el repositorio de la app.
3. *Permissions → Repository permissions → Contents*: **Read and write**.
4. Elige la expiración (por ejemplo 1 año), genera el token y cópialo.

## Activar la aplicación (una sola vez)

1. Abre la dirección de GitHub Pages. Como es la primera vez, aparece **Activar la aplicación**.
2. Pega el token, escribe tu nombre, tu usuario y una contraseña segura → **Activar y entrar**.
3. Entra en **Usuarios** y crea un usuario para cada jefe (rol *Aprobador*). Entrégales su usuario y contraseña inicial; cada uno puede cambiarla con **Cambiar contraseña**.

## En el celular

Abrir la dirección en Safari (iPhone) o Chrome (Android) → **Agregar a pantalla de inicio**. Al entrar, marcar *Mantener la sesión en este dispositivo* para no escribir la contraseña cada vez.

## Notas

- Si el token vence, la administradora pega uno nuevo en **Usuarios → Token de GitHub**.
- **Quitar acceso** borra el usuario y su contraseña. Si alguien que salió pudo haber guardado datos descifrados, lo más seguro es activar la app en un repositorio nuevo.
- Los roles (administrador / aprobador) controlan lo que muestra la aplicación. Quien tenga una contraseña válida tiene acceso a los datos; den acceso solo a personas de confianza.
