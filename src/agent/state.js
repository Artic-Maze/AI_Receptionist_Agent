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

/** Decided by script. Digits and punctuation alone keep the conversation's language. */
export function detectLanguage(text, fallback = 'en') {
  const bangla = (text.match(/[ঀ-৯]/g) ?? []).filter((c) => !/[০-৯]/.test(c)).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (bangla === 0 && latin === 0) return fallback;
  return bangla >= latin ? 'bn' : 'en';
}

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
