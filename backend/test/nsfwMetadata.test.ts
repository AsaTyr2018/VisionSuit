import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  evaluateLoRaMetadata,
  mergeFrequencyTables,
  normalizeFrequencyTable,
  scoreFrequencyTable,
  type NormalizedTagCount,
} from '../src/lib/nsfw/metadata';

test('normalizeFrequencyTable sanitizes keys and aggregates duplicate tags', () => {
  const normalized = normalizeFrequencyTable({
    Nude: 4,
    'young_girl': '2',
    Landscape: 10,
    ' ': 3,
  });

  assert.deepEqual(normalized, [
    { tag: 'landscape', count: 10 },
    { tag: 'nude', count: 4 },
    { tag: 'young_girl', count: 2 },
  ]);
});

test('mergeFrequencyTables combines multiple sources without duplicating tags', () => {
  const primary: NormalizedTagCount[] = [
    { tag: 'nude', count: 4 },
    { tag: 'portrait', count: 7 },
  ];
  const secondary: NormalizedTagCount[] = [
    { tag: 'NUDE', count: 6 },
    { tag: 'portrait', count: 3 },
    { tag: 'ambient', count: 5 },
  ];

  const merged = mergeFrequencyTables(primary, secondary);

  assert.deepEqual(merged, [
    { tag: 'nude', count: 10 },
    { tag: 'portrait', count: 10 },
    { tag: 'ambient', count: 5 },
  ]);
});

test('scoreFrequencyTable sums counts across configured filter packs', () => {
  const evaluation = scoreFrequencyTable([
    { tag: 'nude', count: 10 },
    { tag: 'young_girl', count: 2 },
    { tag: 'beast', count: 1 },
    { tag: 'ambient', count: 8 },
  ]);

  assert.equal(evaluation.adultScore, 10);
  assert.equal(evaluation.minorScore, 2);
  assert.equal(evaluation.beastScore, 1);
  assert.deepEqual(evaluation.matches.adult, [{ tag: 'nude', count: 10 }]);
  assert.deepEqual(evaluation.matches.minor, [{ tag: 'young_girl', count: 2 }]);
  assert.deepEqual(evaluation.matches.beast, [{ tag: 'beast', count: 1 }]);
});

test('evaluateLoRaMetadata merges safetensor metadata and aggregated tag frequency tables', () => {
  const evaluation = evaluateLoRaMetadata({
    ss_tag_frequency: {
      Nude: 5,
      portrait: 8,
      young_girl: 1,
    },
    tag_frequency: [
      ['nude', 4],
      ['beast', 2],
      ['portrait', 2],
    ],
  });

  assert.equal(evaluation.adultScore, 9);
  assert.equal(evaluation.minorScore, 1);
  assert.equal(evaluation.beastScore, 2);
  assert.deepEqual(evaluation.normalized, [
    { tag: 'portrait', count: 10 },
    { tag: 'nude', count: 9 },
    { tag: 'beast', count: 2 },
    { tag: 'young_girl', count: 1 },
  ]);
});
