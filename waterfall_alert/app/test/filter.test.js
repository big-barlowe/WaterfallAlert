import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTagExpr, exprName } from '../public/js/filter.js';

const tags = [
  { id: 1, name: 'Switch' },
  { id: 2, name: 'Home' },
  { id: 3, name: 'Cabin' },
  { id: 4, name: 'Server room' },
  { id: 5, name: 'R&D' },
  { id: 6, name: 'Not here' },
];
const matches = (expr, ...sets) => sets.map((s) => parseTagExpr(expr, tags).test(s));

test('& binds tighter than |, and parentheses group', () => {
  // the (Switch & Home) | (Switch & Cabin) case, written both ways
  for (const expr of ['Switch & Home | Switch & Cabin', 'switch and (home or cabin)', 'Switch & (Home, Cabin)']) {
    assert.deepEqual(matches(expr, [1, 2], [1, 3], [1], [2, 3], [1, 2, 3]), [true, true, false, false, true], expr);
  }
  assert.deepEqual(matches('Switch | Home & Cabin', [1], [2], [2, 3]), [true, false, true]);
});

test('not, multi-word names and quotes', () => {
  assert.deepEqual(matches('Switch & !Home', [1], [1, 2]), [true, false]);
  assert.deepEqual(matches('not Switch', [], [1]), [true, false]);
  assert.deepEqual(matches('server ROOM & !(Switch | Cabin)', [4], [4, 3], [1]), [true, false, false]);
  assert.deepEqual(matches('"R&D" | "Not here"', [5], [6], [1]), [true, true, false]);
  assert.equal(exprName('Server room'), 'Server room');
  assert.equal(exprName('R&D'), '"R&D"');
  assert.equal(exprName('Not here'), '"Not here"');
});

test('brackets left open at the end are closed', () => {
  const expr = parseTagExpr('Switch & (Home | Cabin', tags);
  assert.equal(expr.unclosed, 1);
  assert.deepEqual([[1, 2], [1], [2, 3]].map((s) => expr.test(s)), [true, false, false]);
  assert.equal(parseTagExpr('!(Switch & (Home', tags).unclosed, 2);
  assert.equal(parseTagExpr('(Switch) & Home', tags).unclosed, 0);
});

test('mistakes are reported, an empty filter is no filter', () => {
  assert.equal(parseTagExpr('  ', tags), null);
  const err = (expr) => parseTagExpr(expr, tags).error;
  assert.match(err('Switch &'), /ends too early/);
  assert.match(err('Switch & ('), /ends too early/);
  assert.match(err('Switch)'), /without a "\("/);
  assert.match(err('Switches'), /No tag called "Switches"/);
  assert.match(err('& Switch'), /before "&"/);
  assert.match(err('Switch "Home"'), /Expected & or \|/);
  assert.match(err('""'), /Empty quotes/);
});
