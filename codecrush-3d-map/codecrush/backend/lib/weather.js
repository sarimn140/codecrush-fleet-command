'use strict';
/*
 * Weather integration - Open-Meteo (no API key required, free tier).
 * We snap coordinates to a coarse grid (0.5 deg) and cache results for 10 minutes so
 * we don't hammer the API for 15 ships ticking at 1Hz.
 *
 * Adverse weather = wind gusts > 25 kt OR precipitation > 0.5mm OR a "storm-like"
 * WMO weather code (thunderstorm codes 95-99, or heavy rain/snow codes >= 65).
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { data, ts }

function gridKey(lat, lng) {
  const glat = Math.round(lat * 2) / 2;
  const glng = Math.round(lng * 2) / 2;
  return `${glat},${glng}`;
}

function isAdverseCode(code) {
  return (code >= 95 && code <= 99) || (code >= 65 && code <= 67) || (code >= 82 && code <= 86);
}

async function fetchWeatherAt(lat, lng) {
  const key = gridKey(lat, lng);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const [glat, glng] = key.split(',').map(Number);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${glat}&longitude=${glng}&current=wind_speed_10m,wind_gusts_10m,precipitation,weather_code&wind_speed_unit=kn`;

  let data;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) throw new Error(`open-meteo status ${resp.status}`);
    const json = await resp.json();
    const cur = json.current || {};
    const gusts = cur.wind_gusts_10m ?? 0;
    const precip = cur.precipitation ?? 0;
    const code = cur.weather_code ?? 0;
    const adverse = gusts > 25 || precip > 0.5 || isAdverseCode(code);
    data = {
      windSpeedKt: cur.wind_speed_10m ?? 0,
      windGustsKt: gusts,
      precipitationMm: precip,
      weatherCode: code,
      adverse,
      source: 'open-meteo',
      fetchedAt: Date.now(),
    };
  } catch (err) {
    // Network unavailable / rate limited -> fail safe to a benign, clearly-flagged default
    data = {
      windSpeedKt: 0,
      windGustsKt: 0,
      precipitationMm: 0,
      weatherCode: 0,
      adverse: false,
      source: 'fallback (fetch failed: ' + err.message + ')',
      fetchedAt: Date.now(),
    };
  }
  cache.set(key, { data, ts: Date.now() });
  return data;
}

// Synchronous sampler used by the routing engine, backed by whatever is already cached.
// Falls back to "no data / assume calm" for cells we haven't fetched yet - the periodic
// background refresh (see startWeatherRefresh) keeps the cache warm for ship positions.
function sampler(lat, lng) {
  const key = gridKey(lat, lng);
  const cached = cache.get(key);
  return cached ? cached.data : { adverse: false, source: 'no-data-yet' };
}

function makeSampler() {
  return (posOrLat, maybeLng) => {
    if (Array.isArray(posOrLat)) return sampler(posOrLat[0], posOrLat[1]);
    return sampler(posOrLat, maybeLng);
  };
}

// Kick off periodic refreshes for a set of positions (called each tick with live ship positions)
async function refreshFor(positions) {
  await Promise.all(positions.map(([lat, lng]) => fetchWeatherAt(lat, lng).catch(() => null)));
}

module.exports = { fetchWeatherAt, makeSampler, refreshFor, gridKey };
