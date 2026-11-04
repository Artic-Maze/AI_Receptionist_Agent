const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

/**
 * Runs after every write. A success response only says the calendar accepted the
 * request, so read the booking back and compare patient, provider and time.
 *
 * @param {object} args
 * @param {string} args.action  create | reschedule | cancel
 * @param {{ patientId?: string, providerId?: string, start?: string|Date, status: string }} args.expected
 * @param {string} [args.previousBookingId]  for a reschedule: must no longer be active
 */
export async function verifyBooking({ calendar, action, bookingId, expected, previousBookingId }) {
  const result = (mismatches, actual = null) => ({
    guard: 'booking_verify',
    ok: mismatches.length === 0,
    action,
    bookingId,
    mismatches,
    expected,
    actual,
  });

  let actual;
  try {
    actual = await calendar.getBooking(bookingId);
  } catch (error) {
    return result([`read_back_failed: ${error.message}`]);
  }
  if (!actual) return result(['missing']);

  const mismatches = [];
  if (expected.patientId !== undefined && actual.patientId !== expected.patientId) mismatches.push('patient');
  if (expected.providerId !== undefined && actual.providerId !== expected.providerId) mismatches.push('provider');
  if (expected.start !== undefined && !sameInstant(actual.start, expected.start)) mismatches.push('time');
  if (actual.status !== expected.status) mismatches.push('status');

  if (previousBookingId) {
    try {
      const previous = await calendar.getBooking(previousBookingId);
      if (previous?.status === 'active') mismatches.push('previous_still_active');
    } catch (error) {
      mismatches.push(`read_back_failed: ${error.message}`);
    }
  }

  return result(mismatches, actual);
}
