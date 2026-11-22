import { FakeAdapter } from '../../src/calendar/fake.js';
import { startConversation } from '../../src/agent/turn.js';
import { parseLocal } from '../../src/time.js';
import { ScriptedLLM } from '../../evals/lib/scripted-llm.js';
import { resetDatabase } from '../../evals/lib/db.js';

export const TZ = 'Asia/Dhaka';
export const NOW = parseLocal('2026-11-04T10:00', TZ);
export const at = (local) => parseLocal(local, TZ);

export const PROVIDERS = [
  { id: 'dr_karim', name: 'Dr. Karim', nameBn: 'ডা. করিম', specialty: 'General Medicine' },
  { id: 'dr_nasrin', name: 'Dr. Nasrin', nameBn: 'ডা. নাসরিন', specialty: 'Cardiology' },
];

export const RAHIM = { id: 'p1', name: 'Rahim Uddin', nameBn: 'রহিম উদ্দিন', phone: '+8801000000001', dob: '1985-03-12' };

/** A clean database, a seeded calendar and a scripted model, ready for a turn. */
export async function setup(prisma, { patients = [RAHIM], slots, bookings = [], channel = 'web', callerPhone } = {}) {
  await resetDatabase(prisma);
  for (const patient of patients) await prisma.patient.create({ data: patient });
  const clock = () => NOW;
  const calendar = new FakeAdapter({ clock });
  calendar.seed({
    providers: PROVIDERS,
    slots: (slots ?? ['2026-11-10T10:00', '2026-11-10T10:30', '2026-11-11T11:00']).map((start) => ({
      providerId: 'dr_karim',
      start: at(start),
    })),
    bookings,
  });
  const llm = new ScriptedLLM();
  const deps = { prisma, calendar, llm, clock, tz: TZ };
  const conversation = await startConversation(prisma, { channel, callerPhone });
  return { deps, calendar, llm, conversationId: conversation.id };
}
