import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 019 — The shop location pin goes out through the SAME pre-flight as text
 * (sandbox, 24 h window, credentials, recipient) and is persisted like any
 * other outbound message.
 */

const h = vi.hoisted(() => ({ db: null as unknown, graph: vi.fn() }));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: h.graph };
});
vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: async () => ({
    id: "mc1",
    organizationId: "org1",
    wabaId: "waba",
    phoneNumberId: "pn1",
    displayPhoneNumber: null,
    verifiedName: null,
    status: "connected",
    token: "tok",
  }),
  markReconnectRequired: async () => {},
}));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

let eph: EphemeralDb;

beforeAll(async () => {
  eph = await openEphemeralDb();
  await eph.applyMigrations();
  h.db = drizzle(eph.sql, { schema });
  await eph.run(`
    INSERT INTO organization (id, name, slug) VALUES ('org1', 'Style', 'style');
    INSERT INTO contact (id, organization_id, name, wa_identity, phone) VALUES
      ('ct1', 'org1', 'Uno', '5215500000001', '5215500000001'),
      ('ct2', 'org1', 'Dos', '5215500000002', '5215500000002'),
      ('ct3', 'org1', 'Tres', '5215500000003', '5215500000003');
    INSERT INTO conversation (id, organization_id, contact_id, is_test, last_inbound_at) VALUES
      ('cv_real', 'org1', 'ct1', false, now()),
      ('cv_test', 'org1', 'ct2', true, now()),
      ('cv_old', 'org1', 'ct3', false, now() - interval '30 hours');
  `);
});

afterAll(async () => {
  await eph.dropAll();
});

beforeEach(async () => {
  h.graph.mockReset();
  h.graph.mockResolvedValue({ messages: [{ id: "wamid.LOC1" }] });
  await eph.run(`DELETE FROM message; DELETE FROM media_asset;`);
});

const pin = {
  latitude: 4.598865027392155,
  longitude: -74.1632885539481,
  name: "Style",
  address: "Av. Juárez 123, Col. Centro",
};

describeDb("sendStructured location (real DB)", () => {
  it("sends the Cloud API location payload to the normalized recipient", async () => {
    const { sendStructured } = await import("@/server/inbox/send");
    await sendStructured({
      conversationId: "cv_real",
      organizationId: "org1",
      kind: "location",
      location: pin,
      aiGenerated: true,
    });
    expect(h.graph).toHaveBeenCalledTimes(1);
    const [path, opts] = h.graph.mock.calls[0] as [string, { body: unknown; token: string }];
    expect(path).toBe("pn1/messages");
    expect(opts.body).toEqual({
      messaging_product: "whatsapp",
      to: "525500000001",
      type: "location",
      location: pin,
    });
  });

  it("persists it as an outbound location message from the bot", async () => {
    const { sendStructured } = await import("@/server/inbox/send");
    await sendStructured({
      conversationId: "cv_real",
      organizationId: "org1",
      kind: "location",
      location: pin,
      aiGenerated: true,
    });
    const [msg] = await eph.run(
      `SELECT type, direction, origin, ai_generated, wa_message_id, status FROM message WHERE conversation_id = 'cv_real'`
    );
    expect(msg).toMatchObject({
      type: "location",
      direction: "out",
      origin: "ai",
      ai_generated: true,
      wa_message_id: "wamid.LOC1",
      status: "pending",
    });
  });

  it("without aiGenerated it stays an operator message (inbox behaviour unchanged)", async () => {
    const { sendStructured } = await import("@/server/inbox/send");
    await sendStructured({
      conversationId: "cv_real",
      organizationId: "org1",
      kind: "location",
      location: pin,
    });
    const [msg] = await eph.run(`SELECT origin, ai_generated FROM message WHERE conversation_id = 'cv_real'`);
    expect(msg).toMatchObject({ origin: "operator", ai_generated: false });
  });

  it("a Laboratorio conversation never reaches Meta", async () => {
    const { sendStructured } = await import("@/server/inbox/send");
    await expect(
      sendStructured({
        conversationId: "cv_test",
        organizationId: "org1",
        kind: "location",
        location: pin,
        aiGenerated: true,
      })
    ).rejects.toMatchObject({ code: "sandbox_violation" });
    expect(h.graph).not.toHaveBeenCalled();
    expect(await eph.run(`SELECT 1 FROM message`)).toHaveLength(0);
  });

  it("outside the 24 h window it is refused before Meta", async () => {
    const { sendStructured } = await import("@/server/inbox/send");
    await expect(
      sendStructured({
        conversationId: "cv_old",
        organizationId: "org1",
        kind: "location",
        location: pin,
        aiGenerated: true,
      })
    ).rejects.toMatchObject({ code: "window_closed" });
    expect(h.graph).not.toHaveBeenCalled();
  });
});
