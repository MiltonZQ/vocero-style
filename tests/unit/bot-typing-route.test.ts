import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/** POST /api/bot/typing keeps its contract after sharing the helper with the agent. */

const h = vi.hoisted(() => ({ db: null as unknown, graph: vi.fn(), creds: vi.fn() }));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: h.graph };
});
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg: h.creds }));
vi.mock("@/server/bot/auth", () => ({
  requireBotKey: () => null,
  resolveInstanceOrg: async () => "org1",
}));

let eph: EphemeralDb;
let POST: (req: Request) => Promise<Response>;

const post = (conversationId: string) =>
  POST(new Request("http://x/api/bot/typing", { method: "POST", body: JSON.stringify({ conversationId }) }));

beforeAll(async () => {
  eph = await openEphemeralDb();
  await eph.applyMigrations();
  h.db = drizzle(eph.sql, { schema });
  await eph.run(`
    INSERT INTO organization (id, name, slug) VALUES ('org1', 'Style', 'style');
    INSERT INTO contact (id, organization_id, name, wa_identity) VALUES
      ('ct1', 'org1', 'Uno', '5215500000001'), ('ct2', 'org1', 'Dos', '5215500000002'),
      ('ct3', 'org1', 'Tres', '5215500000003');
    INSERT INTO conversation (id, organization_id, contact_id, is_test, ai_enabled, last_inbound_at) VALUES
      ('cv_real', 'org1', 'ct1', false, true, now()),
      ('cv_test', 'org1', 'ct2', true, true, now()),
      ('cv_off', 'org1', 'ct3', false, false, now());
  `);
  ({ POST } = (await import("@/app/api/bot/typing/route")) as unknown as { POST: typeof POST });
});

afterAll(async () => {
  await eph.dropAll();
});

beforeEach(async () => {
  h.graph.mockReset();
  h.graph.mockResolvedValue({ success: true });
  h.creds.mockReset();
  h.creds.mockResolvedValue({ phoneNumberId: "pn1", token: "tok" });
  await eph.run(`DELETE FROM message`);
  await eph.run(`
    INSERT INTO message (id, organization_id, conversation_id, direction, type, text, status, wa_message_id, created_at)
    VALUES ('m_old', 'org1', 'cv_real', 'in', 'text', 'a', 'delivered', 'wamid.OLD', now() - interval '5 minutes'),
           ('m_new', 'org1', 'cv_real', 'in', 'text', 'b', 'delivered', 'wamid.NEW', now()),
           ('m_t', 'org1', 'cv_test', 'in', 'text', 'b', 'delivered', 'wamid.T', now()),
           ('m_o', 'org1', 'cv_off', 'in', 'text', 'b', 'delivered', 'wamid.O', now())
  `);
});

describeDb("POST /api/bot/typing (real DB)", () => {
  it("marks the LATEST inbound message read with the typing indicator", async () => {
    const res = await post("cv_real");
    expect(await res.json()).toEqual({ ok: true });
    expect(h.graph).toHaveBeenCalledWith(
      "pn1/messages",
      expect.objectContaining({
        body: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.NEW",
          typing_indicator: { type: "text" },
        },
      })
    );
  });

  it("never touches Meta for a Laboratorio conversation or a paused one", async () => {
    expect(await (await post("cv_test")).json()).toEqual({ ok: false, reason: "sandbox" });
    expect(await (await post("cv_off")).json()).toEqual({ ok: false, reason: "ai_paused" });
    expect(h.graph).not.toHaveBeenCalled();
  });

  it("answers no_inbound when there is no WhatsApp message id", async () => {
    await eph.run(`DELETE FROM message WHERE conversation_id = 'cv_real'`);
    expect(await (await post("cv_real")).json()).toEqual({ ok: false, reason: "no_inbound" });
  });

  it("409 without a WhatsApp connection; a Meta failure is a 200 {ok:false}", async () => {
    h.creds.mockResolvedValue(null);
    expect((await post("cv_real")).status).toBe(409);
    h.creds.mockResolvedValue({ phoneNumberId: "pn1", token: "tok" });
    h.graph.mockRejectedValue(new Error("down"));
    const res = await post("cv_real");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "meta_error" });
  });
});
