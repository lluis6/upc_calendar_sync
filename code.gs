// ════════════════════════════════════════════════════════════
//  UPC Visor Horaris → Google Calendar Sync  ·  v2.4
//  Google Apps Script (V8) — SPA-safe
// ════════════════════════════════════════════════════════════

const SPA_URL      = "https://visorhoraris.upc.edu";
const API_BASE     = "https://visor-horaris-nest.upc.edu/";
const EVENT_PREFIX = "UPC | ";
const SYNC_MONTHS  = 6;
const TOTP_PERIOD  = 30;
const SESSION_PROP = "UPC_SESSION";
const BLACKLIST_PROP = "UPC_BLACKLIST";

const COMMENTS_HEADER = "=== COMENTARIS / NOTES ===";
const COMMENTS_FOOTER = "=== FI COMENTARIS ===";

function cfg() {
  const p = PropertiesService.getScriptProperties();
  return {
    user:         p.getProperty("UPC_USER"),
    pass:         p.getProperty("UPC_PASS"),
    totpSecret:   p.getProperty("UPC_TOTP_SECRET"),
    calendarId:   p.getProperty("CALENDAR_ID") || "primary",
    apiEventsUrl: (p.getProperty("API_EVENTS_URL") || "").trim(),
  };
}

// ════════════════════════════════════════════════════════════
//  ENTRADA PRINCIPAL
// ════════════════════════════════════════════════════════════
function syncUPCtoGCal() {
  const c = cfg();
  if (!c.user || !c.pass) throw new Error("Faltan UPC_USER / UPC_PASS en las Propiedades del script.");

  const s = getSession(c);

  for (let m = 0; m < SYNC_MONTHS; m++) {
    const range = getMonthRange(m);
    Logger.log("── " + range.label + "  (" + range.startStr + " → " + range.endStr + ") ──");
    let events = null;
    try {
      events = fetchEvents(s, c, range);
    } catch (e) {
      if (String(e.message).indexOf("SESSION_EXPIRED") === 0) throw e;
      Logger.log("(Aviso) " + String(e.message).split("\n")[0]);
      Logger.log("        Se continúa con el siguiente mes.");
      continue;
    }
    if (!events.length) Logger.log("Sin eventos para este rango.");
    syncEventsToCalendar(events, c.calendarId, range);
  }
  Logger.log("Sincronización completada.");
}

// ════════════════════════════════════════════════════════════
//  GESTIÓN DE LISTA NEGRA (CLASES ELIMINADAS MANUALMENTE)
// ════════════════════════════════════════════════════════════
function getBlacklist_() {
  const raw = PropertiesService.getScriptProperties().getProperty(BLACKLIST_PROP);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function saveBlacklist_(list) {
  PropertiesService.getScriptProperties().setProperty(BLACKLIST_PROP, JSON.stringify(list));
}

function addToBlacklist_(key) {
  if (!key) return;
  const list = getBlacklist_();
  if (list.indexOf(key) === -1) {
    list.push(key);
    saveBlacklist_(list);
    Logger.log("  [LISTA NEGRA] Añadida clase a la lista negra permanente: " + key);
  }
}

/** Ver qué clases están bloqueadas */
function verClasesBorradas() {
  const list = getBlacklist_();
  Logger.log("Clases actualmente en lista negra (" + list.length + "):");
  list.forEach(function(k) { Logger.log(" · " + k); });
}

/** Limpiar lista negra para restaurar todas las clases */
function restaurarClasesBorradas() {
  PropertiesService.getScriptProperties().deleteProperty(BLACKLIST_PROP);
  Logger.log("Lista negra vaciada con éxito. En la próxima sincronización se volverán a descargar.");
}

function isMarkedForPermanentDeletion_(ev) {
  const title = String(ev.getTitle() || "");
  const desc  = String(ev.getDescription() || "");
  
  // Ahora busca en todo el título o en CUALQUIER parte de la descripción sin importar la sección
  return /^(\[BORRAR\]|\[ELIMINAR\]|\[DELETE\])/i.test(title)
      || /#(BORRAR|ELIMINAR|DELETE|SUPRIMIR)/i.test(desc)
      || /#(BORRAR|ELIMINAR|DELETE|SUPRIMIR)/i.test(title);
}

// ════════════════════════════════════════════════════════════
//  SESIÓN Y LOGIN
// ════════════════════════════════════════════════════════════
function getSession(c) {
  const jar = newCookieJar();
  const stored = readStoredSession_();
  if (stored) {
    jar.set(stored.domain, stored.name, stored.value);
    try {
      const r = refreshToken_(jar);
      if (!r.uid && stored.uid) r.uid = stored.uid;
      if (!r.gauss && stored.gauss) r.gauss = stored.gauss;
      persistSession_(jar, r.uid, r.gauss);
      Logger.log("Sesión restaurada con la cookie de refresco (sin TOTP)"
        + (r.uid ? " · uid " + r.uid : "")
        + (r.gauss ? " · idGauss " + r.gauss : "") + ".");
      return { jar: jar, token: r.token, uid: r.uid, gauss: r.gauss };
    } catch (e) {
      Logger.log("La sesión guardada ya no sirve (" + e.message + "); login completo…");
      clearStoredSession_();
    }
  }

  if (!c.totpSecret) throw new Error("Falta UPC_TOTP_SECRET (necesario para el primer login).");
  return loginUPC(c, jar);
}

function refreshToken_(jar) {
  const resp = httpFetch(API_BASE + "auth/refresh", jar, { method: "post", payload: {} });
  if (resp.getResponseCode() >= 400) throw new Error("auth/refresh HTTP " + resp.getResponseCode());
  const body = safeJson_(resp.getContentText());
  const tok  = findToken_(body);
  if (!tok) throw new Error("auth/refresh no devolvió access token");
  const sub = body && (body.sub || body.idGauss || body.gauss);
  return { token: tok, uid: body && body.uid ? String(body.uid) : null, gauss: sub ? String(sub) : null };
}

function loginUPC(c, jar) {
  let url  = API_BASE + "auth/v2/sso/login";
  let resp = httpFetch(url, jar);
  let lastAction = "";

  for (let step = 0; step < 20; step++) {
    const code = resp.getResponseCode();

    if (code >= 300 && code < 400) {
      const loc = getLocation(resp);
      if (!loc) throw new Error("Redirect sin Location en " + abbrev_(url));
      const target = resolveUrl(url, loc);
      Logger.log("  → " + abbrev_(target));

      const mCode  = target.match(/[?&]code=([^&#]+)/);
      const mState = target.match(/[?&]state=([^&#]+)/);
      if (mCode && mState) {
        Logger.log("Authorization code recibido; canjeando en auth/v2/callback…");
        const ex = exchangeCode_(jar, mCode[1], mState[1]);
        persistSession_(jar, ex.uid, ex.gauss);
        Logger.log("Login completado (uid " + ex.uid + (ex.gauss ? ", idGauss " + ex.gauss : "") + ").");
        return { jar: jar, token: ex.token, uid: ex.uid, gauss: ex.gauss };
      }
      url  = target;
      resp = httpFetch(url, jar);
      lastAction = "";
      continue;
    }
    if (code !== 200) throw new Error("HTTP inesperado " + code + " en " + abbrev_(url));

    const html  = resp.getContentText() || "";
    const forms = extractForms(html, url);
    const loginForm = findForm(forms, /pass(word)?/i);
    const otpForm   = findForm(forms, /(otp|totp|passcode|2fa|mfa|verific)/i)
                   || findForm(forms, /(token|authenticator|\bcode\b)/i);

    if (loginForm) {
      if (lastAction === "creds") throw new Error("Keycloak vuelve a pedir credenciales: revisa UPC_USER / UPC_PASS.");
      const uf = firstKey(loginForm.fields, /user|login|email|name/i) || "username";
      const pf = firstKey(loginForm.fields, /pass/i)                  || "password";
      loginForm.fields[uf] = c.user;
      loginForm.fields[pf] = c.pass;
      const of = firstKey(loginForm.fields, /otp|totp|code|token/i);
      if (of) loginForm.fields[of] = freshTOTP(c.totpSecret);
      Logger.log("Enviando credenciales… (campos " + uf + " / " + pf + (of ? " / " + of : "") + ")");
      url  = loginForm.url;
      resp = httpFetch(url, jar, { method: "post", payload: loginForm.fields });
      lastAction = "creds";
      continue;
    }

    if (otpForm) {
      if (lastAction === "otp") throw new Error("TOTP rechazado: revisa UPC_TOTP_SECRET.");
      const visible = Object.keys(otpForm.fields).filter(function(n) {
        return ["text", "tel", "number", "password"].indexOf(otpForm.types[n] || "text") !== -1;
      });
      const of = firstKey(otpForm.fields, /otp|totp|passcode|code|token/i) || visible[0] || "otp";
      otpForm.fields[of] = freshTOTP(c.totpSecret);
      Logger.log("Enviando TOTP (campo '" + of + "')…");
      url  = otpForm.url;
      resp = httpFetch(url, jar, { method: "post", payload: otpForm.fields });
      lastAction = "otp";
      continue;
    }

    Logger.log("Página no reconocida (" + abbrev_(url) + "):\n" + html.substring(0, 300));
    throw new Error("Login: no se encuentra formulario de credenciales ni de TOTP.");
  }
  throw new Error("Login: demasiados pasos/redirecciones (20).");
}

function exchangeCode_(jar, authCode, state) {
  const url = API_BASE + "auth/v2/callback?code=" + encodeURIComponent(authCode) + "&state=" + encodeURIComponent(state);
  const resp = httpFetch(url, jar);
  if (resp.getResponseCode() >= 400) {
    throw new Error("auth/v2/callback HTTP " + resp.getResponseCode() + ": " + resp.getContentText().substring(0, 200));
  }
  const body = safeJson_(resp.getContentText());
  let tok  = findToken_(body);
  let uid  = body && body.uid ? String(body.uid) : null;
  const sub = body && (body.sub || body.idGauss || body.gauss);
  let gauss = sub ? String(sub) : null;
  if (!tok) {
    const r = refreshToken_(jar);
    tok = r.token;
    uid = uid || r.uid;
    gauss = gauss || r.gauss;
  }
  return { token: tok, uid: uid, gauss: gauss };
}

function readStoredSession_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SESSION_PROP);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function persistSession_(jar, uid, gauss) {
  const apiHost = hostOf_(API_BASE);
  const all = jar.entries().filter(function(x) { return apiHost === x.domain || apiHost.endsWith("." + x.domain); });
  if (!all.length) return;
  let best = null;
  all.forEach(function(x) { if (!best && /refresh/i.test(x.name)) best = x; });
  if (!best) best = all.reduce(function(a, b) { return b.value.length > a.value.length ? b : a; });

  PropertiesService.getScriptProperties().setProperty(
    SESSION_PROP,
    JSON.stringify({ domain: best.domain, name: best.name, value: best.value,
                     uid:   uid   ? String(uid)   : null,
                     gauss: gauss ? String(gauss) : null })
  );
}

function clearStoredSession_() {
  PropertiesService.getScriptProperties().deleteProperty(SESSION_PROP);
}

function apiGet_(s, pathOrUrl) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : API_BASE + pathOrUrl.replace(/^\//, "");
  const headers = { "Accept": "application/json" };
  if (s.token) headers["Authorization"] = "Bearer " + s.token;

  let resp = httpFetch(url, s.jar, { headers: headers });
  if (resp.getResponseCode() === 401) {
    try {
      const r = refreshToken_(s.jar);
      s.token = r.token;
      if (r.uid) s.uid = r.uid;
      if (r.gauss) s.gauss = r.gauss;
      persistSession_(s.jar, r.uid, r.gauss);
    } catch (e) {
      throw new Error("SESSION_EXPIRED: " + e.message);
    }
    headers["Authorization"] = "Bearer " + s.token;
    resp = httpFetch(url, s.jar, { headers: headers });
  }
  return resp;
}

// ════════════════════════════════════════════════════════════
//  OBTENCIÓN DE EVENTOS
// ════════════════════════════════════════════════════════════
function buildStudentScheduleUrls_(s, range) {
  const ids = [];
  if (s.gauss) ids.push(s.gauss);
  if (s.uid && s.uid !== s.gauss) ids.push(s.uid);
  if (!ids.length) return [];
  const startMs = range.start.getTime();
  const endMs   = range.end.getTime();
  return ids.map(function(id) {
    return "schedule/student-schedule/" + encodeURIComponent(id) + "/" + startMs + "/" + endMs;
  });
}

function fetchEvents(s, c, range) {
  const paths = [];
  if (c.apiEventsUrl) {
    paths.push(applyRangeToStudentUrl_(c.apiEventsUrl, range));
  } else if (s.token || s.uid) {
    const personal = buildStudentScheduleUrls_(s, range);
    personal.forEach(function(p) { paths.push(p); });
  }

  let hit = tryPaths_(s, paths);
  if (hit) return hit.events;

  throw new Error("No se ha podido obtener eventos. Revisa la sesión o API_EVENTS_URL.");
}

function tryPaths_(s, paths) {
  let emptyFallback = null;
  for (const path of paths) {
    try {
      const resp = apiGet_(s, path);
      const code = resp.getResponseCode();
      const text = (resp.getContentText() || "").trim();
      if (code !== 200 || (text.charAt(0) !== "[" && text.charAt(0) !== "{")) continue;
      const events = normalizeApiEvents(JSON.parse(text));
      if (events.length) return { path: path, events: events };
      if (!emptyFallback) emptyFallback = { path: path, events: events };
    } catch (e) {
      if (String(e.message).indexOf("SESSION_EXPIRED") === 0) throw e;
    }
  }
  return emptyFallback;
}

const SCHOOL_NAMES_ = { "270": "FIB" };

function mapStudentSchedule_(list, label) {
  const out = [];
  (list || []).forEach(function(ev) {
    if (!ev || typeof ev !== "object") return;
    const s = new Date(Number(ev.data_inici));
    const e = new Date(Number(ev.data_fi));
    if (isNaN(s) || isNaN(e)) return;

    const asig    = ev.assignatura || {};
    const aulas   = Array.isArray(ev.aules) ? ev.aules : [];
    const aulaIds = aulas.map(function(a) { return a.id_aula || ""; }).filter(Boolean);
    const primera = aulas.length ? aulas[0] : {};
    const school  = primera.campus_aula || SCHOOL_NAMES_[primera.escola] || (primera.escola ? "escola " + primera.escola : "");

    const nom  = titleCase_(asig.nom_cat || asig.nom_cast || asig.short_name || asig.id_assignatura || "Assignatura");
    const grup = ev.id_grup ? "G" + ev.id_grup : "";
    const tag  = label ? "(" + label + ")" : (ev.tipus_activitat ? "(" + ev.tipus_activitat + ")" : "");
    const title = nom + (tag ? " - " + tag : "") + (grup ? " - " + grup : "");

    const tipusLargo = ev.tipus_activitat === "T" ? "Teoria" : ev.tipus_activitat === "L" ? "Laboratori" : ev.tipus_activitat;
    const lines = [];
    if (asig.id_assignatura) lines.push("Codi Assignatura: " + asig.id_assignatura);
    const noms = [asig.nom_cat, asig.nom_eng].filter(Boolean);
    if (noms.length)         lines.push(noms.join(" / "));
    if (ev.id_grup)          lines.push("Grup: " + ev.id_grup);
    if (ev.tipus_activitat)  lines.push("Tipus activitat: " + ev.tipus_activitat + (tipusLargo !== ev.tipus_activitat ? " (" + tipusLargo + ")" : ""));
    if (ev.semestre)         lines.push("Semestre: " + ev.semestre);
    if (aulaIds.length) {
      lines.push("Aules: " + aulas.map(function(a) { return a.id_aula + (a.escola ? " (escola " + a.escola + ")" : ""); }).join(", "));
    }
    if (Array.isArray(ev.idioma) && ev.idioma.length) lines.push("Idioma: " + ev.idioma.join(", "));
    if (Array.isArray(ev.professor) && ev.professor.length) {
      lines.push("Professorat: " + ev.professor.map(function(p) { return (p && (p.nom || p.name)) || String(p); }).join(", "));
    }
    if (ev.observacions) lines.push("Observacions: " + ev.observacions);

    const location = (school ? school + " - " : "") + (aulaIds.length ? "Aula " + aulaIds.join(", ") : "");

    out.push({
      key:         fmtDate(s) + "|" + (asig.id_assignatura || "") + "|" + (ev.id_grup || "") + "|" + (label || ev.tipus_activitat || ""),
      title:       title,
      date:        fmtDate(s),
      startTime:   fmtTime(s),
      endTime:     fmtTime(e),
      location:    location,
      description: lines.join("\n"),
    });
  });
  return out;
}

function normalizeApiEvents(data) {
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.response)) {
    return mapStudentSchedule_(data.response, "").concat(mapStudentSchedule_(data.response_examens || [], "EXAMEN"));
  }
  return [];
}

// ════════════════════════════════════════════════════════════
//  GESTIÓN DE DESCRIPCIONES Y COMENTARIOS
// ════════════════════════════════════════════════════════════
function extractUserComments_(desc) {
  if (!desc) return "";
  const regex = /=== COMENTARIS(?:\s*\/.*?)? ===([\s\S]*?)=== FI COMENTARIS ===/i;
  const m = desc.match(regex);
  return m ? m[1].trim() : "";
}

function extractAcademicDesc_(desc) {
  if (!desc) return "";
  return desc
    .replace(/=== CAMBIADO[\s\S]*?=== FI CAMBIADO ===\n*/gi, "")
    .replace(/=== COMENTARIS[\s\S]*?=== FI COMENTARIS ===\n*/gi, "")
    .trim();
}

function buildDescription_(academicDesc, userComments, changedDiffs) {
  const parts = [];

  if (changedDiffs && changedDiffs.length) {
    parts.push("=== CAMBIADO (" + fmtDate(new Date()) + ") ===\n" +
               changedDiffs.join("\n") +
               "\n=== FI CAMBIADO ===");
  }

  parts.push(COMMENTS_HEADER + "\n" +
             (userComments ? userComments + "\n" : "") +
             COMMENTS_FOOTER);

  if (academicDesc) parts.push(academicDesc);

  return parts.join("\n\n");
}

function isProtectedEvent_(title) {
  const clean = String(title || "").replace(/^C\s+/, "").trim();
  return /^(Examen|Deures|Exàmens|Examens|Examenes|Entrega|Pràctica|Practica)/i.test(clean);
}

// ════════════════════════════════════════════════════════════
//  GOOGLE CALENDAR SYNC
// ════════════════════════════════════════════════════════════
function syncEventsToCalendar(events, calendarId, range) {
  const cal = calendarId === "primary" ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error("Calendario no encontrado: " + calendarId);

  const TAG = "upc_sync";
  const blacklist = getBlacklist_();

  const preexistentes = cal.getEvents(range.start, range.end).filter(function(ev) {
    return ev.getTag(TAG) === "true" || ev.getTitle().indexOf(EVENT_PREFIX) === 0;
  });

  // ── PASO PREVIO: Detectar eventos marcados para eliminar por el usuario ──
  const preexistentesValidos = [];
  preexistentes.forEach(function(ev) {
    const k = calEventKey_(ev);
    if (isMarkedForPermanentDeletion_(ev)) {
      addToBlacklist_(k);
      ev.deleteEvent();
      Logger.log("  - Eliminado y añadido a lista negra: " + ev.getTitle());
    } else {
      preexistentesValidos.push(ev);
    }
  });

  // ── Filtrar eventos de la API que estén en la lista negra ──
  const activeBlacklist = getBlacklist_();
  events = events.filter(function(nuevo) {
    const isBlocked = activeBlacklist.indexOf(nuevo.key) !== -1;
    if (isBlocked) {
      Logger.log("  * Ignorando clase bloqueada en lista negra: " + nuevo.title + " (" + nuevo.date + ")");
    }
    return !isBlocked;
  });

  const porClave = {};
  preexistentesValidos.forEach(function(ev) {
    const k = calEventKey_(ev);
    (porClave[k] = porClave[k] || []).push(ev);
  });

  let created = 0, unchanged = 0, updated = 0, moved = 0, removed = 0;
  const emparejados = {};
  const sinPar = [];

  // ── PASO 1 · Misma fecha y misma clave ──
  events.forEach(function(nuevo) {
    const bucket = porClave[nuevo.key] || [];
    let best = null, bestScore = Infinity;
    bucket.forEach(function(ce) {
      if (emparejados[ce.getId()]) return;
      const score = Math.abs(ce.getStartTime().getTime() - toDateTime(nuevo.date, nuevo.startTime).getTime());
      if (score < bestScore) { bestScore = score; best = ce; }
    });
    if (!best) { sinPar.push(nuevo); return; }

    emparejados[best.getId()] = true;
    const diffs = diffEvent_(best, nuevo);
    if (!diffs.length) {
      if (!best.getTag("upc_key")) best.setTag("upc_key", nuevo.key);
      unchanged++;
      return;
    }
    applyUpdate_(best, nuevo, diffs);
    updated++;
    Logger.log("  C cambiado: " + nuevo.title + " · " + nuevo.date);
  });

  // ── PASO 2 · Reubicaciones ──
  sinPar.forEach(function(nuevo) {
    const core = coreKey_(nuevo.key);
    let best = null, bestScore = Infinity;
    preexistentesValidos.forEach(function(ce) {
      if (emparejados[ce.getId()]) return;
      if (coreKey_(calEventKey_(ce)) !== core) return;
      const score = Math.abs(ce.getStartTime().getTime() - toDateTime(nuevo.date, nuevo.startTime).getTime());
      if (score < bestScore) { bestScore = score; best = ce; }
    });
    if (!best) return;
    emparejados[best.getId()] = true;
    nuevo._paired = true;
    applyUpdate_(best, nuevo, diffEvent_(best, nuevo));
    moved++;
    Logger.log("  C reubicado: " + nuevo.title + " · " + fmtDate(best.getStartTime()) + " → " + nuevo.date);
  });

  // ── PASO 3 · Nuevos eventos ──
  sinPar.forEach(function(nuevo) {
    if (nuevo._paired) return;
    const g = cal.createEvent(nuevo.title,
      toDateTime(nuevo.date, nuevo.startTime),
      toDateTime(nuevo.date, nuevo.endTime), {
        description: buildDescription_(nuevo.description || "", "", null),
        location:    nuevo.location || "",
      });
    g.setTag(TAG, "true");
    g.setTag("upc_key", nuevo.key);
    created++;
    Logger.log("  + nuevo: " + nuevo.title + " · " + nuevo.date);
  });

  // ── PASO 4 · Borrado de eventos desaparecidos de la UPC ──
  preexistentesValidos.forEach(function(ev) {
    if (!emparejados[ev.getId()]) {
      const title = ev.getTitle();
      if (isProtectedEvent_(title)) {
        Logger.log("  * Conservado (protegido): " + title + " · " + fmtDate(ev.getStartTime()));
        return;
      }
      Logger.log("  - eliminado: " + title + " · " + fmtDate(ev.getStartTime()));
      ev.deleteEvent();
      removed++;
    }
  });

  Logger.log(range.startStr + " → " + range.endStr + ": " + created + " nuevos, "
    + updated + " con cambios (C), " + moved + " reubicados (C), "
    + unchanged + " intactos, " + removed + " eliminados.");
}

function coreKey_(key) {
  return String(key).split("|").slice(1).join("|");
}

function calEventKey_(ev) {
  const tagged = ev.getTag("upc_key");
  if (tagged) return tagged;
  const desc  = ev.getDescription() || "";
  const title = (ev.getTitle() || "").replace(/^C /, "");
  const codi  = (desc.match(/Codi Assignatura:\s*(\S+)/i) || [])[1] || "";
  const grup  = (desc.match(/^Grup:\s*(\S+)/im) || title.match(/- G(\S+)\s*$/) || [])[1] || "";
  const tipus = (title.match(/- \(([^)]+)\)/) || [])[1] || "";
  return fmtDate(ev.getStartTime()) + "|" + codi + "|" + grup + "|" + tipus;
}

function diffEvent_(calEv, nuevo) {
  const diffs = [];
  const calTitle = (calEv.getTitle() || "").replace(/^C /, "");

  if (calTitle !== nuevo.title) {
    diffs.push("Títol: " + calTitle + " → " + nuevo.title);
  }

  const cs = calEv.getStartTime(), ce = calEv.getEndTime();
  if (fmtDate(cs) !== nuevo.date || fmtTime(cs) !== nuevo.startTime || fmtTime(ce) !== nuevo.endTime) {
    diffs.push("Horari: " + fmtDate(cs) + " " + fmtTime(cs) + "–" + fmtTime(ce)
      + " → " + nuevo.date + " " + nuevo.startTime + "–" + nuevo.endTime);
  }
  if ((calEv.getLocation() || "") !== (nuevo.location || "")) {
    diffs.push("Ubicació: " + (calEv.getLocation() || "—") + " → " + (nuevo.location || "—"));
  }

  const descCal = extractAcademicDesc_(calEv.getDescription() || "");
  const descNou = (nuevo.description || "").trim();
  if (descCal !== descNou) diffs.push("Descripció actualitzada");

  return diffs;
}

function applyUpdate_(calEv, nuevo, diffs) {
  const existingComments = extractUserComments_(calEv.getDescription() || "");

  calEv.setTime(toDateTime(nuevo.date, nuevo.startTime), toDateTime(nuevo.date, nuevo.endTime));
  calEv.setLocation(nuevo.location || "");
  calEv.setTitle("C " + nuevo.title);
  calEv.setDescription(buildDescription_(nuevo.description, existingComments, diffs));
  calEv.setTag("upc_key", nuevo.key);
}

// ════════════════════════════════════════════════════════════
//  HELPERS GENERALES
// ════════════════════════════════════════════════════════════
function getMonthRange(offsetMonths) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1, 0, 0, 0, 0);
  const endMs = new Date(now.getFullYear(), now.getMonth() + offsetMonths + 1, 1, 0, 0, 0, 0).getTime() - 1;
  const end = new Date(endMs);
  return { start: start, end: end, label: fmtDate(start).substring(0, 7), startStr: fmtDate(start), endStr: fmtDate(end) };
}

function applyRangeToStudentUrl_(url, range) {
  const m = String(url).match(/(\/student-schedule\/[^\/]+\/)\d+\/\d+/);
  if (!m) return url;
  return url.substring(0, m.index) + m[1] + range.start.getTime() + "/" + range.end.getTime();
}

function fmtDate(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd"); }
function fmtTime(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "HH:mm"); }
function toDateTime(dateStr, timeStr) {
  const d = String(dateStr).split("-").map(Number);
  const t = String(timeStr).split(":").map(Number);
  return new Date(d[0], d[1] - 1, d[2], t[0], t[1] || 0, 0);
}

function titleCase_(s) {
  const small = ["de", "la", "el", "i", "a", "als", "del", "dels", "les", "en", "amb", "per", "para", "los", "las", "y", "e", "un", "una"];
  return String(s).toLowerCase().split(/\s+/).filter(Boolean).map(function(w, i) {
    if (i > 0 && small.indexOf(w) !== -1) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

function httpFetch(url, jar, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const ck = jar.header(url);
  if (ck) headers["Cookie"] = ck;

  const resp = UrlFetchApp.fetch(url, {
    method:             opts.method || "get",
    payload:            opts.payload,
    headers:            headers,
    followRedirects:    false,
    muteHttpExceptions: true,
  });
  jar.store(url, setCookiesOf(resp));
  return resp;
}

function newCookieJar() {
  const jar = {};
  return {
    store: function(url, setCookies) {
      (setCookies || []).forEach(function(raw) {
        const parts = String(raw).split(";");
        const nv    = parts.shift().trim();
        const eq    = nv.indexOf("=");
        if (eq <= 0) return;
        let domain = hostOf_(url);
        parts.forEach(function(attr) {
          const dm = attr.trim().match(/^domain\s*=\s*\.?(.+)$/i);
          if (dm) domain = dm[1].toLowerCase();
        });
        (jar[domain] = jar[domain] || {})[nv.substring(0, eq).trim()] = nv.substring(eq + 1).trim();
      });
    },
    header: function(url) {
      const h = hostOf_(url), out = [];
      Object.keys(jar).forEach(function(dom) {
        if (h === dom || h.endsWith("." + dom)) {
          Object.keys(jar[dom]).forEach(function(n) { out.push(n + "=" + jar[dom][n]); });
        }
      });
      return out.join("; ");
    },
    set: function(domain, name, value) { (jar[domain] = jar[domain] || {})[name] = value; },
    entries: function() {
      const out = [];
      Object.keys(jar).forEach(function(dom) {
        Object.keys(jar[dom]).forEach(function(n) { out.push({ domain: dom, name: n, value: jar[dom][n] }); });
      });
      return out;
    },
  };
}

function setCookiesOf(resp) {
  const out = [];
  const all = resp.getAllHeaders();
  Object.keys(all).forEach(function(k) {
    if (k.toLowerCase() === "set-cookie") {
      const v = all[k];
      (Array.isArray(v) ? v : [v]).forEach(function(x) { out.push(x); });
    }
  });
  if (!out.length) {
    const h = resp.getHeaders()["Set-Cookie"] || resp.getHeaders()["set-cookie"];
    if (h) (Array.isArray(h) ? h : [h]).forEach(function(x) { out.push(x); });
  }
  return out;
}

function getLocation(resp) {
  const h = resp.getHeaders();
  return h["Location"] || h["location"] || null;
}

function hostOf_(u) {
  const m = String(u).match(/^https?:\/\/([^\/:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function extractForms(html, pageUrl) {
  const forms = [];
  const formRe = /<form\b[\s\S]*?<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html)) !== null) {
    const block  = fm[0];
    const tagM   = block.match(/<form\b[^>]*>/i);
    const action = tagM ? getAttr(tagM[0], "action") : null;
    const fields = {}, types = {};
    const inputRe = /<input\b[^>]*>/gi;
    let im;
    while ((im = inputRe.exec(block)) !== null) {
      const name = getAttr(im[0], "name");
      if (!name) continue;
      const type = (getAttr(im[0], "type") || "text").toLowerCase();
      if (["submit", "image", "button", "reset", "file"].indexOf(type) !== -1) continue;
      fields[name] = getAttr(im[0], "value") || "";
      types[name]  = type;
    }
    forms.push({
      url:    resolveUrl(pageUrl, action || pageUrl),
      method: ((tagM && getAttr(tagM[0], "method")) || "post").toLowerCase(),
      fields: fields,
      types:  types,
    });
  }
  return forms;
}

function getAttr(tag, name) {
  if (!tag) return null;
  const m = tag.match(new RegExp(name + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i"));
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

function findForm(forms, regex) {
  return forms.find(function(f) { return Object.keys(f.fields).some(function(n) { return regex.test(n); }); }) || null;
}

function firstKey(fields, regex) {
  return Object.keys(fields).find(function(n) { return regex.test(n); }) || null;
}

function resolveUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  const rootM = base.match(/^(https?:\/\/[^\/]+)/i);
  const root  = rootM ? rootM[1] : base;
  if (rel.charAt(0) === "/") return root + rel;
  return base.replace(/\/[^\/?]*(\?.*)?$/, "/") + rel;
}

function generateTOTP(base32Secret, digits) {
  const secret  = base32Decode(String(base32Secret).replace(/\s+/g, "").toUpperCase());
  const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  return totpForCounter(secret, counter, digits || 6);
}

function totpForCounter(secretBytes, counter, digits) {
  digits = digits || 6;
  const msg = [];
  let tmp = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = tmp & 0xff; tmp = Math.floor(tmp / 256); }
  const h   = hmacSha1(secretBytes, msg);
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % Math.pow(10, digits)).padStart(digits, "0");
}

function freshTOTP(base32Secret) {
  const remain = TOTP_PERIOD - (Math.floor(Date.now() / 1000) % TOTP_PERIOD);
  if (remain <= 4) Utilities.sleep((remain + 1) * 1000);
  return generateTOTP(base32Secret);
}

function base32Decode(input) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).replace(/=+$/, "");
  const bytes = [];
  let buffer = 0, bitsLeft = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = ALPHABET.indexOf(clean[i]);
    if (val === -1) continue;
    buffer = ((buffer << 5) | val) & 0xffffffff;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return bytes;
}

function hmacSha1(keyBytes, msgBytes) {
  const BLOCK = 64;
  let key = keyBytes.slice();
  if (key.length > BLOCK) key = sha1(key);
  while (key.length < BLOCK) key.push(0);
  const outer = [], inner = [];
  for (let i = 0; i < BLOCK; i++) {
    outer.push(key[i] ^ 0x5c);
    inner.push(key[i] ^ 0x36);
  }
  return sha1(outer.concat(sha1(inner.concat(msgBytes))));
}

function sha1(msgBytes) {
  const ml  = msgBytes.length;
  const msg = msgBytes.slice();
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const hi = Math.floor(ml * 8 / 0x100000000);
  const lo = (ml * 8) >>> 0;
  msg.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
           (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

  for (let i = 0; i < msg.length; i += 64) {
    const w = new Array(80);
    for (let t = 0; t < 16; t++) {
      w[t] = (msg[i + t * 4] << 24) | (msg[i + t * 4 + 1] << 16) | (msg[i + t * 4 + 2] << 8) | msg[i + t * 4 + 3];
    }
    for (let t = 16; t < 80; t++) {
      const v = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (v << 1) | (v >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20)      { f = (b & c) | (~b & d);           k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d;                    k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d);  k = 0x8f1bbcdc; }
      else             { f = b ^ c ^ d;                    k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d;  d = c;  c = ((b << 30) | (b >>> 2)) | 0;  b = a;  a = temp;
    }
    h0 = (h0 + a) | 0;  h1 = (h1 + b) | 0;  h2 = (h2 + c) | 0;  h3 = (h3 + d) | 0;  h4 = (h4 + e) | 0;
  }

  const out = [];
  [h0, h1, h2, h3, h4].forEach(function(h) {
    out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  });
  return out;
}

function safeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function findToken_(obj) {
  if (!obj || typeof obj !== "object") return null;
  const pref = ["jwtNestToken", "accessToken", "access_token", "token", "idToken", "id_token", "jwt"];
  for (const k of pref) {
    if (typeof obj[k] === "string" && obj[k].split(".").length >= 3) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === "string" && /token|jwt/i.test(k) && obj[k].length > 40) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const t = findToken_(obj[k]);
    if (t) return t;
  }
  return null;
}

function abbrev_(u) {
  const s = String(u);
  return s.length > 140 ? s.substring(0, 137) + "…" : s;
}
