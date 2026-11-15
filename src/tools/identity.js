import { toAsciiDigits } from '../time.js';

/** Bangladeshi numbers arrive as 017..., 88017..., +88017... or in Bangla numerals. */
export function normalizePhone(raw) {
  const cleaned = toAsciiDigits(raw).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('880')) return `+${cleaned}`;
  if (cleaned.startsWith('0')) return `+88${cleaned}`;
  return cleaned;
}

const nameTokens = (name) =>
  name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

function nameMatches(query, patient) {
  const wanted = nameTokens(query);
  if (!wanted.length) return false;
  return [patient.name, patient.nameBn].filter(Boolean).some((candidate) => {
    const tokens = nameTokens(candidate);
    return wanted.every((token) => tokens.includes(token));
  });
}

/** E.164 after normalizing: a plus and 8 to 15 digits. */
export const isPlausiblePhone = (phone) => /^\+\d{8,15}$/.test(phone);

/**
 * Patients a new registration could be mistaken for: the same date of birth and a
 * name that contains, or is contained in, theirs. "Rahim Uddin Khan" born the same
 * day as Rahim Uddin would make every lookup for Rahim ambiguous, so it counts.
 */
export async function findRegistrationClash(prisma, { names, dob }) {
  const rows = await prisma.patient.findMany({ where: { dob }, orderBy: { id: 'asc' } });
  const wanted = names.map(nameTokens).filter((tokens) => tokens.length);
  return rows.filter((patient) =>
    [patient.name, patient.nameBn].filter(Boolean).some((candidate) => {
      const tokens = nameTokens(candidate);
      if (!tokens.length) return false;
      return wanted.some(
        (mine) => mine.every((t) => tokens.includes(t)) || tokens.every((t) => mine.includes(t)),
      );
    }),
  );
}

/** Every patient matching ALL of the identifiers given. */
export async function searchPatients(prisma, { phone, name, dob }) {
  const where = {};
  if (phone) where.phone = phone;
  if (dob) where.dob = dob;
  const rows = await prisma.patient.findMany({ where, orderBy: { id: 'asc' } });
  return name ? rows.filter((patient) => nameMatches(name, patient)) : rows;
}
