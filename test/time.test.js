import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dayBounds,
  displayLabels,
  localParts,
  parseLocal,
  toAsciiDigits,
  toBnDigits,
  toLocalIso,
} from '../src/time.js';

const DHAKA = 'Asia/Dhaka';

describe('time helpers', () => {
  it('reads wall-clock time in the clinic zone', () => {
    assert.equal(parseLocal('2026-11-10T10:00', DHAKA).toISOString(), '2026-11-10T04:00:00.000Z');
  });

  it('takes a value with an offset as written', () => {
    assert.equal(parseLocal('2026-11-10T10:00:00+06:00', DHAKA).toISOString(), '2026-11-10T04:00:00.000Z');
    assert.equal(parseLocal('2026-11-10T04:00:00Z', DHAKA).toISOString(), '2026-11-10T04:00:00.000Z');
  });

  it('converts correctly across a daylight-saving change', () => {
    assert.equal(parseLocal('2026-03-08T12:00', 'America/New_York').toISOString(), '2026-03-08T16:00:00.000Z');
    assert.equal(parseLocal('2026-01-08T12:00', 'America/New_York').toISOString(), '2026-01-08T17:00:00.000Z');
  });

  it('writes local ISO with the offset', () => {
    assert.equal(toLocalIso(new Date('2026-11-10T04:00:00Z'), DHAKA), '2026-11-10T10:00:00+06:00');
  });

  it('uses the clinic date, not the UTC date', () => {
    // 05:30 in Dhaka is still the previous day in UTC.
    const instant = parseLocal('2026-11-11T05:30', DHAKA);
    assert.equal(instant.toISOString().slice(0, 10), '2026-11-10');
    assert.equal(localParts(instant, DHAKA).dateKey, '2026-11-11');
    assert.equal(localParts(instant, DHAKA).weekday, 3);
  });

  it('finds the bounds of a clinic day, across a month end', () => {
    const { start, end } = dayBounds('2026-11-30', DHAKA);
    assert.equal(start.toISOString(), '2026-11-29T18:00:00.000Z');
    assert.equal(end.toISOString(), '2026-11-30T18:00:00.000Z');
  });

  it('labels a slot in both languages', () => {
    const labels = displayLabels(parseLocal('2026-11-10T15:30', DHAKA), DHAKA);
    assert.equal(labels.display_en, 'Tuesday, November 10, 3:30 PM');
    assert.equal(labels.display_bn, 'মঙ্গলবার, ১০ নভেম্বর, বিকাল ৩:৩০');
  });

  it('converts numerals both ways', () => {
    assert.equal(toAsciiDigits('১০:৩০'), '10:30');
    assert.equal(toBnDigits('10:30'), '১০:৩০');
  });
});
