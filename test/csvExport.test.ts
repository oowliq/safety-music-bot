import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCsvRow,
  buildExportFilename,
  buildQueueCsv,
  escapeCsvField,
} from '../src/bot/commands/helpers/csvExport.ts';


test('csv escaping protects separators, quotes and newlines', () => {
  assert.equal(escapeCsvField('plain'), 'plain');
  assert.equal(escapeCsvField('a,b'), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField('line\nbreak'), '"line\nbreak"');
  assert.equal(escapeCsvField(null), '');
});

test('csv row keeps a comma in a track title from shifting columns', () => {
  const row = buildCsvRow([1, 'queued', 'Hello, World', 'Artist']);
  assert.equal(row, '1,queued,"Hello, World",Artist');
});

test('queue export lists the current track first and numbers continuously', () => {
  const csv = buildQueueCsv({
    current: { title: 'Now', duration: '3:00', source: 'deezer', requestedBy: 'u1' },
    pending: [
      { title: 'Next', duration: '4:00', source: 'youtube', requestedBy: 'u2' },
      { title: 'Later', duration: '5:00', source: 'spotify', requestedBy: 'u3' },
    ],
  });
  const lines = csv.trim().split('\r\n');

  assert.equal(lines.length, 4, 'header plus three tracks');
  assert.match(lines[0]!, /^position,state,title/);
  assert.match(lines[1]!, /^1,playing,Now/);
  assert.match(lines[2]!, /^2,queued,Next/);
  assert.match(lines[3]!, /^3,queued,Later/);
});

test('queue export works without a current track', () => {
  const csv = buildQueueCsv({ current: null, pending: [{ title: 'Only' }] });
  const lines = csv.trim().split('\r\n');

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^1,queued,Only/);
});

test('live tracks report live instead of a bogus duration', () => {
  const csv = buildQueueCsv({ current: { title: 'Radio', isLive: true, duration: 'Unknown' }, pending: [] });
  assert.match(csv, /1,playing,Radio,,live,/);
});

test('an empty queue still produces a valid header-only file', () => {
  const csv = buildQueueCsv({ current: null, pending: [] });
  assert.equal(csv.trim(), buildCsvRow([...['position', 'state', 'title', 'artist', 'duration', 'source', 'url', 'requested_by']]));
});

test('export filename is filesystem safe and carries the guild', () => {
  const name = buildExportFilename('123456', new Date('2026-08-19T18:30:45.000Z'));
  assert.match(name, /^queue-123456-2026-08-19T18-30-45\.csv$/);
  assert.doesNotMatch(buildExportFilename('../etc/passwd', new Date()), /[/\\.]{2}/);
});
