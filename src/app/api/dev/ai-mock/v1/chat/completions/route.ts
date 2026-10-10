import { mockGuard } from "@/lib/dev-guard";
import { aiMockCompletion } from "@/server/dev/ai-mock";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = (await req.json().catch(() => ({}))) as {
    messages?: { role: string; content: string }[];
  };
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  // El self-test pide un proveedor caído. El resto de las frases sigue igual.
  if (lastUser.toLowerCase().includes("simula proveedor caido")) {
    return Response.json({ error: "down" }, { status: 500 });
  }
  const content = aiMockCompletion(messages);
  return Response.json({
    id: "aimock",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  });
}
