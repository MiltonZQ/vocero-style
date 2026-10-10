/**
 * Self-test E2E de comportamiento — conduce la app real en localhost con los
 * mocks (wa-mock + ai-mock) por las superficies de usuario, en vez de darle
 * el guion al humano. Cubre tests/e2e/us-bsuid.md y tests/e2e/us-bot-api.md.
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock,
 *      BOT_API_KEY configurada y BD migrada
 *   2) node --env-file=.env scripts/e2e-selftest.mjs
 *
 * Sale con código 1 si algún check falla (apto para CI o para el gate previo
 * a declarar "Hecho").
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const BOT_KEY = process.env.BOT_API_KEY;

let cookie = "";
let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  OK  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/**
 * 018 — Una jar de cookies por usuario. Sin `jar`, `api()` se comporta EXACTO
 * como siempre (cookie global `cookie`), de modo que `main()` y
 * `agendaChecks()` no cambian. Con `jar`, la llamada no toca el estado global:
 * por eso es segura en paralelo (carreras, un usuario por jar).
 */
function newJar() {
  return { cookie: "" };
}

async function api(path, opts = {}) {
  const { jar, ...fetchOpts } = opts;
  const current = jar ? jar.cookie : cookie;
  const res = await fetch(`${BASE}${path}`, {
    ...fetchOpts,
    headers: {
      "content-type": "application/json",
      // Better Auth valida Origin (CSRF) en los endpoints de auth.
      origin: BASE,
      ...(current ? { cookie: current } : {}),
      ...(fetchOpts.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    const next = setCookie.map((c) => c.split(";")[0]).join("; ");
    if (jar) jar.cookie = next;
    else cookie = next;
  }
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

/** Versión paralelo-segura: exige jar, así que nunca toca la cookie global. */
function apiAsync(path, opts = {}) {
  if (!opts.jar) throw new Error("apiAsync() exige una jar de cookies");
  return api(path, opts);
}

async function login(jar, email, password) {
  return api("/api/auth/sign-in/email", {
    method: "POST",
    jar,
    body: JSON.stringify({ email, password }),
  });
}

function bot(path, opts = {}) {
  return api(path, {
    ...opts,
    headers: { "x-api-key": BOT_KEY ?? "", ...(opts.headers ?? {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que algo OCURRA, en vez de dormir un rato y confiar.
 *
 * Un `sleep` fijo convierte cualquier lentitud —la primera compilación de una
 * ruta en `next dev`, por ejemplo— en un fallo que no significa nada. Y si se
 * pone generoso, alarga el guion entero para todos.
 */
async function hasta(cond, ms = 15000, paso = 400) {
  const fin = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > fin) return false;
    await sleep(paso);
  }
}
const PN = "PN-E2E-1";

async function main() {
  if (!BOT_KEY || BOT_KEY.length < 16) {
    console.error(
      "BOT_API_KEY ausente o corta (<16): los checks de /api/bot/* no pueden correr."
    );
    process.exit(1);
  }

  console.log("== Setup: registro/login + conexión WhatsApp ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    // Re-corrida: el registro se cierra tras la primera organización.
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  const conn = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({
      wabaId: "WABA-E2E",
      phoneNumberId: PN,
      token: "tok-e2e",
    }),
  });
  ok(
    "conexión WhatsApp guardada (vía wa-mock)",
    conn.res.ok,
    JSON.stringify(conn.json)
  );
  await api("/api/dev/wa-mock/outbox", { method: "DELETE" });

  console.log("\n== us-bsuid: inbound sin wa_id ==");
  const inb1 = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: "bsu_e2e_1",
      name: "Dueña Dental",
      text: "hola, vi su anuncio",
      waMessageId: "wamid.e2e.bsuid.1",
    }),
  });
  ok("inbound BSUID entregado", inb1.res.ok, JSON.stringify(inb1.json));
  await sleep(1200);

  let convs = (await api("/api/conversations")).json?.conversations ?? [];
  const bsuidConv = convs.find((c) => c.contact.name === "Dueña Dental");
  ok("conversación con nombre de perfil (no el BSUID crudo)", !!bsuidConv);
  ok("contacto BSUID sin teléfono", bsuidConv?.contact.phone === null);

  const reply = await api(`/api/conversations/${bsuidConv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "¡Hola! Te atendemos enseguida" }),
  });
  ok("respuesta a contacto BSUID enviable", reply.res.ok, JSON.stringify(reply.json));

  const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  /**
   * Esta comprobación fijaba el comportamiento EQUIVOCADO: afirmaba que el
   * BSUID viaja en `to`. Y pasaba, porque el mock aceptaba cualquier cosa ahí
   * — mientras Meta respondía 131026 en producción. Un test verde sobre un
   * mock permisivo es peor que no tenerlo: convence de lo contrario.
   */
  ok(
    "el destinatario del envío es el BSUID, en `recipient`",
    outbox.some((o) => o.recipient === "bsu_e2e_1" && !o.to),
    JSON.stringify(outbox.map((o) => ({ to: o.to, recipient: o.recipient })))
  );

  // Idempotencia: re-entrega del mismo wa_message_id
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      fromUserId: "bsu_e2e_1",
      name: "Dueña Dental",
      text: "hola, vi su anuncio",
      waMessageId: "wamid.e2e.bsuid.1",
    }),
  });
  await sleep(800);
  const msgs =
    (await api(`/api/conversations/${bsuidConv?.id}/messages`)).json?.messages ??
    [];
  const inCount = msgs.filter((m) => m.direction === "in").length;
  ok("webhook duplicado no duplica mensajes", inCount === 1, `in=${inCount}`);

  console.log("\n== us-bsuid: a un contacto sin teléfono se le puede responder ==");
  {
    /**
     * El caso de produccion que dejo mudo al agente de un miembro.
     *
     * Meta omite el telefono cuando coinciden TRES condiciones: el usuario
     * activo su nombre de usuario, no hubo interaccion con ese numero de
     * empresa en 30 dias, y no esta en la agenda. Entonces solo llega el
     * BSUID — y hay que responderle por `recipient`, no por `to`: en `to`
     * Meta espera un telefono y devuelve 131026, que en la bandeja se lee
     * como si el numero del cliente no existiera.
     */
    const conv = bsuidConv;
    if (!conv) {
      ok("hay conversacion BSUID para responder", false, "no aparecio");
    } else {
      const envio = await api(`/api/conversations/${conv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "respuesta a un BSUID" }),
      });
      ok("se le PUEDE responder (antes: Meta 131026)", envio.res.ok,
        `status=${envio.res.status} ${JSON.stringify(envio.json)}`);

      const outbox = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
      const salida = outbox[outbox.length - 1];
      ok("y el BSUID viaja en `recipient`, nunca en `to`",
        salida?.recipient === "bsu_e2e_1" && !salida?.to,
        `to=${JSON.stringify(salida?.to)} recipient=${JSON.stringify(salida?.recipient)}`);
    }
  }

  console.log("\n== us-bsuid: reconciliación 521/52 ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: "5214621349768",
      name: "Kevin MX",
      text: "uno",
    }),
  });
  await sleep(800);
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: "524621349768", text: "dos" }),
  });
  await sleep(800);
  const contacts =
    (await api("/api/contacts?q=Kevin%20MX")).json?.contacts ?? [];
  ok(
    "521 y 52 resuelven a UN solo contacto",
    contacts.length === 1,
    `n=${contacts.length}`
  );

  const mxConv = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Kevin MX"
  );
  ok("el contacto reconciliado conserva su conversación", !!mxConv);

  // Issue #35: un destinatario argentino llega como `549` + 10 dígitos y hay
  // que ENVIARLE sin el 9. La identidad, en cambio, conserva lo que Meta
  // reporta: si se reescribiera, dejaría de casar con el `wa_id` de cada
  // webhook y el contacto se partiría en dos.
  console.log("\n== us-bsuid: destinatario argentino (549 → 54) ==");
  const AR_REPORTADO = "5491122334455";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: AR_REPORTADO,
      name: "Lead AR",
      text: "hola desde Argentina",
      waMessageId: "wamid.e2e.ar.1",
    }),
  });
  await sleep(1200);
  const convAr = ((await api("/api/conversations")).json?.conversations ?? []).find(
    (c) => c.contact.name === "Lead AR"
  );
  ok("la conversación argentina se creó", Boolean(convAr));
  ok(
    "la identidad guardada conserva el 9 que reporta Meta",
    convAr?.contact.phone === AR_REPORTADO,
    `phone=${convAr?.contact.phone}`
  );

  if (convAr) {
    // Se cuenta lo que ya había en vez de vaciar el outbox: el DELETE del
    // wa-mock reinicia su contador de wa_message_id, y en una RE-CORRIDA eso
    // choca con los mensajes que ya están en la base (unique) y tumba el envío
    // con un 500 que no tiene nada que ver con lo que se está probando.
    const outboxAntes =
      ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
    const envioAr = await api(`/api/conversations/${convAr.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "respuesta a Argentina" }),
    });
    ok("el mensaje a Argentina se envía", envioAr.res.ok, `status=${envioAr.res.status}`);
    const outboxAr = (
      (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []
    ).slice(outboxAntes);
    ok(
      "por el cable viaja SIN el 9 (lo que la lista de permitidos acepta)",
      outboxAr.some((o) => o.to === "541122334455"),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
    ok(
      "…y nunca con el 9, que es lo que devolvía 131030",
      !outboxAr.some((o) => o.to === AR_REPORTADO),
      JSON.stringify(outboxAr.map((o) => o.to))
    );
  }

  console.log("\n== #51: el nombre del contacto sigue al perfil, salvo si lo escribió alguien ==");
  {
    const N = Date.now().toString().slice(-6);
    const TEL = `5214627${N}`;
    const decir = (nombre, i) =>
      api("/api/dev/wa-mock/inbound", {
        method: "POST",
        body: JSON.stringify({
          phoneNumberId: PN,
          from: TEL,
          name: nombre,
          text: `hola ${i}`,
          waMessageId: `wamid.e2e.51.${N}.${i}`,
        }),
      });
    const contactoDe = async () => {
      const cs = (await api("/api/contacts")).json?.contacts ?? [];
      return cs.find((c) => c.phone === `524627${N}`) ?? null;
    };

    await decir("Federico", 1);
    await hasta(async () => Boolean(await contactoDe()));
    const creado = await contactoDe();
    ok("el contacto nace con el nombre del perfil", creado?.name === "Federico",
      `nombre: ${creado?.name}`);

    // El caso reportado: cambia su nombre de WhatsApp y vuelve a escribir.
    await decir("Federicoso", 2);
    await hasta(async () => (await contactoDe())?.name === "Federicoso");
    ok("cambiar el nombre de WhatsApp actualiza el contacto",
      (await contactoDe())?.name === "Federicoso",
      `nombre: ${(await contactoDe())?.name}`);

    // Y lo que NO puede pasar: que el perfil pise lo que escribió una persona.
    const editado = await api(`/api/contacts/${creado?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Fede - obra Polanco" }),
    });
    ok("el operador puede renombrar a mano", editado.res.ok, editado.texto);

    await decir("Federicoso", 3);
    await sleep(1500);
    ok("y WhatsApp ya no pisa ese nombre",
      (await contactoDe())?.name === "Fede - obra Polanco",
      `nombre: ${(await contactoDe())?.name}`);
  }

  console.log("\n== us-bot-api: autorización ==");
  const noKey = await api("/api/bot/media/media123");
  ok("media sin API key → 401", noKey.res.status === 401);
  const badKey = await api("/api/bot/media/media123", {
    headers: { "x-api-key": "x".repeat(BOT_KEY.length) },
  });
  ok("media con API key equivocada → 401", badKey.res.status === 401);
  const resetNoKey = await api("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: mxConv?.id }),
  });
  ok("reset sin API key → 401", resetNoKey.res.status === 401);

  console.log("\n== us-bot-api: typing + leído ==");
  const convId = mxConv?.id;
  const outboxBeforeTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const typ = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/typing → ok:true (leído + escribiendo…)",
    typ.res.ok && typ.json?.ok === true,
    JSON.stringify(typ.json)
  );
  const outboxAfterTyping =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "typing NO contamina el outbox",
    outboxAfterTyping === outboxBeforeTyping,
    `antes=${outboxBeforeTyping} después=${outboxAfterTyping}`
  );

  const typ404 = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe" }),
  });
  ok("typing con conversación inexistente → 404", typ404.res.status === 404);

  console.log("\n== us-bot-api: media proxy ==");
  const med = await bot("/api/bot/media/media123");
  const medBytes = med.res.ok ? await med.res.arrayBuffer() : new ArrayBuffer(0);
  ok(
    "GET /api/bot/media/{id} → binario con content-type",
    med.res.ok &&
      medBytes.byteLength > 0 &&
      (med.res.headers.get("content-type") ?? "").includes("image"),
    `status=${med.res.status} bytes=${medBytes.byteLength}`
  );
  const medBad = await bot("/api/bot/media/no-es-media");
  ok(
    "mediaId que Graph no reconoce → error tipado, no 500",
    medBad.res.status === 404 || medBad.res.status === 502,
    `status=${medBad.res.status}`
  );

  console.log("\n== us-bot-api: perfil del agente + knowledge base ==");
  const profNoKey = await api("/api/bot/profile");
  ok("perfil sin API key → 401", profNoKey.res.status === 401);

  const putProf = await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({
      name: "Sofi",
      tone: "cálido y directo",
      instructions: "Vendemos limpiezas dentales.",
      escalationRules: "Urgencias de dolor → humano.",
      greeting: "¡Hola! Soy Sofi",
      enabled: false,
    }),
  });
  ok("perfil guardado desde la pantalla Agente", putProf.res.ok);
  const kbQa = await api("/api/kb", {
    method: "POST",
    body: JSON.stringify({
      kind: "qa",
      question: "¿Cuánto cuesta?",
      answer: "$800.",
    }),
  });
  ok("entrada de KB creada desde la pantalla", kbQa.res.ok, JSON.stringify(kbQa.json));

  const prof = await bot("/api/bot/profile");
  ok(
    "GET /api/bot/profile → 200 con el perfil de la pantalla",
    prof.res.ok && prof.json?.profile?.name === "Sofi",
    JSON.stringify(prof.json?.profile)
  );
  ok(
    "el knowledge base viaja renderizado (P:/R:)",
    typeof prof.json?.kb === "string" && prof.json.kb.includes("P: ¿Cuánto cuesta?"),
    JSON.stringify(prof.json?.kb)
  );
  ok(
    "`enabled` NO viaja: gobierna la IA in-process, no al bot externo",
    prof.json?.profile && !("enabled" in prof.json.profile)
  );
  ok("`resources` presente y vacío", Array.isArray(prof.json?.resources));

  await api("/api/agent/profile", {
    method: "PUT",
    body: JSON.stringify({ tone: "seco y breve" }),
  });
  const profAgain = await bot("/api/bot/profile");
  ok(
    "editar el tono se refleja al instante (sin caché)",
    profAgain.json?.profile?.tone === "seco y breve",
    JSON.stringify(profAgain.json?.profile?.tone)
  );

  console.log("\n== us-bot-api: contexto conversacional ==");
  const ctxNoKey = await api(`/api/bot/context?conversationId=${convId}`);
  ok("contexto sin API key → 401", ctxNoKey.res.status === 401);

  const ctx = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "GET /api/bot/context por conversationId → 200",
    ctx.res.ok && ctx.json?.conversation?.id === convId,
    JSON.stringify(ctx.json?.conversation)
  );
  ok(
    "trae la identidad estable del contacto (no solo el teléfono)",
    typeof ctx.json?.contact?.waIdentity === "string" &&
      ctx.json.contact.waIdentity.length > 0
  );
  ok(
    "trae la etapa del lead en el pipeline",
    typeof ctx.json?.lead?.stageName === "string",
    JSON.stringify(ctx.json?.lead)
  );
  ok(
    "la ventana de 24 h viaja abierta tras un entrante reciente",
    ctx.json?.conversation?.windowOpen === true &&
      ctx.json?.conversation?.windowRemainingMs > 0,
    JSON.stringify(ctx.json?.conversation)
  );

  const ctxByIdentity = await bot(
    `/api/bot/context?waIdentity=${encodeURIComponent(ctx.json.contact.waIdentity)}`
  );
  ok(
    "resolver por waIdentity da la MISMA conversación",
    ctxByIdentity.json?.conversation?.id === convId,
    JSON.stringify(ctxByIdentity.json?.conversation?.id)
  );

  const ctxSinArgs = await bot("/api/bot/context");
  ok("contexto sin waIdentity ni conversationId → 422", ctxSinArgs.res.status === 422);
  const ctx404 = await bot("/api/bot/context?conversationId=cv_no_existe");
  ok("contexto de una conversación inexistente → 404", ctx404.res.status === 404);

  console.log("\n== us-bot-api: ficha de calificación ==");
  const fichaNoKey = await api("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId, ficha: { rubro: "x" } }),
  });
  ok("ficha sin API key → 401", fichaNoKey.res.status === 401);

  const f1 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { rubro: "dentista", geo: "Querétaro", calificado: true },
    }),
  });
  ok(
    "PUT /api/bot/ficha → 200 con la ficha completa",
    f1.res.ok && f1.json?.ficha?.rubro === "dentista",
    JSON.stringify(f1.json)
  );
  ok(
    "las claves las pone el negocio: el CRM guarda lo que le manden",
    f1.json?.ficha?.geo === "Querétaro" && f1.json?.ficha?.calificado === true,
    JSON.stringify(f1.json?.ficha)
  );

  const ctxConFicha = await bot(`/api/bot/context?conversationId=${convId}`);
  ok(
    "la ficha viaja en el contexto del siguiente turno",
    ctxConFicha.json?.contact?.ficha?.rubro === "dentista",
    JSON.stringify(ctxConFicha.json?.contact?.ficha)
  );

  const f2 = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { presupuesto: "20 mil", geo: null },
    }),
  });
  ok(
    "merge campo a campo: lo ausente se conserva",
    f2.json?.ficha?.rubro === "dentista" && f2.json?.ficha?.presupuesto === "20 mil",
    JSON.stringify(f2.json?.ficha)
  );
  ok(
    "null explícito borra la clave",
    f2.json?.ficha && !("geo" in f2.json.ficha),
    JSON.stringify(f2.json?.ficha)
  );

  const fBasura = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({
      conversationId: convId,
      ficha: { anidado: { a: 1 }, vacío: "", bueno: "  sí  " },
    }),
  });
  ok(
    "lo que no se entiende se ignora sin 422 (no se le tiran datos al bot)",
    fBasura.res.ok &&
      fBasura.json?.ficha?.bueno === "sí" &&
      !("anidado" in fBasura.json.ficha) &&
      !("vacío" in fBasura.json.ficha),
    JSON.stringify(fBasura.json?.ficha)
  );

  const fNoConv = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: "cv_no_existe", ficha: { a: "b" } }),
  });
  ok("ficha de conversación inexistente → 404", fNoConv.res.status === 404);
  const fSinFicha = await bot("/api/bot/ficha", {
    method: "PUT",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok("cuerpo sin `ficha` → 422", fSinFicha.res.status === 422);

  console.log("\n== us-bot-api: el bot envía a través del CRM ==");
  const sendNoKey = await api("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "hola" }),
  });
  ok("envío sin API key → 401", sendNoKey.res.status === 401);

  const outboxBeforeBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const botSend = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "Hola, soy el bot." }),
  });
  ok(
    "POST /api/bot/messages → 200 con messageId",
    botSend.res.ok && typeof botSend.json?.messageId === "string",
    JSON.stringify(botSend.json)
  );
  const outboxAfterBot =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "el mensaje salió de verdad por el canal de WhatsApp",
    outboxAfterBot === outboxBeforeBot + 1,
    `antes=${outboxBeforeBot} después=${outboxAfterBot}`
  );
  const botMsg = ((await api(`/api/conversations/${convId}/messages`)).json
    ?.messages ?? []).find((m) => m.id === botSend.json?.messageId);
  ok(
    "queda en la bandeja marcado como IA (aiGenerated + origin=ai)",
    botMsg?.aiGenerated === true && botMsg?.origin === "ai",
    JSON.stringify({ aiGenerated: botMsg?.aiGenerated, origin: botMsg?.origin })
  );
  const sendNoConv = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", text: "hola" }),
  });
  ok("envío a conversación inexistente → 404", sendNoConv.res.status === 404);
  const sendVacio = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "" }),
  });
  ok("texto vacío → 422 (no se manda un mensaje en blanco)", sendVacio.res.status === 422);

  console.log("\n== us-bot-api: el bot pide un humano ==");
  const hoNoKey = await api("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  ok("handoff sin API key → 401", hoNoKey.res.status === 401);

  const ho = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "hostilidad" }),
  });
  ok("POST /api/bot/handoff → 200", ho.res.ok && ho.json?.ok === true);
  await sleep(300);
  let convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "la conversación queda pausada y con su motivo",
    convTrasHandoff?.aiEnabled === false &&
      !!convTrasHandoff?.handoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      aiEnabled: convTrasHandoff?.aiEnabled,
      reason: convTrasHandoff?.handoffReason,
    })
  );
  const primerHandoffAt = convTrasHandoff?.handoffAt;

  const hoRepe = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "cliente" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "repetir el handoff es idempotente: no pisa la hora ni el motivo original",
    hoRepe.res.ok &&
      convTrasHandoff?.handoffAt === primerHandoffAt &&
      convTrasHandoff?.handoffReason === "hostilidad",
    JSON.stringify({
      antes: primerHandoffAt,
      ahora: convTrasHandoff?.handoffAt,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  const hoNoConv = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: "cv_no_existe", reason: "cliente" }),
  });
  ok("handoff de conversación inexistente → 404", hoNoConv.res.status === 404);

  // El handoff jamás debe perderse por un motivo que no esté en el catálogo:
  // el bot se quedaría hablándole a alguien que pidió un humano.
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoRaro = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, reason: "porque sí" }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "un motivo fuera del catálogo NO tira el handoff (cae a 'modelo')",
    hoRaro.res.ok &&
      convTrasHandoff?.aiEnabled === false &&
      convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify({
      status: hoRaro.res.status,
      reason: convTrasHandoff?.handoffReason,
    })
  );

  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  const hoSinReason = await bot("/api/bot/handoff", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);
  convTrasHandoff = ((await api("/api/conversations")).json?.conversations ?? [])
    .find((c) => c.id === convId);
  ok(
    "sin motivo también pausa (cae a 'modelo')",
    hoSinReason.res.ok && convTrasHandoff?.handoffReason === "modelo",
    JSON.stringify(convTrasHandoff?.handoffReason)
  );
  await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  await sleep(300);

  console.log("\n== us-bot-api: IA pausada y reset ==");
  const pause = await api(`/api/conversations/${convId}`, {
    method: "PATCH",
    body: JSON.stringify({ aiEnabled: false }),
  });
  ok("IA pausada desde la bandeja", pause.res.ok, JSON.stringify(pause.json));

  const typPaused = await bot("/api/bot/typing", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "typing con IA pausada → ok:false ai_paused (no toca Meta)",
    typPaused.res.ok &&
      typPaused.json?.ok === false &&
      typPaused.json?.reason === "ai_paused",
    JSON.stringify(typPaused.json)
  );

  const outboxBeforePaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  const sendPaused = await bot("/api/bot/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId, text: "¿sigo yo?" }),
  });
  ok(
    "el bot NO habla sobre una conversación tomada por un humano → 409 ai_paused",
    sendPaused.res.status === 409 &&
      sendPaused.json?.error?.code === "ai_paused",
    JSON.stringify(sendPaused.json)
  );
  const outboxAfterPaused =
    ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).length;
  ok(
    "y el rechazo ocurre ANTES de tocar Meta",
    outboxAfterPaused === outboxBeforePaused,
    `antes=${outboxBeforePaused} después=${outboxAfterPaused}`
  );

  const msgsBeforeReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  const rst = await bot("/api/bot/reset", {
    method: "POST",
    body: JSON.stringify({ conversationId: convId }),
  });
  ok(
    "POST /api/bot/reset → ok:true",
    rst.res.ok && rst.json?.ok === true,
    JSON.stringify(rst.json)
  );
  await sleep(400);
  convs = (await api("/api/conversations")).json?.conversations ?? [];
  const afterReset = convs.find((c) => c.id === convId);
  ok(
    "reset reactiva la IA (sale del handoff)",
    afterReset?.aiEnabled === true && !afterReset?.handoffAt,
    JSON.stringify({
      aiEnabled: afterReset?.aiEnabled,
      handoffAt: afterReset?.handoffAt,
    })
  );
  const msgsAfterReset =
    ((await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [])
      .length;
  ok(
    "el reset conserva el historial (auditoría)",
    msgsAfterReset === msgsBeforeReset,
    `antes=${msgsBeforeReset} después=${msgsAfterReset}`
  );

  const stages = (await api("/api/pipeline/stages")).json?.stages ?? [];
  const firstStage = [...stages].sort((a, b) => a.position - b.position)[0];
  const detail = (await api(`/api/contacts/${afterReset?.contact.id}`)).json;
  ok(
    "reset regresa el lead a la primera etapa",
    !detail?.lead || detail?.stage?.id === firstStage?.id,
    `etapa=${detail?.stage?.name} esperada=${firstStage?.name}`
  );

  console.log("\n== 008: paridad inbox — echoes de coexistence (US1) ==");
  const LEAD = "5214627008001"; // canónica: 524627008001

  // Un inbound primero: la conversación existe y la ventana queda abierta.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      name: "Lead 008",
      text: "hola, quiero informes",
      waMessageId: "wamid.e2e.008.in.1",
    }),
  });
  await sleep(1200);
  const findConv008 = async () =>
    (((await api("/api/conversations")).json?.conversations) ?? []).find(
      (c) => c.contact.phone === "524627008001"
    );
  let conv008 = await findConv008();
  ok("conversación del lead 008 creada", Boolean(conv008), "sin conversación");
  const inboundAtBefore = conv008?.lastInboundAt;

  // Echo: el dueño contesta A MANO desde la app del teléfono.
  const echo1 = await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: "wamid.e2e.008.echo.1",
    }),
  });
  ok("echo entregado al webhook", echo1.res.ok, JSON.stringify(echo1.json));
  await sleep(900);

  const msgs1 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const manual1 = msgs1.find((m) => m.text === "te contesto yo, dame un minuto");
  ok(
    "el mensaje manual aparece como saliente origin=manual",
    manual1?.direction === "out" && manual1?.origin === "manual" && manual1?.status === "sent",
    JSON.stringify(manual1)
  );

  conv008 = await findConv008();
  ok(
    "la IA quedó pausada con handoff manual_reply",
    conv008?.aiEnabled === false && conv008?.handoffReason === "manual_reply",
    JSON.stringify({ aiEnabled: conv008?.aiEnabled, reason: conv008?.handoffReason })
  );
  ok(
    "el echo NO tocó la ventana de 24 h (lastInboundAt intacto)",
    conv008?.lastInboundAt === inboundAtBefore,
    `${inboundAtBefore} → ${conv008?.lastInboundAt}`
  );

  // Idempotencia: el mismo echo otra vez no duplica.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "te contesto yo, dame un minuto",
      waMessageId: "wamid.e2e.008.echo.1",
    }),
  });
  await sleep(700);
  const msgs2 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo duplicado (mismo wamid) no duplica el mensaje",
    msgs2.filter((m) => m.text === "te contesto yo, dame un minuto").length === 1
  );

  // Variante defensiva: echoes bajo la clave `messages`.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      text: "segundo mensaje manual",
      waMessageId: "wamid.e2e.008.echo.2",
      useMessagesKey: true,
    }),
  });
  await sleep(700);
  const msgs3 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  ok(
    "echo bajo la clave `messages` también se ingiere (parser tolerante)",
    msgs3.some((m) => m.text === "segundo mensaje manual" && m.origin === "manual")
  );

  // Echo hacia un número SIN conversación previa → la crea.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: "5214627008002",
      text: "hola, te escribo del anuncio",
      waMessageId: "wamid.e2e.008.echo.3",
    }),
  });
  await sleep(700);
  const convNew = (((await api("/api/conversations")).json?.conversations) ?? []).find(
    (c) => c.contact.phone === "524627008002"
  );
  ok("echo a número nuevo crea contacto y conversación", Boolean(convNew));

  // Reactivación desde el CRM (flujo existente de handoff).
  const react = await api(`/api/conversations/${conv008.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactivate: true }),
  });
  conv008 = await findConv008();
  ok(
    "reactivar la IA desde el CRM limpia el handoff",
    react.res.ok && conv008?.aiEnabled === true && !conv008?.handoffReason
  );

  console.log("\n== 008: enviar adjuntos desde el composer (US2) ==");
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
  const mediaForm = new FormData();
  mediaForm.set(
    "file",
    new Blob([JPEG_BYTES], { type: "image/jpeg" }),
    "local.jpg"
  );
  mediaForm.set("caption", "mira nuestro local");
  const upRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: mediaForm,
  });
  const upJson = await upRes.json().catch(() => null);
  ok("imagen con caption enviada (201)", upRes.status === 201, JSON.stringify(upJson));

  const msgs4 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentImg = msgs4.find((m) => m.media?.caption === "mira nuestro local");
  ok(
    "el saliente con imagen trae asset disponible y origin=operator",
    sentImg?.type === "image" &&
      sentImg?.origin === "operator" &&
      sentImg?.media?.fetchStatus === "available",
    JSON.stringify(sentImg)
  );

  const imgBin = await fetch(`${BASE}/api/media/${sentImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok(
    "GET /api/media/{id} sirve el binario con su content-type",
    imgBin.ok && (imgBin.headers.get("content-type") ?? "").includes("image/jpeg")
  );

  const outbox008 = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "el envío llegó a Graph como type=image con media id subido",
    outbox008.some((o) => o.type === "image" && JSON.stringify(o.body).includes("media-up-"))
  );

  // Camino infeliz: archivo que excede el límite (imagen > 5 MB) → 413 previo.
  const bigForm = new FormData();
  bigForm.set(
    "file",
    new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: "image/png" }),
    "grande.png"
  );
  const bigRes = await fetch(`${BASE}/api/conversations/${conv008.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: bigForm,
  });
  ok("imagen de 6 MB → 413 too_large ANTES de enviar", bigRes.status === 413);

  // Ubicación (payload estructurado, sin archivo).
  const locRes = await api(`/api/conversations/${conv008.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      type: "location",
      location: { latitude: 21.019, longitude: -101.257, name: "Oficina Central" },
    }),
  });
  ok("ubicación enviada", locRes.res.ok, JSON.stringify(locRes.json));
  const msgs5 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const sentLoc = msgs5.find((m) => m.type === "location" && m.direction === "out");
  ok(
    "la ubicación viaja como payload (lat/long/name) sin binario",
    sentLoc?.media?.kind === "location" && sentLoc?.media?.payload?.latitude === 21.019,
    JSON.stringify(sentLoc?.media)
  );
  const outboxLoc = (await api("/api/dev/wa-mock/outbox")).json?.outbox ?? [];
  ok(
    "Graph recibió type=location",
    outboxLoc.some((o) => o.type === "location")
  );

  console.log("\n== 008: previews de adjuntos entrantes (US3) ==");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "media-e2e-img-1",
      caption: "foto de mi negocio",
      waMessageId: "wamid.e2e.008.in.img",
    }),
  });
  await sleep(1600); // ingesta + descarga in-process del binario
  const msgs6 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inImg = msgs6.find((m) => m.media?.caption === "foto de mi negocio");
  ok(
    "imagen entrante queda disponible tras la descarga in-process",
    inImg?.direction === "in" &&
      inImg?.media?.kind === "image" &&
      inImg?.media?.fetchStatus === "available",
    JSON.stringify(inImg?.media)
  );
  const inImgBin = await fetch(`${BASE}/api/media/${inImg?.media?.assetId}`, {
    headers: { cookie, origin: BASE },
  });
  ok("el binario entrante se sirve desde el volumen local", inImgBin.ok);

  // Ubicación entrante: payload directo, sin binario (404 en /api/media).
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "location",
      location: { latitude: 20.5, longitude: -100.8, name: "Mi taller" },
      waMessageId: "wamid.e2e.008.in.loc",
    }),
  });
  await sleep(900);
  const msgs7 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const inLoc = msgs7.find((m) => m.type === "location" && m.direction === "in");
  ok(
    "ubicación entrante trae payload directo",
    inLoc?.media?.payload?.name === "Mi taller",
    JSON.stringify(inLoc?.media)
  );

  // Camino infeliz: media cuya descarga falla (metadata sin url) → failed,
  // el mensaje se conserva y /api/media responde 410.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD,
      type: "image",
      mediaId: "broken-no-url",
      waMessageId: "wamid.e2e.008.in.broken",
    }),
  });
  await sleep(1600);
  const msgs8 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const broken = msgs8.find((m) => m.id !== inImg?.id && m.media?.fetchStatus === "failed");
  ok(
    "descarga fallida degrada a failed sin perder el mensaje",
    Boolean(broken),
    JSON.stringify(msgs8.filter((m) => m.media).map((m) => m.media))
  );
  if (broken) {
    const goneRes = await fetch(`${BASE}/api/media/${broken.media.assetId}`, {
      headers: { cookie, origin: BASE },
    });
    ok("asset fallido → 410 gone en /api/media", goneRes.status === 410);
  }

  // Echo CON adjunto (AC-5 de US1): la foto que el dueño mandó desde el cel.
  await api("/api/dev/wa-mock/echo", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      to: LEAD,
      type: "image",
      mediaId: "media-e2e-echo-img",
      caption: "así quedaría tu logo",
      waMessageId: "wamid.e2e.008.echo.img",
    }),
  });
  await sleep(1600);
  const msgs9 = (await api(`/api/conversations/${conv008.id}/messages`)).json?.messages ?? [];
  const echoImg = msgs9.find((m) => m.media?.caption === "así quedaría tu logo");
  ok(
    "echo con imagen: manual + asset descargado y previsualizable",
    echoImg?.origin === "manual" && echoImg?.media?.fetchStatus === "available",
    JSON.stringify(echoImg?.media)
  );

  await agendaChecks();
  await aislamientoChecks();
  await atribucionChecks();

  console.log(`\n===== ${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures > 0 ? 1 : 0);
}

/* ============================================================
 * 015 — Motor de agenda universal (tests/e2e/us-agenda.md)
 *
 * Cubre las dos configuraciones de la bandera, las dos garantías
 * innegociables con sus CÓDIGOS EXACTOS, la carrera del hueco, el enlace
 * pendiente cuando el proveedor falla, y el sandbox del Laboratorio.
 * ============================================================ */

async function agendaChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.AGENDA ?? "").trim()
  );

  console.log("\n== 015: la bandera de la agenda ==");
  const rutas = [
    "/api/calendar/settings",
    "/api/calendar/availability",
    "/api/bookings",
  ];

  if (!encendida) {
    // Con la bandera apagada la agenda NO EXISTE: ni rutas de operador, ni de
    // servicio, ni pantallas. Es la mitad del contrato que casi nunca se
    // prueba, y la que toda instancia normal usa.
    for (const ruta of rutas) {
      const { res } = await api(ruta);
      ok(`${ruta} → 404 con la agenda apagada`, res.status === 404, `status=${res.status}`);
    }
    const botAvail = await bot("/api/bot/availability?conversationId=x");
    ok(
      "/api/bot/availability → 404 con la agenda apagada",
      botAvail.res.status === 404,
      `status=${botAvail.res.status}`
    );
    const page = await fetch(`${BASE}/bookings`, { headers: { cookie } });
    ok("la pantalla /bookings no existe", page.status === 404, `status=${page.status}`);
    console.log("  (agenda apagada: el resto de los checks de 015 no aplican)");
    return;
  }

  for (const ruta of rutas) {
    const { res } = await api(ruta);
    ok(`${ruta} responde con la agenda encendida`, res.ok, `status=${res.status}`);
  }

  console.log("\n== 015: configuración de la agenda (US2) ==");
  const defaults = (await api("/api/calendar/settings")).json?.settings;
  ok(
    "una instancia sin configurar da defaults usables, no 404",
    defaults?.slotMinutes === 30 && defaults?.connector === "enlace-fijo",
    JSON.stringify(defaults)
  );

  const SALA = "https://meet.ejemplo.test/sala-fija";
  const guardado = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({
      weeklyHours: {
        mon: [{ start: "09:00", end: "18:00" }],
        tue: [{ start: "09:00", end: "18:00" }],
        wed: [{ start: "09:00", end: "18:00" }],
        thu: [{ start: "09:00", end: "18:00" }],
        fri: [{ start: "09:00", end: "18:00" }],
        sat: [{ start: "09:00", end: "18:00" }],
        sun: [{ start: "09:00", end: "18:00" }],
      },
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 7,
      connector: "enlace-fijo",
      meetingLink: SALA,
    }),
  });
  ok("se guarda el horario y la sala fija", guardado.res.ok, `status=${guardado.res.status}`);

  const tzMala = await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ timezone: "Marte/Olympus" }),
  });
  ok(
    "una zona horaria inventada se rechaza (422) en vez de romper el motor",
    tzMala.res.status === 422,
    `status=${tzMala.res.status}`
  );

  const disp = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok("hay huecos ofrecibles tras configurar", disp.length > 0, `slots=${disp.length}`);
  ok(
    "cada hueco trae el día EN PALABRAS, no solo la hora",
    Boolean(disp[0]?.dayLabel && disp[0]?.time),
    JSON.stringify(disp[0])
  );

  console.log("\n== 015: las dos garantías (US3) ==");
  const LEAD_A = "5214627015001";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_A,
      name: "Lead agenda A",
      text: "quiero agendar",
      waMessageId: "wamid.e2e.015.a.1",
    }),
  });
  const LEAD_B = "5214627015002";
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: LEAD_B,
      name: "Lead agenda B",
      text: "yo también quiero",
      waMessageId: "wamid.e2e.015.b.1",
    }),
  });
  await sleep(1500);

  const convsAgenda = (await api("/api/conversations")).json?.conversations ?? [];
  const convA = convsAgenda.find((c) => c.contact.phone === "524627015001");
  const convB = convsAgenda.find((c) => c.contact.phone === "524627015002");
  ok("dos conversaciones de prueba listas", Boolean(convA && convB));
  if (!convA || !convB) return;

  const ofertaA = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotsA = ofertaA.json?.slots ?? [];
  ok("ofrecer horarios devuelve huecos", slotsA.length > 0, `slots=${slotsA.length}`);
  ok(
    "el reparto cubre más de un día (no todo hoy)",
    (ofertaA.json?.diasConAgenda ?? []).length > 1,
    JSON.stringify(ofertaA.json?.diasConAgenda)
  );

  // GARANTÍA 1: un instante libre pero JAMÁS ofrecido se rechaza.
  const noOfrecido = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({
      conversationId: convA.id,
      // Un minuto después de un hueco real: válido, libre, y nunca ofrecido.
      startUtc: new Date(Date.parse(slotsA[0].startUtc) + 60_000).toISOString(),
    }),
  });
  ok(
    "horario no ofrecido → 409 slot_not_offered (código EXACTO)",
    noOfrecido.res.status === 409 &&
      noOfrecido.json?.error?.code === "slot_not_offered",
    `status=${noOfrecido.res.status} body=${JSON.stringify(noOfrecido.json)}`
  );
  ok(
    "y devuelve lo que SÍ se ofreció, para re-ofrecer sin inventar",
    (noOfrecido.json?.slots ?? []).length > 0
  );

  // Camino feliz: 201 EXACTO, no 200.
  const elegido = slotsA[0].startUtc;
  const creada = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convA.id, startUtc: elegido }),
  });
  ok(
    "reservar responde 201 Created (NO 200): es contrato",
    creada.res.status === 201,
    `status=${creada.res.status}`
  );
  ok(
    "la respuesta trae etiqueta y el enlace de la sala fija",
    creada.json?.label && creada.json?.meetingLink === SALA,
    JSON.stringify(creada.json)
  );
  ok("el enlace no queda pendiente con el conector soberano", creada.json?.linkPending === false);

  const dispTrasReserva = (await api("/api/calendar/availability")).json?.slots ?? [];
  ok(
    "el hueco reservado desaparece de la disponibilidad",
    !dispTrasReserva.some((s) => s.startUtc === elegido)
  );

  const lista = (await api("/api/bookings")).json?.bookings ?? [];
  ok(
    "la cita aparece en Citas, marcada como agendada por la IA",
    lista.some((b) => b.id === creada.json?.bookingId && b.source === "ai"),
    JSON.stringify(lista.map((b) => ({ id: b.id, source: b.source })))
  );

  // GARANTÍA 2: la carrera. B tenía el mismo hueco ofrecido y llega tarde.
  const ofertaB = await bot(
    `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
  );
  // Se le ofrece a B exactamente el hueco que A acaba de tomar: se simula la
  // oferta previa a la reserva de A, que es como ocurre en la vida real.
  const tomado = await bot("/api/bot/bookings", {
    method: "POST",
    body: JSON.stringify({ conversationId: convB.id, startUtc: elegido }),
  });
  ok(
    "el hueco ya tomado → 409 (nunca una segunda cita)",
    tomado.res.status === 409,
    `status=${tomado.res.status} body=${JSON.stringify(tomado.json)}`
  );
  ok(
    "el sobre del error va ANIDADO y `slots` es HERMANO",
    typeof tomado.json?.error?.code === "string" && Array.isArray(tomado.json?.slots),
    JSON.stringify(tomado.json)
  );

  const listaTrasCarrera = (await api("/api/bookings")).json?.bookings ?? [];
  const activasEnElHueco = listaTrasCarrera.filter(
    (b) =>
      b.scheduledAtUtc === elegido &&
      (b.status === "agendada" || b.status === "realizada")
  );
  ok(
    "CERO doble-agendamiento: una sola cita activa en ese instante",
    activasEnElHueco.length === 1,
    `activas=${activasEnElHueco.length}`
  );

  // Las alternativas del 409 ya son la oferta vigente: reservables de una.
  const alternativa = (tomado.json?.slots ?? [])[0];
  if (alternativa) {
    const conAlternativa = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convB.id,
        startUtc: alternativa.startUtc,
      }),
    });
    ok(
      "una alternativa del 409 se reserva de inmediato (201)",
      conAlternativa.res.status === 201,
      `status=${conAlternativa.res.status}`
    );
  } else {
    ok("el 409 trajo alternativas frescas", false, "lista vacía");
  }

  // Reprogramar por la superficie del bot: 200, no 201.
  const ofertaMover = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const destino = (ofertaMover.json?.slots ?? [])[0];
  if (destino) {
    const movida = await bot("/api/bot/bookings", {
      method: "PATCH",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: destino.startUtc,
      }),
    });
    ok(
      "reprogramar responde 200 (NO 201): no crea un recurso nuevo",
      movida.res.status === 200,
      `status=${movida.res.status}`
    );
  }

  /**
   * El agujero de INTEGRACIÓN del issue #50.
   *
   * Todo lo de arriba entra por `/api/bot/*`, donde quien llama YA tiene el
   * ISO. El agente EMBEBIDO no lo tenía: al modelo solo le llegaban el prompt
   * y el historial de TEXTO, con las etiquetas que leyó el cliente y sin año,
   * zona ni fecha de hoy. Acertar el instante era suerte, el rechazo caía en
   * `slot_not_offered` —de texto fijo— y la conversación repetía la lista
   * para siempre.
   *
   * Y por eso este self-test no lo cazaba: el resto de 015 ejercita el
   * gateway, nunca la conversación. Aquí hay que ENCENDER el agente
   * in-process a propósito, y apagarlo después para no alterar lo que sigue.
   */
  console.log("\n== 015: el agente reserva desde la conversación (#50) ==");
  {
    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    const encendido = await api("/api/agent/profile");
    ok(
      "el agente in-process queda encendido para esta prueba",
      encendido.json?.profile?.enabled === true,
      JSON.stringify(encendido.json?.profile?.enabled)
    );

    /**
     * Contacto NUEVO en cada corrida.
     *
     * Con un teléfono fijo, la segunda ejecución arrastra la conversación y —
     * sobre todo— las OFERTAS de la anterior: el mapa ya está ahí desde el
     * primer mensaje y el agente reserva antes de ofrecer, así que el check
     * mide otra cosa. El resto del guion asume base recién sembrada; esta
     * sección no puede permitírselo porque compara ANTES y DESPUÉS.
     */
    const CORRIDA = Date.now().toString().slice(-6);
    const LEAD_C = `5214627${CORRIDA}`;
    const decir = (texto, n) =>
      api("/api/dev/wa-mock/inbound", {
        method: "POST",
        body: JSON.stringify({
          phoneNumberId: PN,
          from: LEAD_C,
          name: "Lead agenda C",
          text: texto,
          // Único por corrida: con un id fijo, la segunda ejecución lo
          // deduplica en la ingesta y no entra NADA — el agente no llega a
          // correr y el check falla sin que haya nada roto.
          waMessageId: `wamid.e2e.015.c.${CORRIDA}.${n}`,
        }),
      });

    await decir("quiero agendar una cita", 1);
    await hasta(async () => {
      const cs = (await api("/api/conversations")).json?.conversations ?? [];
      return cs.some((c) => c.contact.phone === `524627${CORRIDA}`);
    });

    const convs = (await api("/api/conversations")).json?.conversations ?? [];
    const convC = convs.find((c) => c.contact.phone === `524627${CORRIDA}`);
    ok("el agente atendió al lead que pide cita", Boolean(convC));

    if (convC) {
      const salientesDe = async () => {
        const msgs =
          (await api(`/api/conversations/${convC.id}/messages`)).json
            ?.messages ?? [];
        return msgs.filter((m) => m.direction === "out");
      };

      // El agente tiene que RESPONDER; cuánto tarde no es asunto del check.
      await hasta(async () => (await salientesDe()).length > 0);
      const trasOferta = await salientesDe();
      ok(
        "el agente OFRECE horarios (hay respuesta, no silencio)",
        trasOferta.length > 0 && /\d{2}:\d{2}/.test(trasOferta.at(-1)?.text ?? ""),
        `salientes=${trasOferta.length} ultimo=${(trasOferta.at(-1)?.text ?? "").slice(0, 80)}`
      );

      const antes = (await api("/api/bookings")).json?.bookings ?? [];
      await decir("quiero el primero", 2);
      await hasta(async () => {
        const bs = (await api("/api/bookings")).json?.bookings ?? [];
        return bs.length > antes.length;
      });

      const despues = (await api("/api/bookings")).json?.bookings ?? [];
      ok(
        "elegir un horario CREA la cita (no repite la lista)",
        despues.length > antes.length,
        `citas antes=${antes.length} despues=${despues.length}`
      );

      /**
       * Aquí había una tercera comprobación —«confirma en vez de volver a
       * ofrecer»— y se quitó: pasaba TAMBIÉN con el bug puesto, porque bajo el
       * fallo el agente responde cualquier otra cosa que tampoco contiene
       * «estos horarios». Una comprobación que no distingue el fallo del
       * acierto solo da confianza falsa. Lo que decide es la cita creada.
       */
    }

    await api("/api/agent/profile", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
  }

  console.log("\n== 015: el operador y el enlace pendiente (US4) ==");
  const bookingId = creada.json?.bookingId;
  const cancelada1 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  const cancelada2 = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "cancel" }),
  });
  ok(
    "cancelar dos veces no falla (idempotente)",
    cancelada1.res.ok && cancelada2.res.ok,
    `${cancelada1.res.status}/${cancelada2.res.status}`
  );

  const reintentoInvalido = await api(`/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "retry_link" }),
  });
  ok(
    "reintentar el enlace de una cita que sí lo tiene → 422",
    reintentoInvalido.res.status === 422,
    `status=${reintentoInvalido.res.status}`
  );

  // El conector caído: la cita SE CREA igual, con el enlace pendiente.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "zoom" }),
  });
  const ofertaPend = await bot(
    `/api/bot/availability?conversationId=${convA.id}&limit=12&perDay=3&days=5`
  );
  const slotPend = (ofertaPend.json?.slots ?? [])[0];
  if (slotPend) {
    const sinProveedor = await bot("/api/bot/bookings", {
      method: "POST",
      body: JSON.stringify({
        conversationId: convA.id,
        startUtc: slotPend.startUtc,
      }),
    });
    ok(
      "con el proveedor sin conectar, la cita SE CREA igual (201)",
      sinProveedor.res.status === 201,
      `status=${sinProveedor.res.status}`
    );
    ok(
      "…y avisa que el enlace queda pendiente, en vez de prometerlo",
      sinProveedor.json?.linkPending === true &&
        sinProveedor.json?.meetingLink === null,
      JSON.stringify(sinProveedor.json)
    );

    const listaPend = (await api("/api/bookings")).json?.bookings ?? [];
    ok(
      "la cita sin enlace se ve como tal en Citas",
      listaPend.some(
        (b) => b.id === sinProveedor.json?.bookingId && b.linkPending === true
      )
    );
  }

  // Se restaura el conector soberano para no dejar la instancia a medias.
  await api("/api/calendar/settings", {
    method: "PUT",
    body: JSON.stringify({ connector: "enlace-fijo" }),
  });

  console.log("\n== 015: conector Zoom contra su mock ==");
  const zoomMockUp = await fetch(`${BASE}/api/dev/zoom-mock/_state`);
  if (!zoomMockUp.ok) {
    console.log("  (zoom-mock no disponible: se omiten los checks del conector)");
  } else {
    await fetch(`${BASE}/api/dev/zoom-mock/_reset`, { method: "POST" });

    const malas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-invalid",
      }),
    });
    ok(
      "credenciales que el proveedor rechaza NO se guardan (422)",
      malas.res.status === 422,
      `status=${malas.res.status}`
    );
    ok(
      "…y la conexión sigue sin existir",
      (await api("/api/settings/zoom")).json?.connection === null
    );

    const buenas = await api("/api/settings/zoom", {
      method: "PUT",
      body: JSON.stringify({
        accountId: "acc",
        clientId: "cli",
        clientSecret: "secreto-bueno",
      }),
    });
    ok("credenciales válidas se guardan", buenas.res.ok, `status=${buenas.res.status}`);
    ok(
      "hacia el navegador solo salen los últimos 4 del secreto",
      buenas.json?.connection?.secretLast4 === "ueno" &&
        !JSON.stringify(buenas.json).includes("secreto-bueno"),
      JSON.stringify(buenas.json)
    );

    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "zoom" }),
    });
    const ofertaZoom = await bot(
      `/api/bot/availability?conversationId=${convB.id}&limit=12&perDay=3&days=5`
    );
    const slotZoom = (ofertaZoom.json?.slots ?? [])[0];
    if (slotZoom) {
      const conZoom = await bot("/api/bot/bookings", {
        method: "POST",
        body: JSON.stringify({
          conversationId: convB.id,
          startUtc: slotZoom.startUtc,
        }),
      });
      ok(
        "agendar con Zoom crea la reunión y devuelve su enlace",
        conZoom.res.status === 201 &&
          typeof conZoom.json?.meetingLink === "string" &&
          conZoom.json.meetingLink.includes("zoom.mock"),
        JSON.stringify(conZoom.json)
      );

      const estado = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "el proveedor recibió la reunión con su tema y su hora",
        estado.meetings?.length === 1 &&
          estado.meetings[0].topic.startsWith("Cita —"),
        JSON.stringify(estado.meetings)
      );

      // Cancelar borra la reunión en el proveedor.
      await api(`/api/bookings/${conZoom.json.bookingId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      const estado2 = await (await fetch(`${BASE}/api/dev/zoom-mock/_state`)).json();
      ok(
        "cancelar la cita borra la reunión en el proveedor",
        (estado2.deleted ?? []).length === 1,
        JSON.stringify(estado2)
      );
    }

    await api("/api/settings/zoom", { method: "DELETE" });
    await api("/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify({ connector: "enlace-fijo" }),
    });
  }

  // El sandbox del Laboratorio (una cita de prueba jamás llega a un conector)
  // NO se verifica aquí: las conversaciones del Laboratorio no son alcanzables
  // desde la API pública —a propósito—, así que desde fuera solo podría
  // observarse por ausencia, que es una prueba débil. Vive en
  // `tests/unit/agenda-sandbox.test.ts`, que afirma lo que de verdad importa:
  // que el conector no se llama, ni al crear, ni al reprogramar, ni al
  // cancelar.
}

main().catch((err) => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API (tests/e2e/us-atribucion.md)
 *
 * Cubre las dos configuraciones de la bandera, la conexión del dataset, la
 * captura del anuncio, los dos eventos con la FORMA de su payload, el dedup,
 * y —lo que más importa— que un fallo de Meta jamás cuesta el movimiento del
 * lead.
 *
 * Los contactos llevan un sufijo por corrida: el dedup de conversiones es
 * permanente por diseño, así que re-correr el arnés contra la MISMA base
 * tiene que estrenar leads o estaría midiendo los de la corrida anterior.
 * ============================================================ */

async function atribucionChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.ATRIBUCION ?? "").trim()
  );
  const SUF = String(Date.now()).slice(-6);
  const tel = (n) => `52155${SUF}${n}`;
  const nom = (base) => `${base} ${SUF}`;

  console.log("\n== 016: la bandera de la atribución ==");

  if (!encendida) {
    for (const ruta of ["/api/settings/capi", "/api/settings/capi/events"]) {
      const { res } = await api(ruta);
      ok(
        `${ruta} → 404 con la atribución apagada`,
        res.status === 404,
        `status=${res.status}`
      );
    }
    const put = await api("/api/settings/capi", {
      method: "PUT",
      body: JSON.stringify({ datasetId: "ds-e2e" }),
    });
    ok(
      "PUT /api/settings/capi → 404 con la atribución apagada",
      put.res.status === 404,
      `status=${put.res.status}`
    );
    const page = await fetch(`${BASE}/settings/ads`, { headers: { cookie } });
    ok(
      "la pantalla /settings/ads no existe",
      page.status === 404,
      `status=${page.status}`
    );

    // Y un mensaje que SÍ viene de un anuncio se atiende como cualquier otro:
    // la instancia que no atribuye no se entera del referral, pero tampoco se
    // rompe con él.
    const inb = await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        from: tel("1"),
        name: nom("Lead con anuncio apagada"),
        text: "vi su anuncio",
        ctwaClid: "clid-apagada",
        waMessageId: `wamid.e2e.016.off.${SUF}`,
      }),
    });
    ok("inbound con anuncio entregado igual", inb.res.ok);
    await sleep(1400);
    const convsOff = (await api("/api/conversations")).json?.conversations ?? [];
    ok(
      "la conversación del anuncio existe (la ingesta no se rompe)",
      convsOff.some((c) => c.contact.name === nom("Lead con anuncio apagada"))
    );
    console.log(
      "  (atribución apagada: el resto de los checks de 016 no aplican)"
    );
    return;
  }

  /* ---------------- US2: conectar el dataset ---------------- */

  console.log("\n== 016: conectar el dataset (US2) ==");
  // Se parte de desconectado: así el primer check afirma lo que dice afirmar
  // aunque el arnés se re-corra sobre la misma base.
  await api("/api/settings/capi", { method: "DELETE" });
  const vacio = await api("/api/settings/capi");
  ok(
    "sin configurar responde 200 con capi: null (no 404)",
    vacio.res.status === 200 && vacio.json?.capi === null,
    JSON.stringify(vacio.json)
  );

  const board0 = (await api("/api/pipeline/board")).json;
  const etapaCalificado = board0.stages.filter((s) => s.kind === "open").at(-1);
  const etapaGanada = board0.stages.find((s) => s.kind === "won");
  const etapaInicial = board0.stages.find((s) => s.kind === "open");

  const etapaAjena = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: "stg_de_otro_negocio",
    }),
  });
  ok(
    "una etapa que no es del negocio se rechaza con 422 etapa_invalida",
    etapaAjena.res.status === 422 &&
      etapaAjena.json?.error?.code === "etapa_invalida",
    `status=${etapaAjena.res.status} ${JSON.stringify(etapaAjena.json)}`
  );

  const guardado = await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  ok(
    "se guarda el dataset sin pegar token",
    guardado.res.ok,
    `status=${guardado.res.status}`
  );

  const cfg = (await api("/api/settings/capi")).json?.capi;
  ok(
    "reusó el token de WhatsApp y solo muestra sus últimos 4",
    cfg?.datasetId === "ds-e2e" && cfg?.tokenLast4 === "-e2e",
    JSON.stringify(cfg)
  );
  ok(
    "el token completo NUNCA sale del servidor",
    !JSON.stringify(cfg).includes("tok-e2e"),
    JSON.stringify(cfg)
  );

  /* ---------------- US3 + US4: capturar y calificar ---------------- */

  console.log("\n== 016: del anuncio al lead calificado (US3/US4) ==");
  await api("/api/dev/wa-mock/capi-events", { method: "DELETE" });

  const CLID = `clid-e2e-${SUF}`;
  const NOMBRE_AD = nom("Lead de anuncio");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "hola, vengo del anuncio",
      ctwaClid: CLID,
      adHeadline: "Kit de verano",
      waMessageId: `wamid.e2e.016.ad.${SUF}.1`,
    }),
  });
  await sleep(1400);

  // Segundo mensaje con OTRO referral: el primero gana y no se sobreescribe.
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("2"),
      name: NOMBRE_AD,
      text: "sigo aquí",
      ctwaClid: "clid-que-no-debe-ganar",
      waMessageId: `wamid.e2e.016.ad.${SUF}.2`,
    }),
  });
  await sleep(1200);

  const board1 = (await api("/api/pipeline/board")).json;
  const leadAd = board1.leads.find((l) => l.contact.name === NOMBRE_AD);
  ok("el lead del anuncio existe en el tablero", !!leadAd);

  const mov1 = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "el lead se mueve a la etapa calificada",
    mov1.res.ok,
    `status=${mov1.res.status}`
  );
  await sleep(800);

  const act1 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const calificado = act1.find(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "se reportó QualifiedLead con acuse de Meta",
    calificado?.status === "sent" && !!calificado?.fbTraceId,
    JSON.stringify(calificado)
  );
  ok(
    "la actividad dice de qué anuncio vino",
    calificado?.adHeadline === "Kit de verano",
    JSON.stringify(calificado)
  );

  const capi1 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento1 = capi1.find((e) => e.eventName === "QualifiedLead");
  ok(
    "el evento viajó con el ctwa_clid del PRIMER referral",
    evento1?.ctwaClid === CLID,
    JSON.stringify(evento1?.ctwaClid)
  );
  ok(
    "y con custom_data.lead_stage (lo único reglable en Meta)",
    evento1?.customData?.lead_stage === "qualified",
    JSON.stringify(evento1?.customData)
  );

  // Dedup: sacarlo y volverlo a meter no re-reporta.
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaInicial.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act2 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const califsDeEste = act2.filter(
    (e) => e.eventName === "QualifiedLead" && e.contactName === NOMBRE_AD
  );
  ok(
    "volver a calificar NO reporta dos veces",
    califsDeEste.length === 1,
    `${califsDeEste.length} filas`
  );

  /* ---------------- US5: la venta ---------------- */

  console.log("\n== 016: la venta (US5) ==");
  const venta = await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      stageId: etapaGanada.id,
      amountCents: 45050,
      currency: "MXN",
    }),
  });
  ok("el trato se marca como ganado", venta.res.ok, `status=${venta.res.status}`);
  await sleep(800);

  const act3 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const compra = act3.find(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok("se reportó la venta", compra?.status === "sent", JSON.stringify(compra));

  const capi2 = (await api("/api/dev/wa-mock/capi-events")).json?.capiEvents ?? [];
  const evento2 = capi2.find((e) => e.eventName === "Purchase");
  ok(
    "la venta viajó en UNIDADES de la moneda, no en centavos",
    evento2?.customData?.value === 450.5 &&
      evento2?.customData?.currency === "MXN",
    JSON.stringify(evento2?.customData)
  );

  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await api(`/api/pipeline/leads/${leadAd.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaGanada.id }),
  });
  await sleep(800);
  const act4 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const comprasDeEste = act4.filter(
    (e) => e.eventName === "Purchase" && e.contactName === NOMBRE_AD
  );
  ok(
    "re-ganar NO manda una segunda compra (a Meta no se le des-envía nada)",
    comprasDeEste.length === 1,
    `${comprasDeEste.length} filas`
  );

  /* ---------------- Los caminos infelices ---------------- */

  console.log("\n== 016: caminos infelices ==");

  // Un lead que no vino de un anuncio: se registra el motivo y nada falla.
  const NOMBRE_ORG = nom("Lead organico");
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("3"),
      name: NOMBRE_ORG,
      text: "hola",
      waMessageId: `wamid.e2e.016.org.${SUF}`,
    }),
  });
  await sleep(1400);
  const board2 = (await api("/api/pipeline/board")).json;
  const leadOrg = board2.leads.find((l) => l.contact.name === NOMBRE_ORG);
  await api(`/api/pipeline/leads/${leadOrg.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  await sleep(800);
  const act5 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const omitido = act5.find((e) => e.contactName === NOMBRE_ORG);
  ok(
    "un lead sin anuncio queda OMITIDO con el motivo escrito",
    omitido?.status === "skipped" && /ctwa_clid/.test(omitido?.error ?? ""),
    JSON.stringify(omitido)
  );

  // Meta rechazando: el 200 mentiroso (events_received: 0).
  const NOMBRE_FAIL = nom("Lead con Meta caido");
  await api("/api/settings/capi", {
    method: "PUT",
    body: JSON.stringify({
      datasetId: "ds-e2e-fail",
      qualifiedStageId: etapaCalificado.id,
    }),
  });
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: PN,
      from: tel("4"),
      name: NOMBRE_FAIL,
      text: "vengo del anuncio",
      ctwaClid: `clid-fail-${SUF}`,
      waMessageId: `wamid.e2e.016.fail.${SUF}`,
    }),
  });
  await sleep(1400);
  const board3 = (await api("/api/pipeline/board")).json;
  const leadFail = board3.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  const movFail = await api(`/api/pipeline/leads/${leadFail.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: etapaCalificado.id }),
  });
  ok(
    "con Meta rechazando, el lead SE MUEVE igual",
    movFail.res.ok,
    `status=${movFail.res.status}`
  );
  await sleep(800);
  const board4 = (await api("/api/pipeline/board")).json;
  const leadFail2 = board4.leads.find((l) => l.contact.name === NOMBRE_FAIL);
  ok(
    "y se queda en la etapa a la que lo movieron",
    leadFail2?.stageId === etapaCalificado.id,
    JSON.stringify(leadFail2?.stageId)
  );
  const act6 = (await api("/api/settings/capi/events")).json?.events ?? [];
  const fallido = act6.find((e) => e.contactName === NOMBRE_FAIL);
  ok(
    "la fila queda FALLIDA con lo que dijo Meta (200 pero events_received=0)",
    fallido?.status === "failed" &&
      /events_received=0/.test(fallido?.error ?? ""),
    JSON.stringify(fallido)
  );

  // Desconectar: deja de reportarse, pero la bitácora de lo ya dicho se queda.
  const del = await api("/api/settings/capi", { method: "DELETE" });
  ok("se puede desconectar", del.res.ok);
  const trasBorrar = (await api("/api/settings/capi")).json;
  ok("tras desconectar, no hay configuración", trasBorrar?.capi === null);
  const act7 = (await api("/api/settings/capi/events")).json?.events ?? [];
  ok(
    "los eventos ya reportados NO se borran al desconectar",
    act7.length >= 3,
    `${act7.length} filas`
  );
}

/* ============================================================
 * 018 — Agenda multi-profesional: gate de AISLAMIENTO por actor
 * (specs/018-agenda-multi-profesional/tasks.md, T009/T033/T064)
 *
 * Nace en la Fase 2 y cada historia le suma verificaciones. Los códigos HTTP
 * se comparan EXACTOS (nunca `res.ok`). Lo que una historia posterior (US3)
 * todavía no implementa se marca `pendiente(...)`: se ejecuta, se ve fallar
 * (rojo observable) y NO cuenta como fallo hasta que su slice lo active.
 *
 * Siembra por SQL (dependencia `postgres`) los perfiles `staff` que más
 * adelante crea `POST /api/staff/[id]/account` (T033). Se limpia al empezar y
 * al terminar: dejar profesionales extra activos rompería la compatibilidad
 * temporal de la 015 en la siguiente corrida (SC-006).
 * ============================================================ */

let pendientes = 0;

/** Check de una historia aún sin implementar: visible, pero no tumba el gate. */
function pendiente(name, cond, historia, extra = "") {
  if (cond) {
    checks++;
    console.log(`  OK  ${name}`);
  } else {
    pendientes++;
    console.log(`  PENDIENTE(${historia}) ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Abre el SSE con una jar, devuelve status/headers y lo cierra. */
async function abrirEventos(jar) {
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${BASE}/api/events`, {
      headers: { cookie: jar.cookie, origin: BASE },
      signal: ctrl.signal,
    });
    let json = null;
    if (res.headers.get("content-type")?.includes("json")) {
      json = await res.json().catch(() => null);
    }
    return { status: res.status, json, type: res.headers.get("content-type") };
  } finally {
    ctrl.abort();
  }
}

/**
 * US1 (T033) — equipo, catálogo y cuenta. Solo con la agenda encendida:
 * apagada estas rutas son 404 y la siembra SQL de la fase 2 no se toca.
 * Limpia lo que crea. No desactiva al equipo de forma permanente: el último
 * activo se prueba y se restaura.
 */
async function us1EquipoCatalogo({ ownerJar, jarA }) {
  console.log("  -- US1 equipo, catálogo y cuenta (T033)");
  const createdStaff = [];
  const createdServices = [];
  const receptionEmail = "iso-reception@vocero.test";

  const receptionAlta = await api("/api/settings/team", {
    method: "POST",
    jar: ownerJar,
    body: JSON.stringify({
      name: "Recepcion E2E",
      email: receptionEmail,
      password: ISO_PASS,
      role: "reception",
    }),
  });
  ok(
    "alta de recepción (201, o 409 si ya existe)",
    receptionAlta.res.status === 201 || receptionAlta.res.status === 409,
    `status ${receptionAlta.res.status}`
  );
  const jarR = newJar();
  const loginR = await login(jarR, receptionEmail, ISO_PASS);
  ok("la recepción inicia sesión", loginR.res.status === 200, `status ${loginR.res.status}`);

  try {
    const staffRes = await api("/api/staff", {
      method: "POST",
      jar: ownerJar,
      body: JSON.stringify({
        displayName: "US1 temporal",
        jobTitle: "Barbero",
        color: "#336699",
      }),
    });
    ok("owner POST /api/staff → 201", staffRes.res.status === 201, `status ${staffRes.res.status}`);
    const staffId = staffRes.json?.staff?.id;
    if (staffId) createdStaff.push(staffId);

    const serviceRes = await api("/api/services", {
      method: "POST",
      jar: ownerJar,
      body: JSON.stringify({
        name: "US1 corte",
        durationMinutes: 30,
        priceCents: 2500,
        currency: "MXN",
      }),
    });
    ok(
      "owner POST /api/services → 201",
      serviceRes.res.status === 201,
      `status ${serviceRes.res.status}`
    );
    const serviceId = serviceRes.json?.service?.id;
    if (serviceId) createdServices.push(serviceId);

    for (const [who, jar] of [
      ["reception", jarR],
      ["staff", jarA],
    ]) {
      const denyStaff = await api("/api/staff", {
        method: "POST",
        jar,
        body: JSON.stringify({ displayName: "intruso" }),
      });
      ok(`${who} POST /api/staff → 403`, denyStaff.res.status === 403, `status ${denyStaff.res.status}`);
      const denyService = await api("/api/services", {
        method: "POST",
        jar,
        body: JSON.stringify({ name: "intruso", durationMinutes: 30, priceCents: 1 }),
      });
      ok(
        `${who} POST /api/services → 403`,
        denyService.res.status === 403,
        `status ${denyService.res.status}`
      );
    }

    if (serviceId) {
      for (const [who, jar] of [
        ["staff", jarA],
        ["reception", jarR],
      ]) {
        const price = await api(`/api/services/${serviceId}`, {
          method: "PATCH",
          jar,
          body: JSON.stringify({ priceCents: 1 }),
        });
        ok(
          `${who} PATCH /api/services/{id} precio → 403`,
          price.res.status === 403 && price.json?.error?.code === "forbidden",
          `${price.res.status} ${JSON.stringify(price.json)}`
        );
      }
      const reread = await api("/api/services?includeInactive=1", { jar: ownerJar });
      const row = (reread.json?.services ?? []).find((s) => s.id === serviceId);
      ok(
        "el precio sigue intacto releído por el dueño",
        reread.res.status === 200 && row?.priceCents === 2500,
        JSON.stringify(row)
      );
    }

    if (staffId) {
      const email = `iso-us1-${Date.now()}@vocero.test`;
      const cuenta = await api(`/api/staff/${staffId}/account`, {
        method: "POST",
        jar: ownerJar,
        body: JSON.stringify({ email, name: "US1 temporal", password: ISO_PASS }),
      });
      ok(
        "POST /api/staff/{id}/account → 201",
        cuenta.res.status === 201 && cuenta.json?.ok === true,
        `${cuenta.res.status} ${JSON.stringify(cuenta.json)}`
      );
      const jarN = newJar();
      const logged = await login(jarN, email, ISO_PASS);
      ok("la cuenta nueva entra", logged.res.status === 200, `status ${logged.res.status}`);
      const me = await api("/api/me", { jar: jarN });
      ok(
        "GET /api/me → role staff con su staffId",
        me.res.status === 200 && me.json?.role === "staff" && me.json?.staffId === staffId,
        JSON.stringify(me.json)
      );

      const off = await api(`/api/staff/${staffId}`, {
        method: "PATCH",
        jar: ownerJar,
        body: JSON.stringify({ active: false }),
      });
      ok("desactivar un profesional que no es el último → 200", off.res.status === 200, `status ${off.res.status}`);
      const meOff = await api("/api/me", { jar: jarN });
      ok(
        "su login recibe 403 account_disabled",
        meOff.res.status === 403 && meOff.json?.error?.code === "account_disabled",
        `${meOff.res.status} ${JSON.stringify(meOff.json)}`
      );

      const delCuenta = await api(`/api/staff/${staffId}`, { method: "DELETE", jar: ownerJar });
      ok(
        "DELETE /api/staff/{id} con cuenta → 409 has_account",
        delCuenta.res.status === 409 && delCuenta.json?.error?.code === "has_account",
        `${delCuenta.res.status} ${JSON.stringify(delCuenta.json)}`
      );
    }

    const delCitas = await api(`/api/staff/${ISO.A.staff}`, { method: "DELETE", jar: ownerJar });
    ok(
      "DELETE /api/staff/{id} con citas → 409 has_bookings",
      delCitas.res.status === 409 && delCitas.json?.error?.code === "has_bookings",
      `${delCitas.res.status} ${JSON.stringify(delCitas.json)}`
    );

    const antes = await api("/api/staff?includeInactive=1", { jar: ownerJar });
    const estabaActivo = (antes.json?.staff ?? []).filter((s) => s.active).map((s) => s.id);
    const keeper = estabaActivo[0];
    try {
      for (const id of estabaActivo.slice(1)) {
        await api(`/api/staff/${id}`, {
          method: "PATCH",
          jar: ownerJar,
          body: JSON.stringify({ active: false }),
        });
      }
      if (keeper) {
        const last = await api(`/api/staff/${keeper}`, {
          method: "PATCH",
          jar: ownerJar,
          body: JSON.stringify({ active: false }),
        });
        ok(
          "PATCH /api/staff/{id} {active:false} sobre el último activo → 409 last_active_staff",
          last.res.status === 409 && last.json?.error?.code === "last_active_staff",
          `${last.res.status} ${JSON.stringify(last.json)}`
        );
      } else {
        ok("había un profesional activo para probar last_active_staff", false);
      }
    } finally {
      for (const id of estabaActivo) {
        await api(`/api/staff/${id}`, {
          method: "PATCH",
          jar: ownerJar,
          body: JSON.stringify({ active: true }),
        });
      }
    }
  } finally {
    for (const id of createdStaff) {
      await api(`/api/staff/${id}/account`, { method: "DELETE", jar: ownerJar });
      await api(`/api/staff/${id}`, { method: "DELETE", jar: ownerJar });
    }
    for (const id of createdServices) {
      await api(`/api/services/${id}`, { method: "DELETE", jar: ownerJar });
    }
  }
}

/**
 * US5 (T089) — foto y horario. La rejilla de 45 minutos no se afirma aquí:
 * el motor de disponibilidad es la slice 5.
 */
async function us5FotoYHorario({ ownerJar, jarA }) {
  console.log("  -- US5 foto y horario (sin rejilla de disponibilidad)");
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  const foto = await api(`/api/staff/${ISO.A.staff}/photo`, {
    method: "PUT",
    jar: jarA,
    headers: { "content-type": "image/png" },
    body: png,
  });
  ok(
    "PUT /api/staff/{A}/photo PNG → 200 photoUrl",
    foto.res.status === 200 && typeof foto.json?.photoUrl === "string",
    `${foto.res.status} ${JSON.stringify(foto.json)}`
  );

  const svg = await api(`/api/staff/${ISO.A.staff}/photo`, {
    method: "PUT",
    jar: jarA,
    headers: { "content-type": "image/svg+xml" },
    body: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
  });
  ok(
    "PUT foto SVG → 422 unsupported",
    svg.res.status === 422 && svg.json?.error?.code === "unsupported",
    `${svg.res.status} ${JSON.stringify(svg.json)}`
  );

  const vacia = await api(`/api/staff/${ISO.A.staff}/photo`, {
    method: "PUT",
    jar: jarA,
    headers: { "content-type": "image/png" },
    body: Buffer.alloc(0),
  });
  ok(
    "PUT foto vacía → 422 empty",
    vacia.res.status === 422 && vacia.json?.error?.code === "empty",
    `${vacia.res.status} ${JSON.stringify(vacia.json)}`
  );

  const enorme = Buffer.alloc(524289);
  png.copy(enorme);
  const grande = await api(`/api/staff/${ISO.A.staff}/photo`, {
    method: "PUT",
    jar: jarA,
    headers: { "content-type": "image/png" },
    body: enorme,
  });
  ok(
    "PUT foto de 524289 bytes → 413 too_large",
    grande.res.status === 413 && grande.json?.error?.code === "too_large",
    `${grande.res.status} ${JSON.stringify(grande.json)}`
  );

  const deB = await api(`/api/staff/${ISO.B.staff}/photo`, {
    method: "PUT",
    jar: ownerJar,
    headers: { "content-type": "image/png" },
    body: png,
  });
  ok(
    "el dueño sube la foto de B",
    deB.res.status === 200,
    `${deB.res.status} ${JSON.stringify(deB.json)}`
  );
  const ajena = await api(`/api/staff/${ISO.B.staff}/photo`, { jar: jarA });
  ok(
    "staff A GET foto de B → 404",
    ajena.res.status === 404,
    `status ${ajena.res.status}`
  );

  const jarR = newJar();
  const loginR = await login(jarR, "iso-reception@vocero.test", ISO_PASS);
  ok(
    "recepción de US5 inicia sesión",
    loginR.res.status === 200,
    `status ${loginR.res.status}`
  );
  const horas = await api(`/api/staff/${ISO.A.staff}/hours`, {
    method: "PUT",
    jar: jarR,
    body: JSON.stringify({
      weeklyHours: { mon: [{ start: "09:00", end: "12:00" }] },
    }),
  });
  ok(
    "reception PUT /api/staff/{id}/hours → 403",
    horas.res.status === 403,
    `${horas.res.status} ${JSON.stringify(horas.json)}`
  );

  pendiente(
    "huecos de 45 minutos en availability",
    false,
    "Slice 5",
    "la rejilla llega con el motor de disponibilidad"
  );
}

const ISO_PASS = "password-aislamiento-123";
const ISO = {
  A: { email: "iso-staff-a@vocero.test", name: "Staff A", staff: "st_e2eisoA", booking: "bk_e2eisoA" },
  B: { email: "iso-staff-b@vocero.test", name: "Staff B", staff: "st_e2eisoB", booking: "bk_e2eisoB" },
  C: { email: "iso-staff-c@vocero.test", name: "Staff sin perfil" },
  D: { email: "iso-staff-d@vocero.test", name: "Staff desactivado", staff: "st_e2eisoD" },
};
const ISO_STAFF_IDS = [ISO.A.staff, ISO.B.staff, ISO.D.staff];
const ISO_BOOKING_IDS = [ISO.A.booking, ISO.B.booking];

async function aislamientoChecks() {
  const encendida = /^(on|1|true|si|sí|yes)$/i.test(
    (process.env.AGENDA ?? "").trim()
  );
  console.log("\n== 018: aislamiento por actor (roles, alcance, deny-by-default) ==");

  const dbUrl = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(dbUrl).hostname;
  } catch {}
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    ok(
      "aislamiento: DATABASE_URL local (la siembra por SQL nunca toca una BD remota)",
      false,
      "DATABASE_URL ausente o no local"
    );
    return;
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, { max: 2 });

  const limpiar = async () => {
    await sql`delete from booking where id = any(${ISO_BOOKING_IDS})`;
    await sql`delete from staff where id = any(${ISO_STAFF_IDS})`;
  };

  try {
    await limpiar();

    // ---- siembra: 4 cuentas de equipo con rol staff (dueño = jar global) ----
    const ownerJar = { cookie };
    for (const key of ["A", "B", "C", "D"]) {
      const acc = ISO[key];
      const r = await api("/api/settings/team", {
        method: "POST",
        jar: ownerJar,
        body: JSON.stringify({
          name: acc.name,
          email: acc.email,
          password: ISO_PASS,
          role: "staff",
        }),
      });
      ok(
        `alta de cuenta staff ${key} (201, o 409 en re-corrida)`,
        r.res.status === 201 || r.res.status === 409,
        `status ${r.res.status}`
      );
    }
    const members = await sql`
      select u.email, m.id as member_id, m.role, m.organization_id
      from member m join "user" u on u.id = m.user_id
      where u.email = any(${Object.values(ISO).map((a) => a.email)})`;
    const byEmail = Object.fromEntries(members.map((m) => [m.email, m]));
    ok(
      "las cuentas de equipo nacen con rol `staff`",
      Object.values(ISO).every((a) => byEmail[a.email]?.role === "staff")
    );
    const orgId = byEmail[ISO.A.email]?.organization_id;
    const [svc] = await sql`select id from service where organization_id = ${orgId} order by position limit 1`;
    if (!orgId || !svc) {
      ok("siembra: organización y servicio base existen", false);
      return;
    }
    // Perfiles sembrados por SQL a propósito. T033 no los cambia: los ids fijos
    // (`st_e2eisoA`…) y las citas de la fase 2 dependen de ellos, y con la
    // agenda apagada POST /api/staff responde 404. La ruta de cuenta se prueba
    // en el bloque US1, solo con la bandera encendida.
    for (const key of ["A", "B", "D"]) {
      const acc = ISO[key];
      await sql`insert into staff (id, organization_id, member_id, display_name, active, position)
        values (${acc.staff}, ${orgId}, ${byEmail[acc.email].member_id}, ${acc.name},
                ${key !== "D"}, ${100 + ISO_STAFF_IDS.indexOf(acc.staff)})`;
    }
    await sql`insert into booking (id, organization_id, kind, status, scheduled_at, duration_minutes, staff_id, service_id, price_cents, currency)
      values (${ISO.A.booking}, ${orgId}, 'session', 'agendada', now() + interval '30 days', 30, ${ISO.A.staff}, ${svc.id}, 0, 'MXN'),
             (${ISO.B.booking}, ${orgId}, 'session', 'agendada', now() + interval '31 days', 30, ${ISO.B.staff}, ${svc.id}, 0, 'MXN')`;

    const jarA = newJar();
    const jarB = newJar();
    const jarC = newJar();
    const jarD = newJar();
    const logins = await Promise.all([
      login(jarA, ISO.A.email, ISO_PASS),
      login(jarB, ISO.B.email, ISO_PASS),
      login(jarC, ISO.C.email, ISO_PASS),
      login(jarD, ISO.D.email, ISO_PASS),
    ]);
    ok(
      "las 4 cuentas staff inician sesión (una jar por usuario)",
      logins.every((l) => l.res.status === 200),
      logins.map((l) => l.res.status).join(",")
    );

    // ---- GET /api/me ----
    console.log("  -- /api/me y roles");
    const meOwner = await api("/api/me", { jar: ownerJar });
    ok("GET /api/me del dueño → 200 role owner", meOwner.res.status === 200 && meOwner.json?.role === "owner", `status ${meOwner.res.status}`);
    ok("el dueño no tiene staffId", meOwner.json?.staffId === null);
    ok(
      `/api/me informa agendaEnabled:${encendida}`,
      meOwner.json?.agendaEnabled === encendida
    );
    const meA = await apiAsync("/api/me", { jar: jarA });
    ok("staff A: /api/me → 200 role staff con su staffId", meA.res.status === 200 && meA.json?.role === "staff" && meA.json?.staffId === ISO.A.staff, JSON.stringify(meA.json));
    const meC = await apiAsync("/api/me", { jar: jarC });
    ok("staff sin perfil: /api/me → 200 staffId null", meC.res.status === 200 && meC.json?.role === "staff" && meC.json?.staffId === null, JSON.stringify(meC.json));

    // ---- (4) superficies vedadas para staff ----
    console.log("  -- (4) superficies vedadas para staff → 403 exacto");
    for (const ruta of [
      "/api/conversations",
      "/api/contacts",
      "/api/pipeline/board",
      "/api/lab/runs",
      "/api/settings/team",
      "/api/calendar/settings",
      "/api/templates",
      "/api/agent/profile",
    ]) {
      const r = await apiAsync(ruta, { jar: jarA });
      ok(`staff A GET ${ruta} → 403`, r.res.status === 403, `status ${r.res.status}`);
    }
    const nuevoEquipo = await apiAsync("/api/settings/team", {
      method: "POST",
      jar: jarA,
      body: JSON.stringify({ name: "x", email: "x@vocero.test", password: "password-x-123", role: "staff" }),
    });
    ok("staff A no puede crear cuentas de equipo → 403", nuevoEquipo.res.status === 403, `status ${nuevoEquipo.res.status}`);
    // El tablero global lo crea la Slice 5: hasta entonces la ruta no existe (404).
    {
      const r = await apiAsync("/api/calendar/board", { jar: jarA });
      pendiente("staff A GET /api/calendar/board → 403", r.res.status === 403, "Slice 5", `status ${r.res.status}`);
    }

    console.log("  -- (4) mutaciones del plugin de organización → rechazadas");
    const memberA = byEmail[ISO.A.email].member_id;
    const escalada = await apiAsync("/api/auth/organization/update-member-role", {
      method: "POST",
      jar: jarA,
      body: JSON.stringify({ memberId: memberA, role: "owner", organizationId: orgId }),
    });
    ok("staff A: update-member-role → 403", escalada.res.status === 403, `status ${escalada.res.status}`);
    const invitar = await apiAsync("/api/auth/organization/invite-member", {
      method: "POST",
      jar: jarA,
      body: JSON.stringify({ email: "intruso@vocero.test", role: "owner", organizationId: orgId }),
    });
    ok("staff A: invite-member → 403", invitar.res.status === 403, `status ${invitar.res.status}`);
    const [rolDespues] = await sql`select role from member where id = ${memberA}`;
    ok("el rol de staff A sigue siendo `staff` tras el intento de escalada", rolDespues?.role === "staff", rolDespues?.role);

    console.log("  -- (4) páginas: el staff se redirige a su agenda (UX; la defensa real son las APIs)");
    for (const ruta of ["/inbox", "/contacts", "/pipeline", "/agent", "/lab", "/bookings", "/settings/team"]) {
      const r = await fetch(`${BASE}${ruta}`, {
        redirect: "manual",
        headers: { cookie: jarA.cookie },
      });
      const destino = r.headers.get("location") ?? "";
      ok(
        `staff A GET ${ruta} → redirige a /my-agenda`,
        [307, 308].includes(r.status) && destino.endsWith("/my-agenda"),
        `status ${r.status} → ${destino}`
      );
    }
    {
      const r = await fetch(`${BASE}/inbox`, {
        redirect: "manual",
        headers: { cookie: ownerJar.cookie },
      });
      ok("el dueño sigue entrando a /inbox → 200", r.status === 200, `status ${r.status}`);
    }

    // ---- SSE ----
    console.log("  -- SSE: el stream respeta el rol");
    const sseA = await abrirEventos(jarA);
    ok("staff A: /api/events → 200 text/event-stream", sseA.status === 200 && sseA.type === "text/event-stream", `status ${sseA.status}`);
    const sseC = await abrirEventos(jarC);
    ok("staff sin perfil: /api/events → 200 (stream abierto, sin eventos)", sseC.status === 200, `status ${sseC.status}`);
    const sseOwner = await abrirEventos(ownerJar);
    ok("dueño: /api/events → 200", sseOwner.status === 200, `status ${sseOwner.status}`);

    // ---- (5) cuenta sin perfil / desactivada ----
    console.log("  -- (5) cuenta staff sin perfil y con perfil desactivado");
    {
      const r = await apiAsync("/api/settings/whatsapp", { jar: jarC });
      ok("staff sin perfil: ruta de ajustes → 403", r.res.status === 403, `status ${r.res.status}`);
      const w = await apiAsync("/api/bookings", {
        method: "POST",
        jar: jarC,
        body: JSON.stringify({}),
      });
      ok("staff sin perfil: escritura POST /api/bookings → 403", w.res.status === 403, `status ${w.res.status}`);
      const l = await apiAsync("/api/bookings", { jar: jarC });
      pendiente(
        "staff sin perfil: GET /api/bookings → 200 con lista vacía",
        l.res.status === 200 && (l.json?.bookings ?? []).length === 0,
        "US3",
        `status ${l.res.status}`
      );
    }
    const meD = await apiAsync("/api/me", { jar: jarD });
    ok("perfil desactivado: /api/me → 403 account_disabled", meD.res.status === 403 && meD.json?.error?.code === "account_disabled", `${meD.res.status} ${JSON.stringify(meD.json)}`);
    const conD = await apiAsync("/api/conversations", { jar: jarD });
    ok("perfil desactivado: cualquier ruta → 403 account_disabled", conD.res.status === 403 && conD.json?.error?.code === "account_disabled", `${conD.res.status} ${JSON.stringify(conD.json)}`);
    const sseD = await abrirEventos(jarD);
    ok("perfil desactivado: /api/events → 403 account_disabled", sseD.status === 403 && sseD.json?.error?.code === "account_disabled", `${sseD.status} ${JSON.stringify(sseD.json)}`);

    // ---- (1) lectura cruzada (US3: en rojo hasta implementarla) ----
    console.log("  -- (1) lectura cruzada entre profesionales (US3)");
    {
      const r = await apiAsync(`/api/bookings/${ISO.B.booking}`, { jar: jarA });
      pendiente("staff A GET /api/bookings/{cita de B} → 404", r.res.status === 404, "US3", `status ${r.res.status}`);
      const own = await apiAsync(`/api/bookings/${ISO.A.booking}`, { jar: jarA });
      pendiente("staff A GET /api/bookings/{su cita} → 200", own.res.status === 200, "US3", `status ${own.res.status}`);
      const list = await apiAsync("/api/bookings", { jar: jarA });
      const ids = (list.json?.bookings ?? []).map((b) => b.id);
      pendiente(
        "staff A GET /api/bookings no contiene citas de B",
        list.res.status === 200 && !ids.includes(ISO.B.booking) && ids.includes(ISO.A.booking),
        "US3",
        `status ${list.res.status}`
      );
    }

    // ---- (9) bandera de la agenda ----
    console.log("  -- (9) bandera de la agenda");
    if (!encendida) {
      for (const ruta of ["/api/staff", "/api/services", "/api/calendar/board"]) {
        const r = await api(ruta, { jar: ownerJar });
        ok(`bandera apagada: GET ${ruta} → 404`, r.res.status === 404, `status ${r.res.status}`);
      }
      ok("bandera apagada: /api/me informa agendaEnabled:false", meOwner.json?.agendaEnabled === false);
    } else {
      ok("bandera encendida: /api/me informa agendaEnabled:true", meOwner.json?.agendaEnabled === true);
      await us1EquipoCatalogo({ ownerJar, jarA });
      await us5FotoYHorario({ ownerJar, jarA });
    }
  } finally {
    await limpiar().catch((e) => console.log(`  (limpieza falló: ${e})`));
    await sql.end({ timeout: 5 });
    if (pendientes > 0) {
      console.log(`  (${pendientes} verificación(es) PENDIENTE: pertenecen a slices siguientes y se activan allí)`);
    }
  }
}
