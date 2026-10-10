"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type StaffOption = {
  id: string;
  displayName: string;
  jobTitle: string | null;
};

const selectClass = "h-9 max-w-full rounded-md border border-input bg-card px-2 text-sm";

/**
 * Professional and job-title filters. Both live in the URL (`staffId`,
 * `jobTitle`). `jobTitle` is stored lowercased. `from` and `days` stay put.
 */
export function StaffFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const staffId = searchParams.get("staffId") ?? "";
  const jobTitle = (searchParams.get("jobTitle") ?? "").trim().toLowerCase();
  const [staff, setStaff] = useState<StaffOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/staff?includeInactive=1").catch(() => null);
      if (!res?.ok || cancelled) return;
      const data = (await res.json()) as { staff?: StaffOption[] };
      if (!cancelled) setStaff(data.staff ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function write(key: "staffId" | "jobTitle", value: string) {
    const next = new URLSearchParams(searchParams.toString());
    const stored = key === "jobTitle" ? value.trim().toLowerCase() : value;
    if (stored) next.set(key, stored);
    else next.delete(key);
    const query = next.toString();
    router.replace(query ? `/calendar?${query}` : "/calendar", { scroll: false });
  }

  const titles = new Map<string, string>();
  for (const person of staff) {
    const raw = person.jobTitle?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!titles.has(key)) titles.set(key, raw);
  }
  if (jobTitle && !titles.has(jobTitle)) titles.set(jobTitle, jobTitle);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-text-2">
        Profesional
        <select
          aria-label="Filtrar por profesional"
          className={selectClass}
          value={staffId}
          onChange={(event) => write("staffId", event.target.value)}
        >
          <option value="">Todos</option>
          {staffId && !staff.some((person) => person.id === staffId) && (
            <option value={staffId}>{staffId}</option>
          )}
          {staff.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-text-2">
        Oficio
        <select
          aria-label="Filtrar por oficio"
          className={selectClass}
          value={jobTitle}
          onChange={(event) => write("jobTitle", event.target.value)}
        >
          <option value="">Todos</option>
          {[...titles.entries()].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
