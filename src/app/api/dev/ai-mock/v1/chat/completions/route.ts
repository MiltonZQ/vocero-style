import { mockGuard } from "@/lib/dev-guard";
import { aiMockCompletion } from "@/server/dev/ai-mock";

export const dynamic = "force-dynamic";

/** 020 — Forma de `usage` de OpenRouter (usage accounting); costo cero. */
const MOCK_USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0 };

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
  // 019 — Respuesta basura (200 pero sin JSON): ejercita la extracción robusta
  // y el re-preguntar del paso. Solo existe tras el guard de mocks de arriba.
  if (lastUser.toLowerCase().includes("simula json invalido")) {
    return Response.json({
      id: "aimock",
      choices: [{ index: 0, message: { role: "assistant", content: "lo siento {{ no soy json" } }],
      usage: MOCK_USAGE,
    });
  }
  const content = aiMockCompletion(messages);
  return Response.json({
    id: "aimock",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: MOCK_USAGE,
  });
}
