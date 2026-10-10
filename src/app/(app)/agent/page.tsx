import { requirePageActor } from "@/lib/auth/actor";
import { AgentClient } from "@/components/agent/agent-client";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  await requirePageActor(["owner", "reception"]);
  return <AgentClient />;
}
