const isoDate = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const yearlyHolidayCache = new Map();

function nthMonday(year, month, nth) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((8 - firstWeekday) % 7) + (nth - 1) * 7;
}

function equinoxDay(year, spring) {
  const offset = year - 1980;
  return Math.floor((spring ? 20.8431 : 23.2488) + 0.242194 * offset - Math.floor(offset / 4));
}

function holidaysForYear(year) {
  if (yearlyHolidayCache.has(year)) return yearlyHolidayCache.get(year);
  const dates = new Set();
  const add = (month, day) => dates.add(isoDate(year, month, day));
  if (year < 1948 || year > 2099) { yearlyHolidayCache.set(year, dates); return dates; }

  add(1, year >= 2000 ? nthMonday(year, 1, 2) : 15);
  if (year >= 1967) add(2, 11);
  if (year >= 2020) add(2, 23);
  add(3, equinoxDay(year, true));
  add(4, 29);
  add(5, 3); if (year >= 1986) add(5, 4); add(5, 5);
  add(7, year === 2020 ? 23 : year === 2021 ? 22 : year >= 2003 ? nthMonday(year, 7, 3) : 20);
  if (year >= 2016) add(8, year === 2020 ? 10 : year === 2021 ? 8 : 11);
  add(9, year >= 2003 ? nthMonday(year, 9, 3) : 15);
  add(9, equinoxDay(year, false));
  if (year !== 2020 && year !== 2021) add(10, year >= 2000 ? nthMonday(year, 10, 2) : 10);
  if (year >= 1948) add(11, 3); if (year >= 1948) add(11, 23);
  if (year >= 1989 && year <= 2018) add(12, 23);

  if (year === 2019) {
    add(4, 30); add(5, 1); add(5, 2); add(10, 22);
  }
  if (year === 2020) add(7, 24);
  if (year === 2021) add(7, 23);

  // Citizens' holidays: a weekday between two national holidays is also closed.
  if (year >= 1986) {
    for (let day = 2; day < 366; day++) {
      const current = new Date(Date.UTC(year, 0, day));
      const previous = new Date(current.getTime() - 86_400_000);
      const next = new Date(current.getTime() + 86_400_000);
      const date = isoDate(year, current.getUTCMonth() + 1, current.getUTCDate());
      const before = isoDate(year, previous.getUTCMonth() + 1, previous.getUTCDate());
      const after = isoDate(year, next.getUTCMonth() + 1, next.getUTCDate());
      if (current.getUTCFullYear() === year && current.getUTCDay() !== 0 && dates.has(before) && dates.has(after)) dates.add(date);
    }
  }

  // Substitute holidays began in 1973; since 2007 they move to the next open day.
  const substitutions = [];
  for (const date of year >= 1973 ? dates : []) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) continue;
    const source = new Date(`${date}T00:00:00Z`);
    let candidate = new Date(source.getTime() + 86_400_000);
    while (dates.has(isoDate(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate()))) {
      candidate = new Date(candidate.getTime() + 86_400_000);
    }
    substitutions.push(isoDate(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate()));
  }
  for (const date of substitutions) dates.add(date);
  yearlyHolidayCache.set(year, dates);
  return dates;
}

export function isJapanesePublicHoliday(date) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const year = Number(match[1]);
  if (Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > 31) return false;
  return holidaysForYear(year).has(date);
}
