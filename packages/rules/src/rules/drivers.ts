/**
 * Who a trip belongs to.
 *
 * The old system had no driver id on a trip — only a typed name. Matching a
 * typed name to a roster is therefore a real rule with a real failure behind it:
 * a substring match once let one driver complete another driver's trips,
 * because "Lee" is inside "Ashleen".
 *
 * A rebuild should carry a real `driver_id` foreign key and use this only for
 * the import. Keep the function: the import has to match thousands of rows.
 */

/** Strip accents, apostrophes and punctuation; split into lowercase tokens. */
export function nameParts(s: unknown): string[] {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // José === Jose
    .toLowerCase()
    .replace(/['’]/g, '')                          // OBrien === O'Brien
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The parts joined back up — a readable, comparable form of a name. */
export function normalizeName(s: unknown): string {
  return nameParts(s).join(' ');
}

/**
 * The live system's own identity key: lowercase, then everything that is not a
 * letter or a digit removed. Ported exactly, because `driverMatches` leans on
 * it and its result decides who may complete a trip.
 *
 * Note that this does NOT fold accents, while `nameParts` does — so in the old
 * system "José Álvarez" and "Jose Alvarez" are the same name to one test and
 * different names to another. That inconsistency is real and is reproduced here
 * on purpose; it is also the reason a rebuild should put a real `driver_id` on
 * every trip and leave this function to the importer alone.
 */
export function identityKey(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is `few` a short form of `many`? Whole tokens, or a prefix of at least two
 * characters, or a suffix of at least four. Never a bare substring — that is
 * the rule that let one driver into another's day.
 */
export function isShortFormOf(few: string[], many: string[]): boolean {
  if (!few.length || !many.length) return false;
  return few.every((t) =>
    many.some((u) => {
      if (u === t) return true;
      if (u.length <= t.length) return false;
      if (t.length >= 2 && u.indexOf(t) === 0) return true;
      if (t.length >= 4 && u.lastIndexOf(t) === u.length - t.length) return true;
      return false;
    }),
  );
}

/**
 * A short form only counts when the roster agrees there is exactly one driver it
 * could possibly mean. With two DeFinos on staff, "DeFino" identifies nobody.
 *
 * Ported verbatim from `driverUniqueShortForm_` in DriverApp.gs. Either side may
 * be the roster name — the question is asked in both directions, because the
 * texts and emails go out through the reverse one.
 */
export function isUniqueShortForm(tripDriver: string, driverName: string, roster: string[]): boolean {
  const pa = nameParts(tripDriver), pb = nameParts(driverName);
  if (!pa.length || !pb.length) return false;
  const shorter = pa.join('').length <= pb.join('').length ? pa : pb;
  const longer = pa.join('').length <= pb.join('').length ? pb : pa;
  if (!isShortFormOf(shorter, longer)) return false;
  const names = Array.isArray(roster) ? roster : [];
  if (!names.length) return false;
  let hits = 0;
  let only = '';
  for (const n of names) {
    const rp = nameParts(n);
    if (!rp.length) continue;
    if (isShortFormOf(shorter, rp) || isShortFormOf(rp, shorter)) {
      hits += 1;
      only = identityKey(n);
      if (hits > 1) return false;          // more than one driver it could mean
    }
  }
  return hits === 1 && (only === identityKey(tripDriver) || only === identityKey(driverName));
}

/**
 * Does the name written on this trip mean this driver?
 *
 * Ported verbatim from `driverMatches_` in DriverApp.gs. Four tests, in order,
 * and the last one needs the roster to agree. Do not "simplify" this: every
 * clause is load-bearing and the whole function gates who may complete a trip.
 */
export function driverMatches(tripDriver: string, driverName: string, roster: string[] = []): boolean {
  const a = identityKey(tripDriver), b = identityKey(driverName);
  if (!a || !b) return false;
  if (a === b) return true;

  const pa = nameParts(tripDriver), pb = nameParts(driverName);
  if (!pa.length || !pb.length) return false;
  const ja = pa.join(''), jb = pb.join('');
  const few = ja.length <= jb.length ? pa : pb;
  const many = ja.length <= jb.length ? pb : pa;

  // 1. every part of the shorter name is a whole part of the longer one
  if (few.every((t) => many.indexOf(t) >= 0)) return true;

  // 2. the shorter name written solid is a run of the longer one's parts
  //    ("Vanderberg" for "Van Der Berg")
  const joined = few.join('');
  for (let i = 0; i < many.length; i++) {
    let acc = '';
    for (let j = i; j < many.length; j++) {
      acc += many[j]!;
      if (acc === joined) return true;
      if (acc.length > joined.length) break;
    }
  }

  // 3. the first name in full, then initials of real parts. Requiring the FIRST
  //    part in full separates "Mike J" (fine) from "M Johnson" (ambiguous
  //    between Mike and Mary Johnson, so refused).
  if (few.length > 1 && many.indexOf(few[0]!) >= 0) {
    const rest = few.slice(1).every((t) => {
      if (many.indexOf(t) >= 0) return true;
      return t.length === 1 && many.some((u) => u.charAt(0) === t);
    });
    if (rest) return true;
  }

  // 4. Last resort: a short form the rules above cannot see — "Chris" for
  //    "Christopher", "Rick" for "Patrick". Two things keep it safe. The short
  //    form must line up with the START or the END of a whole name part, never
  //    the middle (which is what let "Lee" match "AshLEEn"). And the roster has
  //    to agree there is only one driver it could possibly mean.
  return isUniqueShortForm(tripDriver, driverName, roster);
}

/**
 * The gate on every driver action.
 *
 * A failed lookup is NOT "not yours". Conflating the two once destroyed a
 * completed pickup: the record could not be read, the app read that as "this
 * trip is not yours", and the driver's work was thrown away. A lookup failure
 * must be retried, never denied.
 */
export type OwnershipResult = { ok: true } | { ok: false; reason: 'not-yours' | 'lookup-failed' | 'no-driver' };

export function driverOwnsTrip(
  trip: { driverId: string | null; driverName: string | null } | null,
  driver: { id: string; name: string },
  roster: string[] = [],
): OwnershipResult {
  if (trip == null) return { ok: false, reason: 'lookup-failed' };
  if (trip.driverId) return trip.driverId === driver.id ? { ok: true } : { ok: false, reason: 'not-yours' };
  if (!trip.driverName || !trip.driverName.trim()) return { ok: false, reason: 'no-driver' };
  return driverMatches(trip.driverName, driver.name, roster) ? { ok: true } : { ok: false, reason: 'not-yours' };
}
