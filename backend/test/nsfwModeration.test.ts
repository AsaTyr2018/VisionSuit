import { strict as assert } from 'node:assert';
import test from 'node:test';

import { appConfig } from '../src/config';
import {
  evaluateImageModeration,
  evaluateModelModeration,
  resolveMetadataScreening,
} from '../src/lib/nsfw/moderation';

test('evaluateModelModeration marks assets as adult when metadata crosses the adult threshold', () => {
  const originalThresholds = { ...appConfig.nsfw.metadataFilters.thresholds };
  appConfig.nsfw.metadataFilters.thresholds = {
    adult: 10,
    minor: originalThresholds.minor,
    beast: originalThresholds.beast,
  };

  const decision = evaluateModelModeration({
    title: 'Dreamscape mix',
    description: 'Harmless training data',
    trigger: null,
    metadata: {
      nsfwMetadata: {
        adultScore: 12,
        minorScore: 0,
        beastScore: 0,
        matches: { adult: [], minor: [], beast: [] },
        normalized: [],
      },
    },
    metadataList: [],
    tags: [],
    adultKeywords: [],
  });

  assert.equal(decision.metadataAdult, true);
  assert.equal(decision.metadataMinor, false);
  assert.equal(decision.metadataBeast, false);
  assert.equal(decision.requiresModeration, false);
  assert.equal(decision.isAdult, true);

  appConfig.nsfw.metadataFilters.thresholds = originalThresholds;
});

test('evaluateModelModeration flags potentially illegal metadata for moderation', () => {
  const originalThresholds = { ...appConfig.nsfw.metadataFilters.thresholds };
  appConfig.nsfw.metadataFilters.thresholds = {
    adult: 50,
    minor: 2,
    beast: originalThresholds.beast,
  };

  const decision = evaluateModelModeration({
    title: 'Model pack',
    description: 'General release',
    trigger: null,
    metadata: {
      nsfwMetadata: {
        adultScore: 5,
        minorScore: 3,
        beastScore: 0,
        matches: { adult: [], minor: [{ tag: 'schoolgirl', count: 3 }], beast: [] },
        normalized: [],
      },
    },
    metadataList: [],
    tags: [],
    adultKeywords: [],
  });

  assert.equal(decision.metadataAdult, false, 'Adult threshold remains untouched');
  assert.equal(decision.metadataMinor, true, 'Minor threshold should trigger');
  assert.equal(decision.metadataBeast, false);
  assert.equal(decision.requiresModeration, true, 'Minor hits must queue moderation');
  assert.equal(decision.isAdult, true, 'Illegal findings still mark the asset as adult');
  assert.ok(decision.metadataScreening, 'Screening result should be returned');

  appConfig.nsfw.metadataFilters.thresholds = originalThresholds;
});

test('evaluateImageModeration marks images as adult when minor keywords surface in metadata', () => {
  const decision = evaluateImageModeration({
    title: 'Classroom sketch',
    description: 'A concept illustration',
    prompt: null,
    negativePrompt: null,
    model: null,
    sampler: null,
    metadata: { notes: ['soft lighting', 'schoolgirl uniform portrait'] },
    metadataList: [],
    tags: [],
    adultKeywords: [],
  });

  assert.equal(decision.illegalMinor, true);
  assert.equal(decision.illegalBeast, false);
  assert.equal(decision.requiresModeration, true);
  assert.equal(decision.isAdult, true);
});

test('evaluateImageModeration surfaces bestiality markers across tags and nested metadata', () => {
  const decision = evaluateImageModeration({
    title: 'Fantasy duo',
    description: null,
    prompt: 'Hero poses with guardian',
    negativePrompt: null,
    model: null,
    sampler: null,
    metadata: null,
    metadataList: [{ details: ['feral_mating ritual recorded'] }],
    tags: [
      {
        tag: {
          label: 'Beastman partner',
          isAdult: false,
        },
      },
    ],
    adultKeywords: [],
    additionalTexts: ['companion described as beastial hero'],
  });

  assert.equal(decision.illegalBeast, true);
  assert.equal(decision.illegalMinor, false);
  assert.equal(decision.requiresModeration, true);
  assert.equal(decision.isAdult, true);
});

test('evaluateModelModeration still screens metadata when bypass is active', () => {
  const originalBypass = appConfig.nsfw.bypassFilter;
  const originalThresholds = { ...appConfig.nsfw.metadataFilters.thresholds };

  appConfig.nsfw.bypassFilter = true;
  appConfig.nsfw.metadataFilters.thresholds = {
    adult: 10,
    minor: 2,
    beast: originalThresholds.beast,
  };

  try {
    const decision = evaluateModelModeration({
      title: 'Private pack',
      description: 'contains disallowed material',
      trigger: null,
      metadata: {
        nsfwMetadata: {
          adultScore: 12,
          minorScore: 3,
          beastScore: 0,
          matches: { adult: [], minor: [{ tag: 'schoolgirl', count: 3 }], beast: [] },
          normalized: [],
        },
      },
      metadataList: [],
      tags: [],
      adultKeywords: [],
    });

    assert.equal(decision.metadataAdult, true, 'Adult scores must still be honored');
    assert.equal(decision.metadataMinor, true, 'Minor scores must still trigger moderation');
    assert.equal(decision.requiresModeration, true, 'Bypass should not suppress moderation');
    assert.equal(decision.isAdult, true, 'Assets stay adult while bypass is active');
  } finally {
    appConfig.nsfw.bypassFilter = originalBypass;
    appConfig.nsfw.metadataFilters.thresholds = originalThresholds;
  }
});

test('evaluateImageModeration flags minor prompts for guests when bypass is active', () => {
  const originalBypass = appConfig.nsfw.bypassFilter;

  appConfig.nsfw.bypassFilter = true;

  try {
    const decision = evaluateImageModeration({
      title: 'Sketch',
      description: null,
      prompt: 'portrait of a schoolgirl in uniform',
      negativePrompt: null,
      model: null,
      sampler: null,
      metadata: null,
      metadataList: [],
      tags: [],
      adultKeywords: [],
    });

    assert.equal(decision.illegalMinor, true, 'Minor prompts must be blocked');
    assert.equal(decision.requiresModeration, true, 'Bypass must not hide moderation requirements');
    assert.equal(decision.isAdult, true, 'Image is treated as adult content');
  } finally {
    appConfig.nsfw.bypassFilter = originalBypass;
  }
});

test('resolveMetadataScreening returns parsed evaluation from metadata payloads', () => {
  const screening = resolveMetadataScreening({
    extracted: {
      ss_tag_frequency: { Nude: 3, Portrait: 1 },
      tag_frequency: [
        ['nude', 2],
        ['young_girl', 1],
      ],
    },
  });

  assert.ok(screening, 'Screening should be derived from extracted metadata');
  assert.equal(screening?.adultScore, 5);
  assert.equal(screening?.minorScore, 1);
});
