import { requirePageActor } from "@/lib/auth/actor";
import { PipelineClient } from "@/components/pipeline/pipeline-client";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  await requirePageActor(["owner", "reception"]);
  return <PipelineClient />;
}
