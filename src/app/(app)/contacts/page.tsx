import { requirePageActor } from "@/lib/auth/actor";
import { ContactsClient } from "@/components/contacts/contacts-client";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  await requirePageActor(["owner", "reception"]);
  return <ContactsClient />;
}
