/**
 * Append to the audit log. `db` may be the Prisma client or a transaction, so a
 * write can commit together with its ToolCall row. Postgres triggers reject any
 * later UPDATE, DELETE or TRUNCATE of this table.
 */
export function auditCreate(
  db,
  { conversationId, actor = 'agent', action, patientId, bookingId, before, after, guardResults = [] },
) {
  return db.auditLog.create({
    data: {
      conversationId,
      actor,
      action,
      patientId: patientId ?? undefined,
      bookingId: bookingId ?? undefined,
      before: before ?? undefined,
      after: after ?? undefined,
      guardResults,
    },
  });
}
