/* ==========================================================================
   panchang.js — tithi (lunar day) for each date, offline.

   Tithi = the Moon's elongation from the Sun divided into 30 parts of 12°
   (Shukla/Valarpirai 1-15, ending at Pournami; Krishna/Theipirai 1-15,
   ending at Amavasya). Positions and sunrise/sunset come from the bundled
   astronomy-engine library (vendor/astronomy/astronomy.browser.min.js, MIT).

   Day rules used here (common South Indian Panchang practice):
   - The day's tithi is the one running at local sunrise.
   - Pradosham: Thrayodasi (13th tithi, either paksha) running at sunset;
     Soma Pradosham on Mondays, Shani Pradosham on Saturdays.
   - Ekadasi, Pournami, Amavasya: by the tithi at sunrise.
   - Nakshatra and Rasi (Moon's star and sign) at sunrise, in the sidereal
     zodiac with the Lahiri (Chitrapaksha) ayanamsa: 23.857092° at J2000,
     precessing 50.28"/year (Swiss Ephemeris SE_SIDM_LAHIRI values).
   End times ("till 3:12 pm") are when the tithi/nakshatra/rasi changes.
   Sunrise/sunset are for a reference place (default Chennai). Temple and
   sect calendars can apply further rules (e.g. Vaishnava Ekadasi), so an
   occasional day may differ from a printed Panchang.
   ========================================================================== */
(function (root) {
  'use strict';

  const A = root.Astronomy || (typeof require === 'function' ? require('astronomy-engine') : null);

  const PLACES = {
    chennai: { name: 'Chennai', lat: 13.0827, lon: 80.2707 },
    trivandrum: { name: 'Thiruvananthapuram', lat: 8.5241, lon: 76.9366 },
    bengaluru: { name: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
    mumbai: { name: 'Mumbai', lat: 19.0760, lon: 72.8777 },
    delhi: { name: 'New Delhi', lat: 28.6139, lon: 77.2090 },
    kolkata: { name: 'Kolkata', lat: 22.5726, lon: 88.3639 },
  };
  let placeKey = 'chennai';

  const TITHI = ['Prathamai', 'Dhvitiyai', 'Thrithiyai', 'Chathurthi', 'Panchami', 'Sashti', 'Sapthami',
    'Ashtami', 'Navami', 'Dhasami', 'Ekadasi', 'Dhvadasi', 'Thrayodasi', 'Chathurdasi'];

  const NAKSHATRA = ['Ashwini', 'Bharani', 'Karthigai', 'Rohini', 'Mirugasirisham', 'Thiruvathirai', 'Punarpoosam',
    'Poosam', 'Ayilyam', 'Magam', 'Pooram', 'Uthiram', 'Hastham', 'Chithirai', 'Swathi', 'Visakam', 'Anusham',
    'Kettai', 'Moolam', 'Pooradam', 'Uthiradam', 'Thiruvonam', 'Avittam', 'Sadhayam', 'Poorattathi', 'Uthirattathi', 'Revathi'];
  const RASI = ['Mesham', 'Rishabam', 'Mithunam', 'Kadagam', 'Simmam', 'Kanni', 'Thulam', 'Viruchigam',
    'Dhanusu', 'Magaram', 'Kumbam', 'Meenam'];

  function lahiriAyanamsa(date) {
    const years = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 365.25;
    return 23.857092 + (50.28 / 3600) * years;
  }

  // Moon's sidereal longitude (0-360°)
  function moonSidereal(date) {
    const lon = A.EclipticGeoMoon(date).lon - lahiriAyanamsa(date);
    return ((lon % 360) + 360) % 360;
  }

  // When an angle (fn, degrees 0-360, increasing ~speed °/day) next reaches a multiple of `step`.
  function nextBoundary(fn, start, step, speed) {
    const v0 = fn(start);
    const target = (Math.floor(v0 / step) + 1) * step;
    const unwrap = (v) => v0 + ((((v - v0) % 360) + 360) % 360);
    let t = new Date(start.getTime() + ((target - v0) / speed) * 86400000);
    for (let i = 0; i < 6; i++) {
      const v = unwrap(fn(t));
      const dt = ((target - v) / speed) * 86400000;
      t = new Date(t.getTime() + dt);
      if (Math.abs(dt) < 20000) break;
    }
    return t;
  }

  // 1-30 at an instant: 1-15 Shukla (15 = Pournami), 16-30 Krishna (30 = Amavasya)
  function tithiAt(date) {
    const elong = A.MoonPhase(date);                    // Moon minus Sun ecliptic longitude, 0-360°
    return Math.min(30, Math.floor(elong / 12) + 1);
  }

  function tithiName(n) {
    if (n === 15) return 'Pournami';
    if (n === 30) return 'Amavasya';
    const paksha = n <= 15 ? 'Valarpirai' : 'Theipirai';
    return `${paksha} ${TITHI[(n - 1) % 15]}`;
  }

  function observer() {
    const p = PLACES[placeKey] || PLACES.chennai;
    return new A.Observer(p.lat, p.lon, 0);
  }

  const cache = new Map();
  function dayInfo(year, month, day) {
    if (!A) return null;
    const key = `${placeKey}|${year}-${month}-${day}`;
    if (cache.has(key)) return cache.get(key);
    const obs = observer();
    const midnight = new Date(year, month, day, 0, 0, 0);
    const rise = A.SearchRiseSet(A.Body.Sun, obs, +1, midnight, 1);
    const set = A.SearchRiseSet(A.Body.Sun, obs, -1, midnight, 1);
    const sunrise = rise ? rise.date : new Date(year, month, day, 6, 0);
    const sunset = set ? set.date : new Date(year, month, day, 18, 0);
    const t = tithiAt(sunrise);
    const tSet = tithiAt(sunset);
    const weekday = midnight.getDay();

    let special = null;
    if (tSet === 13 || tSet === 28) {
      special = weekday === 1 ? 'Soma Pradosham' : weekday === 6 ? 'Shani Pradosham' : 'Pradosham';
    } else if (t === 15) special = 'Pournami';
    else if (t === 30) special = 'Amavasya';
    else if (t === 11 || t === 26) special = 'Ekadasi';

    const sid = moonSidereal(sunrise);
    const nak = Math.floor(sid / (360 / 27));
    const rasi = Math.floor(sid / 30);
    const info = {
      tithi: t, name: tithiName(t), special, sunrise, sunset,
      tithiEnds: nextBoundary((d) => A.MoonPhase(d), sunrise, 12, 12.19),
      nextName: tithiName((t % 30) + 1),
      nakshatra: NAKSHATRA[nak],
      nakshatraEnds: nextBoundary(moonSidereal, sunrise, 360 / 27, 13.18),
      nextNakshatra: NAKSHATRA[(nak + 1) % 27],
      rasi: RASI[rasi],
      rasiEnds: nextBoundary(moonSidereal, sunrise, 30, 13.18),
      nextRasi: RASI[(rasi + 1) % 12],
      place: (PLACES[placeKey] || PLACES.chennai).name,
    };
    cache.set(key, info);
    return info;
  }

  function setPlace(key) {
    if (PLACES[key]) { placeKey = key; cache.clear(); }
  }

  const api = { dayInfo, tithiAt, tithiName, moonSidereal, lahiriAyanamsa, setPlace, places: PLACES, get place() { return placeKey; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRGPanchang = api;
})(typeof window !== 'undefined' ? window : globalThis);
