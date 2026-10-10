/** Preview solar position. SunCalc-style geometry, azimuth converted to north-clockwise.
 *  Spot-checked against pvlib SPA: about 0.4° on the dates in test_preview.mjs.
 *  The annual Gate did not use this function.
 */

const PI = Math.PI;
const sin = Math.sin;
const cos = Math.cos;
const tan = Math.tan;
const asin = Math.asin;
const atan = Math.atan2;
const rad = PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const obliquity = rad * 23.4397;

function toDays(date) {
  return date.valueOf() / dayMs - 0.5 + J1970 - J2000;
}

function rightAscension(l, b) {
  return atan(sin(l) * cos(obliquity) - tan(b) * sin(obliquity), cos(l));
}

function declination(l, b) {
  return asin(sin(b) * cos(obliquity) + cos(b) * sin(obliquity) * sin(l));
}

function solarMeanAnomaly(d) {
  return rad * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M) {
  const C = rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M));
  const P = rad * 102.9372;
  return M + C + P + PI;
}

function lastSunday(year, month) {
  const last = new Date(Date.UTC(year, month, 0));
  last.setUTCDate(last.getUTCDate() - last.getUTCDay());
  return last.getUTCDate();
}

/** Europe/London civil offset in hours. Other zones in this project are UTC+8. */
export function offsetHours(tz, year, month, day, hour) {
  if (tz !== "Europe/London") return 8;
  const startDay = lastSunday(year, 3);
  const endDay = lastSunday(year, 10);
  if (month < 3 || month > 10) return 0;
  if (month > 3 && month < 10) return 1;
  if (month === 3) return day > startDay || (day === startDay && hour >= 2) ? 1 : 0;
  return day < endDay || (day === endDay && hour < 1) ? 1 : 0;
}

export function localToUtc(year, month, day, hour, minute, tz) {
  const offset = offsetHours(tz, year, month, day, hour);
  return new Date(Date.UTC(year, month - 1, day, hour - offset, minute, 0));
}

/** Degrees. Azimuth clockwise from north, matching pvlib / glare_sim.physics. */
export function solarPosition(utcDate, lat, lon) {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(utcDate);
  const L = eclipticLongitude(solarMeanAnomaly(d));
  const dec = declination(L, 0);
  const ra = rightAscension(L, 0);
  const H = rad * (280.16 + 360.9856235 * d) - lw - ra;
  const altitude = asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
  const azSouth = atan(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi));
  let azNorth = azSouth / rad + 180;
  azNorth = ((azNorth % 360) + 360) % 360;
  return { elevationDeg: altitude / rad, azimuthDeg: azNorth };
}

export function sunVector(elevationDeg, azimuthDeg) {
  const el = elevationDeg * rad;
  const az = azimuthDeg * rad;
  return [sin(az) * cos(el), cos(az) * cos(el), sin(el)];
}

/** Meinel-style clear-sky DNI for colouring only. Not TMY and not Ineichen. */
export function previewDni(elevationDeg) {
  if (elevationDeg <= 0) return 0;
  const am = 1 / Math.sin(Math.max(elevationDeg * rad, 0.02));
  return 1361 * Math.pow(0.7, Math.pow(am, 0.678));
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function dayOfYear(month, day) {
  let n = day;
  for (let i = 0; i < month - 1; i += 1) n += MONTH_DAYS[i];
  return n;
}

export function fromDayOfYear(doy) {
  let left = Math.max(1, Math.min(365, doy));
  for (let i = 0; i < 12; i += 1) {
    if (left <= MONTH_DAYS[i]) return { month: i + 1, day: left };
    left -= MONTH_DAYS[i];
  }
  return { month: 12, day: 31 };
}

export function formatStamp(year, month, day, hour, minute) {
  const p = (n) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}`;
}
