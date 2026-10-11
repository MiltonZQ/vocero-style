import { graphRequest } from "@/lib/meta/client";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";

/**
 * 019 — "Leído" + "escribiendo…" para un mensaje entrante de WhatsApp.
 *
 * Una sola llamada a la Cloud API (`status: read` con `typing_indicator`) que
 * comparten el agente en proceso y `POST /api/bot/typing`. Best-effort por
 * contrato: el indicador dura hasta ~25 s o hasta que llegue la respuesta, y
 * si falla JAMÁS se lanza — a quien contesta no le sirve reintentarlo.
 */

export type TypingResult =
  | { ok: true }
  | { ok: false; reason: "no_connection" | "meta_error" };

export async function showTyping(
  organizationId: string,
  waMessageId: string
): Promise<TypingResult> {
  try {
    const creds = await getCredentialsByOrg(organizationId);
    if (!creds) return { ok: false, reason: "no_connection" };
    await graphRequest(`${creds.phoneNumberId}/messages`, {
      method: "POST",
      token: creds.token,
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: waMessageId,
        typing_indicator: { type: "text" },
      },
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "meta_error" };
  }
}
