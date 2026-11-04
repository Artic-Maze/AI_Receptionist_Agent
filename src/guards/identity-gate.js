/** Two disambiguating questions are allowed; the failure after that hands off. */
export const MAX_IDENTITY_FAILURES = 2;

/**
 * Runs before any tool that writes or reads a booking. The model's word is not
 * enough: the patient must be the one patient this conversation has resolved, and
 * any booking touched must belong to them.
 */
export async function checkIdentityGate({ conversation, toolName, input, calendar }) {
  const fail = (reason, extra = {}) => ({
    guard: 'identity_gate',
    ok: false,
    tool: toolName,
    reason,
    ...extra,
  });

  const resolved = conversation.patientId;
  if (!resolved) return fail('no_patient_resolved');

  if (input.patient_id !== undefined && input.patient_id !== resolved) {
    return fail('patient_mismatch', { requested: input.patient_id, resolved });
  }

  if (input.booking_id !== undefined) {
    const booking = await calendar.getBooking(input.booking_id);
    // Not-found is left for the tool to report. A foreign booking is reported to the
    // model only as blocked, so the error can't confirm that the booking exists.
    if (booking && booking.patientId !== resolved) {
      return fail('booking_not_owned', { bookingId: input.booking_id, resolved });
    }
  }

  return { guard: 'identity_gate', ok: true, tool: toolName, patientId: resolved };
}
