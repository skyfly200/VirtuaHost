// The station you are working on. Stations are profiles kept on the site (docs: Stations tab); one is "active" at a time, chosen in the
// header and remembered in this browser. Every view reads it from here: its name goes into AI-written lines, its time zone is the default
// for schedules and promos, and its persona, voice and treatment are the defaults for new clips.
const KEY = 'activeStation';

let stations = [];
let current = null;

export const allStations = () => stations;
export const currentStation = () => current;
export const stationName = (fallback = '') => (current && current.name) || fallback;
// A real profile (not the placeholder named by STATION_NAME) is what gets recorded on clips.
export const stationId = () => (current && !current.builtin ? current.id : '');

export async function loadStations(api) {
  try { stations = (await api.get('/stations')).stations; } catch { stations = []; }
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch { /* storage blocked */ }
  current = stations.find((s) => s.id === saved) || stations[0] || null;
  return stations;
}

export function setStation(id) {
  current = stations.find((s) => s.id === id) || current;
  try { if (current) localStorage.setItem(KEY, current.id); } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent('vh-station', { detail: current }));
}

// Replaces the station's own profile in the list (after it was edited) without changing which one is active.
export function refreshStations(next) {
  stations = next;
  current = stations.find((s) => current && s.id === current.id) || stations[0] || null;
}

export const fillStation = (text) => text.replace(/\{station\}/g, stationName('the station'));
