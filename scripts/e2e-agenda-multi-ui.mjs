/**
 * 018 — SC-003, SC-004 y SC-007 en el navegador.
 *
 * La app ya tiene que estar viva (no arranca Next y no lee `.env`).
 *   APP_BASE_URL=http://localhost:3000 pnpm test:e2e:agenda-ui
 *
 * `pnpm test:e2e` no sirve: carga `.env`. El arnés de API es
 * `pnpm test:e2e:local`.
 *
 * Un sign-in por usuario. El límite es 10 intentos / 10 min por IP.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const OWNER_EMAIL = "e2e@vocero.test";
const OWNER_PASSWORD = "password-e2e-123";
const RECEPTION_EMAIL = "slice9-reception@vocero.test";
const RECEPTION_PASSWORD = "slice9-reception-123";
const STAFF_PASSWORD = "slice9-temporal-1";
const PN = "PN-E2E-1";

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dayIso(iso, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function hm(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return `${hour}:${minute}`;
}

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function authHeaders() {
  return { origin: BASE, "content-type": "application/json" };
}

async function main() {
  const stamp = Date.now().toString().slice(-8);
  const staffName = `Slice9 Luz ${stamp}`;
  const serviceName = `Slice9 Corte ${stamp}`;
  const staffEmail = `slice9-luz-${stamp}@vocero.test`;
  const leadName = `Slice9 Lead ${stamp}`;
  const clientName = `SC003 Cliente ${stamp}`;
  const shots = [];

  const browser = await chromium.launch();
  const ownerContext = await browser.newContext({
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
  });
  const api = ownerContext.request;
  let agentWasOn = false;

  const call = (path, init = {}) =>
    api.fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers ?? {}) },
    });

  try {
    let session = await call("/api/auth/sign-in/email", {
      method: "POST",
      data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    if (!session.ok()) {
      session = await call("/api/auth/sign-up/email", {
        method: "POST",
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Operador E2E" },
      });
    }
    if (!session.ok()) {
      throw new Error(
        `no entré como dueño (${session.status()}). La app tiene que estar viva en ${BASE}.`
      );
    }

    const staffRes = await call("/api/staff", {
      method: "POST",
      data: { displayName: staffName, jobTitle: "barbero", color: "#0d5bff" },
    });
    const staffBody = await jsonOf(staffRes);
    const staffId = staffBody?.staff?.id;
    if (staffRes.status() !== 201 || !staffId) {
      throw new Error(`alta de profesional ${staffRes.status()}`);
    }

    const serviceRes = await call("/api/services", {
      method: "POST",
      data: {
        name: serviceName,
        durationMinutes: 30,
        priceCents: 15000,
        currency: "MXN",
      },
    });
    const serviceBody = await jsonOf(serviceRes);
    const serviceId = serviceBody?.service?.id;
    if (serviceRes.status() !== 201 || !serviceId) {
      throw new Error(`alta de servicio ${serviceRes.status()}`);
    }

    const link = await call(`/api/staff/${staffId}/services/${serviceId}`, {
      method: "PUT",
      data: {},
    });
    if (!link.ok()) throw new Error(`vincular servicio ${link.status()}`);

    const account = await call(`/api/staff/${staffId}/account`, {
      method: "POST",
      data: { email: staffEmail, name: staffName, password: STAFF_PASSWORD },
    });
    const accountBody = await jsonOf(account);
    if (account.status() !== 201 || accountBody?.ok !== true) {
      throw new Error(`cuenta del profesional ${account.status()}`);
    }

    const reception = await call("/api/settings/team", {
      method: "POST",
      data: {
        name: "Recepcion Slice9",
        email: RECEPTION_EMAIL,
        password: RECEPTION_PASSWORD,
        role: "reception",
      },
    });
    if (reception.status() !== 201 && reception.status() !== 409) {
      throw new Error(`alta de recepción ${reception.status()}`);
    }

    const profile = await jsonOf(await call("/api/agent/profile"));
    agentWasOn = profile?.profile?.enabled === true;

    await run("SC-004", () => sc004(browser, staffEmail, shots));

    const receptionContext = await browser.newContext({
      locale: "es-MX",
      timezoneId: "America/Mexico_City",
      viewport: { width: 1440, height: 900 },
    });
    try {
      const signed = await receptionContext.request.fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: authHeaders(),
        data: { email: RECEPTION_EMAIL, password: RECEPTION_PASSWORD },
      });
      if (!signed.ok()) throw new Error(`login de recepción ${signed.status()}`);
      const page = await receptionContext.newPage();
      await run("SC-003", () =>
        sc003(page, staffId, staffName, serviceId, serviceName, clientName, stamp, shots)
      );
      await run("SC-007", () =>
        sc007({
          call,
          page,
          staffId,
          staffName,
          serviceId,
          serviceName,
          leadName,
          stamp,
        })
      );
    } finally {
      await receptionContext.close();
    }
  } catch (err) {
    const pending = ["SC-004", "SC-003", "SC-007"].filter(
      (name) => !results.some((row) => row.name === name)
    );
    const message = err instanceof Error ? err.message : String(err);
    for (const name of pending) record(name, false, message);
  } finally {
    if (!agentWasOn) {
      await call("/api/agent/profile", {
        method: "PUT",
        data: { enabled: false },
      }).catch(() => {});
    }
    await browser.close();
  }

  if (shots.length) {
    console.log(`pendiente de verificación humana: ${shots.join(" ")}`);
  } else {
    console.log("pendiente de verificación humana: sin capturas");
  }
  const failed = results.filter((row) => !row.ok).map((row) => row.name);
  console.log(
    failed.length
      ? `resumen: fallaron ${failed.join(", ")}`
      : "resumen: SC-003, SC-004 y SC-007 en verde"
  );
  if (failed.length) process.exit(1);
}

async function run(name, fn) {
  if (results.some((row) => row.name === name)) return;
  try {
    const detail = await fn();
    record(name, true, detail ?? "");
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

async function sc004(browser, email, shots) {
  const context = await browser.newContext({
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    // /login ya es la URL actual: no cuenta como destino.
    const landed = await page
      .waitForURL((url) => new URL(url).pathname !== "/login", { timeout: 20000 })
      .then(() => new URL(page.url()).pathname)
      .catch(async () => {
        const banner = page.locator("p.text-destructive");
        const text = (await banner.count()) ? await banner.first().innerText() : "sigue en /login";
        throw new Error(text);
      });
    if (landed === "/inbox" || landed === "/calendar") {
      throw new Error(`aterrizó en ${landed}`);
    }
    if (landed !== "/my-agenda") throw new Error(`aterrizó en ${landed}`);

    await page.goto(`${BASE}/my-profile`, { waitUntil: "load" });
    const foto = page.getByRole("heading", { name: "Foto", exact: true });
    await foto.waitFor({ timeout: 15000 });
    await page.screenshot({ path: "/tmp/slice9-perfil.png", animations: "disabled" });
    shots.push("/tmp/slice9-perfil.png");
    const section = page.locator("section").filter({ has: foto });
    await section.screenshot({ path: "/tmp/slice9-foto.png", animations: "disabled" });
    shots.push("/tmp/slice9-foto.png");
    return "login → /my-agenda";
  } finally {
    await context.close();
  }
}

async function sc003(page, staffId, staffName, serviceId, serviceName, clientName, stamp, shots) {
  const availRes = await page.request.get(
    `${BASE}/api/calendar/availability?staffId=${encodeURIComponent(staffId)}&serviceId=${encodeURIComponent(serviceId)}`
  );
  const avail = await jsonOf(availRes);
  const slot = (avail?.slots ?? []).find((row) => row?.dayIso && row?.time);
  if (!availRes.ok() || !slot) {
    throw new Error(`no hay hueco libre para recepción (${availRes.status()})`);
  }

  await page.goto(`${BASE}/calendar?from=${slot.dayIso}&days=1`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Día", exact: true }).waitFor({ timeout: 15000 });
  // El filtro también pinta el nombre, pero dentro de un <option> que Playwright
  // trata como oculto. La columna es el span visible.
  const column = page.locator("span.truncate").filter({
    hasText: new RegExp(`^${escapeRe(staffName)}$`),
  });
  await column.waitFor({ timeout: 15000 });
  await column.scrollIntoViewIfNeeded();
  const t0 = Date.now();

  const nameBox = await column.boundingBox();
  if (!nameBox) throw new Error("la columna no tiene caja");
  const hour = page
    .locator("span.font-mono", { hasText: new RegExp(`^${escapeRe(slot.time)}$`) })
    .first();
  await hour.waitFor({ timeout: 10000 });
  const hourBox = await hour.boundingBox();
  if (!hourBox) throw new Error(`no vi la hora ${slot.time} en la grilla`);
  await page.mouse.click(nameBox.x + nameBox.width / 2, hourBox.y + 8);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5000 });
  const title = await dialog.locator("h3").innerText();
  if (title !== "Nueva cita") throw new Error(`se abrió «${title}», no una cita nueva`);
  const when = (await dialog.locator("p").first().innerText()) ?? "";
  if (!when.includes(slot.time)) {
    throw new Error(`el diálogo muestra «${when}» y el hueco libre es ${slot.time}`);
  }

  await page.locator("#cal-staff").selectOption({ label: staffName });
  // <option> no es visible para Playwright. Esperar a que exista en el DOM.
  await page
    .locator("#cal-service option")
    .filter({ hasText: serviceName })
    .waitFor({ state: "attached", timeout: 10000 });
  await page.locator("#cal-service").selectOption({ label: serviceName });
  await page.getByLabel("Nombre del cliente nuevo").fill(clientName);
  await page.getByLabel("Teléfono con código de país").fill(`5219${stamp}`);
  const time = slot.time;
  const before = await page.getByRole("button", { name: new RegExp(`(?<!\\d)${escapeRe(time)}`) }).count();
  await dialog.getByRole("button", { name: "Agendar", exact: true }).click();

  const deadline = t0 + 30000;
  let seen = false;
  let reason = "";
  while (Date.now() < deadline) {
    const error = dialog.locator(".text-danger-text");
    if ((await dialog.count()) && (await error.count()) && (await error.first().isVisible())) {
      reason = await error.first().innerText();
      break;
    }
    const now = await page.getByRole("button", { name: new RegExp(`(?<!\\d)${time}`) }).count();
    if (now > before) {
      seen = true;
      break;
    }
    await sleep(200);
  }
  const elapsed = Date.now() - t0;
  await page.screenshot({ path: "/tmp/slice9-calendar.png", animations: "disabled" }).then(() => {
    shots.push("/tmp/slice9-calendar.png");
  }).catch(() => {});
  if (reason) throw new Error(`${reason} (${elapsed} ms)`);
  if (!seen || elapsed > 30000) {
    throw new Error(`la cita no se vio en el calendario (${elapsed} ms)`);
  }
  return `${elapsed} ms`;
}

async function sc007({ call, page, staffId, staffName, serviceId, serviceName, leadName, stamp }) {
  const settings = await jsonOf(await call("/api/calendar/settings"));
  const timeZone = settings?.settings?.timezone || "America/Mexico_City";
  const availability = await jsonOf(
    await call(
      `/api/calendar/availability?staffId=${encodeURIComponent(staffId)}&serviceId=${encodeURIComponent(serviceId)}`
    )
  );
  const slot = availability?.slots?.[0];
  if (!slot?.startUtc || !slot?.dayIso || !slot?.time) {
    throw new Error("no hay hueco para que el agente reserve");
  }

  const wa = await call("/api/settings/whatsapp", {
    method: "PUT",
    data: { wabaId: "WABA-E2E", phoneNumberId: PN, token: "tok-e2e" },
  });
  if (!wa.ok()) throw new Error(`conexión de prueba ${wa.status()}`);
  const enabled = await call("/api/agent/profile", {
    method: "PUT",
    data: { enabled: true },
  });
  if (!enabled.ok()) throw new Error(`no pude encender el agente (${enabled.status()})`);

  await page.goto(`${BASE}/calendar?from=${slot.dayIso}&days=1`, { waitUntil: "load" });
  await page
    .locator("span.truncate")
    .filter({ hasText: new RegExp(`^${escapeRe(staffName)}$`) })
    .waitFor({ timeout: 15000 });

  let n = 0;
  const decir = async (text) => {
    n += 1;
    const res = await call("/api/dev/wa-mock/inbound", {
      method: "POST",
      data: {
        phoneNumberId: PN,
        from: `521467${stamp}`,
        name: leadName,
        text,
        waMessageId: `wamid.slice9.${stamp}.${n}`,
      },
    });
    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`wa-mock respondió ${res.status()}: ${body.slice(0, 160)}`);
    }
  };

  await decir(`quiero agendar un ${serviceName} con ${staffName}`);
  const conv = await waitFor(async () => {
    const body = await jsonOf(await call("/api/conversations"));
    return (body?.conversations ?? []).find((row) => row.contact?.name === leadName) ?? null;
  }, 20000);
  if (!conv) throw new Error("el inbound no abrió conversación");

  const offer = await waitFor(async () => {
    const body = await jsonOf(await call(`/api/conversations/${conv.id}/messages`));
    const outs = (body?.messages ?? []).filter((row) => row.direction === "out");
    return outs.find((row) => /a las \d{2}:\d{2}/.test(row.text ?? "")) ?? null;
  }, 25000);
  if (!offer) throw new Error("el mock no ofreció horarios");

  const beforeIds = new Set(
    ((await jsonOf(await call("/api/bookings")))?.bookings ?? []).map((row) => row.id)
  );
  const beforeLabels = await page.getByRole("button").allInnerTexts();
  await decir("quiero el primero");
  const booking = await waitFor(async () => {
    const rows = (await jsonOf(await call("/api/bookings")))?.bookings ?? [];
    return (
      rows.find(
        (row) =>
          !beforeIds.has(row.id) &&
          row.contact?.name === leadName &&
          row.staff?.id === staffId
      ) ?? null
    );
  }, 25000);
  const startUtc = booking?.scheduledAtUtc ?? booking?.startUtc;
  if (!startUtc) {
    throw new Error("el turno del mock no reservó; no marco esto como pendiente");
  }

  const bookedDay = dayIso(startUtc, timeZone);
  if (bookedDay !== slot.dayIso) {
    throw new Error(
      `el mock reservó ${startUtc} (${bookedDay}) y el calendario está en ${slot.dayIso}`
    );
  }
  const time = Date.parse(startUtc) === Date.parse(slot.startUtc) ? slot.time : hm(startUtc, timeZone);
  const needle = new RegExp(`(?<!\\d)${escapeRe(time)}`);
  const before = beforeLabels.filter((label) => needle.test(label)).length;
  const t0 = Date.now();
  const appeared = await waitFor(async () => {
    const now = await page.getByRole("button", { name: needle }).count();
    return now > before ? true : null;
  }, 5000);
  const elapsed = Date.now() - t0;
  if (!appeared || elapsed > 5000) {
    throw new Error(`la cita del agente no se vio por SSE en ${elapsed} ms (hora ${time})`);
  }
  return `${elapsed} ms vía SSE`;
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
