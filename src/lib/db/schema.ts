import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ============================================================
 * Auth (Better Auth + plugin organization)
 * ============================================================ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  metadata: text("metadata"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/* ============================================================
 * Dominio (toda tabla lleva organization_id NOT NULL + índice org-first)
 * ============================================================ */

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Llave de resolución WhatsApp (003): teléfono normalizado (521→52) o
     * `bsuid:<id>` cuando Meta no manda wa_id. Estable de por vida.
     */
    /**
     * 014: canal por el que vive este contacto. Aditivo y con default: toda
     * fila existente sigue significando exactamente lo mismo.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger"] })
      .notNull()
      .default("whatsapp"),
    /**
     * Llave de resolucion. WhatsApp: telefono normalizado (521 a 52) o
     * `bsuid:<id>`. Instagram (014): `ig:<IGSID>`. Estable de por vida.
     * El nombre `wa_identity` se conserva porque es contrato publicado:
     * `/api/bot/context?waIdentity=...` lo recibe y lo devuelve, y hay
     * cerebros externos que dependen de el.
     */
    waIdentity: text("wa_identity").notNull(),
    /** Teléfono como ATRIBUTO opcional (003): falta en contactos BSUID. */
    phone: text("phone"),
    /** Business-Scoped User ID si se conoce (003). */
    waUserId: text("wa_user_id"),
    name: text("name").notNull(),
    /**
     * Quién puso este nombre.
     *
     * `perfil` = lo trajo WhatsApp y puede seguir actualizandose solo;
     * `manual` = lo escribio una persona en el CRM y NADIE lo pisa.
     *
     * Existe porque las dos cosas se necesitan a la vez: un contacto que
     * cambia su nombre de WhatsApp tiene que reflejarse (#51), y el operador
     * que renombro a alguien como "Juan - obra Polanco" no puede perder ese
     * trabajo con el siguiente mensaje.
     */
    nameSource: text("name_source", { enum: ["perfil", "manual"] })
      .notNull()
      .default("perfil"),
    notes: text("notes"),
    /**
     * Ficha de calificación que levanta un cerebro externo por
     * `PUT /api/bot/ficha`. Es un objeto libre a propósito: los datos que
     * importan de un lead los define cada negocio (una clínica querrá
     * "tratamiento", una constructora "metros"), y cablearlos como columnas
     * obligaría a migrar el CRM cada vez que alguien cambia su cuestionario.
     * Merge campo a campo; `null` explícito borra la clave.
     */
    ficha: jsonb("ficha").$type<Record<string, unknown>>(),
    /**
     * De dónde salió el prospecto. NULL = nadie la capturó, y entonces la API
     * la deduce. Así no hace falta backfill ni marcar en falso los contactos
     * que ya existían.
     */
    source: text("source", {
      enum: ["anuncio", "organico", "referido", "conocido", "otro"],
    }),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // 014: el canal entra en la llave. Sin el, un IGSID que coincidiera con
    // un telefono normalizado mezclaria dos personas en silencio.
    uniqueIndex("contact_org_channel_identity_uq").on(
      t.organizationId,
      t.channel,
      t.waIdentity
    ),
    index("contact_org_wa_user_id_idx").on(t.organizationId, t.waUserId),
    index("contact_org_name_idx").on(t.organizationId, t.name),
  ]
);

export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** open = etapa normal · won / lost = anclas no borrables */
    kind: text("kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("stage_org_pos_idx").on(t.organizationId, t.position)]
);

export const lead = pgTable(
  "lead",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => pipelineStage.id),
    position: integer("position").notNull().default(0),
    /**
     * Monto de la negociación en CENTAVOS ENTEROS. NULL = nadie lo capturó, que
     * no es lo mismo que cero: un trato sin monto no vale $0, simplemente no se
     * sabe, y el tablero lo dice con palabras en vez de sumar un cero.
     */
    amountCents: integer("amount_cents"),
    /** Moneda del monto; la del negocio al capturarlo (Ajustes → Marca). */
    currency: text("currency"),
    /**
     * Prioridad de cierre. NULL = nadie la ha decidido, que NO es lo mismo que
     * "media": nada la escribe automáticamente, así que el dueño puede confiar
     * en que lo que ve es lo que él puso.
     */
    priority: text("priority", { enum: ["alta", "media", "baja"] }),
    priorityUpdatedAt: timestamp("priority_updated_at"),
    lastActivityAt: timestamp("last_activity_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_contact_uq").on(t.contactId),
    index("lead_org_stage_idx").on(t.organizationId, t.stageId, t.position),
  ]
);

/**
 * Bitácora de movimientos de etapa: append-only. Nada se actualiza ni se borra;
 * corregir un dato es agregar un movimiento nuevo.
 *
 * Es el cimiento de todo lo histórico: sin ella el CRM solo sabe dónde está
 * cada lead HOY, y "¿cuánto cerré en julio?" no tiene respuesta.
 *
 * Regla dura: la ÚNICA puerta que escribe aquí —y que escribe `lead.stage_id`—
 * es `src/server/leads/stage-history.ts`. Un unit test de vigilancia falla si
 * aparece otra escritura, porque un camino que mueva el lead sin registrar el
 * evento no truena: solo hace que las gráficas mientan meses después.
 */
export const leadStageEvent = pgTable(
  "lead_stage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    /** Denormalizado a propósito: casi toda agregación cruza con el contacto,
     *  y el join extra se pagaría en cada consulta. */
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** NULL = el lead nació en `toStage` (evento de creación). */
    fromStageId: text("from_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    fromStageName: text("from_stage_name"),
    toStageId: text("to_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    /** Snapshots: sobreviven al renombre y al borrado de la etapa, para que
     *  reorganizar el tablero de hoy no reescriba el embudo del pasado. */
    toStageName: text("to_stage_name").notNull(),
    toStageKind: text("to_stage_kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    /** Cuándo PASÓ (no cuándo se registró). */
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    /** NULL = no lo movió una persona (bot, sistema, migración). */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source", {
      enum: ["dueno", "bot", "sistema", "migracion"],
    })
      .notNull()
      .default("dueno"),
    /** true = fecha SEMBRADA en la migración, no observada. Cuenta para los
     *  totales pero jamás para promedios de tiempo. */
    approximate: boolean("approximate").notNull().default(false),
    lossReason: text("loss_reason", {
      enum: [
        "precio",
        "no_es_perfil",
        "sin_presupuesto",
        "eligio_otro",
        "nunca_contesto",
        "otro",
      ],
    }),
    lossNote: text("loss_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("lse_org_occurred_idx").on(t.organizationId, t.occurredAt),
    index("lse_lead_occurred_idx").on(t.leadId, t.occurredAt),
    index("lse_org_kind_occurred_idx").on(
      t.organizationId,
      t.toStageKind,
      t.occurredAt
    ),
    // Perder un trato sin motivo es imposible a nivel de BASE, no por
    // disciplina de cada ruta. La excepción es la siembra de la migración: no
    // puede inventar un motivo que nadie capturó.
    check(
      "lse_loss_reason_ck",
      sql`${t.toStageKind} <> 'lost' OR ${t.approximate} = true OR ${t.lossReason} IS NOT NULL`
    ),
  ]
);

export const conversation = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Conversación del Laboratorio: jamás toca la API de WhatsApp. */
    isTest: boolean("is_test").notNull().default(false),
    /**
     * 014: canal de la conversacion. Denormalizado del contacto a proposito:
     * el ruteo de salida y el filtro de la bandeja lo leen en cada mensaje.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger"] })
      .notNull()
      .default("whatsapp"),
    /**
     * 014: identificador del hilo en la plataforma de origen. Zernio entrega
     * un conversationId opaco ("no asumas su formato") que hace falta para
     * responder; WhatsApp no lo necesita y queda null.
     */
    channelThreadRef: text("channel_thread_ref"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    handoffAt: timestamp("handoff_at"),
    handoffReason: text("handoff_reason", {
      // 008: manual_reply = el dueño respondió desde la app del teléfono.
      // hostilidad = el lead se puso agresivo y el agente se retiró.
      enum: [
        "cliente",
        "modelo",
        "error",
        "ventana",
        "hostilidad",
        "manual_reply",
        // 019: bot de barbería.
        "cancelacion",
        "reprogramacion",
        "llegada",
        "atascado",
      ],
    }),
    lastInboundAt: timestamp("last_inbound_at"),
    lastMessageAt: timestamp("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Una conversación real por contacto; las de prueba no compiten.
    uniqueIndex("conversation_org_contact_real_uq")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.isTest} = false`),
    index("conversation_org_last_idx").on(t.organizationId, t.lastMessageAt),
  ]
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** ID de WhatsApp — UNIQUE (idempotencia). Nullable en salientes de prueba. */
    waMessageId: text("wa_message_id").unique(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    type: text("type").notNull().default("text"),
    text: text("text"),
    status: text("status", {
      enum: ["pending", "sent", "delivered", "read", "failed"],
    })
      .notNull()
      .default("pending"),
    error: text("error"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /**
     * 008 — Origen del saliente: IA (bot), operador del CRM, manual desde la
     * app de WhatsApp Business del teléfono (echo), o plantilla. En entrantes
     * queda el default y la UI lo ignora.
     */
    origin: text("origin", {
      enum: ["ai", "operator", "manual", "template"],
    })
      .notNull()
      .default("operator"),
    /** 008 — Adjunto del mensaje (imagen, doc, ubicación…), si lo hay. */
    mediaAssetId: text("media_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    waTimestamp: timestamp("wa_timestamp"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_org_conv_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt
    ),
  ]
);

/**
 * 008 — Adjuntos: archivo (imagen/video/audio/documento/sticker) copiado al
 * volumen local (`MEDIA_DIR`) o contenido estructurado (location/contacts) en
 * `payload`. Meta expira sus archivos (~30 días): el disco propio es la
 * fuente durable (constitución II: sin S3/R2).
 */
export const mediaAsset = pgTable(
  "media_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "contacts",
      ],
    }).notNull(),
    /** media id de Graph (entrantes/salientes subidos); NULL en location/contacts. */
    waMediaId: text("wa_media_id"),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    caption: text("caption"),
    /** location {latitude, longitude, name?, address?} o contacts (subset). */
    payload: jsonb("payload"),
    /** Ruta relativa dentro de MEDIA_DIR; NULL si aún no descargado o no aplica. */
    storagePath: text("storage_path"),
    fetchStatus: text("fetch_status", {
      enum: ["available", "pending", "failed"],
    })
      .notNull()
      .default("pending"),
    fetchError: text("fetch_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_asset_org_idx").on(t.organizationId, t.createdAt),
    index("media_asset_wa_media_idx").on(t.waMediaId),
  ]
);

export const metaCredentials = pgTable(
  "meta_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_credentials_org_uq").on(t.organizationId),
    // El webhook enruta por phone_number_id: debe ser único en la instancia.
    uniqueIndex("meta_credentials_phone_uq").on(t.phoneNumberId),
  ]
);

/**
 * 014 - Credenciales del canal de Instagram. Tabla explicita (no un jsonb
 * generico) porque unas credenciales tienen forma fija y conocida: asi
 * conservan tipado e indices. El token se cifra con los mismos helpers que el
 * de WhatsApp; un segundo mecanismo de cifrado seria un segundo mecanismo que
 * auditar.
 */
export const instagramCredentials = pgTable(
  "instagram_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] }).notNull(),
    /** IG_ID del perfil profesional: por el enruta el webhook. */
    igUserId: text("ig_user_id").notNull(),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** Secreto HMAC de las entregas (Zernio); null en modo Meta. */
    webhookSecret: text("webhook_secret"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instagram_credentials_org_uq").on(t.organizationId),
    uniqueIndex("instagram_credentials_ig_user_uq").on(t.igUserId),
    index("instagram_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 017 — Credenciales del canal de Messenger: la página de Facebook y su token
 * de acceso, cifrado con el mismo AES-256-GCM que los demás. Tabla propia y
 * explícita, como la de Instagram: unas credenciales tienen forma fija y
 * conocida, y esconderlas en un jsonb perdería el tipado y los índices.
 */
export const messengerCredentials = pgTable(
  "messenger_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] })
      .notNull()
      .default("meta"),
    /**
     * ID de la página de Facebook: por él enruta el webhook de Meta
     * (`entry[].id`). En modo Zernio puede no conocerse — ahí enruta
     * `account_ref` — así que es opcional.
     */
    pageId: text("page_id"),
    pageName: text("page_name"),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** Secreto HMAC de las entregas (Zernio); null en modo Meta. */
    webhookSecret: text("webhook_secret"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messenger_credentials_org_uq").on(t.organizationId),
    uniqueIndex("messenger_credentials_page_uq").on(t.pageId),
    index("messenger_credentials_account_ref_idx").on(t.accountRef),
  ]
);

export const agentProfile = pgTable(
  "agent_profile",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    name: text("name").notNull().default("Asistente"),
    tone: text("tone"),
    instructions: text("instructions"),
    escalationRules: text("escalation_rules"),
    greeting: text("greeting"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_profile_org_uq").on(t.organizationId)]
);

export const kbEntry = pgTable(
  "kb_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["qa", "block"] }).notNull(),
    question: text("question"),
    answer: text("answer"),
    content: text("content"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("kb_org_idx").on(t.organizationId)]
);

export const template = pgTable(
  "template",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    rejectionReason: text("rejection_reason"),
    waTemplateId: text("wa_template_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_org_name_lang_uq").on(
      t.organizationId,
      t.name,
      t.language
    ),
  ]
);

export const agentTestRun = pgTable(
  "agent_test_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    score: integer("score"),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Lock de concurrencia en BD: máximo 1 corrida activa por organización.
    uniqueIndex("test_run_org_running_uq")
      .on(t.organizationId)
      .where(sql`${t.status} = 'running'`),
    index("test_run_org_idx").on(t.organizationId, t.startedAt),
  ]
);

/* ============================================================
 * 015 — Motor de agenda (detrás de la bandera AGENDA)
 *
 * Las tablas se crean SIEMPRE, encendida o apagada la bandera: una tabla
 * vacía es inerte, y a cambio todas las instancias del mundo comparten la
 * misma estructura y la misma cadena de migraciones (ADR-001).
 * ============================================================ */

/** Configuración de la agenda del negocio: una fila por organización. */
export const calendarSettings = pgTable(
  "calendar_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `{"mon":[{"start":"09:00","end":"18:00"}]}` — hora de PARED, no UTC. */
    weeklyHours: jsonb("weekly_hours").notNull(),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    minNoticeHours: integer("min_notice_hours").notNull().default(2),
    maxDaysAhead: integer("max_days_ahead").notNull().default(7),
    timezone: text("timezone").notNull().default("America/Mexico_City"),
    /**
     * Cómo se entrega la reunión. `enlace-fijo` no habla con nadie: es el
     * default y la razón de que encender la agenda no exija terceros.
     * Un fork agrega el suyo al catálogo del código sin tocar esta columna.
     */
    connector: text("connector").notNull().default("enlace-fijo"),
    /** Sala fija del conector `enlace-fijo`; null ⇒ citas sin link. */
    meetingLink: text("meeting_link"),
    /** 019 — dirección física del negocio (citas presenciales). */
    locationAddress: text("location_address"),
    /** 019 — enlace de Google Maps del negocio. */
    locationMapsUrl: text("location_maps_url"),
    /** 019 — minutos de anticipación que se le piden al cliente al llegar. */
    arrivalLeadMinutes: integer("arrival_lead_minutes").notNull().default(5),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calendar_settings_org_uq").on(t.organizationId),
    check(
      "calendar_settings_arrival_lead_ck",
      sql`${t.arrivalLeadMinutes} between 0 and 120`
    ),
  ]
);

/** `bytea` no tiene tipo nativo en Drizzle 0.38. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Columna GENERADA ALWAYS ... STORED: la define el SQL; Drizzle solo la lee.
 * Nunca debe aparecer en un INSERT/UPDATE (por eso los `.values()` no la
 * incluyen y el tipo de inserción la marca opcional).
 */
const generatedTimestamp = customType<{ data: Date; driverData: string }>({
  dataType() {
    return "timestamp";
  },
  fromDriver(value) {
    return new Date(value.endsWith("Z") ? value : `${value}Z`);
  },
});

/* ============================================================
 * 018 — Agenda multi-profesional
 *
 * Mismo trato que la 015: tablas SIEMPRE creadas, bandera `AGENDA` apagada ⇒
 * inertes. `staff_service` y `staff_photo` usan clave natural (sin prefijo).
 * ============================================================ */

/** El profesional: una columna del calendario. Desactivar ≠ borrar. */
export const staff = pgTable(
  "staff",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** La cuenta de acceso; NULL = perfil sin cuenta. */
    memberId: text("member_id").references(() => member.id, {
      onDelete: "set null",
    }),
    displayName: text("display_name").notNull(),
    /** Oficio libre, normalizado a minúsculas. Dato de perfil, NO de permisos. */
    jobTitle: text("job_title"),
    bio: text("bio"),
    phone: text("phone"),
    /** `#RRGGBB`: color de la columna en el calendario. */
    color: text("color").notNull().default("#0d5bff"),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    /** Misma forma que `calendar_settings.weekly_hours`; NULL ⇒ hereda el del local. */
    weeklyHours: jsonb("weekly_hours"),
    /** 0 = sin foto; sube en cada carga (cache-busting de `?v=`). */
    photoVersion: integer("photo_version").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("staff_org_active_idx").on(t.organizationId, t.active, t.position),
    // Una cuenta ↔ un perfil.
    uniqueIndex("staff_member_uq")
      .on(t.memberId)
      .where(sql`${t.memberId} is not null`),
  ]
);

/**
 * La foto vive en la propia instancia (sin S3/R2: Constitución II). Tabla
 * aparte a propósito: ningún `SELECT ... FROM staff` arrastra bytes.
 */
export const staffPhoto = pgTable(
  "staff_photo",
  {
    staffId: text("staff_id")
      .primaryKey()
      .references(() => staff.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Derivado de los BYTES, no del header que mande el cliente. */
    mime: text("mime", {
      enum: ["image/jpeg", "image/png", "image/webp"],
    }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("staff_photo_org_idx").on(t.organizationId),
    check("staff_photo_size_ck", sql`${t.sizeBytes} <= 524288`),
  ]
);

/** El catálogo del dueño: un precio único por servicio. */
export const service = pgTable(
  "service",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    priceCents: integer("price_cents").notNull().default(0),
    /** ISO-4217 en mayúsculas. */
    currency: text("currency").notNull().default("MXN"),
    /** Oficio al que aplica: sugerencia de filtrado, NO restricción. */
    jobTitle: text("job_title"),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("service_org_active_idx").on(t.organizationId, t.active, t.position),
    check(
      "service_duration_ck",
      sql`${t.durationMinutes} between 5 and 600`
    ),
    check("service_price_ck", sql`${t.priceCents} >= 0`),
    check("service_currency_ck", sql`char_length(${t.currency}) = 3`),
  ]
);

/**
 * Qué servicios hace cada profesional. SIN columna de precio: el ataque
 * "staff cambia el precio" no tiene dónde aterrizar a nivel de esquema.
 */
export const staffService = pgTable(
  "staff_service",
  {
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Duración propia del profesional; NULL ⇒ la del catálogo. */
    durationMinutes: integer("duration_minutes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.staffId, t.serviceId] }),
    index("staff_service_org_service_idx").on(t.organizationId, t.serviceId),
    check(
      "staff_service_duration_ck",
      sql`${t.durationMinutes} is null or ${t.durationMinutes} between 5 and 600`
    ),
  ]
);

/**
 * La cita. Una sola tabla para sesiones y bloqueos manuales: un bloqueo es
 * una cita sin contacto que ocupa agenda igual.
 */
export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["session", "block"] })
      .notNull()
      .default("session"),
    status: text("status", {
      enum: ["agendada", "realizada", "no_show", "cancelada"],
    })
      .notNull()
      .default("agendada"),
    source: text("source", { enum: ["manual", "ai"] })
      .notNull()
      .default("manual"),
    contactId: text("contact_id").references(() => contact.id, {
      onDelete: "cascade",
    }),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    leadId: text("lead_id").references(() => lead.id, { onDelete: "set null" }),
    /** Instante UTC. El horario semanal es de pared; esto ya está resuelto. */
    scheduledAt: timestamp("scheduled_at").notNull(),
    /** Capturada al crear: cambiar la configuración no reescribe el pasado. */
    durationMinutes: integer("duration_minutes").notNull(),
    /**
     * Con qué conector nació la ENTREGA. Reprogramar y cancelar hablan con
     * ESTE, no con el activo: si el negocio cambia de proveedor, las citas ya
     * confirmadas siguen viviendo donde se crearon.
     */
    connector: text("connector"),
    /** Id de la reunión/evento en el proveedor; null en `enlace-fijo`. */
    externalRef: text("external_ref"),
    /**
     * El link que se le dio al cliente. Se COPIA, no se lee de la
     * configuración: la cita es un hecho histórico, no una vista del presente.
     */
    meetingLink: text("meeting_link"),
    /**
     * El proveedor falló al crear la reunión. La cita existe igual —un tercero
     * caído no cuesta la conversión— y el operador reintenta desde "Citas".
     */
    linkPending: boolean("link_pending").notNull().default(false),
    /** Conversación del Laboratorio: jamás llama a un conector real. */
    isTest: boolean("is_test").notNull().default(false),
    notes: text("notes"),
    /**
     * 018 — el profesional. Obligatorio en `session`; en `block` es el
     * bloqueo personal, o NULL = bloqueo de todo el local. RESTRICT: un
     * profesional con citas jamás se borra (se desactiva).
     */
    staffId: text("staff_id").references(() => staff.id, {
      onDelete: "restrict",
    }),
    /** 018 — el servicio reservado. Obligatorio en `session`, NULL en `block`. */
    serviceId: text("service_id").references(() => service.id, {
      onDelete: "restrict",
    }),
    /** 018 — precio COPIADO del catálogo al reservar (la cita es un hecho). */
    priceCents: integer("price_cents"),
    currency: text("currency"),
    /**
     * 018 — fin de la cita: columna GENERADA (`scheduled_at + duration`), la
     * define el SQL de la 0014 y Drizzle nunca la escribe. Es lo que el
     * `EXCLUDE` necesita para comparar rangos.
     */
    endsAt: generatedTimestamp("ends_at"),
    /**
     * 018 — solo la migración la pone en true: citas legadas que ya se
     * solapaban antes de existir el constraint (research D2). Quedan fuera
     * del `EXCLUDE`; cualquier UPDATE que las normalice la baja a false.
     */
    legacyOverlap: boolean("legacy_overlap").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_org_when_idx").on(t.organizationId, t.scheduledAt),
    index("booking_org_status_idx").on(t.organizationId, t.status),
    index("booking_org_staff_when_idx").on(
      t.organizationId,
      t.staffId,
      t.scheduledAt
    ),
    /*
     * El CHECK `booking_session_has_staff_service` y el `EXCLUDE`
     * `booking_staff_no_overlap` (la garantía anti doble-booking por
     * profesional, que reemplazó al índice único `booking_org_active_slot_uq`
     * de la 015) viven SOLO en drizzle/0014: Drizzle no sabe expresar un
     * EXCLUDE y `db:generate` no los ve ni los toca.
     */
  ]
);

/**
 * La memoria de lo ofrecido. Es lo que hace verificable el requisito
 * innegociable: sin fila aquí, no hay reserva.
 *
 * Vive en el CRM y no en quien conduce la conversación porque Vocero promete
 * "conecta TU propio cerebro": con la garantía del lado del cliente, cualquier
 * cerebro podría reservar un instante que jamás se ofreció y el CRM lo
 * aceptaría.
 */
export const offeredSlot = pgTable(
  "offered_slot",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    startUtc: timestamp("start_utc").notNull(),
    /** La etiqueta EXACTA que se le mostró al cliente. */
    label: text("label").notNull(),
    /** 018 — el profesional dueño de ESE hueco. NULL = oferta previa a la 018. */
    staffId: text("staff_id").references(() => staff.id, {
      onDelete: "cascade",
    }),
    serviceId: text("service_id").references(() => service.id, {
      onDelete: "cascade",
    }),
    /** 018 — la duración efectiva ofrecida: la reserva usa esta, no recalcula. */
    durationMinutes: integer("duration_minutes"),
    /** 018 — el cliente pidió "cualquiera": permite reasignar si hubo carrera. */
    anyStaff: boolean("any_staff").notNull().default(false),
    offeredAt: timestamp("offered_at").notNull().defaultNow(),
  },
  (t) => [index("offered_slot_conv_idx").on(t.conversationId, t.startUtc)]
);

/**
 * 019 — Borrador de reserva del bot: lo que el cliente ya decidió (servicio,
 * profesional, preferencia de horario). Una fila por conversación; el paso
 * (`need_service` ... ) se DERIVA de ella, no se guarda. Caduca a las 24 h.
 */
export const bookingDraft = pgTable(
  "booking_draft",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => service.id, {
      onDelete: "set null",
    }),
    /** Id de profesional o el literal `any`. */
    staffChoice: text("staff_choice"),
    /** `{day?, from?, to?}` tal como lo emitió el modelo (día relativo). */
    when: jsonb("when").$type<{ day?: string; from?: string; to?: string }>(),
    stuckTurns: integer("stuck_turns").notNull().default(0),
    failedTurns: integer("failed_turns").notNull().default(0),
    lastStep: text("last_step"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("booking_draft_conversation_uq").on(t.conversationId)]
);

/**
 * Credenciales del conector Zoom (app Server-to-Server del propio negocio).
 * Tabla explícita como las de WhatsApp e Instagram: unas credenciales tienen
 * forma fija y conocida, y así conservan tipado e índices. El secreto se cifra
 * con los mismos helpers; un segundo mecanismo sería otro que auditar.
 */
export const zoomCredentials = pgTable(
  "zoom_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    clientId: text("client_id").notNull(),
    secretCipher: text("secret_cipher").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    /** `error` SE ESCRIBE cuando el proveedor rechaza la autenticación. */
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoom_credentials_org_uq").on(t.organizationId)]
);

/**
 * Credenciales del conector Google (Calendar + Meet), de la app de Google
 * Cloud del propio negocio. DOS secretos cifrados: el client secret y el
 * refresh token pegado una sola vez.
 */
export const googleCredentials = pgTable(
  "google_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretCipher: text("client_secret_cipher").notNull(),
    clientSecretIv: text("client_secret_iv").notNull(),
    clientSecretTag: text("client_secret_tag").notNull(),
    refreshTokenCipher: text("refresh_token_cipher").notNull(),
    refreshTokenIv: text("refresh_token_iv").notNull(),
    refreshTokenTag: text("refresh_token_tag").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("google_credentials_org_uq").on(t.organizationId)]
);

export const agentTestCase = pgTable(
  "agent_test_case",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentTestRun.id, { onDelete: "cascade" }),
    persona: text("persona").notNull(),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    transcript: jsonb("transcript"),
    veredicto: text("veredicto", { enum: ["verde", "amarillo", "rojo"] }),
    hallazgos: jsonb("hallazgos"),
    status: text("status", {
      enum: ["pending", "running", "done", "judge_failed"],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("test_case_run_idx").on(t.runId)]
);

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API
 * (detrás de la bandera ATRIBUCION)
 * ============================================================ */

/**
 * De qué anuncio vino una conversación. El primer referral gana: el UNIQUE de
 * abajo es lo que vuelve idempotente la captura ante los reintentos de Meta,
 * en vez de un "consulta y luego inserta" que dos webhooks simultáneos
 * ganarían los dos.
 */
export const adAttribution = pgTable(
  "ad_attribution",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /**
     * El identificador del clic en el anuncio. Es la llave de TODO: sin él no
     * hay nada que reportarle a Meta. Nullable porque hay referrals sin clid.
     */
    ctwaClid: text("ctwa_clid"),
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
    mediaType: text("media_type"),
    /**
     * Payload íntegro del referral. Es la póliza contra "Meta agregó un campo":
     * nada se pierde y un fork puede pintar el creativo sin migrar nada.
     */
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_attribution_org_conversation_uq").on(
      t.organizationId,
      t.conversationId
    ),
    index("ad_attribution_org_contact_idx").on(t.organizationId, t.contactId),
  ]
);

/**
 * Cada intento de reportarle un desenlace a Meta. Las filas `skipped` no son
 * basura: son la respuesta a "¿por qué este lead no aparece en Meta?", que sin
 * ellas se contesta adivinando.
 */
export const conversionEvent = pgTable(
  "conversion_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    attributionId: text("attribution_id").references(() => adAttribution.id, {
      onDelete: "set null",
    }),
    /** Nombre del catálogo de Meta tal cual (`QualifiedLead`, `Purchase`). */
    eventName: text("event_name").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    /** Motivo legible: por qué se omitió, o qué contestó Meta. */
    error: text("error"),
    /**
     * Acuse del envío. Es la única referencia que Meta pide para rastrear un
     * evento de su lado; sin persistirla, un `sent` no se puede reclamar.
     */
    fbTraceId: text("fb_trace_id"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // El dedup ES este índice: la fila se inserta ANTES de hablar con Meta y
    // con ON CONFLICT DO NOTHING. Dos movimientos simultáneos del mismo lead
    // no pueden mandar dos compras.
    uniqueIndex("conversion_event_org_conv_name_uq").on(
      t.organizationId,
      t.conversationId,
      t.eventName
    ),
    index("conversion_event_org_created_idx").on(
      t.organizationId,
      t.createdAt
    ),
  ]
);

/** Conexión del negocio con su dataset de Meta (token cifrado en reposo). */
export const capiSettings = pgTable(
  "capi_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * Qué etapa significa "lead calificado" PARA ESTE NEGOCIO. Las etapas
     * sembradas de Vocero no incluyen ninguna con ese nombre y cada quien
     * renombra las suyas, así que se elige en vez de adivinarse. NULL = ese
     * evento no se emite. `set null` a propósito: borrar la etapa apaga el
     * evento, no rompe la configuración.
     */
    qualifiedStageId: text("qualified_stage_id").references(
      () => pipelineStage.id,
      { onDelete: "set null" }
    ),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capi_settings_org_uq").on(t.organizationId)]
);
