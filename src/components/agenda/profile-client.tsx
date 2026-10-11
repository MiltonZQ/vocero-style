"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { HoursEditor } from "@/components/agenda/hours-editor";
import { PhotoUpload } from "@/components/agenda/photo-upload";
import { StaffServicesEditor } from "@/components/agenda/staff-services-editor";
import type { Role } from "@/lib/auth/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Profile = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  phone: string | null;
  color: string;
  photoUrl: string | null;
};

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR = "#0d5bff";

export function ProfileClient() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [bio, setBio] = useState("");
  const [phone, setPhone] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    const meRes = await fetch("/api/me").catch(() => null);
    if (!meRes?.ok) {
      setError(await apiMessage(meRes, "No se pudo saber quién eres"));
      setPhase("error");
      return;
    }
    const me = parseMe(await meRes.json().catch(() => null));
    if (!me) {
      setError("No se pudo leer tu rol.");
      setPhase("error");
      return;
    }
    setRole(me.role);
    if (!me.staffId) {
      setProfile(null);
      setPhase("missing");
      return;
    }
    const res = await fetch(`/api/staff/${me.staffId}`).catch(() => null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo cargar tu perfil"));
      setPhase("error");
      return;
    }
    const data = (await res.json().catch(() => null)) as { staff?: unknown } | null;
    const next = parseProfile(data?.staff);
    if (!next) {
      setError("El perfil llegó en un formato inesperado.");
      setPhase("error");
      return;
    }
    setProfile(next);
    setName(next.displayName);
    setJobTitle(next.jobTitle ?? "");
    setBio(next.bio ?? "");
    setPhone(next.phone ?? "");
    setColor(next.color || DEFAULT_COLOR);
    setPhase("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!profile || !role) return;
    if (!COLOR.test(color)) {
      setError("El color debe ser #RRGGBB.");
      return;
    }
    if (role === "owner" && !name.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    // El staff solo puede mandar bio, teléfono y color. jobTitle es 403.
    const body: Record<string, string | null> =
      role === "owner"
        ? {
            displayName: name.trim(),
            jobTitle: jobTitle.trim() ? jobTitle.trim() : null,
            bio,
            phone,
            color,
          }
        : { bio, phone, color };
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/staff/${profile.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo guardar el perfil"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { staff?: unknown } | null;
    const next = parseProfile(data?.staff);
    if (next) {
      setProfile(next);
      setName(next.displayName);
      setJobTitle(next.jobTitle ?? "");
      setBio(next.bio ?? "");
      setPhone(next.phone ?? "");
      setColor(next.color || DEFAULT_COLOR);
    }
    setSaved(true);
  }

  if (phase === "loading") return <p className="text-sm text-text-2">Cargando…</p>;
  if (phase === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (phase === "missing" || !profile || !role) {
    return (
      <div className="max-w-xl space-y-2">
        <p className="text-sm text-text-2">
          {role === "owner"
            ? "Esta cuenta no tiene un perfil de profesional. Los perfiles del equipo se editan en Ajustes → Profesionales."
            : "Tu cuenta no está vinculada a un profesional. Pide al propietario que te cree el acceso desde Profesionales."}
        </p>
        {role === "owner" && (
          <Link href="/settings/staff" className="text-sm font-semibold text-brand-text hover:underline">
            Ir a Profesionales
          </Link>
        )}
      </div>
    );
  }

  const owner = role === "owner";

  return (
    <div className="max-w-2xl space-y-4">
      <Link href="/my-agenda" className="text-sm font-semibold text-brand-text hover:underline">
        Ir a mi agenda
      </Link>
      <PhotoUpload
        staffId={profile.id}
        photoUrl={profile.photoUrl}
        canEdit
        onChange={(photoUrl) => setProfile((current) => (current ? { ...current, photoUrl } : current))}
      />
      <section className="space-y-4 rounded-md border bg-subtle p-4">
        <h3 className="text-sm font-semibold">Datos</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Nombre</Label>
            {owner ? (
              <Input
                id="profile-name"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            ) : (
              <p id="profile-name" className="text-sm">
                {profile.displayName}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-job">Oficio</Label>
            {owner ? (
              <Input
                id="profile-job"
                value={jobTitle}
                maxLength={40}
                onChange={(event) => setJobTitle(event.target.value)}
              />
            ) : (
              <p id="profile-job" className="text-sm">
                {profile.jobTitle ?? "Sin oficio"}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-phone">Teléfono</Label>
            <Input
              id="profile-phone"
              value={phone}
              maxLength={40}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-color">Color</Label>
            <Input
              id="profile-color"
              type="color"
              value={COLOR.test(color) ? color : DEFAULT_COLOR}
              onChange={(event) => setColor(event.target.value)}
              className="h-9 w-16 p-1"
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="profile-bio">Bio</Label>
            <Textarea
              id="profile-bio"
              value={bio}
              maxLength={500}
              onChange={(event) => setBio(event.target.value)}
            />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && <p className="text-sm text-text-2">Perfil guardado.</p>}
        <Button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </section>
      <StaffServicesEditor staffId={profile.id} canEdit />
      <HoursEditor
        staffId={profile.id}
        canEdit={role !== "reception"}
        canReadShopHours={role !== "staff"}
      />
    </div>
  );
}

function parseMe(value: unknown): { role: Role; staffId: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { role?: unknown; staffId?: unknown };
  if (record.role !== "owner" && record.role !== "reception" && record.role !== "staff") {
    return null;
  }
  return {
    role: record.role,
    staffId: typeof record.staffId === "string" && record.staffId ? record.staffId : null,
  };
}

function parseProfile(value: unknown): Profile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.displayName !== "string") return null;
  return {
    id: record.id,
    displayName: record.displayName,
    jobTitle: typeof record.jobTitle === "string" ? record.jobTitle : null,
    bio: typeof record.bio === "string" ? record.bio : null,
    phone: typeof record.phone === "string" ? record.phone : null,
    color: typeof record.color === "string" ? record.color : DEFAULT_COLOR,
    photoUrl: typeof record.photoUrl === "string" ? record.photoUrl : null,
  };
}

async function apiMessage(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "No hubo respuesta del servidor";
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const message = data?.error?.message?.trim();
  return message ? message : fallback;
}
