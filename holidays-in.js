/* ==========================================================================
   holidays-in.js — Government of India gazetted (closed) holidays.

   Source: DoPT, Ministry of Personnel, Public Grievances & Pensions,
   "Holidays to be observed in Central Government offices", Annexure-I
   (administrative offices of the Central Government at Delhi/New Delhi):
     2026: O.M. F. No. 12/2/2023-JCA dated 03.07.2025
     2027: O.M. F. No. 12/2/2023-JCA dated 16.07.2026
   Offices outside Delhi observe the 14 compulsory holidays plus 3 chosen by the
   Central Government Employees Welfare Coordination Committee of each State
   capital, so a few dates differ by State. State Government holidays differ
   too. Add a year here only once its O.M. is issued.
   ========================================================================== */
(function (root) {
  'use strict';

  const NATIONAL = new Set(['Republic Day', 'Independence Day', "Mahatma Gandhi's Birthday"]);

  const LISTS = {
    2026: {
      source: 'DoPT O.M. F. No. 12/2/2023-JCA dated 03.07.2025',
      days: [
        ['01-26', 'Republic Day'],
        ['03-04', 'Holi'],
        ['03-21', 'Id-ul-Fitr'],
        ['03-26', 'Ram Navami'],
        ['03-31', 'Mahavir Jayanti'],
        ['04-03', 'Good Friday'],
        ['05-01', 'Budha Purnima'],
        ['05-27', 'Id-ul-Zuha (Bakrid)'],
        ['06-26', 'Muharram'],
        ['08-15', 'Independence Day'],
        ['08-26', 'Milad-un-Nabi (Id-e-Milad)'],
        ['09-04', 'Janmashtami (Vaishnava)'],
        ['10-02', "Mahatma Gandhi's Birthday"],
        ['10-20', 'Dussehra'],
        ['11-08', 'Diwali (Deepavali)'],
        ['11-24', "Guru Nanak's Birthday"],
        ['12-25', 'Christmas Day'],
      ],
    },
    2027: {
      source: 'DoPT O.M. F. No. 12/2/2023-JCA dated 16.07.2026',
      days: [
        ['01-26', 'Republic Day'],
        ['03-10', 'Id-ul-Fitr'],
        ['03-23', 'Holi'],
        ['03-26', 'Good Friday'],
        ['04-15', 'Ram Navami'],
        ['04-19', 'Mahavir Jayanti'],
        ['05-17', 'Id-ul-Zuha (Bakrid)'],
        ['05-20', 'Budha Purnima'],
        ['06-16', 'Muharram'],
        ['08-15', 'Independence Day'],
        ['08-15', 'Milad-un-Nabi (Id-e-Milad)'],
        ['08-25', 'Janmashtami (Vaishnav)'],
        ['10-02', "Mahatma Gandhi's Birthday"],
        ['10-09', 'Dussehra (Vijaya Dashmi)'],
        ['10-29', 'Diwali (Deepavali)'],
        ['11-14', "Guru Nanak's Birthday"],
        ['12-25', 'Christmas Day'],
      ],
    },
  };

  // { 'YYYY-MM-DD': { names: [...], national: bool, source } }
  const byDate = {};
  for (const [year, list] of Object.entries(LISTS)) {
    for (const [md, name] of list.days) {
      const key = `${year}-${md}`;
      const h = byDate[key] || (byDate[key] = { names: [], national: false, source: list.source });
      h.names.push(name);
      if (NATIONAL.has(name)) h.national = true;
    }
  }

  const api = {
    get: (dateStr) => byDate[dateStr] || null,
    years: Object.keys(LISTS).map(Number),
    lists: LISTS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRGHolidaysIN = api;
})(typeof window !== 'undefined' ? window : globalThis);
