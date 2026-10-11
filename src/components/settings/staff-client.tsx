"use client";

import { useCallback, useEffect, useState } from "react";
import { HoursEditor } from "@/components/agenda/hours-editor";
import { PhotoUpload } from "@/components/agenda/photo-upload";
import { StaffServicesEditor } from "@/components/agenda/staff-services-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type StaffPerson = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  phone: string | null;
  color: string;
  active: boolean;
  photoUrl: string | null;
  hasAccount: boolean;
  accountEmail?: string | null;
  needsReassignment?: boolean;
};

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR = "#0d5bff";

export function StaffClient() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<StaffPerson[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refetch = useCallback(async (silent: boolean) => {
    if (!silent) setPhase("loading");
    const res = await fetch("/api/staff?includeInactive=1").catch(() => null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudieron cargar los profesionales"));
      setPhase("error");
      return;
    }
    const data = (await res.json().catch(() => null)) as { staff?: unknown } | null;
    setPeople(parseStaff(data?.staff));
    setError(null);
    setPhase("ready");
  }, []);

  useEffect(() => {
    void refetch(false);
  }, [refetch]);

  const selected = people.find((person) => person.id === selectedId) ?? null;

  async function setActive(person: StaffPerson, active: boolean) {
    setBusy(person.id);
    setError(null);
    const res = await fetch(`/api/staff/${person.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    }).catch(() => null);
    setBusy(null);
    setConfirmOff(null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo cambiar el estado"));
      return;
    }
    await refetch(true);
  }

  if (phase === "loading") return <p className="text-sm text-text-2">Cargando…</p>;
  if (phase === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="secondary" onClick={() => void refetch(false)}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <CreateStaff
        onCreated={(person) => {
          setPeople((current) => [person, ...current.filter((row) => row.id !== person.id)]);
          setSelectedId(person.id);
          void refetch(true);
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          Equipo <span className="text-text-2">({people.length})</span>
        </h3>
        {people.length === 0 && (
          <p className="text-sm text-text-2">
            Todavía no hay profesionales. Da de alta al primero para poder agendar.
          </p>
        )}
        <ul className="divide-y rounded-md border">
          {people.map((person) => (
            <li key={person.id} className="space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="h-3 w-3 rounded-full border"
                  style={{ backgroundColor: person.color }}
                  aria-hidden
                />
                <span className="text-sm font-medium">{person.displayName}</span>
                <span className="text-sm text-text-2">{person.jobTitle ?? "Sin oficio"}</span>
                <Badge variant={person.active ? "default" : "secondary"}>
                  {person.active ? "Activo" : "Inactivo"}
                </Badge>
                <Badge variant="secondary">{person.hasAccount ? "Con acceso" : "Sin cuenta"}</Badge>
              </div>
              {person.accountEmail && (
                <p className="text-sm text-text-2">{person.accountEmail}</p>
              )}
              {person.needsReassignment && (
                <p className="rounded-sm bg-subtle px-2 py-1 text-sm text-text-2">
                  Tiene citas futuras por reasignar.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setSelectedId((current) => (current === person.id ? null : person.id))}
                >
                  {selectedId === person.id ? "Cerrar" : "Editar"}
                </Button>
                {person.active ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy === person.id}
                    onClick={() => setConfirmOff(person.id)}
                  >
                    Desactivar
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy === person.id}
                    onClick={() => void setActive(person, true)}
                  >
                    Activar
                  </Button>
                )}
              </div>
              {confirmOff === person.id && (
                <div className="space-y-2 rounded-sm bg-subtle p-3">
                  <p className="text-sm text-text-2">
                    Si tiene citas futuras, quedarán por reasignar. Desactivar no
                    borra el perfil. El último profesional activo no se puede
                    desactivar.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy === person.id}
                      onClick={() => void setActive(person, false)}
                    >
                      {busy === person.id ? "Desactivando…" : "Confirmar desactivación"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmOff(null)}
                    >
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
              {selected?.id === person.id && (
                <Editor
                  key={selected.id}
                  person={selected}
                  onSaved={(next) => {
                    setPeople((current) =>
                      current.map((row) => (row.id === next.id ? { ...row, ...next } : row))
                    );
                    void refetch(true);
                  }}
                  onPhoto={(photoUrl) => {
                    setPeople((current) =>
                      current.map((row) => (row.id === person.id ? { ...row, photoUrl } : row))
                    );
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CreateStaff({ onCreated }: { onCreated: (person: StaffPerson) => void }) {
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [bio, setBio] = useState("");
  const [phone, setPhone] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (!COLOR.test(color)) {
      setError("El color debe ser #RRGGBB.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: name.trim(),
        jobTitle: jobTitle.trim() ? jobTitle.trim() : null,
        bio,
        phone,
        color,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo crear el profesional"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { staff?: unknown } | null;
    const created = parseOne(data?.staff);
    if (!created) {
      setError("El profesional se creó, pero la respuesta no se pudo leer.");
      return;
    }
    setName("");
    setJobTitle("");
    setBio("");
    setPhone("");
    setColor(DEFAULT_COLOR);
    onCreated(created);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo profesional</CardTitle>
        <CardDescription>
          El horario, la foto, los servicios y el acceso se completan después, en su ficha.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PersonFields
          idPrefix="new-staff"
          name={name}
          jobTitle={jobTitle}
          bio={bio}
          phone={phone}
          color={color}
          onName={setName}
          onJobTitle={setJobTitle}
          onBio={setBio}
          onPhone={setPhone}
          onColor={setColor}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="button" disabled={saving || !name.trim()} onClick={() => void create()}>
          {saving ? "Creando…" : "Crear profesional"}
        </Button>
      </CardContent>
    </Card>
  );
}

function Editor({
  person,
  onSaved,
  onPhoto,
}: {
  person: StaffPerson;
  onSaved: (person: StaffPerson) => void;
  onPhoto: (photoUrl: string | null) => void;
}) {
  const [name, setName] = useState(person.displayName);
  const [jobTitle, setJobTitle] = useState(person.jobTitle ?? "");
  const [bio, setBio] = useState(person.bio ?? "");
  const [phone, setPhone] = useState(person.phone ?? "");
  const [color, setColor] = useState(person.color || DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (!COLOR.test(color)) {
      setError("El color debe ser #RRGGBB.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/staff/${person.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: name.trim(),
        jobTitle: jobTitle.trim() ? jobTitle.trim() : null,
        bio,
        phone,
        color,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo guardar el profesional"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { staff?: unknown } | null;
    const next = parseOne(data?.staff);
    if (next) onSaved(next);
  }

  return (
    <div className="space-y-4 border-t pt-3">
      <PersonFields
        idPrefix={person.id}
        name={name}
        jobTitle={jobTitle}
        bio={bio}
        phone={phone}
        color={color}
        onName={setName}
        onJobTitle={setJobTitle}
        onBio={setBio}
        onPhone={setPhone}
        onColor={setColor}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="button" disabled={saving} onClick={() => void save()}>
        {saving ? "Guardando…" : "Guardar ficha"}
      </Button>
      <PhotoUpload
        staffId={person.id}
        photoUrl={person.photoUrl}
        canEdit
        onChange={onPhoto}
      />
      <HoursEditor staffId={person.id} canEdit canReadShopHours />
      <StaffServicesEditor staffId={person.id} canEdit />
      <AccountForm person={person} onLinked={() => onSaved(person)} />
    </div>
  );
}

function PersonFields({
  idPrefix,
  name,
  jobTitle,
  bio,
  phone,
  color,
  onName,
  onJobTitle,
  onBio,
  onPhone,
  onColor,
}: {
  idPrefix: string;
  name: string;
  jobTitle: string;
  bio: string;
  phone: string;
  color: string;
  onName: (value: string) => void;
  onJobTitle: (value: string) => void;
  onBio: (value: string) => void;
  onPhone: (value: string) => void;
  onColor: (value: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>Nombre</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          maxLength={80}
          onChange={(event) => onName(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-job`}>Oficio</Label>
        <Input
          id={`${idPrefix}-job`}
          value={jobTitle}
          maxLength={40}
          placeholder="por ejemplo, barbero"
          onChange={(event) => onJobTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-phone`}>Teléfono</Label>
        <Input
          id={`${idPrefix}-phone`}
          value={phone}
          maxLength={40}
          onChange={(event) => onPhone(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-color`}>Color</Label>
        <Input
          id={`${idPrefix}-color`}
          type="color"
          value={COLOR.test(color) ? color : DEFAULT_COLOR}
          onChange={(event) => onColor(event.target.value)}
          className="h-9 w-16 p-1"
        />
      </div>
      <div className="space-y-1.5 md:col-span-2">
        <Label htmlFor={`${idPrefix}-bio`}>Bio</Label>
        <Textarea
          id={`${idPrefix}-bio`}
          value={bio}
          maxLength={500}
          onChange={(event) => onBio(event.target.value)}
        />
      </div>
    </div>
  );
}

function AccountForm({
  person,
  onLinked,
}: {
  person: StaffPerson;
  onLinked: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);

  async function create() {
    if (password.length < 8 || password.length > 128) {
      setError("La contraseña debe tener entre 8 y 128 caracteres.");
      return;
    }
    setSaving(true);
    setError(null);
    setShown(null);
    const res = await fetch(`/api/staff/${person.id}/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: email.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        password,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo crear el acceso"));
      return;
    }
    setShown({ email: email.trim(), password });
    setEmail("");
    setName("");
    setPassword("");
    onLinked();
  }

  if (shown) {
    return (
      <div className="space-y-2 rounded-md border border-success-soft bg-success-tint p-3 text-sm">
        <p className="font-medium text-success-text">Acceso creado</p>
        <p className="text-success-text">
          Compártelo ahora. No se vuelve a mostrar.
          <br />
          <code>{shown.email}</code> · contraseña <code>{shown.password}</code>
        </p>
      </div>
    );
  }

  if (person.hasAccount) {
    return (
      <p className="text-sm text-text-2">
        Ya tiene cuenta{person.accountEmail ? `: ${person.accountEmail}` : ""}.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Acceso</h3>
        <p className="text-sm text-text-2">
          La contraseña temporal se muestra una sola vez: la API no la devuelve.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${person.id}-account-email`}>Correo</Label>
          <Input
            id={`${person.id}-account-email`}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${person.id}-account-name`}>Nombre de la cuenta</Label>
          <Input
            id={`${person.id}-account-name`}
            value={name}
            maxLength={120}
            placeholder="opcional"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${person.id}-account-password`}>Contraseña temporal</Label>
        <div className="flex gap-2">
          <Input
            id={`${person.id}-account-password`}
            value={password}
            maxLength={128}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="entre 8 y 128 caracteres"
          />
          <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
            Generar
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        type="button"
        disabled={saving || !email.trim() || password.length < 8 || password.length > 128}
        onClick={() => void create()}
      >
        {saving ? "Creando acceso…" : "Crear acceso"}
      </Button>
    </div>
  );
}

function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length] ?? "a").join("");
}

function parseStaff(value: unknown): StaffPerson[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const person = parseOne(row);
    return person ? [person] : [];
  });
}

function parseOne(value: unknown): StaffPerson | null {
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
    active: record.active !== false,
    photoUrl: typeof record.photoUrl === "string" ? record.photoUrl : null,
    hasAccount: record.hasAccount === true,
    accountEmail: typeof record.accountEmail === "string" ? record.accountEmail : null,
    needsReassignment: record.needsReassignment === true,
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
