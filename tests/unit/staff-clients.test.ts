import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import { AgendaHttpError } from "@/server/agenda/http";
import { listStaffClients } from "@/server/agenda/queries";

const ana: Actor = {
  userId: "usr_ana",
  organizationId: "org_1",
  memberId: "mem_ana",
  role: "staff",
  staffId: "st_ana",
};

describe("listStaffClients", () => {
  it("un barbero no lista los clientes de otro profesional", async () => {
    await expect(listStaffClients(ana, "st_otro")).rejects.toBeInstanceOf(AgendaHttpError);
    await expect(listStaffClients(ana, "st_otro")).rejects.toMatchObject({ code: "not_found" });
  });
});
