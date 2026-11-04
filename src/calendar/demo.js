import { localParts, parseLocal } from '../time.js';

/** Two providers and two weeks of slots, for running the app without a Cal.com account. */
export function demoCalendar(now, tz) {
  const providers = [
    { id: 'dr_karim', name: 'Dr. Karim', nameBn: 'ডা. করিম', specialty: 'General Medicine' },
    { id: 'dr_nasrin', name: 'Dr. Nasrin', nameBn: 'ডা. নাসরিন', specialty: 'Cardiology' },
  ];
  const hours = { dr_karim: [9, 10, 11, 12], dr_nasrin: [14, 15, 16] };
  const today = localParts(now, tz);
  const slots = [];
  for (let offset = 1; offset <= 14; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = day.getUTCDay();
    if (weekday === 5 || weekday === 6) continue; // The Bangladeshi weekend.
    const dateKey = day.toISOString().slice(0, 10);
    for (const [providerId, providerHours] of Object.entries(hours)) {
      for (const hour of providerHours) {
        for (const minute of ['00', '30']) {
          const start = parseLocal(`${dateKey}T${String(hour).padStart(2, '0')}:${minute}`, tz);
          slots.push({ providerId, start });
        }
      }
    }
  }
  return { providers, slots };
}
