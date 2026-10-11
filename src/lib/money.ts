/**
 * Dinero. Vive en `lib/` (no en `server/`) porque el tablero suma sus columnas
 * en el cliente y no puede arrastrar la BD al bundle.
 *
 * Todo en CENTAVOS ENTEROS, también en el cálculo: sumar pesos en coma flotante
 * da totales que el dueño no puede cuadrar contra sus propias tarjetas.
 *
 * La moneda NO está cableada. Cada instancia elige la suya en Ajustes → Marca,
 * y todas las funciones la reciben explícitamente: un default global escondido
 * haría que una instalación fuera de su país sumara mal sin avisar.
 */

/** Monedas ISO-4217 razonables para un CRM de WhatsApp hispanohablante. */
export const CURRENCIES = [
  "MXN",
  "USD",
  "EUR",
  "COP",
  "ARS",
  "CLP",
  "PEN",
  "GTQ",
  "DOP",
  "BRL",
] as const;

export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "MXN";

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);
}

/**
 * ¿Este monto entra en el total de su columna? Solo suma lo que está en la
 * moneda del negocio: convertir exigiría un tipo de cambio, y un CRM que
 * inventa tipos de cambio miente. Lo que queda fuera se CUENTA aparte para
 * poder decirlo en pantalla, en vez de desaparecerlo.
 */
export function sumable(
  amount: { amountCents: number | null; currency: string | null },
  businessCurrency: string
): boolean {
  if (amount.amountCents === null) return false;
  return (amount.currency ?? businessCurrency) === businessCurrency;
}

/** Dinero para mostrar. Recibe centavos porque es como viaja y como se guarda. */
export function formatMoneyCents(
  cents: number | null | undefined,
  currency: string,
  locale = "es-MX"
): string | null {
  if (cents === null || cents === undefined) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // Moneda o locale que el runtime no conoce: mejor un número correcto sin
    // símbolo que una pantalla rota.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Texto libre del dueño → centavos. Acepta "12,500.50", "12500", "$12 500".
 * Devuelve `null` si no hay un número reconocible, para no guardar un 0 que
 * después se lea como "no vale nada".
 */
export function parseMoneyToCents(input: string): number | null {
  const limpio = input.replace(/[^\d.,-]/g, "").trim();
  if (!limpio) return null;
  // El último separador manda como decimal; el resto son de millares.
  const ultimoPunto = limpio.lastIndexOf(".");
  const ultimaComa = limpio.lastIndexOf(",");
  const corte = Math.max(ultimoPunto, ultimaComa);
  let entero = limpio;
  let decimales = "";
  if (corte !== -1 && limpio.length - corte <= 3) {
    entero = limpio.slice(0, corte);
    decimales = limpio.slice(corte + 1);
  }
  const soloDigitos = entero.replace(/[^\d-]/g, "");
  if (!soloDigitos || soloDigitos === "-") return null;
  const cents =
    Number(soloDigitos) * 100 + Number((decimales + "00").slice(0, 2)) *
      (soloDigitos.startsWith("-") ? -1 : 1);
  return Number.isFinite(cents) ? Math.trunc(cents) : null;
}

/** Locale whose digit grouping matches how each currency is written locally. */
const PRICE_LOCALE: Record<string, string> = {
  COP: "es-CO",
  ARS: "es-AR",
  CLP: "es-CL",
  PEN: "es-PE",
  EUR: "es-ES",
  BRL: "pt-BR",
};
const PRICE_SYMBOL: Record<string, string> = { EUR: "€", BRL: "R$" };

/**
 * Precio para un mensaje de WhatsApp: "$25.000 COP", "$250 MXN", "$150.50 MXN".
 * El agrupador de miles sigue a la moneda; los decimales solo salen cuando la
 * moneda los tiene y el monto los necesita. `null` si el servicio no cuesta.
 */
export function formatPriceShort(cents: number, currency: string): string | null {
  if (cents <= 0) return null;
  const amount = cents / 100;
  const locale = PRICE_LOCALE[currency] ?? "es-MX";
  let minorDigits = 2;
  try {
    minorDigits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits as number;
  } catch {
    // Código de moneda que el runtime no conoce: se asume la unidad menor de 2.
  }
  const shown = minorDigits === 0 ? Math.round(amount) : amount;
  const decimals = Number.isInteger(shown) ? 0 : minorDigits;
  const digits = new Intl.NumberFormat(locale, {
    useGrouping: "always",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  } as Intl.NumberFormatOptions).format(shown);
  return `${PRICE_SYMBOL[currency] ?? "$"}${digits} ${currency}`;
}
