# 📅 UPC Visor Horaris → Google Calendar Sync

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://developers.google.com/apps-script)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/es/docs/Web/JavaScript)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen.svg)]()
[![UPC](https://img.shields.io/badge/UPC-Universitat%20Politècnica%20de%20Catalunya-0072C6.svg)](https://www.upc.edu)

Sincronizador automático inteligente entre el **Visor d'Horaris de la UPC** (NestJS / Keycloak SSO) y **Google Calendar**. 

Ejecutado enteramente en la nube mediante **Google Apps Script** (gratuito y sin necesidad de servidores propios).

---

## ✨ Características Principales

* 🔐 **Autenticación SSO + 2FA (TOTP):** Compatible con el sistema Keycloak de la UPC. Genera el código 2FA internamente mediante RFC 6238.
* 🔄 **Gestión inteligente de sesión:** Almacena la cookie de refresco (`refresh_token`) para sincronizar periódicamente **sin volver a pedir el 2FA**.
* 🔍 **Detección inteligente de cambios (Diff):** Si una clase cambia de aula, profesor u hora:
  * No duplica el evento.
  * Marca el evento con el prefijo `C ` y añade un bloque detallando el historial de cambios (*antes → después*).
* 📝 **Bloque de notas/comentarios personales:** Cada evento incluye una sección protegida para añadir tus propios apuntes que **nunca se sobrescriben** aunque la UPC actualice la clase.
* 🚫 **Lista negra para clases canceladas/no impartidas:** Si una clase sigue apareciendo en el visor público pero no se realiza, puedes borrarla definitivamente sin que el script la vuelva a crear.
* 🛡️ **Protección de Exámenes y Deberes:** El sincronizador nunca eliminará eventos manuales que empiecen por `Examen`, `Deures`, `Entrega`, etc.
* 📆 **Ventana móvil de 6 meses:** Mantiene siempre actualizados los próximos 6 meses de curso académico.

---

## 🚀 Instalación y Configuración

### 1. Crear el proyecto en Google Apps Script
1. Entra en [Google Apps Script](https://script.google.com/).
2. Haz clic en **Nuevo proyecto**.
3. Pega el código del archivo `code.js` en el editor.
4. Dale un nombre al proyecto (ej. `UPC-Calendar-Sync`).

### 2. Configurar las Propiedades del Script
En Apps Script, ve a **Configuración del proyecto** (icono de engranaje ⚙️ a la izquierda) ➔ **Propiedades de la secuencia de comandos** y añade las siguientes claves:

| Propiedad | Obligatorio | Descripción | Ejemplo |
| :--- | :---: | :--- | :--- |
| `UPC_USER` | **Sí** | Tu usuario de la UPC (sin `@estudiantat.upc.edu` o completo según tu login) | `nombre.apellido` |
| `UPC_PASS` | **Sí** | Tu contraseña de acceso UPC | `TuPassword123` |
| `UPC_TOTP_SECRET` | **Sí** | Tu clave secreta 2FA en Base32 (sin espacios) | `JBSWY3DPEHPK3PXP` |
| `CALENDAR_ID` | *No* | ID del calendario de destino (por defecto: `primary`) | `primary` o `xxxx@group.calendar.google.com` |
| `API_EVENTS_URL` | *No* | Endpoint manual en caso de cambios en la API | *(Dejar vacío)* |

> 💡 **¿Cómo obtener tu `UPC_TOTP_SECRET`?**  
> Al activar el 2FA en la UPC, en la pantalla del código QR suele haber un botón tipo *"No puedo escanear el código"* que revela una clave alfanumérica de ~16-32 caracteres. También puedes extraerla de clientes como Aegis, Bitwarden o 1Password.

### 3. Primera ejecución y permisos
1. En el desplegable de funciones de Apps Script, selecciona la función **`setup`** y pulsa **Ejecutar**.
2. Concede los permisos que solicite Google Calendar.
3. Abre el **Registro de ejecución** (Ctrl + Intro) y comprueba que el login y el autotest TOTP devuelvan `OK`.
4. Ejecuta la función **`syncUPCtoGCal`** para realizar la primera sincronización completa.

### 4. Automatización diaria
Para que el calendario se sincronice solo todas las mañanas:
1. Selecciona en el desplegable la función **`createDailyTrigger`** y pulsa **Ejecutar**.
2. ¡Listo! El script se ejecutará automáticamente todos los días a las 08:00 AM.

---

## 📖 Guía de Uso del Calendario

### 📝 Añadir notas personales a una clase
En la descripción de cualquier evento creado por el script encontrarás:
```text
=== COMENTARIS / NOTES ===
Llevar la práctica impresa / Preguntar duda ejercicio 3
=== FI COMENTARIS ===
