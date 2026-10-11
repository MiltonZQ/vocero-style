import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 019 — Where the shop is and how early to arrive. Kept apart from
 * `getSettings` so the engine's settings shape stays untouched.
 */

export type ShopLocation = {
  locationAddress: string | null;
  locationMapsUrl: string | null;
  arrivalLeadMinutes: number;
  /** Coordenadas del pin de WhatsApp; ambas o ninguna. */
  latitude: number | null;
  longitude: number | null;
};

import { parseMapsCoordinates } from "@/lib/maps-coordinates";

export { parseMapsCoordinates };

export const DEFAULT_LOCATION: ShopLocation = {
  locationAddress: null,
  locationMapsUrl: null,
  arrivalLeadMinutes: 5,
  latitude: null,
  longitude: null,
};

export async function getShopLocation(
  organizationId: string,
  db: ReturnType<typeof getDb> = getDb()
): Promise<ShopLocation> {
  const [row] = await db
    .select({
      locationAddress: schema.calendarSettings.locationAddress,
      locationMapsUrl: schema.calendarSettings.locationMapsUrl,
      arrivalLeadMinutes: schema.calendarSettings.arrivalLeadMinutes,
      latitude: schema.calendarSettings.latitude,
      longitude: schema.calendarSettings.longitude,
    })
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  if (!row) return DEFAULT_LOCATION;
  // Sin coordenadas guardadas pero con un enlace que las trae: el pin sale igual.
  if ((row.latitude === null || row.longitude === null) && row.locationMapsUrl) {
    const parsed = parseMapsCoordinates(row.locationMapsUrl);
    if (parsed.ok) return { ...row, latitude: parsed.lat, longitude: parsed.lng };
  }
  return row;
}

// Used only to keep the eq import honest for future filters.
void eq;
