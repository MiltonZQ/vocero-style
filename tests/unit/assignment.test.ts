import { describe, expect, it } from "vitest";
import {
  pickAssignee,
  rankCandidates,
  type AssigneeCandidate,
} from "@/server/agenda/assignment";

const ana: AssigneeCandidate = {
  id: "st_ana",
  position: 2,
  offersService: true,
};
const bea: AssigneeCandidate = {
  id: "st_bea",
  position: 1,
  offersService: true,
};
const cio: AssigneeCandidate = {
  id: "st_cio",
  position: 0,
  offersService: false,
};

describe("pickAssignee", () => {
  it("chooses the candidate with the fewest active bookings that day", () => {
    expect(pickAssignee([ana, bea], { st_ana: 1, st_bea: 4 })?.id).toBe(
      "st_ana",
    );
  });

  it("breaks a load tie by lower position, then by lower id", () => {
    expect(
      pickAssignee(
        [
          { id: "st_b", position: 2, offersService: true },
          { id: "st_a", position: 2, offersService: true },
          { id: "st_c", position: 1, offersService: true },
        ],
        { st_a: 3, st_b: 3, st_c: 3 },
      )?.id,
    ).toBe("st_c");

    expect(
      pickAssignee(
        [
          { id: "st_b", position: 5, offersService: true },
          { id: "st_a", position: 5, offersService: true },
        ],
        {},
      )?.id,
    ).toBe("st_a");
  });

  it("never chooses someone who does not offer the service", () => {
    expect(pickAssignee([cio, ana], { st_ana: 9, st_cio: 0 })?.id).toBe(
      "st_ana",
    );
  });

  it("returns null when nobody eligible remains", () => {
    expect(pickAssignee([cio], { st_cio: 0 })).toBeNull();
    expect(pickAssignee([], {})).toBeNull();
  });

  it("treats a missing load entry as zero active bookings", () => {
    expect(pickAssignee([ana, bea], { st_bea: 0 })?.id).toBe("st_bea");
  });
});

describe("rankCandidates", () => {
  it("orders the rest the same way and drops ineligible staff", () => {
    expect(
      rankCandidates(
        [ana, bea, cio, { id: "st_dia", position: 3, offersService: true }],
        { st_ana: 2, st_bea: 2, st_dia: 1 },
      ).map((candidate) => candidate.id),
    ).toEqual(["st_dia", "st_bea", "st_ana"]);
  });

  it("returns an empty list when every candidate is ineligible", () => {
    expect(rankCandidates([cio], {})).toEqual([]);
  });
});
