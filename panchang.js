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

  // Reference places for sunrise/sunset: State/UT capitals and large cities (lat, lon in degrees).
  const PLACES = {
    agartala: { name: 'Agartala', lat: 23.8315, lon: 91.2868 },
    ahmedabad: { name: 'Ahmedabad', lat: 23.0225, lon: 72.5714 },
    aizawl: { name: 'Aizawl', lat: 23.7271, lon: 92.7176 },
    bengaluru: { name: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
    bhopal: { name: 'Bhopal', lat: 23.2599, lon: 77.4126 },
    bhubaneswar: { name: 'Bhubaneswar', lat: 20.2961, lon: 85.8245 },
    chandigarh: { name: 'Chandigarh', lat: 30.7333, lon: 76.7794 },
    chennai: { name: 'Chennai', lat: 13.0827, lon: 80.2707 },
    coimbatore: { name: 'Coimbatore', lat: 11.0168, lon: 76.9558 },
    dehradun: { name: 'Dehradun', lat: 30.3165, lon: 78.0322 },
    gangtok: { name: 'Gangtok', lat: 27.3389, lon: 88.6065 },
    guwahati: { name: 'Guwahati', lat: 26.1445, lon: 91.7362 },
    hyderabad: { name: 'Hyderabad', lat: 17.3850, lon: 78.4867 },
    imphal: { name: 'Imphal', lat: 24.8170, lon: 93.9368 },
    itanagar: { name: 'Itanagar', lat: 27.0844, lon: 93.6053 },
    jaipur: { name: 'Jaipur', lat: 26.9124, lon: 75.7873 },
    jammu: { name: 'Jammu', lat: 32.7266, lon: 74.8570 },
    kochi: { name: 'Kochi', lat: 9.9312, lon: 76.2673 },
    kohima: { name: 'Kohima', lat: 25.6751, lon: 94.1086 },
    kolkata: { name: 'Kolkata', lat: 22.5726, lon: 88.3639 },
    lucknow: { name: 'Lucknow', lat: 26.8467, lon: 80.9462 },
    madurai: { name: 'Madurai', lat: 9.9252, lon: 78.1198 },
    mumbai: { name: 'Mumbai', lat: 19.0760, lon: 72.8777 },
    delhi: { name: 'New Delhi', lat: 28.6139, lon: 77.2090 },
    panaji: { name: 'Panaji', lat: 15.4909, lon: 73.8278 },
    patna: { name: 'Patna', lat: 25.5941, lon: 85.1376 },
    puducherry: { name: 'Puducherry', lat: 11.9416, lon: 79.8083 },
    pune: { name: 'Pune', lat: 18.5204, lon: 73.8567 },
    raipur: { name: 'Raipur', lat: 21.2514, lon: 81.6296 },
    ranchi: { name: 'Ranchi', lat: 23.3441, lon: 85.3096 },
    shillong: { name: 'Shillong', lat: 25.5788, lon: 91.8933 },
    shimla: { name: 'Shimla', lat: 31.1048, lon: 77.1734 },
    srinagar: { name: 'Srinagar', lat: 34.0837, lon: 74.7973 },
    trivandrum: { name: 'Thiruvananthapuram', lat: 8.5241, lon: 76.9366 },
    tiruchirappalli: { name: 'Tiruchirappalli', lat: 10.7905, lon: 78.7047 },
    varanasi: { name: 'Varanasi', lat: 25.3176, lon: 82.9739 },
    vijayawada: { name: 'Vijayawada', lat: 16.5062, lon: 80.6480 },
    visakhapatnam: { name: 'Visakhapatnam', lat: 17.6868, lon: 83.2185 },
  };
  let placeKey = 'chennai';

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

    // special day code: pradosham / soma / shani / purnima / amavasya / ekadasi
    let special = null;
    if (tSet === 13 || tSet === 28) special = weekday === 1 ? 'soma' : weekday === 6 ? 'shani' : 'pradosham';
    else if (t === 15) special = 'purnima';
    else if (t === 30) special = 'amavasya';
    else if (t === 11 || t === 26) special = 'ekadasi';

    const sid = moonSidereal(sunrise);
    const nak = Math.floor(sid / (360 / 27));
    const rasi = Math.floor(sid / 30);
    const info = {
      tithi: t,                     // 1-30 (15 Purnima, 30 Amavasya); names come from panchang-i18n.js
      tithiEnds: nextBoundary((d) => A.MoonPhase(d), sunrise, 12, 12.19),
      nakshatra: nak,               // 0-26, Ashwini..Revati
      nakshatraEnds: nextBoundary(moonSidereal, sunrise, 360 / 27, 13.18),
      rasi,                         // 0-11, Mesha..Meena
      rasiEnds: nextBoundary(moonSidereal, sunrise, 30, 13.18),
      special, sunrise, sunset,
      place: (PLACES[placeKey] || PLACES.chennai).name,
    };
    cache.set(key, info);
    return info;
  }

  function setPlace(key) {
    if (PLACES[key]) { placeKey = key; cache.clear(); }
  }

  const api = { dayInfo, tithiAt, moonSidereal, lahiriAyanamsa, setPlace, places: PLACES, get place() { return placeKey; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRGPanchang = api;
})(typeof window !== 'undefined' ? window : globalThis);
