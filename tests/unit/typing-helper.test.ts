import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 019 — The "read + typing…" call shared by the in-process agent and
 * POST /api/bot/typing. Best-effort by contract: it reports, never throws.
 */

const h = vi.hoisted(() => ({
  graph: vi.fn(),
  creds: vi.fn(),
}));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: h.graph };
});
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg: h.creds }));

const { showTyping } = await import("@/server/whatsapp/typing");
const { MetaApiError } = await import("@/lib/meta/client");

beforeEach(() => {
  h.graph.mockReset();
  h.creds.mockReset();
  h.creds.mockResolvedValue({ phoneNumberId: "pn1", token: "tok" });
  h.graph.mockResolvedValue({ success: true });
});

describe("showTyping", () => {
  it("marks the message read and shows typing with the Cloud API payload", async () => {
    await expect(showTyping("org1", "wamid.ABC")).resolves.toEqual({ ok: true });
    expect(h.creds).toHaveBeenCalledWith("org1");
    expect(h.graph).toHaveBeenCalledTimes(1);
    expect(h.graph).toHaveBeenCalledWith("pn1/messages", {
      method: "POST",
      token: "tok",
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.ABC",
        typing_indicator: { type: "text" },
      },
    });
  });

  it("reports a missing connection without calling Meta", async () => {
    h.creds.mockResolvedValue(null);
    await expect(showTyping("org1", "wamid.ABC")).resolves.toEqual({
      ok: false,
      reason: "no_connection",
    });
    expect(h.graph).not.toHaveBeenCalled();
  });

  it("a Meta error is reported, never thrown", async () => {
    h.graph.mockRejectedValue(new MetaApiError("boom", { status: 500 }));
    await expect(showTyping("org1", "wamid.ABC")).resolves.toEqual({
      ok: false,
      reason: "meta_error",
    });
  });

  it("an unexpected failure (network, credentials) is reported, never thrown", async () => {
    h.creds.mockRejectedValue(new Error("db down"));
    await expect(showTyping("org1", "wamid.ABC")).resolves.toEqual({
      ok: false,
      reason: "meta_error",
    });
  });
});
