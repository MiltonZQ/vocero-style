import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt, buildDraftStateBlock } from "@/server/ai/prompts";
import { CASES, SYSTEM, stateBlock } from "../../scripts/eval-bot-model.mjs";

/**
 * 019 — The eval script is a standalone COPY of the agenda prompt (it imports
 * nothing from the app). If the copy drifts, the pass rates lie: this pins the
 * action contract, the rules and the tone line to the real prompt.
 */
describe("scripts/eval-bot-model.mjs stays in sync with the app prompt", () => {
  const real = buildAgentSystemPrompt({
    profile: { name: "Style Bot", tone: null, instructions: null, escalationRules: null, greeting: null } as never,
    kb: [],
    stages: [{ name: "Nuevo" }],
    agenda: true,
  });
  const block = (text: string) => text.slice(text.indexOf("En cada turno respondes"));

  it("copies the action contract and the hard rules verbatim", () => {
    expect(block(SYSTEM as string)).toBe(block(real));
  });

  it("copies the persona line (tú, professional, no slang)", () => {
    expect((SYSTEM as string).split("\n")[0]).toBe(real.split("\n")[0]);
  });

  it("renders the state block like buildDraftStateBlock", () => {
    const options = ["mañana lunes 12 de octubre 09:00 · Luis", "mañana lunes 12 de octubre 09:30 · Luis"];
    const real = buildDraftStateBlock({
      now: new Date("2026-10-11T16:00:00Z"),
      timezone: "America/Mexico_City",
      step: "ready",
      serviceName: "Fade",
      staffLabel: "Luis",
      whenLabel: "mañana",
      options,
    });
    const copy = (stateBlock as (o: unknown) => { content: string })({
      step: "ready",
      service: "Fade",
      staff: "Luis",
      when: "mañana",
      options,
    }).content;
    expect(copy).toBe(real);
  });

  it("covers picking by time, by position and a time that was not offered", () => {
    const ids = (CASES as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(["01-saludo", "13-elige-por-hora", "14-el-primero", "15-hora-no-ofrecida"])
    );
  });
});
