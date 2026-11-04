import { detectLanguage } from '../../src/agent/state.js';
import { extractTimes, normalize } from '../../src/guards/text-extract.js';
import { localParts, parseLocal } from '../../src/time.js';

const contains = (text, phrase) => normalize(text ?? '').includes(normalize(phrase));
const asList = (value) => (Array.isArray(value) ? value : [value]);

/**
 * Scripted replays add the offline expectations on top of the ones every run must
 * meet. List fields combine; anything else, the offline value wins.
 */
export function effectiveExpect(scenario, mode) {
  if (mode !== 'scripted' || !scenario.offline_expect) return scenario.expect;
  const merged = { ...scenario.expect };
  for (const [key, value] of Object.entries(scenario.offline_expect)) {
    merged[key] = Array.isArray(value) && Array.isArray(merged[key]) ? [...merged[key], ...value] : value;
  }
  return merged;
}

/**
 * Pass or fail comes only from here, and only from observable facts: what is on the
 * calendar, what reached the patient, which tools ran, what the audit log says.
 *
 * `kind` separates outcomes (state, text, status) from mechanics (guard, tool, audit,
 * script). The mutation test counts only outcomes, so a removed guard is only "caught"
 * if a bad result actually reached the calendar or the patient.
 */
export function evaluateChecks({ scenario, mode, run, tz }) {
  const expect = effectiveExpect(scenario, mode);
  const checks = [];
  const add = (kind, name, pass, expected, actual) => checks.push({ kind, name, pass, expected, actual });

  add('status', 'no_crash', !run.crash, 'turn completes', run.crash ?? 'completed');

  // ---- The calendar: the final word on what actually happened ----------------
  const active = run.calendar.filter((b) => b.status === 'active');
  const seededPatients = new Set(scenario.seed.patients.map((p) => p.id));
  if (expect.final_calendar) {
    const { total_active: total, exact, ...perPatient } = expect.final_calendar;
    for (const [key, count] of Object.entries(perPatient)) {
      const patient = key.replace('bookings_for_', '');
      const actual = active.filter((b) => b.patientId === patient).length;
      add('state', `calendar.${key}`, actual === count, count, actual);
    }
    if (total !== undefined) add('state', 'calendar.total_active', active.length === total, total, active.length);
    if (exact) {
      const mine = active.filter((b) => seededPatients.has(b.patientId));
      const matched = exact.every((want) =>
        mine.some(
          (b) =>
            b.patientId === want.patient &&
            b.providerId === want.provider &&
            asList(want.start).some((start) => parseLocal(start, tz).getTime() === new Date(b.start).getTime()),
        ),
      );
      add(
        'state',
        'calendar.exact',
        matched && mine.length === exact.length,
        exact,
        mine.map((b) => ({ patient: b.patientId, provider: b.providerId, start: b.start })),
      );
    }
  }

  // ---- What reached the patient ------------------------------------------------
  const replies = run.turns.map((t) => t.reply).filter(Boolean);
  for (const phrase of expect.must_not_say ?? []) {
    const offending = replies.find((reply) => contains(reply, phrase));
    add('text', `must_not_say: ${phrase}`, !offending, 'absent', offending ?? 'absent');
  }
  if (expect.must_say_any) {
    const found = replies.some((reply) => expect.must_say_any.some((phrase) => contains(reply, phrase)));
    add('text', `must_say_any: ${expect.must_say_any.join(' | ')}`, found, expect.must_say_any, replies.at(-1));
  }
  if (expect.reply_language) {
    const last = replies.at(-1) ?? '';
    add('text', 'reply_language', detectLanguage(last, 'none') === expect.reply_language, expect.reply_language, last);
  }

  scenario.turns.forEach((turn, index) => {
    const reply = run.turns[index]?.reply ?? '';
    const label = `turn ${index + 1}`;
    if (turn.expect?.language) {
      add('text', `${label}.language`, detectLanguage(reply, 'none') === turn.expect.language, turn.expect.language, reply);
    }
    for (const phrase of turn.expect?.must_not_say ?? []) {
      add('text', `${label}.must_not_say: ${phrase}`, !contains(reply, phrase), 'absent', reply);
    }
    if (turn.expect?.must_say_any) {
      const found = turn.expect.must_say_any.some((phrase) => contains(reply, phrase));
      add('text', `${label}.must_say_any`, found, turn.expect.must_say_any, reply);
    }
  });

  // ---- Conversation outcome -----------------------------------------------------
  const [conversation] = run.conversations;
  if (expect.conversation_status) {
    add('status', 'conversation_status', conversation?.status === expect.conversation_status, expect.conversation_status, conversation?.status);
  }
  if (expect.handoff_reason) {
    const reasons = run.handoffs.map((h) => h.reason);
    const wanted = asList(expect.handoff_reason);
    add('status', 'handoff_reason', reasons.some((r) => wanted.includes(r)), wanted, reasons);
  }
  if (expect.resolved_patient !== undefined) {
    add('status', 'resolved_patient', conversation?.patientId === expect.resolved_patient, expect.resolved_patient, conversation?.patientId);
  }
  if (expect.must) {
    const handedOff = run.conversations.some((c) => c.status === 'handed_off');
    const last = replies.at(-1) ?? '';
    const asked = /[?؟]/.test(last);
    const offered = extractTimes(last).some((time) =>
      run.freeSlots.some((slot) => time.minutes.includes(localParts(slot.start, tz).minutes)),
    );
    const pass = {
      offer_alternative_or_handoff: handedOff || offered,
      ask_question: asked && !handedOff,
      ask_or_handoff: asked || handedOff,
    }[expect.must];
    add('status', `must: ${expect.must}`, pass, expect.must, last);
  }

  // ---- Mechanics ---------------------------------------------------------------
  const tools = run.toolCalls.map((t) => t.tool);
  if (expect.tool_sequence_includes) {
    let position = 0;
    for (const tool of tools) if (tool === expect.tool_sequence_includes[position]) position += 1;
    add('tool', 'tool_sequence_includes', position === expect.tool_sequence_includes.length, expect.tool_sequence_includes, tools);
  }
  for (const tool of expect.tools_not_called ?? []) {
    add('tool', `tool_not_called: ${tool}`, !tools.includes(tool), 'not called', tools);
  }

  const fired = new Set(run.turns.flatMap((t) => t.guards).filter((g) => g.ok === false).map((g) => g.guard));
  for (const guard of expect.guards_fired ?? []) {
    add('guard', `guard_fired: ${guard}`, fired.has(guard), 'fired', [...fired]);
  }
  for (const guard of expect.guards_not_fired ?? []) {
    add('guard', `guard_not_fired: ${guard}`, !fired.has(guard), 'not fired', [...fired]);
  }

  const actions = run.audit.map((a) => a.action);
  for (const entry of expect.audit_includes ?? []) {
    const { action, patient } = typeof entry === 'string' ? { action: entry } : entry;
    const found = run.audit.some((a) => a.action === action && (!patient || a.patientId === patient));
    add('audit', `audit_includes: ${action}${patient ? ` (${patient})` : ''}`, found, entry, actions);
  }
  for (const action of expect.audit_excludes ?? []) {
    add('audit', `audit_excludes: ${action}`, !actions.includes(action), 'absent', actions);
  }

  if (mode === 'scripted') {
    add('script', 'script_not_exhausted', !run.scriptExhausted, 'enough steps', run.scriptExhausted ? 'ran out' : 'ok');
    if (!scenario.allow_unused_script) {
      add('script', 'script_fully_used', run.scriptRemaining === 0, 0, run.scriptRemaining);
    }
  }

  return checks;
}
