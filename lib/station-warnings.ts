import type { Station } from "./station-profile.js";
import { zoneWarnings, type ZoneWarning } from "./timezones.js";

/** Things worth telling the person who edits a station: clock settings that disagree, and a missing location for {{weather}}. */
export function stationWarnings(s: Station, now = Date.now()): ZoneWarning[] {
  const out = zoneWarnings({ machineTz: s.machineTz, broadcastTz: s.broadcastTz ?? s.tz, now });
  // Only a station with a PC to warn about needs a machineTz; a profile with no connection stays quiet about it.
  const quiet = s.connection.kind !== "radiodj";
  const list = out.filter((w) => !(quiet && w.code === "machine-tz-missing"));
  const located = (typeof s.lat === "number" && typeof s.lon === "number") || !!s.city || !!s.place;
  if (!located) list.push({ code: "weather-location-missing", level: "warn", message: "{{weather}} and {{temp}} need a place: set the station's city, or its latitude and longitude. Until then those placeholders are left out of the spoken line." });
  return list;
}
