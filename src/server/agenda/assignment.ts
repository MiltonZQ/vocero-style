export type AssigneeCandidate = {
  id: string;
  position: number;
  offersService: boolean;
};

function loadOf(load: Record<string, number>, id: string): number {
  return load[id] ?? 0;
}

function byLoadThenPositionThenId(
  load: Record<string, number>,
): (a: AssigneeCandidate, b: AssigneeCandidate) => number {
  return (a, b) => {
    const byLoad = loadOf(load, a.id) - loadOf(load, b.id);
    if (byLoad !== 0) return byLoad;
    if (a.position !== b.position) return a.position - b.position;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };
}

/** Eligible staff only, lightest load first, then position, then id. */
export function rankCandidates(
  candidates: readonly AssigneeCandidate[],
  load: Record<string, number>,
): AssigneeCandidate[] {
  return candidates.filter((candidate) => candidate.offersService).sort(byLoadThenPositionThenId(load));
}

export function pickAssignee(
  candidates: readonly AssigneeCandidate[],
  load: Record<string, number>,
): AssigneeCandidate | null {
  return rankCandidates(candidates, load)[0] ?? null;
}
