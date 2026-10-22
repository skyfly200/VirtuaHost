// A quick, honest estimate of where a transmitter can be heard: power, antenna and height in, a circle or rough ellipse out. It is a PLANNING
// model for decisions like "is this alert or event inside where we are heard", not a coverage study. It ignores terrain (hills, mountains,
// buildings beyond a flat allowance), so in rough country it over-predicts behind ridges and under-predicts from high ground. For a real
// prediction use terrain-aware tools (Nautel's, SPLAT!, Radio Mobile) and import the contour: see docs/COVERAGE.md.
//
// The model, step by step:
//   ERP        transmitter power x antenna gain (dBd) less line loss, relative to a half-wave dipole.
//   Free space E(d) = 106.92 + 10 log10(ERP in kW) - 20 log10(d in km)   dB(uV/m)   (the standard figure for ERP referenced to a dipole).
//   Horizon    d_h = 4.12 (sqrt(h_tx) + sqrt(h_rx)) km, heights in metres (4/3-earth radio horizon).
//   Beyond it  the field falls 40 dB per decade instead of 20 (diffraction), from its value at the horizon.
//   Clutter    a flat dB allowance for the surroundings (open 0, suburban 8, urban 16) plus any extra loss you enter.
//   Contours   the distance where the field drops to 70 (strong), 60 (good) and 48 (fringe) dB(uV/m): the usual FM-style planning levels.
//   Pattern    omni = the same distance every way (a circle); a directional antenna scales the distance by azimuth (an ellipse-like shape).
// Frequency does not change free-space field strength, so it is recorded but not used.
export const FREE_SPACE_DBU = 106.92;
export const LEVELS = [
  { name: "strong", dbu: 70, label: "Strong (city grade)" },
  { name: "good", dbu: 60, label: "Good (reliable)" },
  { name: "fringe", dbu: 48, label: "Fringe (weak, noisy)" },
] as const;
export type LevelName = (typeof LEVELS)[number]["name"];

export const ENVIRONMENTS = { open: 0, suburban: 8, urban: 16 } as const;
export type Environment = keyof typeof ENVIRONMENTS;

export const ANTENNAS = {
  "ground-plane": { label: "Quarter-wave ground plane (omni)", gainDbd: 0, directional: false },
  dipole: { label: "Half-wave dipole (omni)", gainDbd: 0, directional: false },
  collinear: { label: "Collinear / multi-bay (omni)", gainDbd: 3, directional: false },
  directional: { label: "Directional (yagi, panel)", gainDbd: 6, directional: true },
  other: { label: "Other (set the gain)", gainDbd: 0, directional: false },
} as const;
export type AntennaType = keyof typeof ANTENNAS;

export interface Transmitter {
  /** Transmitter output power (TPO), watts. Used with the gain and loss unless `erpWatts` is given. */
  powerWatts?: number;
  /** Effective radiated power, watts, if you know it (a datasheet or your own figure). Wins over power x gain. */
  erpWatts?: number;
  antenna: AntennaType;
  /** Antenna gain over a half-wave dipole, dB. Defaults from the antenna type. */
  gainDbd?: number;
  /** Feedline and connector loss, dB. */
  lossDb?: number;
  /** Antenna height above ground, feet. */
  heightFt: number;
  /** Antenna height above AVERAGE surrounding terrain (HAAT), feet, if known: better than height above ground, especially on a hill. */
  haatFt?: number;
  /** Ground elevation above sea level, feet. Recorded for reference; not used by this quick model. */
  groundElevationFt?: number;
  frequencyMHz?: number;
  environment: Environment;
  /** Extra loss for the surroundings, dB (terrain you know about). */
  extraLossDb?: number;
  /** For a directional antenna: the way it points (degrees from north), its beamwidth, and how much weaker it is behind. */
  directional?: { azimuthDeg: number; beamwidthDeg: number; frontToBackDb: number };
}

const FT = 0.3048;
export const RX_HEIGHT_M = 1.5;                                        // a car radio or a person
const log10 = Math.log10;

export const gainOf = (tx: Transmitter): number => tx.gainDbd ?? ANTENNAS[tx.antenna].gainDbd;

/** Peak ERP in watts, or null when there is no power to work from. */
export function erpWatts(tx: Transmitter): number | null {
  if (typeof tx.erpWatts === "number" && tx.erpWatts > 0) return tx.erpWatts;
  if (typeof tx.powerWatts !== "number" || tx.powerWatts <= 0) return null;
  return tx.powerWatts * 10 ** ((gainOf(tx) - (tx.lossDb ?? 0)) / 10);
}

export const txHeightM = (tx: Transmitter): number => Math.max(1, (tx.haatFt ?? tx.heightFt) * FT);

/** Distance in km at which the field has fallen to `dbu`, for a given ERP in watts. */
export function radiusKm(erp: number, hTxM: number, dbu: number, extraLossDb = 0, hRxM = RX_HEIGHT_M): number {
  if (!(erp > 0)) return 0;
  const e1 = FREE_SPACE_DBU + 10 * log10(erp / 1000) - extraLossDb;           // the field at 1 km
  const horizon = 4.12 * (Math.sqrt(hTxM) + Math.sqrt(hRxM));
  const atHorizon = e1 - 20 * log10(horizon);
  const d = atHorizon >= dbu ? horizon * 10 ** ((atHorizon - dbu) / 40) : 10 ** ((e1 - dbu) / 20);
  return Math.max(0.01, d);
}

const extraLoss = (tx: Transmitter): number => ENVIRONMENTS[tx.environment] + (tx.extraLossDb ?? 0);

/** How much weaker than peak the signal is toward a bearing (dB, >= 0). 0 for an omni antenna. */
export function patternLossDb(tx: Transmitter, bearingDeg: number): number {
  const d = tx.directional;
  if (!d || !ANTENNAS[tx.antenna].directional) return 0;
  let off = Math.abs(((bearingDeg - d.azimuthDeg) % 360 + 540) % 360 - 180);   // 0 to 180 degrees off the way it points
  off = Math.min(180, off);
  return Math.min(d.frontToBackDb, 3 * (off / (d.beamwidthDeg / 2)) ** 2);   // -3 dB at the beamwidth edge, never weaker than front-to-back
}

/** Distance in km toward `bearingDeg` where the field falls to the named level, or 0 if there is no power. */
export function reachKm(tx: Transmitter, level: LevelName, bearingDeg = 0): number {
  const erp = erpWatts(tx);
  if (erp === null) return 0;
  const dbu = LEVELS.find((l) => l.name === level)!.dbu;
  return radiusKm(erp * 10 ** (-patternLossDb(tx, bearingDeg) / 10), txHeightM(tx), dbu, extraLoss(tx));
}

// ---------- geometry ----------
const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point `km` away from (lat, lon) along `bearingDeg`. */
export function destination(lat: number, lon: number, bearingDeg: number, km: number): { lat: number; lon: number } {
  const d = km / R_KM; const b = rad(bearingDeg); const p1 = rad(lat); const l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: Math.round(deg(p2) * 1e5) / 1e5, lon: Math.round((((deg(l2) + 540) % 360) - 180) * 1e5) / 1e5 };
}

/** Initial bearing from one point to another, degrees from north (0-360). */
export function bearingTo(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const p1 = rad(from.lat); const p2 = rad(to.lat); const dl = rad(to.lon - from.lon);
  return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360;
}

export interface CoverageModel {
  model: "quick";
  erpWatts: number;
  heightUsedM: number;
  /** Distance to each level straight ahead (the maximum for a directional antenna), km. */
  reachKm: Record<LevelName, number>;
  levels: Array<{ name: LevelName; dbu: number; label: string; km: number }>;
  /** One closed ring per level, as GeoJSON (a circle for an omni antenna, an ellipse-like shape for a directional one). */
  geojson: { type: "FeatureCollection"; features: Array<{ type: "Feature"; properties: { level: LevelName; dbu: number; km: number }; geometry: { type: "Polygon"; coordinates: number[][][] } }> };
  assumptions: string[];
}

const RADIALS = 72;                                                  // every 5 degrees

/** The model for a transmitter at a place, or null when there is no power to work from. */
export function coverageModel(tx: Transmitter, at: { lat: number; lon: number }): CoverageModel | null {
  const erp = erpWatts(tx);
  if (erp === null) return null;
  const peak = tx.directional && ANTENNAS[tx.antenna].directional ? tx.directional.azimuthDeg : 0;
  const reach = Object.fromEntries(LEVELS.map((l) => [l.name, Math.round(reachKm(tx, l.name, peak) * 100) / 100])) as Record<LevelName, number>;
  const features = LEVELS.map((l) => ({
    type: "Feature" as const,
    properties: { level: l.name, dbu: l.dbu, km: reach[l.name] },
    geometry: { type: "Polygon" as const, coordinates: [Array.from({ length: RADIALS + 1 }, (_, i) => { const b = (i % RADIALS) * (360 / RADIALS); const p = destination(at.lat, at.lon, b, reachKm(tx, l.name, b)); return [p.lon, p.lat]; })] },
  }));
  return {
    model: "quick", erpWatts: Math.round(erp * 1000) / 1000, heightUsedM: Math.round(txHeightM(tx) * 10) / 10, reachKm: reach,
    levels: LEVELS.map((l) => ({ name: l.name, dbu: l.dbu, label: l.label, km: reach[l.name] })),
    geojson: { type: "FeatureCollection", features },
    assumptions: [
      "Ignores terrain: hills and mountains are not modelled, so coverage is over-predicted behind ridges and under-predicted from high ground.",
      tx.haatFt === undefined ? "Uses the antenna's height above ground; give height above average terrain (HAAT) for a better answer, especially on a hill." : "Uses the height above average terrain you gave.",
      `Surroundings allowance: ${ENVIRONMENTS[tx.environment]} dB (${tx.environment})${tx.extraLossDb ? ` plus ${tx.extraLossDb} dB you added` : ""}.`,
      `Receiver at ${RX_HEIGHT_M} m. Planning levels: 70, 60 and 48 dBuV/m.`,
      "A planning estimate, not a terrain-aware coverage study.",
    ],
  };
}
