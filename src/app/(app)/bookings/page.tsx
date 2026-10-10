import { requirePageActor } from "@/lib/auth/actor";
import { notFound } from "next/navigation";
import { BookingsClient } from "@/components/bookings/bookings-client";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  await requirePageActor(["owner", "reception"]);
  // Sin la bandera esta pantalla no existe en esta instancia.
  if (!agendaEnabled()) notFound();
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">Citas</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <BookingsClient />
      </div>
    </div>
  );
}
