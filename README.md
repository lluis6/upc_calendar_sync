# 📅 UPC Visor Horaris → Google Calendar Sync

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://developers.google.com/apps-script)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/es/docs/Web/JavaScript)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen.svg)]()
[![UPC](https://img.shields.io/badge/UPC-Universitat%20Politècnica%20de%20Catalunya-0072C6.svg)](https://www.upc.edu)

Sincronizador automático e inteligente entre el **Visor d'Horaris de la UPC** (NestJS / Keycloak SSO) y **Google Calendar**.

Se ejecuta de forma autónoma y gratuita en la nube mediante **Google Apps Script** — sin servidores, sin contenedores, sin dependencias externas.

---

## ✨ Características

| Característica | Descripción |
| :--- | :--- |
| 🔐 **SSO + 2FA (TOTP)** | Login completo contra Keycloak UPC. Genera códigos TOTP internamente (RFC 6238, JS puro). |
| 🔄 **Sesión persistente** | Guarda la cookie de refresco; las sincronizaciones diarias no piden TOTP de nuevo. |
| 🔍 **Diff inteligente** | Detecta cambios de aula, hora, profesor o día. Marca con `C ` y añade historial *antes → después*. |
| 📝 **Notas personales** | Bloque protegido en la descripción que **nunca se sobrescribe** aunque la UPC actualice la clase. |
| 🚫 **Lista negra** | Elimina clases definitivamente para que no vuelvan a aparecer aunque sigan en el visor UPC. |
| ❌ **Clases anuladas** | Marca clases como `[NO]` para que el script las respete sin intentar actualizarlas. |
| 🛡️ **Exámenes protegidos** | Nunca borra eventos que empiecen por `Examen`, `Deures`, `Entrega`, `Pràctica`, etc. |
| 📆 **Ventana de 6 meses** | Mantiene sincronizados los próximos 6 meses del curso académico. |

---

## 🚀 Instalación

### 1. Crear el proyecto

1. Ve a [Google Apps Script](https://script.google.com/).
2. Clic en **Nuevo proyecto**.
3. Pega el contenido de [`code.js`](./code.js) en el editor.
4. Ponle nombre (ej. `UPC-Calendar-Sync`).

### 2. Configurar las propiedades

En **Configuración del proyecto** (⚙️) → **Propiedades de la secuencia de comandos**, añade:

| Propiedad | Obligatoria | Descripción | Ejemplo |
| :--- | :---: | :--- | :--- |
| `UPC_USER` | **Sí** | Tu usuario UPC | `nombre.apellido` |
| `UPC_PASS` | **Sí** | Tu contraseña UPC | `MiPassword123` |
| `UPC_TOTP_SECRET` | **Sí** | Clave secreta 2FA en Base32 (sin espacios) | `JBSWY3DPEHPK3PXP` |
| `CALENDAR_ID` | No | Calendario destino (`primary` por defecto) | `primary` |
| `API_EVENTS_URL` | No | Endpoint manual si la API cambia | *(vacío)* |

> 💡 **¿Dónde está mi `UPC_TOTP_SECRET`?**
> Al activar el 2FA en la UPC, la pantalla del QR tiene un enlace tipo *"No puedo escanear"* que muestra la clave. También puedes exportarla desde Aegis, 2FAS, Bitwarden, 1Password, etc.

### 3. Primera ejecución

1. Selecciona la función **`setup`** → **Ejecutar**.
2. Concede los permisos de Google Calendar.
3. Revisa el **Registro de ejecución**: login y TOTP deben mostrar `OK`.
4. Ejecuta **`syncUPCtoGCal`** para la primera sincronización completa.

### 4. Automatización

Ejecuta **`createDailyTrigger`** una vez. El script se sincronizará solo cada día a las 08:00.

---

## 📖 Guía de uso del calendario

### 📝 1. Añadir notas personales

Cada evento creado por el script incluye un bloque reservado en la descripción:

```
=== COMENTARIS / NOTES ===

=== FI COMENTARIS ===
```

Escribe lo que quieras entre esas dos líneas:

```
=== COMENTARIS / NOTES ===
Llevar la práctica impresa
Preguntar duda del ejercicio 3
=== FI COMENTARIS ===
```

> ✅ El script **conservará tu texto intacto** en cada sincronización, aunque la UPC cambie el aula, la hora o el profesor de la clase.

---

### ✍️ 2. Cómo añadir deberes, entregas o tareas personales

Dispones de dos métodos infalibles para organizar tus tareas sin peligro de que el script las borre:

#### Método A: Crear eventos independientes (Recomendado 🌟)
Si tienes una entrega, deberes o quieres planificar una sesión de estudio:
* **Simplemente crea un evento normal manualmente en tu Google Calendar** (haciendo clic en el día y hora que quieras).
* *Por qué es seguro:* El script es inteligente y **solo** modifica o borra los eventos que él mismo ha creado (los cuales llevan una etiqueta oculta de sincronización). Tus eventos manuales son invisibles para el script y **nunca se tocarán**.

#### Método B: Escribirlos dentro de la clase correspondiente
* Abre el evento de la clase donde te han mandado la tarea.
* Escribe tus deberes dentro del bloque de notas personales (`=== COMENTARIS ===`).
* *Por qué es seguro:* El script protege este bloque en cada sincronización académica.

---

### ❌ 3. Clases que no se hacen (canceladas por el profesor)

Si una clase sigue apareciendo en el visor UPC pero el profesor la ha suspendido o no se imparte, tienes **dos opciones**:

#### Opción A — Mantenerla marcada como anulada

La clase sigue visible en tu calendario pero el script deja de tocarla:

**Cómo:** Edita el **título** del evento y pon uno de estos prefijos al principio:

| Prefijo | Ejemplo |
| :--- | :--- |
| `[NO]` | `[NO] Fonaments Matemàtics - (T) - G20` |
| `[ANUL·LADA]` | `[ANUL·LADA] Fonaments Matemàtics - (T) - G20` |
| `[CANCELADA]` | `[CANCELADA] Fonaments Matemàtics - (T) - G20` |

También puedes escribir `#CANCELADA` o `#IGNORAR` en **cualquier parte** de la descripción.

> **Resultado:** El script la deja tal cual. No actualiza título, hora ni aula.

---

#### Opción B — Eliminarla para siempre (Lista Negra)

La clase se borra del calendario y **nunca vuelve a aparecer**, aunque la UPC la siga enviando.

**Cómo (elige una):**

| Método | Dónde | Qué escribir |
| :--- | :--- | :--- |
| **Prefijo en el título** | Título del evento | `[BORRAR]` o `[ELIMINAR]` al inicio |
| **Hashtag en la descripción** | **Cualquier parte** de la descripción | `#BORRAR` o `#ELIMINAR` |

**Ejemplo rápido desde el móvil:**
1. Abre el evento en Google Calendar.
2. Edita el título y pon `[BORRAR]` delante del nombre.
3. Guarda.
4. En la siguiente sincronización (automática o manual), el evento desaparece para siempre.

> ⚠️ **No necesitas buscar ninguna sección especial.** Escribe `#BORRAR` arriba del todo, abajo, en medio del texto... donde te sea más cómodo. El script lee la descripción entera.

---

### 🛠️ Gestionar la lista negra desde Apps Script

| Función | Qué hace |
| :--- | :--- |
| `verClasesBorradas()` | Muestra en el registro todas las clases que tienes bloqueadas. |
| `restaurarClasesBorradas()` | Vacía la lista negra. En la siguiente sincronización se volverán a descargar todas las clases. |

---

### 🛡️ Eventos protegidos contra borrado automático

El script elimina del calendario las clases que la UPC quita del visor (clases oficialmente canceladas). Sin embargo, **nunca borrará** eventos cuyos títulos empiecen por:

- `Examen` / `Examens` / `Exàmens` / `Examenes`
- `Deures`
- `Entrega`
- `Pràctica` / `Practica`

Esto protege tanto los exámenes oficiales descargados automáticamente como cualquier evento que crees tú y empiece por estas palabras.

---

## ⚙️ Formato de los eventos

| Campo | Formato | Ejemplo |
| :--- | :--- | :--- |
| **Título** | `Assignatura - (Tipus) - Grup` | `Fonaments Matemàtics - (T) - G20` |
| **Ubicación** | `Campus - Aula` | `FIB - Aula A5 002` |
| **Descripción** | Código, nombres, grupo, tipo, semestre, aules, profesorado, idioma + bloque de notas | *(ver arriba)* |

---

## 📂 Estructura del proyecto

```
├── code.js        ← Código completo para Google Apps Script
├── README.md      ← Este archivo
└── LICENSE        ← Licencia MIT
```

---

## 🛠️ Solución de problemas

| Problema | Solución |
| :--- | :--- |
| `SESSION_EXPIRED` | Revisa `UPC_USER`, `UPC_PASS` y `UPC_TOTP_SECRET`. Ejecuta `setup()` para diagnosticar. |
| No descarga clases | Verifica que tu matrícula esté activa en [visorhoraris.upc.edu](https://visorhoraris.upc.edu). |
| Horas incorrectas | Comprueba que la zona horaria del proyecto (`appsscript.json`) sea `Europe/Madrid`. |
| Una clase borrada vuelve a aparecer | Asegúrate de haber usado `[BORRAR]` o `#BORRAR` (no `[NO]`, que solo la marca como anulada). Ejecuta `verClasesBorradas()` para confirmar que está en la lista negra. |

---

## 📄 Licencia

MIT. Consulta [`LICENSE`](./LICENSE).

---

*Aviso: Proyecto de código abierto desarrollado por estudiantes. Sin afiliación oficial con la Universitat Politècnica de Catalunya (UPC).*
