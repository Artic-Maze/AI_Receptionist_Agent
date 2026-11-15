import { MAX_IDENTITY_FAILURES } from '../guards/identity-gate.js';

/** The regression suite switches guards off one at a time to prove the evals notice. */
export const guardDisabled = (ctx, name) => Boolean(ctx.deps.disabledGuards?.has(name));

/** Counts a failed identity attempt. After the allowed retries, a person takes over. */
export function noteIdentityFailure(ctx) {
  if (guardDisabled(ctx, 'identity_gate')) return;
  const { state } = ctx.conversation;
  state.identityFailures = (state.identityFailures ?? 0) + 1;
  if (state.identityFailures > MAX_IDENTITY_FAILURES) {
    ctx.turn.forcedHandoff ??= {
      reason: 'identity_unresolved',
      detail: `${state.identityFailures} failed attempts to identify the patient.`,
    };
  }
}

export function saveConversation(prisma, conversation) {
  const { id, patientId, language, status, state } = conversation;
  return prisma.conversation.update({ where: { id }, data: { patientId, language, status, state } });
}

// Common words of each language that the other rarely uses. Words both use ("a",
// "me", "no", "doctor", "hospital") are left out, as they say nothing.
const ES_WORDS = new Set(
  (
    'hola buenas buenos días dias tardes noches gracias favor quiero quisiera necesito puedo puede podría ' +
    'cita citas consulta reservar reserva cancelar cambiar anular el la los las un una unos unas del al de que qué ' +
    'es está esta estoy soy mi mis su sus con para por pero porque como cómo cuando cuándo donde dónde hay muy ' +
    'sí también ya hoy mañana lunes martes miércoles jueves viernes sábado domingo enero febrero marzo abril mayo ' +
    'junio julio agosto septiembre octubre noviembre diciembre médico médica doctora nací nacimiento llamo nombre ' +
    'teléfono número vale claro perfecto bien día semana hora horas usted nuevo nueva primera vez registrarme ' +
    'paciente se le lo y o'
  ).split(' '),
);
const EN_WORDS = new Set(
  (
    "hi hello hey thanks thank please want would like need book booking appointment appointments cancel change " +
    "reschedule the you your is are was were be been it it's this that and or but with for to of in on at from by " +
    "my i i'm im what when where which who how can could should will do does did have not yes yeah sure " +
    'today tomorrow morning afternoon evening monday tuesday wednesday thursday friday saturday sunday january ' +
    'february march april june july august september october november december name born birth phone number new ' +
    'patient register first time'
  ).split(' '),
);

/**
 * Bangla is told apart by its script. English and Spanish share an alphabet, so
 * between them the words decide, and a message that gives no evidence either way
 * (a name, "OK", digits) keeps the conversation's language.
 */
export function detectLanguage(text, fallback = 'en') {
  const bangla = (text.match(/[ঀ-৯]/g) ?? []).filter((c) => !/[০-৯]/.test(c)).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  if (bangla === 0 && latin === 0) return fallback;
  if (bangla >= latin) return 'bn';
  const words = text.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}']+/gu) ?? [];
  let es = words.filter((w) => ES_WORDS.has(w)).length;
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  if (/[¿¡]/.test(text)) es += 2;
  else if (/[áéíóúñ]/i.test(text)) es += 1;
  if (es !== en) return es > en ? 'es' : 'en';
  return fallback === 'es' ? 'es' : 'en';
}

export const LANGUAGE_NAMES = { en: 'English', es: 'Spanish', bn: 'Bangla' };

const locks = new Map();

/**
 * One turn at a time per conversation, because two concurrent turns would interleave
 * their tool rounds in the history. Single-process only: running more than one server
 * instance would need a shared lock, such as a Postgres advisory lock.
 */
export function withLock(key, task) {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}
