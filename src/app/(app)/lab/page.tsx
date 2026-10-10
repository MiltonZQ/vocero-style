import { requirePageActor } from "@/lib/auth/actor";
import { LabClient } from "@/components/lab/lab-client";

export const dynamic = "force-dynamic";

export default async function LabPage() {
  await requirePageActor(["owner", "reception"]);
  return <LabClient />;
}
