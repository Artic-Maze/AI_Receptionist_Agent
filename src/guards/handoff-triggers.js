import { normalize } from './text-extract.js';

const re = (source) => new RegExp(source.normalize('NFC'), 'u');

const ASKS_FOR_HUMAN = [
  '\\b(?:talk|speak|chat|connect|transfer|put)\\b.{0,40}\\b(?:human|person|someone|somebody|staff|agent|receptionist|manager|supervisor|representative|operator)\\b',
  '\\b(?:real|live|actual)\\s+(?:person|human|agent)\\b',
  '\\bhuman\\s+(?:please|agent)\\b',
  '\\bi\\s+(?:want|need)\\s+(?:a\\s+|the\\s+|your\\s+)?(?:human|manager|supervisor)\\b',
  '(?:মানুষ|কর্মী|ম্যানেজার|রিসেপশনিস্ট|অপারেটর|কারো|কারও|কেউ).{0,25}(?:কথা|সংযোগ|দিন|চাই)',
].map(re);

const EMERGENCY = [
  "\\b(?:chest pain|can'?t breathe|cannot breathe|trouble breathing|difficulty breathing|heavy bleeding|bleeding (?:a lot|heavily)|unconscious|fainted|stroke|heart attack|overdose|suicid\\w*|kill myself)\\b",
  'বুকে ব্যথা|বুকে ব্যাথা|শ্বাস নিতে পারছি না|শ্বাসকষ্ট|অজ্ঞান|প্রচুর রক্ত|হার্ট অ্যাটাক|স্ট্রোক|আত্মহত্যা',
].map(re);

const MEDICATION =
  'medicine|medication|tablet|pill|drug|dose|antibiotic|paracetamol|napa|insulin|ibuprofen|aspirin|injection|syrup';

const MEDICAL_ADVICE = [
  // "Can I take the 10am slot?" is a booking, so these need a medication word...
  `\\b(?:should|can|could|may)\\s+i\\s+(?:take|stop|skip|use|mix)\\b.{0,40}\\b(?:${MEDICATION})s?\\b`,
  // ...and "should I take" alone counts only if the message isn't about scheduling.
  '\\bshould\\s+i\\s+(?:take|stop|skip)\\b(?!.*\\b(?:slot|appointment|time|booking)\\b)',
  '\\bwhat\\s+(?:medicine|medication|drug|dose|dosage|should\\s+i\\s+take)\\b',
  '\\bhow\\s+(?:much|many)\\b.{0,30}\\b(?:take|mg|tablets?|pills?)\\b',
  '\\b(?:dosage|side effects?|diagnos\\w+)\\b',
  '\\bis\\s+(?:it|this|that)\\s+(?:serious|dangerous|normal|safe)\\b',
  '\\bdo\\s+i\\s+have\\s+(?:a|an)?\\s*(?:\\w+\\s+)?(?:infection|disease|cancer|diabetes|fever|virus|condition)\\b',
  'কোন ওষুধ|কী ওষুধ|কি ওষুধ|ওষুধ খাব|ওষুধ খাওয়া|ওষুধ খেতে|ডোজ|পার্শ্বপ্রতিক্রিয়া|গুরুতর কিছু|কি গুরুতর|কী গুরুতর|কী খাব|কি খাব',
].map(re);

const MISUNDERSTANDING = re(
  "\\b(?:didn'?t|did not|don'?t|do not|couldn'?t|could not)\\s+(?:quite\\s+)?(?:understand|catch)\\b|\\bnot sure (?:what|i understand)\\b|" +
    'বুঝতে পারিনি|বুঝতে পারছি না|বুঝিনি',
);

/** Consecutive replies that fail to understand before a person takes over. */
export const MAX_MISUNDERSTANDINGS = 3;

/**
 * Checked before the model sees the message, so nothing in the conversation can
 * talk the agent out of it. Fuzzier cases (an angry patient, say) are left to the
 * model's handoff_to_human tool.
 */
export function checkPatientMessage(text) {
  const message = normalize(text);
  const fired = (trigger) => ({ guard: 'handoff_triggers', ok: false, trigger });
  if (EMERGENCY.some((pattern) => pattern.test(message))) return fired('medical_emergency');
  if (MEDICAL_ADVICE.some((pattern) => pattern.test(message))) return fired('medical_question');
  if (ASKS_FOR_HUMAN.some((pattern) => pattern.test(message))) return fired('user_request');
  return { guard: 'handoff_triggers', ok: true };
}

export const isMisunderstanding = (reply) => MISUNDERSTANDING.test(normalize(reply));

// These replies are written in code, not by the model, so a handoff can never carry
// a hallucinated time or a false confirmation.
const MESSAGES = {
  medical_emergency: {
    en: 'This may be an emergency. Please call 999 or go to the nearest emergency department now. I am also alerting our staff.',
    bn: 'এটি জরুরি অবস্থা হতে পারে। অনুগ্রহ করে এখনই ৯৯৯-এ কল করুন বা নিকটস্থ জরুরি বিভাগে যান। আমি আমাদের কর্মীদেরও জানাচ্ছি।',
  },
  medical_question: {
    en: 'I can’t give medical advice, so I’m connecting you with a member of our staff. If this is an emergency, please call 999 or go to the nearest emergency department.',
    bn: 'আমি চিকিৎসা-সংক্রান্ত পরামর্শ দিতে পারি না, তাই আপনাকে আমাদের একজন কর্মীর সঙ্গে যুক্ত করছি। জরুরি অবস্থা হলে অনুগ্রহ করে ৯৯৯-এ কল করুন বা নিকটস্থ জরুরি বিভাগে যান।',
  },
  user_request: {
    en: 'Of course. I’m connecting you with a member of our staff.',
    bn: 'অবশ্যই, আপনাকে আমাদের একজন কর্মীর সঙ্গে যুক্ত করছি।',
  },
  tool_error: {
    en: 'Our booking system isn’t responding right now, so I’m passing this to our staff to finish for you.',
    bn: 'আমাদের বুকিং সিস্টেম এই মুহূর্তে সাড়া দিচ্ছে না, তাই বিষয়টি আমাদের কর্মীদের কাছে পাঠাচ্ছি। তাঁরা আপনার কাজটি সম্পন্ন করবেন।',
  },
  booking_verify_failed: {
    en: 'I couldn’t verify that change, so our staff will check it. Please don’t rely on it until they contact you.',
    bn: 'এই পরিবর্তনটি আমি যাচাই করতে পারিনি, তাই আমাদের কর্মীরা এটি দেখবেন। তাঁরা যোগাযোগ না করা পর্যন্ত অনুগ্রহ করে এর ওপর নির্ভর করবেন না।',
  },
  default: {
    en: 'I’m connecting you with a member of our staff, who will help you from here.',
    bn: 'আপনাকে আমাদের একজন কর্মীর সঙ্গে যুক্ত করছি, তিনি আপনাকে সাহায্য করবেন।',
  },
  holding: {
    en: 'A member of our staff has this conversation and will reply here.',
    bn: 'আমাদের একজন কর্মী কথোপকথনটি দেখছেন এবং এখানেই উত্তর দেবেন।',
  },
};

export function handoffMessage(reason, language) {
  const entry = MESSAGES[reason] ?? MESSAGES.default;
  return entry[language] ?? entry.en;
}
