// Demo patients for the running app. Fictional, and safe to run repeatedly. They
// include the awkward cases: two people with one name, and a family on one phone.

import { config } from '../src/config.js';
import { createPrisma } from '../src/db/client.js';

const PATIENTS = [
  { id: 'demo_rahim', name: 'Rahim Uddin', nameBn: 'রহিম উদ্দিন', phone: '+8801711000001', dob: '1985-03-12' },
  { id: 'demo_arif', name: 'Arif Uddin', nameBn: 'আরিফ উদ্দিন', phone: '+8801711000001', dob: '2015-06-01' },
  { id: 'demo_rahim_ali', name: 'Rahim Uddin', nameBn: 'রহিম উদ্দিন', phone: '+8801711000002', dob: '1990-07-21' },
  { id: 'demo_fatema', name: 'Fatema Begum', nameBn: 'ফাতেমা বেগম', phone: '+8801811000003', dob: '1978-11-02' },
];

const prisma = createPrisma(config.databaseUrl);
for (const patient of PATIENTS) {
  await prisma.patient.upsert({ where: { id: patient.id }, create: patient, update: patient });
}
await prisma.$disconnect();
console.log(`Seeded ${PATIENTS.length} demo patients.`);
