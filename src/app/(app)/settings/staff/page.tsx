import { notFound } from "next/navigation";
import { StaffClient } from "@/components/settings/staff-client";
import { requirePageActor } from "@/lib/auth/actor";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

export default async function StaffSettingsPage() {
  await requirePageActor(["owner"]);
  if (!agendaEnabled()) notFound();
  return (
    <div className="space-y-4">
      <h3 className="text-[17px] font-bold tracking-tight">Profesionales</h3>
      <StaffClient />
    </div>
  );
}
