import { notFound } from "next/navigation";
import { ServicesClient } from "@/components/settings/services-client";
import { requirePageActor } from "@/lib/auth/actor";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

export default async function ServicesSettingsPage() {
  const actor = await requirePageActor(["owner", "reception"]);
  if (!agendaEnabled()) notFound();
  return (
    <div className="space-y-4">
      <h3 className="text-[17px] font-bold tracking-tight">Servicios</h3>
      <ServicesClient canEdit={actor.role === "owner"} />
    </div>
  );
}
