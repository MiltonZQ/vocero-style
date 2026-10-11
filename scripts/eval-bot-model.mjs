#!/usr/bin/env node
/**
 * 019 — Compare LLMs on the barber-bot action contract.
 *
 * Standalone on purpose: it imports nothing from the app, so it runs with just
 * Node and an OpenRouter key. The system prompt below is a COPY of the shape
 * built by `buildAgentSystemPrompt` + `buildDraftStateBlock` in
 * `src/server/ai/prompts.ts` (agenda on): when you change the rules, actions or
 * the draft-state block there, mirror the change here or the pass rates lie.
 *
 * Usage:
 *   node --env-file=.env scripts/eval-bot-model.mjs [models...] [--runs N] [--concurrency N]
 *   pnpm eval:bot -- z-ai/glm-5.3-flash anthropic/claude-haiku-4.5 --runs 5
 *   node scripts/eval-bot-model.mjs --dry-run      # prints the cases, calls nothing
 *   node scripts/eval-bot-model.mjs --help
 *
 * Costs real money (OpenRouter). Reads OPENROUTER_API_TOKEN from the env.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_RUNS = 5;
const DEFAULT_CONCURRENCY = 6;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const HELP = `Evaluates models on the barber-bot action contract (12 cases x N runs).

Usage: node --env-file=.env scripts/eval-bot-model.mjs [models...] [options]

Arguments:
  models             OpenRouter model ids (default: ${DEFAULT_MODEL})

Options:
  --runs N           runs per case and model (default ${DEFAULT_RUNS})
  --concurrency N    parallel requests (default ${DEFAULT_CONCURRENCY})
  --dry-run          list models, cases and the prompt size; make no API call
  --show-prompt      print the system prompt and exit
  -h, --help         this help

Environment:
  OPENROUTER_API_TOKEN   required unless --dry-run / --show-prompt / --help

Output per model: pass rate per case, p50/p90 latency and total cost.
Exit code is 1 when any model finishes below 100% on any case.`;

/* ------------------------------ prompt ------------------------------ */

// Copy of the rules in src/server/ai/prompts.ts (agenda on). Keep in sync.
const PROFILE_NAME = "Style Bot";
const KB = [
  "P: ¿Dónde están?",
  "R: Av. Juárez 123, Col. Centro.",
  "P: ¿Qué horario tienen?",
  "R: Lunes a sábado de 10:00 a 20:00. Domingo cerrado.",
  "P: ¿Qué formas de pago aceptan?",
  "R: Efectivo, tarjeta y transferencia.",
  "P: ¿Hay estacionamiento?",
  "R: Sí, hay lugares en la calle.",
].join("\n");
const CATALOG = [
  "Catálogo de la agenda (usa estos nombres tal cual en update_draft):",
  "- Corte clásico — 30 min — $200 MXN",
  "  - Charly",
  "  - Luis",
  "  - Ana",
  "- Fade — 45 min — $250 MXN",
  "  - Charly",
  "  - Luis",
  "- Barba — 30 min — $150 MXN",
  "  - Luis",
  "  - Ana",
  "- Corte + barba — 60 min — $320 MXN",
  "  - Charly",
  "  - Luis",
  'Si el cliente dice que le da igual quién, manda staff "any". Si nombra a uno, usa su nombre. Si no dice nada de profesional, NO lo inventes.',
].join("\n");
const SHOP_HOURS =
  "lunes 10:00-20:00; martes 10:00-20:00; miércoles 10:00-20:00; jueves 10:00-20:00; viernes 10:00-20:00; sábado 10:00-20:00; domingo cerrado";
const STAGES = "Nuevo | Interesado | Cita agendada | Cliente";
const TODAY = "domingo 11 de octubre de 2026, 10:00";
const TIMEZONE = "America/Mexico_City";

const SYSTEM = [
  `Eres "${PROFILE_NAME}", el asistente de WhatsApp de este negocio. Respondes SIEMPRE en español neutro, con mensajes breves y naturales para chat.`,
  `CONOCIMIENTO DEL NEGOCIO (tu única fuente de verdad; si algo no está aquí, NO lo inventes — di que lo confirmarás con el equipo o escala):\n${KB}`,
  CATALOG,
  `HORARIO DEL LOCAL: ${SHOP_HOURS}`,
  `Etapas del pipeline disponibles: ${STAGES}`,
  [
    "En cada turno respondes ÚNICAMENTE un objeto JSON con UNA acción:",
    '- {"action":"none"} — no responder nada.',
    '- {"action":"reply","text":"..."} — responder al cliente.',
    '- {"action":"update_lead","note":"...","reply":"..."} — guardar una nota del lead (reply opcional).',
    '- {"action":"move_stage","stage":"<nombre exacto de etapa>","reply":"..."} — mover el lead (reply opcional).',
    '- {"action":"handoff","reason":"...","farewell":"..."} — escalar a un humano (farewell opcional para despedirte).',
    '- {"action":"update_draft","service":"...","staff":"...","when":{"day":"...","from":"HH:mm","to":"HH:mm"},"reply":"..."} — registrar lo que el cliente decidió. Llena TODOS los campos que diga en ese mensaje, a la vez. reply es opcional y MUY breve (sin horarios ni precios: los pone el sistema).',
    '- {"action":"book_slot","option":1} — el cliente eligió una de las opciones NUMERADAS que el sistema le ofreció (1, 2 o 3).',
    '- {"action":"my_bookings"} — el cliente pregunta por su cita ("¿a qué hora era mi cita?").',
    "Reglas duras:",
    "- Si el cliente pide hablar con una persona o un humano → handoff.",
    "- Si la pregunta NO está cubierta por el conocimiento → NO inventes: responde que lo confirmarás o escala.",
    "- Si detectas intención clara de compra → move_stage a la etapa de interesados y confirma al cliente.",
    "- Orden de la reserva: primero el servicio, luego el profesional (o cualquiera), luego el horario. El sistema pregunta lo que falte y ofrece los horarios; tú solo registras lo que el cliente dice.",
    "- NUNCA escribas horarios, fechas ni precios tú: el sistema los pega. NUNCA calcules fechas.",
    '- when.day es EXACTAMENTE "hoy", "mañana", "pasado mañana", el nombre del día ("lunes".."domingo") o YYYY-MM-DD SOLO si el cliente dijo una fecha explícita. from/to en HH:mm de 24 h.',
    '- Franjas: "en la mañana" = 10:00-13:00, "en la tarde" = 14:00-19:00, "en la noche" = 18:00-20:00; ajústalas al horario del local.',
    "- La disponibilidad NO la decides tú: si el cliente menciona un día u hora, pásalo SIEMPRE en when, aunque creas que el local está cerrado o lleno. El sistema verifica y ofrece lo más cercano. Tu reply jamás dice si hay o no lugar.",
    '- Si el cliente elige una opción por número o posición ("la segunda", "la 2"), usa book_slot con esa option. Solo hay opciones si el ESTADO DEL BORRADOR las lista.',
    "- Si ningún horario le sirve y pide otro día u hora → update_draft con el nuevo when.",
    '- Si quiere CANCELAR → handoff con reason "cancelacion". Si quiere CAMBIAR/REPROGRAMAR → handoff con reason "reprogramacion". Esas decisiones no son tuyas.',
    '- Si avisa que llegará tarde o viene sin cita → handoff con reason "llegada".',
    '- Si pide hablar con una persona, se queja o manda una foto/archivo que no puedes atender → handoff con reason "cliente".',
    "- Preguntas generales (dirección, pagos, horario, estacionamiento) o saludo: reply, SOLO con datos del conocimiento.",
    "- service y staff son NOMBRES del catálogo, nunca ids. Si pide un servicio que no está en el catálogo, usa update_draft con su texto literal en service (NO digas que lo confirmarás): el sistema le responde con lo más parecido.",
    "- JSON puro, sin markdown ni texto adicional.",
  ].join("\n"),
].join("\n\n");

/** Same shape as `buildDraftStateBlock`: goes LAST, after the conversation. */
function stateBlock({ step = "need_service", service = null, staff = null, when = null, options = [] } = {}) {
  return {
    role: "system",
    content: [
      `Hoy es ${TODAY}, zona ${TIMEZONE}.`,
      "ESTADO DEL BORRADOR (lo administra el sistema):",
      `- paso: ${step}`,
      `- servicio: ${service ?? "(sin elegir)"}`,
      `- profesional: ${staff ?? "(sin elegir)"}`,
      `- horario pedido: ${when ?? "(sin preferencia)"}`,
      options.length > 0
        ? `- opciones ofrecidas al cliente:\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}`
        : "- opciones ofrecidas al cliente: (ninguna)",
    ].join("\n"),
  };
}

/* ------------------------------- cases ------------------------------- */

const norm = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const inRange = (t, lo, hi) => typeof t === "string" && t >= lo && t <= hi;
const user = (content) => ({ role: "user", content });

const OFFERED = [
  "mañana lunes, 12 de octubre a las 14:00 con Charly",
  "mañana lunes, 12 de octubre a las 14:30 con Charly",
  "mañana lunes, 12 de octubre a las 15:00 con Charly",
];
const OFFERS_TURN = {
  role: "assistant",
  content: `Para Fade con Charly, esto tengo:\n${OFFERED.map((o, i) => `${i + 1}) ${o}`).join("\n")}\n\nResponde con el número de la opción que prefieras, o dime otro día u hora.`,
};

export const CASES = [
  {
    id: "01-saludo",
    msgs: [user("hola buenas"), stateBlock()],
    check: (o) => o.action === "reply",
  },
  {
    id: "02-todo-junto",
    msgs: [user("quiero un fade con Charly mañana a las 5"), stateBlock()],
    check: (o) =>
      o.action === "update_draft" &&
      norm(o.service) === "fade" &&
      norm(o.staff) === "charly" &&
      norm(o.when?.day) === "manana" &&
      o.when?.from?.startsWith("17"),
  },
  {
    id: "03-cualquiera-viernes-tarde",
    msgs: [user("me da igual quien, el viernes en la tarde"), stateBlock({ step: "need_staff", service: "Fade" })],
    check: (o) =>
      o.action === "update_draft" &&
      ["any", "cualquiera"].includes(norm(o.staff)) &&
      norm(o.when?.day) === "viernes" &&
      inRange(o.when?.from, "12:00", "15:00"),
  },
  {
    id: "04-servicio-no-existe",
    msgs: [user("tienen tinte de cabello?"), stateBlock()],
    check: (o) =>
      (o.action === "update_draft" && norm(o.service).includes("tinte")) ||
      (o.action === "reply" && /\bno\b/.test(norm(o.text))),
  },
  {
    id: "05-elige-opcion-2",
    msgs: [
      user("quiero un fade con charly mañana en la tarde"),
      OFFERS_TURN,
      user("la segunda porfa"),
      stateBlock({ step: "ready", service: "Fade", staff: "Charly", when: "mañana de 14:00 a 19:00", options: OFFERED }),
    ],
    check: (o) => o.action === "book_slot" && Number(o.option) === 2,
  },
  {
    id: "06-mi-cita",
    msgs: [user("a que hora era mi cita?"), stateBlock()],
    check: (o) => o.action === "my_bookings",
  },
  {
    id: "07-cancelar",
    msgs: [user("necesito cancelar mi cita del lunes"), stateBlock()],
    check: (o) => o.action === "handoff" && norm(o.reason) === "cancelacion",
  },
  {
    id: "08-reprogramar",
    msgs: [user("me puedes cambiar mi cita del lunes para el martes?"), stateBlock()],
    check: (o) => o.action === "handoff" && norm(o.reason) === "reprogramacion",
  },
  {
    id: "09-direccion-faq",
    msgs: [user("donde estan ubicados?"), stateBlock()],
    check: (o) => o.action === "reply" && norm(o.text).includes("juarez"),
  },
  {
    id: "10-humano",
    msgs: [user("quiero hablar con una persona"), stateBlock()],
    check: (o) => o.action === "handoff" && norm(o.reason) === "cliente",
  },
  {
    id: "11-llego-tarde",
    msgs: [user("voy 10 minutos tarde a mi cita"), stateBlock()],
    check: (o) => o.action === "handoff" && norm(o.reason) === "llegada",
  },
  {
    id: "12-jerga-hoy-noche",
    msgs: [user("q onda bro, un corte y barba pa hoy en la noche"), stateBlock()],
    check: (o) =>
      o.action === "update_draft" &&
      norm(o.service).includes("corte") &&
      norm(o.service).includes("barba") &&
      norm(o.when?.day) === "hoy" &&
      inRange(o.when?.from, "17:00", "19:00"),
  },
];

/* ------------------------------ plumbing ------------------------------ */

export function extractJson(raw) {
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(raw.trim());
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(raw.slice(a, b + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* next candidate */
    }
  }
  return null;
}

export function parseArgs(argv) {
  const opts = { models: [], runs: DEFAULT_RUNS, concurrency: DEFAULT_CONCURRENCY, dryRun: false, help: false, showPrompt: false };
  const positiveInt = (flag, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} necesita un entero >= 1 (recibí «${value}»)`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--show-prompt") opts.showPrompt = true;
    else if (arg === "--runs") opts.runs = positiveInt(arg, argv[++i]);
    else if (arg === "--concurrency") opts.concurrency = positiveInt(arg, argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`opción desconocida: ${arg}`);
    else opts.models.push(arg);
  }
  if (opts.models.length === 0) opts.models.push(DEFAULT_MODEL);
  return opts;
}

async function call(key, model, messages) {
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, usage: { include: true } }),
    });
    const ms = Date.now() - started;
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ms, err: `${res.status} ${JSON.stringify(body).slice(0, 200)}` };
    return { ms, raw: body?.choices?.[0]?.message?.content ?? "", cost: body?.usage?.cost ?? 0 };
  } catch (err) {
    return { ms: Date.now() - started, err: String(err).slice(0, 200) };
  }
}

const percentile = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.showPrompt) {
    console.log(SYSTEM);
    return 0;
  }
  if (opts.dryRun) {
    console.log(`dry-run: no se llama a ninguna API`);
    console.log(`modelos: ${opts.models.join(", ")}`);
    console.log(`corridas por caso: ${opts.runs} · concurrencia: ${opts.concurrency}`);
    console.log(`llamadas totales: ${opts.models.length * CASES.length * opts.runs}`);
    console.log(`prompt del sistema: ${SYSTEM.length} caracteres`);
    for (const c of CASES) console.log(`  ${c.id}  «${c.msgs.find((m) => m.role === "user" && m.content)?.content}»`);
    return 0;
  }

  const key = process.env.OPENROUTER_API_TOKEN;
  if (!key) {
    console.error("Falta OPENROUTER_API_TOKEN (usa: node --env-file=.env scripts/eval-bot-model.mjs).");
    return 2;
  }

  const results = [];
  const jobs = [];
  for (const model of opts.models) {
    for (const c of CASES) {
      for (let run = 0; run < opts.runs; run++) {
        jobs.push(async () => {
          const out = await call(key, model, [{ role: "system", content: SYSTEM }, ...c.msgs]);
          const parsed = out.raw ? extractJson(out.raw) : null;
          results.push({
            model,
            case: c.id,
            ms: out.ms,
            cost: out.cost ?? 0,
            err: out.err,
            parsed: Boolean(parsed),
            pass: Boolean(parsed) && Boolean(c.check(parsed)),
            out: parsed ?? out.raw?.slice(0, 200),
          });
        });
      }
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: opts.concurrency }, async () => {
      while (next < jobs.length) await jobs[next++]();
    })
  );

  let allGreen = true;
  for (const model of opts.models) {
    const rs = results.filter((r) => r.model === model);
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
    const passed = rs.filter((r) => r.pass).length;
    console.log(`\n== ${model}`);
    console.log(`pass ${passed}/${rs.length} · JSON extraíble ${rs.filter((r) => r.parsed).length} · errores ${rs.filter((r) => r.err).length}`);
    console.log(
      `latencia p50 ${percentile(ms, 0.5)}ms · p90 ${percentile(ms, 0.9)}ms · costo total $${rs.reduce((s, r) => s + r.cost, 0).toFixed(5)}`
    );
    for (const c of CASES) {
      const cr = rs.filter((r) => r.case === c.id);
      const ok = cr.filter((r) => r.pass).length;
      const fail = cr.find((r) => !r.pass);
      if (ok < cr.length) allGreen = false;
      const rate = cr.length === 0 ? 0 : Math.round((100 * ok) / cr.length);
      console.log(
        `  ${c.id.padEnd(28)} ${String(ok).padStart(2)}/${cr.length} ${String(rate).padStart(3)}%${fail ? `  ✗ ${JSON.stringify(fail.err ?? fail.out).slice(0, 200)}` : ""}`
      );
    }
  }
  return allGreen ? 0 : 1;
}

// Only run when executed directly (the helpers above are importable for tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(2);
    }
  );
}
