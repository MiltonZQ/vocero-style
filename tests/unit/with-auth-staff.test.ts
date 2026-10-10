import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 (D6) — deny-by-default: `staff` recibe 403 en cualquier ruta que no
 * declare `allowStaff`. `requireActor` se mockea: aqui se prueba la decision
 * de `withAuth`, no la resolucion del actor.
 */
const { requireActor } = vi.hoisted(() => ({ requireActor: vi.fn() }));

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError };
});

vi.mock("@/lib/auth/actor", () => {
  class ForbiddenError extends Error {}
  class AccountDisabledError extends Error {}
  return { requireActor, ForbiddenError, AccountDisabledError };
});

import { withAuth, type ActorSession } from "@/lib/api";
import { AccountDisabledError, ForbiddenError } from "@/lib/auth/actor";
import { UnauthorizedError } from "@/lib/auth/session";

const actorOf = (role: string, staffId: string | null = null) => ({
  userId: "u_1",
  organizationId: "org_1",
  memberId: "mem_1",
  role,
  staffId,
});

beforeEach(() => {
  requireActor.mockReset();
});

describe("withAuth + actor", () => {
  it("staff sin opciones: 403 forbidden y no invoca al handler", async () => {
    requireActor.mockResolvedValue(actorOf("staff", "st_A"));
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const res = await withAuth(handler)();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(handler).not.toHaveBeenCalled();
  });

  it("staff con allowStaff: invoca al handler con el actor", async () => {
    requireActor.mockResolvedValue(actorOf("staff", "st_A"));
    const handler = vi.fn(async (session: ActorSession) =>
      Response.json({ staffId: session.actor.staffId })
    );
    const res = await withAuth(handler, { allowStaff: true })();
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await res.json()).staffId).toBe("st_A");
  });

  it("roles: [owner] responde 403 a reception", async () => {
    requireActor.mockResolvedValue(actorOf("reception"));
    const handler = vi.fn(async () => Response.json({}));
    const res = await withAuth(handler, { roles: ["owner"] })();
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("roles: [owner] deja pasar al owner", async () => {
    requireActor.mockResolvedValue(actorOf("owner"));
    const handler = vi.fn(async () => Response.json({}));
    const res = await withAuth(handler, { roles: ["owner"] })();
    expect(res.status).toBe(200);
  });

  it("sin sesion: 401", async () => {
    requireActor.mockRejectedValue(new UnauthorizedError());
    const res = await withAuth(async () => Response.json({}))();
    expect(res.status).toBe(401);
  });

  it("perfil desactivado: 403 account_disabled (tambien con allowStaff)", async () => {
    requireActor.mockRejectedValue(new AccountDisabledError());
    const res = await withAuth(async () => Response.json({}), {
      allowStaff: true,
    })();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("account_disabled");
  });

  it("rol desconocido (ForbiddenError): 403 forbidden", async () => {
    requireActor.mockRejectedValue(new ForbiddenError());
    const res = await withAuth(async () => Response.json({}))();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("`member` legado (ya normalizado a reception) opera como antes", async () => {
    requireActor.mockResolvedValue(actorOf("reception"));
    const res = await withAuth(async () => Response.json({ ok: 1 }))();
    expect(res.status).toBe(200);
  });

  it("un error no controlado sigue siendo 500 sin stack", async () => {
    requireActor.mockResolvedValue(actorOf("owner"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await withAuth(async () => {
      throw new Error("boom");
    })();
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});
