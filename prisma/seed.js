// Demo data for the running app: the doctors and their weekly hours for the demo
// calendar (CALENDAR_ADAPTER=db), and the patients listed on the homepage. All
// fictional, and safe to run repeatedly: bookings and registered patients are kept.
// The patients include the awkward cases: two people with one name, and a family on
// one phone.

import { config } from '../src/config.js';
import { createPrisma } from '../src/db/client.js';

const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, SAT = 6;
const SUN_TO_THU = [SUN, MON, TUE, WED, THU]; // Friday and Saturday are the Bangladeshi weekend.

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const PROVIDERS = [
  {
    id: 'dr_karim',
    name: 'Dr. Karim',
    nameBn: 'ডা. করিম',
    specialty: 'General Medicine',
    hours: SUN_TO_THU.map((weekday) => ({ weekday, from: '09:00', to: '13:00' })),
  },
  {
    id: 'dr_nasrin',
    name: 'Dr. Nasrin',
    nameBn: 'ডা. নাসরিন',
    specialty: 'Cardiology',
    hours: SUN_TO_THU.map((weekday) => ({ weekday, from: '14:00', to: '17:00' })),
  },
  {
    id: 'dr_farzana',
    name: 'Dr. Farzana',
    nameBn: 'ডা. ফারজানা',
    specialty: 'Paediatrics',
    hours: [
      ...[SUN, TUE, THU].map((weekday) => ({ weekday, from: '16:00', to: '19:00' })),
      { weekday: SAT, from: '10:00', to: '13:00' },
    ],
  },
];

const PATIENTS = [
  { id: 'demo_rahim', name: 'Rahim Uddin', nameBn: 'রহিম উদ্দিন', phone: '+8801000000001', dob: '1985-03-12' },
  { id: 'demo_arif', name: 'Arif Uddin', nameBn: 'আরিফ উদ্দিন', phone: '+8801000000001', dob: '2015-06-01' },
  { id: 'demo_rahim_ali', name: 'Rahim Uddin', nameBn: 'রহিম উদ্দিন', phone: '+8801000000004', dob: '1990-07-21' },
  { id: 'demo_fatema', name: 'Fatema Begum', nameBn: 'ফাতেমা বেগম', phone: '+8801000000005', dob: '1978-11-02' },
];

const prisma = createPrisma(config.databaseUrl);

for (const { hours, ...provider } of PROVIDERS) {
  await prisma.$transaction([
    prisma.provider.upsert({ where: { id: provider.id }, create: provider, update: provider }),
    // Replaced whole, so editing the hours above and re-seeding is how the schedule changes.
    prisma.providerHours.deleteMany({ where: { providerId: provider.id } }),
    prisma.providerHours.createMany({
      data: hours.map(({ weekday, from, to }) => ({
        providerId: provider.id,
        weekday,
        startMinute: minutes(from),
        endMinute: minutes(to),
      })),
    }),
  ]);
}

for (const patient of PATIENTS) {
  const data = { ...patient, demo: true };
  await prisma.patient.upsert({ where: { id: patient.id }, create: data, update: data });
}

await prisma.$disconnect();
console.log(`Seeded ${PROVIDERS.length} doctors with their weekly hours, and ${PATIENTS.length} demo patients.`);
