"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Tab = { href: string; label: string };

const TABS: Tab[] = [
  { href: "/settings/whatsapp", label: "WhatsApp" },
  { href: "/settings/branding", label: "Marca" },
  { href: "/settings/templates", label: "Plantillas" },
  { href: "/settings/team", label: "Equipo" },
];

/** 015 — "Agenda" solo existe si esta instancia encendió la bandera. */
const AGENDA_TAB: Tab = { href: "/settings/calendar", label: "Agenda" };

/** 018 — Catálogo del equipo. Solo el dueño, y solo con la agenda encendida. */
const STAFF_TAB: Tab = { href: "/settings/staff", label: "Profesionales" };
const SERVICES_TAB: Tab = { href: "/settings/services", label: "Servicios" };

/** 016 — Igual con "Anuncios" y la bandera ATRIBUCION. */
const ADS_TAB: Tab = { href: "/settings/ads", label: "Anuncios" };

/** 017 — "Messenger" solo si el canal está encendido con CHANNELS. */
const MESSENGER_TAB: Tab = { href: "/settings/messenger", label: "Messenger" };

export function SettingsNav({
  agenda = false,
  atribucion = false,
  messenger = false,
  role,
}: {
  agenda?: boolean;
  atribucion?: boolean;
  messenger?: boolean;
  /** Sin rol, o cualquier rol que no sea owner, no ve Profesionales ni Servicios. */
  role?: string;
}) {
  const pathname = usePathname();
  // Qué pestañas existen lo decide el servidor y baja por prop: este es un
  // componente de cliente y no puede leer variables de entorno.
  // Messenger va junto a WhatsApp: son las dos conexiones de mensajería.
  // Profesionales y Servicios no son de recepción ni de staff.
  const catalog = agenda && role === "owner";
  const tabs = [
    ...TABS.slice(0, 1),
    ...(messenger ? [MESSENGER_TAB] : []),
    ...TABS.slice(1),
    ...(agenda ? [AGENDA_TAB] : []),
    ...(catalog ? [STAFF_TAB, SERVICES_TAB] : []),
    ...(atribucion ? [ADS_TAB] : []),
  ];
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-44 sm:flex-col sm:space-y-1 sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={cn(
            "block shrink-0 whitespace-nowrap rounded-sm px-3 py-2 text-[13.5px] font-semibold transition-colors",
            pathname.startsWith(t.href)
              ? "bg-brand-tint text-brand-text"
              : "text-text-2 hover:bg-accent hover:text-foreground"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
