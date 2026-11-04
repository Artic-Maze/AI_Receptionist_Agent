import { noteIdentityFailure, guardDisabled } from '../agent/state.js';
import { auditCreate } from '../audit/log.js';
import { CalendarError } from '../calendar/adapter.js';
import { verifyBooking } from '../guards/booking-verify.js';
import { checkIdentityGate } from '../guards/identity-gate.js';
import { TOOLS, toolError } from './index.js';

/** One retry. A second failure goes to a person rather than round the loop again. */
const MAX_ATTEMPTS = 2;

const REJECTED_ACTION = {
  create_booking: 'booking.create_rejected',
  reschedule_booking: 'booking.reschedule_rejected',
  cancel_booking: 'booking.cancel_rejected',
};

function escalateToolError(ctx, detail) {
  if (guardDisabled(ctx, 'handoff_triggers')) return;
  ctx.turn.forcedHandoff ??= { reason: 'tool_error', detail };
}

/**
 * Validation, then the identity gate, then the tool with one retry, then read-back
 * verification of any write. Every call is logged to ToolCall, success or not.
 *
 * @returns {Promise<{ output: object, isError: boolean }>}
 */
export async function executeTool(ctx, name, rawInput) {
  const { deps, conversation, turn } = ctx;
  const { prisma, calendar } = deps;
  const started = Date.now();
  const guardsFrom = turn.guardResults.length;

  const logCall = (input, output, error) => ({
    conversationId: conversation.id,
    tool: name,
    input: input ?? {},
    output,
    durationMs: Date.now() - started,
    error,
  });

  const finish = async (input, output, error) => {
    await prisma.toolCall.create({ data: logCall(input, output, error) });
    return { output, isError: Boolean(error) };
  };

  const tool = TOOLS[name];
  if (!tool) return finish(rawInput, toolError('unknown_tool', `No tool named ${name}.`), 'unknown_tool');

  // ---- Input validation ------------------------------------------------------
  const parsed = tool.input.safeParse(rawInput);
  turn.guardResults.push({
    guard: 'input_validation',
    ok: parsed.success,
    tool: name,
    ...(parsed.success ? {} : { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }),
  });
  if (!parsed.success) {
    return finish(
      rawInput,
      toolError('invalid_input', 'Those arguments are not valid.', { issues: turn.guardResults.at(-1).issues }),
      'invalid_input',
    );
  }
  const input = parsed.data;

  // ---- Identity gate ---------------------------------------------------------
  if (tool.gated && !guardDisabled(ctx, 'identity_gate')) {
    let gate;
    try {
      gate = await checkIdentityGate({ conversation, toolName: name, input, calendar });
    } catch (error) {
      escalateToolError(ctx, `identity gate could not read the booking: ${error.message}`);
      return finish(input, toolError('calendar_unavailable', 'The calendar is not responding.'), 'calendar_unavailable');
    }
    turn.guardResults.push(gate);
    if (!gate.ok) {
      noteIdentityFailure(ctx);
      await auditCreate(prisma, {
        conversationId: conversation.id,
        action: 'identity_gate.blocked',
        patientId: conversation.patientId,
        bookingId: input.booking_id,
        after: { tool: name, reason: gate.reason },
        guardResults: [gate],
      });
      // Says nothing about why, so a probe can't learn whether a booking or patient exists.
      return finish(
        input,
        toolError(
          'identity_gate_blocked',
          'This action is blocked until the patient is verified and matches the request. Ask for their full name and date of birth, then call find_patient.',
        ),
        'identity_gate_blocked',
      );
    }
  }

  // ---- The tool itself, with one retry ---------------------------------------
  let result;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await calendar.onToolEvent?.('before', name);
      result = tool.write ? await tool.run(input, ctx) : { output: await tool.run(input, ctx) };
      await calendar.onToolEvent?.('after', name, result.output);
      break;
    } catch (error) {
      if (error instanceof CalendarError && !error.transient) {
        // A clean refusal, such as a slot that has just been taken. The model can recover.
        const output = toolError(error.code, error.message);
        if (REJECTED_ACTION[name]) {
          await auditCreate(prisma, {
            conversationId: conversation.id,
            action: REJECTED_ACTION[name],
            patientId: conversation.patientId,
            bookingId: input.booking_id,
            after: { input, error: error.code },
            guardResults: turn.guardResults.slice(guardsFrom),
          });
        }
        return finish(input, output, error.code);
      }
      if (error instanceof CalendarError && attempt < MAX_ATTEMPTS) continue;
      escalateToolError(ctx, `${name}: ${error.message}`);
      await auditCreate(prisma, {
        conversationId: conversation.id,
        action: 'tool.failed',
        patientId: conversation.patientId,
        after: { tool: name, error: error.message },
        guardResults: turn.guardResults.slice(guardsFrom),
      });
      return finish(input, toolError('calendar_unavailable', 'The calendar is not responding.'), 'calendar_unavailable');
    }
  }

  // ---- Output validation -----------------------------------------------------
  const checked = tool.output.safeParse(result.output);
  turn.guardResults.push({
    guard: 'output_validation',
    ok: checked.success,
    tool: name,
    ...(checked.success ? {} : { issues: checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }),
  });
  if (!checked.success) {
    escalateToolError(ctx, `${name} returned malformed data`);
    return finish(input, toolError('invalid_tool_output', 'The system returned unexpected data.'), 'invalid_tool_output');
  }
  const output = checked.data;

  if (!tool.write) return finish(input, output, output.error);

  if (!result.verify) {
    // A write the tool itself refused, e.g. an overlap with the patient's own appointment.
    await auditCreate(prisma, {
      conversationId: conversation.id,
      action: REJECTED_ACTION[name],
      patientId: conversation.patientId,
      bookingId: input.booking_id,
      after: { input, error: output.error },
      guardResults: turn.guardResults.slice(guardsFrom),
    });
    return finish(input, output, output.error);
  }

  // ---- Booking verify: read the write back -----------------------------------
  const { audit, before, compensate, ...verifyArgs } = result.verify;
  const verification = guardDisabled(ctx, 'booking_verify')
    ? { guard: 'booking_verify', ok: true, disabled: true, action: verifyArgs.action, bookingId: verifyArgs.bookingId }
    : await verifyBooking({ calendar, ...verifyArgs });
  turn.guardResults.push(verification);

  const undo = async () => {
    if (!compensate) return false;
    try {
      await calendar.cancelBooking(verifyArgs.bookingId, { reason: 'Failed verification' });
      return true;
    } catch {
      return false;
    }
  };

  let finalOutput;
  let finalError;
  let auditEntry;
  if (verification.ok) {
    finalOutput = { ...output, verified: true };
    auditEntry = {
      action: audit,
      after: output.booking,
    };
  } else {
    // A new booking we can't vouch for shouldn't stay on the calendar. A reschedule
    // can't be undone this way without losing the original, so staff get that one.
    const undone = await undo();
    turn.forcedHandoff ??= {
      reason: 'booking_verify_failed',
      detail: `${verifyArgs.action} of ${verifyArgs.bookingId}: ${verification.mismatches.join(', ')}. ` +
        (compensate ? `Automatic undo ${undone ? 'succeeded' : 'FAILED'}.` : 'Left for staff to correct.'),
    };
    finalError = 'verification_failed';
    finalOutput = toolError('verification_failed', 'The change could not be verified. Do not tell the patient it succeeded.');
    auditEntry = {
      action: 'booking.verify_failed',
      after: { expected: verification.expected, actual: verification.actual, undone },
    };
  }

  // ---- Log the call and the audit entry together -----------------------------
  try {
    await prisma.$transaction([
      prisma.toolCall.create({ data: logCall(input, finalOutput, finalError) }),
      auditCreate(prisma, {
        conversationId: conversation.id,
        patientId: conversation.patientId,
        bookingId: verifyArgs.bookingId,
        before,
        guardResults: turn.guardResults.slice(guardsFrom),
        ...auditEntry,
      }),
    ]);
  } catch (error) {
    // The calendar changed but the log did not. Undo what we can and get a person.
    const undone = verification.ok ? await undo() : false;
    turn.forcedHandoff ??= {
      reason: 'audit_write_failed',
      detail: `${verifyArgs.action} of ${verifyArgs.bookingId} could not be logged: ${error.message}. Automatic undo ${undone ? 'succeeded' : 'not done'}.`,
    };
    return {
      output: toolError('verification_failed', 'The change could not be recorded. Do not tell the patient it succeeded.'),
      isError: true,
    };
  }

  if (verification.ok) {
    turn.verified.push({
      action: verifyArgs.action,
      booking: output.booking,
      previous: output.previous_booking,
    });
  }
  return { output: finalOutput, isError: Boolean(finalError) };
}
