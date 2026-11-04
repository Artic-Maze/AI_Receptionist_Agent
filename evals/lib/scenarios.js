import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

export const SCENARIO_DIR = fileURLToPath(new URL('../scenarios/', import.meta.url));

/** Planned size of each category. Loading fails if the golden dataset drifts from it. */
export const CATEGORIES = {
  happy_path: { label: 'Happy path (EN + BN)', count: 10, critical: false },
  double_booking: { label: 'Double-booking', count: 6, critical: true },
  wrong_patient: { label: 'Wrong patient', count: 6, critical: true },
  hallucinated_availability: { label: 'Hallucinated availability', count: 6, critical: true },
  handoff: { label: 'Handoff', count: 6, critical: false },
  dates_timezones: { label: 'Dates and time zones', count: 6, critical: false },
  language_injection: { label: 'Language switch + prompt injection', count: 6, critical: false },
};
export const CORE_SCENARIO_COUNT = 15;

export const GUARDS = [
  'identity_gate',
  'booking_verify',
  'availability_grounding',
  'confirmation_check',
  'handoff_triggers',
];

const Guard = z.enum(GUARDS);
const Language = z.enum(['en', 'bn']);
const OneOrMany = z.union([z.string(), z.array(z.string())]);

const Step = z.union([
  z.strictObject({ call: z.string(), input: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ say: z.string() }),
  z.strictObject({ stop: z.enum(['refusal', 'max_tokens']) }),
  z.strictObject({ throw: z.string() }),
]);

const TurnExpect = z.strictObject({
  language: Language.optional(),
  must_say_any: z.array(z.string()).optional(),
  must_not_say: z.array(z.string()).optional(),
});

const Turn = z.strictObject({
  user: z.string().min(1),
  conversation: z.string().optional(),
  script: z.array(Step).default([]),
  expect: TurnExpect.optional(),
});

const ExpectedBooking = z.strictObject({
  patient: z.string(),
  provider: z.string(),
  start: OneOrMany,
});

const CalendarExpect = z
  .looseObject({
    total_active: z.number().int().optional(),
    exact: z.array(ExpectedBooking).optional(),
  })
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (['total_active', 'exact'].includes(key)) continue;
      if (!/^bookings_for_\w+$/.test(key) || !Number.isInteger(value[key])) {
        context.addIssue({ code: 'custom', message: `Unknown final_calendar key: ${key}` });
      }
    }
  });

const Expect = z.strictObject({
  final_calendar: CalendarExpect.optional(),
  tool_sequence_includes: z.array(z.string()).optional(),
  tools_not_called: z.array(z.string()).optional(),
  must_not_say: z.array(z.string()).optional(),
  must_say_any: z.array(z.string()).optional(),
  must: z.enum(['offer_alternative_or_handoff', 'ask_question', 'ask_or_handoff']).optional(),
  conversation_status: z.enum(['active', 'handed_off', 'closed']).optional(),
  handoff_reason: OneOrMany.optional(),
  guards_fired: z.array(Guard).optional(),
  guards_not_fired: z.array(Guard).optional(),
  audit_includes: z
    .array(z.union([z.string(), z.strictObject({ action: z.string(), patient: z.string().optional() })]))
    .optional(),
  audit_excludes: z.array(z.string()).optional(),
  reply_language: Language.optional(),
  resolved_patient: z.string().nullable().optional(),
});

const Scenario = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(Object.keys(CATEGORIES)),
  language: Language,
  description: z.string().min(1),
  core: z.boolean().default(false),
  channel: z.enum(['web', 'whatsapp', 'vapi']).default('web'),
  caller_phone: z.string().optional(),
  now: z.string().default('2026-11-04T10:00'),
  allow_unused_script: z.boolean().default(false),
  seed: z.strictObject({
    patients: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          nameBn: z.string().optional(),
          phone: z.string(),
          dob: z.string(),
        }),
      )
      .default([]),
    slots: z.array(z.strictObject({ provider: z.string(), start: z.string() })).default([]),
    bookings: z
      .array(
        z.strictObject({
          id: z.string(),
          patient: z.string(),
          provider: z.string(),
          start: z.string(),
        }),
      )
      .default([]),
  }),
  inject: z
    .array(
      z.strictObject({
        before_tool: z.string().optional(),
        after_tool: z.string().optional(),
        action: z.enum(['take_slot', 'error', 'empty_result', 'commit_then_timeout', 'corrupt_write', 'drop_write']),
        times: z.number().int().positive().optional(),
        slot: z.strictObject({ provider: z.string(), start: z.string() }).optional(),
        field: z.enum(['start', 'provider', 'patient']).optional(),
        patient_id: z.string().optional(),
      }),
    )
    .default([]),
  turns: z.array(Turn).min(1),
  expect: Expect,
  // Applies only to scripted replays: what a script that misbehaves on purpose must
  // trigger. A real model rarely hallucinates on demand, so these can't be required
  // of a live run, where those guards may simply never have anything to catch.
  offline_expect: Expect.optional(),
});

/**
 * Loads and validates the whole golden dataset. A typo in a scenario fails here,
 * loudly, rather than silently checking nothing.
 */
export async function loadScenarios(directory = SCENARIO_DIR) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.yaml')).sort();
  const scenarios = [];
  for (const file of files) {
    const parsed = Scenario.safeParse(parseYaml(await readFile(join(directory, file), 'utf8')));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid scenario ${file}:\n${issues}`);
    }
    if (`${parsed.data.id}.yaml` !== file) {
      throw new Error(`Scenario id "${parsed.data.id}" does not match its file name ${file}`);
    }
    scenarios.push(parsed.data);
  }
  return scenarios;
}

export function assertPlannedCoverage(scenarios) {
  const problems = [];
  for (const [category, { count }] of Object.entries(CATEGORIES)) {
    const actual = scenarios.filter((s) => s.category === category).length;
    if (actual !== count) problems.push(`${category}: ${actual} scenarios, planned ${count}`);
  }
  const core = scenarios.filter((s) => s.core).length;
  if (core !== CORE_SCENARIO_COUNT) problems.push(`core set: ${core} scenarios, planned ${CORE_SCENARIO_COUNT}`);
  if (problems.length) throw new Error(`The golden dataset has drifted from the plan:\n  ${problems.join('\n  ')}`);
}
