/* ==========================================================================
   moon-phase.js — exact times of new moon and full moon, offline.

   Jean Meeus, "Astronomical Algorithms" (2nd ed.), chapter 49 ("Phases of the
   Moon"): mean phase plus the periodic and planetary-argument corrections.
   Accurate to about a minute for years 1900-2100, far finer than a calendar
   day needs. Times are converted from Terrestrial Time to UTC with an
   approximate ΔT, then shown in the device's local time zone, so a phase is
   marked on the local calendar date in which it falls (e.g. IST in India).
   ========================================================================== */
(function (root) {
  'use strict';

  const RAD = Math.PI / 180;
  const sin = (deg) => Math.sin(deg * RAD);

  // ΔT = TT - UT in seconds (Espenak & Meeus polynomial, 2005-2050; good enough for ±2 minutes elsewhere).
  function deltaTSeconds(year) {
    if (year >= 2005 && year <= 2050) { const t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
    const u = (year - 1820) / 100;
    return -20 + 32 * u * u;
  }

  // k: integer = new moon, integer + 0.5 = full moon (k = 0 is the new moon of 6 Jan 2000).
  function phaseJDE(k) {
    const isFull = Math.abs(k - Math.floor(k) - 0.5) < 1e-9;
    const T = k / 1236.85;
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T;

    let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;
    const E = 1 - 0.002516 * T - 0.0000074 * T2;
    const M = 2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3;
    const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4;
    const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;
    const Om = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;

    const c = isFull
      ? [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209]
      : [-0.40720, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208];
    jde += c[0] * sin(Mp)
      + c[1] * E * sin(M)
      + c[2] * sin(2 * Mp)
      + c[3] * sin(2 * F)
      + c[4] * E * sin(Mp - M)
      + c[5] * E * sin(Mp + M)
      + c[6] * E * E * sin(2 * M)
      - 0.00111 * sin(Mp - 2 * F)
      - 0.00057 * sin(Mp + 2 * F)
      + 0.00056 * E * sin(2 * Mp + M)
      - 0.00042 * sin(3 * Mp)
      + 0.00042 * E * sin(M + 2 * F)
      + 0.00038 * E * sin(M - 2 * F)
      - 0.00024 * E * sin(2 * Mp - M)
      - 0.00017 * sin(Om)
      - 0.00007 * sin(Mp + 2 * M)
      + 0.00004 * sin(2 * Mp - 2 * F)
      + 0.00004 * sin(3 * M)
      + 0.00003 * sin(Mp + M - 2 * F)
      + 0.00003 * sin(2 * Mp + 2 * F)
      - 0.00003 * sin(Mp + M + 2 * F)
      + 0.00003 * sin(Mp - M + 2 * F)
      - 0.00002 * sin(Mp - M - 2 * F)
      - 0.00002 * sin(3 * Mp + M)
      + 0.00002 * sin(4 * Mp);

    // Planetary arguments (corrections common to all phases).
    const A = [
      [299.77 + 0.107408 * k - 0.009173 * T2, 0.000325],
      [251.88 + 0.016321 * k, 0.000165],
      [251.83 + 26.651886 * k, 0.000164],
      [349.42 + 36.412478 * k, 0.000126],
      [84.66 + 18.206239 * k, 0.000110],
      [141.74 + 53.303771 * k, 0.000062],
      [207.14 + 2.453732 * k, 0.000060],
      [154.84 + 7.306860 * k, 0.000056],
      [34.52 + 27.261239 * k, 0.000047],
      [207.19 + 0.121824 * k, 0.000042],
      [291.34 + 1.844379 * k, 0.000040],
      [161.72 + 24.198154 * k, 0.000037],
      [239.56 + 25.513099 * k, 0.000035],
      [331.55 + 3.592518 * k, 0.000023],
    ];
    for (const [arg, coef] of A) jde += coef * sin(arg);
    return jde;
  }

  function jdeToDate(jde) {
    const msTT = (jde - 2440587.5) * 86400000;            // JD of the Unix epoch is 2440587.5
    const year = 1970 + msTT / (365.2425 * 86400000);
    return new Date(msTT - deltaTSeconds(year) * 1000);  // TT -> UTC
  }

  function localYmd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // All new and full moons whose instant falls between two dates (inclusive of whole local days).
  function phasesBetween(from, to) {
    const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    const yearFrac = (d) => d.getFullYear() + (d.getMonth() + d.getDate() / 31) / 12;
    const k0 = Math.floor((yearFrac(start) - 2000) * 12.3685) - 1;
    const k1 = Math.ceil((yearFrac(end) - 2000) * 12.3685) + 1;
    const out = [];
    for (let k = k0; k <= k1; k++) {
      for (const [kk, type] of [[k, 'new'], [k + 0.5, 'full']]) {
        const at = jdeToDate(phaseJDE(kk));
        if (at >= start && at < end) out.push({ type, at, date: localYmd(at) });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  const cache = new Map();
  // { 'YYYY-MM-DD': { type: 'new'|'full', at: Date } } for a month, padded a week each side for grid overflow days.
  function phasesForMonth(year, month) {
    const key = `${year}-${month}`;
    if (!cache.has(key)) {
      const map = {};
      for (const p of phasesBetween(new Date(year, month, -7), new Date(year, month + 1, 7))) map[p.date] = p;
      cache.set(key, map);
    }
    return cache.get(key);
  }

  const api = { phaseJDE, jdeToDate, phasesBetween, phasesForMonth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRGMoon = api;
})(typeof window !== 'undefined' ? window : globalThis);
