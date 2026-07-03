import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizePath,
  parseTransform,
  transformSegments,
  serializeSegments,
  segmentsBBox,
  multiply,
  countNodes,
} from '../src/lib/svgpath.js';
import { ensureClosed, selfIntersects, dedupePaths } from '../src/lib/validate.js';

test('normalizePath handles absolute and relative commands', () => {
  const segs = normalizePath('M10 10 l10 0 L20 20 h-10 v-10 Z');
  assert.deepEqual(segs, [
    ['M', 10, 10],
    ['L', 20, 10],
    ['L', 20, 20],
    ['L', 10, 20],
    ['L', 10, 10],
    ['Z'],
  ]);
});

test('normalizePath converts quadratics to cubics', () => {
  const segs = normalizePath('M0 0 Q 5 10 10 0');
  assert.equal(segs.length, 2);
  assert.equal(segs[1][0], 'C');
  assert.equal(segs[1][5], 10);
  assert.equal(segs[1][6], 0);
});

test('normalizePath converts arcs to cubics ending at the arc endpoint', () => {
  const segs = normalizePath('M0 0 A 5 5 0 0 1 10 0');
  const last = segs[segs.length - 1];
  assert.equal(last[0], 'C');
  assert.equal(last[5], 10);
  assert.equal(last[6], 0);
  // Arc midpoint should bulge to y < 0 for sweep=1 from (0,0) to (10,0).
  const box = segmentsBBox(segs);
  assert.ok(box.minY < -4 && box.minY > -6, `arc bulge wrong: ${box.minY}`);
});

test('normalizePath handles smooth curves (S) with reflection', () => {
  const segs = normalizePath('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0');
  assert.equal(segs.length, 3);
  // Reflected control point of (10,10) about (10,0) is (10,-10).
  assert.deepEqual(segs[2].slice(1, 3), [10, -10]);
});

test('implicit lineto after moveto', () => {
  const segs = normalizePath('M0 0 10 10 20 0');
  assert.deepEqual(segs, [
    ['M', 0, 0],
    ['L', 10, 10],
    ['L', 20, 0],
  ]);
});

test('parseTransform composes translate/scale/rotate', () => {
  const m = parseTransform('translate(10, 20) scale(2)');
  const segs = transformSegments([['M', 1, 1]], m);
  assert.deepEqual(segs, [['M', 12, 22]]);

  const r = parseTransform('rotate(90)');
  const [seg] = transformSegments([['M', 1, 0]], r);
  assert.ok(Math.abs(seg[1]) < 1e-9 && Math.abs(seg[2] - 1) < 1e-9);
});

test('rotate about a center point', () => {
  const m = parseTransform('rotate(180 5 5)');
  const [seg] = transformSegments([['M', 0, 0]], m);
  assert.ok(Math.abs(seg[1] - 10) < 1e-9 && Math.abs(seg[2] - 10) < 1e-9);
});

test('matrix multiply order matches SVG semantics', () => {
  const t = [1, 0, 0, 1, 10, 0];
  const s = [2, 0, 0, 2, 0, 0];
  // "translate then scale" applies scale to local coords first.
  const m = multiply(t, s);
  const [seg] = transformSegments([['M', 1, 1]], m);
  assert.deepEqual(seg, ['M', 12, 2]);
});

test('serializeSegments rounds and avoids -0', () => {
  const d = serializeSegments([
    ['M', 0.00004, -0.00004],
    ['L', 1.23456, 7],
    ['Z'],
  ]);
  assert.equal(d, 'M0 0L1.235 7Z');
});

test('ensureClosed appends Z and counts non-coincident closures', () => {
  const open = normalizePath('M0 0 L10 0 L10 10');
  const r = ensureClosed(open);
  assert.equal(r.segments[r.segments.length - 1][0], 'Z');
  assert.equal(r.autoClosed, 1);

  const coincident = normalizePath('M0 0 L10 0 L0 0');
  const r2 = ensureClosed(coincident);
  assert.equal(r2.autoClosed, 0);
  assert.equal(r2.segments[r2.segments.length - 1][0], 'Z');

  const closed = normalizePath('M0 0 L10 0 L10 10 Z');
  const r3 = ensureClosed(closed);
  assert.equal(r3.autoClosed, 0);
});

test('selfIntersects detects a bowtie and passes a square', () => {
  const bowtie = normalizePath('M0 0 L10 10 L10 0 L0 10 Z');
  assert.equal(selfIntersects(bowtie), true);

  const square = normalizePath('M0 0 L10 0 L10 10 L0 10 Z');
  assert.equal(selfIntersects(square), false);

  // Donut: two non-crossing subpaths in one path must NOT be flagged.
  const donut = normalizePath('M0 0 L20 0 L20 20 L0 20 Z M5 5 L5 15 L15 15 L15 5 Z');
  assert.equal(selfIntersects(donut), false);

  // Overlapping subpaths in the same path SHOULD be flagged.
  const crossing = normalizePath('M0 0 L10 0 L10 10 L0 10 Z M5 5 L15 5 L15 15 L5 15 Z');
  assert.equal(selfIntersects(crossing), true);
});

test('dedupePaths removes duplicates and degenerates', () => {
  const square = normalizePath('M0 0 L10 0 L10 10 L0 10 Z');
  const square2 = normalizePath('M0 0 L10 0 L10 10 L0 10 Z');
  const dot = normalizePath('M5 5 Z');
  const { paths, duplicatesRemoved, degenerateRemoved } = dedupePaths([
    square,
    square2,
    dot,
  ]);
  assert.equal(paths.length, 1);
  assert.equal(duplicatesRemoved, 1);
  assert.equal(degenerateRemoved, 1);
});

test('countNodes counts anchor commands', () => {
  const segs = normalizePath('M0 0 L10 0 C 12 2 14 4 16 6 Z');
  assert.equal(countNodes(segs), 3);
});
