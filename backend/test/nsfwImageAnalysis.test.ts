import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { analyzeImageBuffer } from '../src/lib/nsfw/imageAnalysis';
import { PNG } from 'pngjs';

const fixturePath = join(__dirname, 'image-fixtures.txt');
const fixtureEntries = readFileSync(fixturePath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && line.includes(':'))
  .map((line) => {
    const [key, value] = line.split(':', 2);
    return [key as 'nude' | 'suggestive' | 'safe', value] as const;
  });

const BASE64_IMAGES = Object.fromEntries(fixtureEntries) as Record<'nude' | 'suggestive' | 'safe', string>;

const imageFromBase64 = (key: keyof typeof BASE64_IMAGES) => Buffer.from(BASE64_IMAGES[key], 'base64');

describe('NSFW image analysis heuristics', () => {
  it('flags near-full skin exposure as adult content', async () => {
    const buffer = imageFromBase64('nude');
    const result = await analyzeImageBuffer(buffer);

    assert.ok(result.decisions.isAdult, 'Expected adult decision for near-fully nude sample');
    assert.equal(result.decisions.isSuggestive, false);
    assert.ok(result.skinRatio > 0.9, 'Skin ratio should be high for synthetic nude sample');
    assert.ok(result.coverageScore < 0.3, 'Coverage should be low for synthetic nude sample');
    assert.ok(result.pose, 'Pose metrics should be populated');
    assert.ok(
      result.pose?.torsoPresenceConfidence && result.pose.torsoPresenceConfidence > 0.6,
      'Torso presence should be confidently detected',
    );
  });

  it('treats partial torso coverage with edge detail as suggestive', async () => {
    const buffer = imageFromBase64('suggestive');
    const result = await analyzeImageBuffer(buffer);

    assert.equal(result.decisions.isAdult, false);
    assert.ok(result.decisions.isSuggestive, 'Expected suggestive classification for partial coverage');
    assert.ok(result.skinRatio > 0.2, 'Skin ratio should reflect exposed torso');
    assert.ok(result.coverageScore > 0.1, 'Coverage score should reflect edge detail');
    assert.ok(result.pose, 'Pose metrics should be populated for suggestive sample');
    assert.ok(
      result.pose?.torsoPresenceConfidence && result.pose.torsoPresenceConfidence > 0.3,
      'Pose heuristics should acknowledge torso exposure',
    );
  });

  it('keeps non-skin images unflagged', async () => {
    const buffer = imageFromBase64('safe');
    const result = await analyzeImageBuffer(buffer);

    assert.equal(result.decisions.isAdult, false);
    assert.equal(result.decisions.isSuggestive, false);
    assert.ok(result.skinRatio < 0.1, 'Skin ratio should be near zero');
    assert.ok(result.pose, 'Pose metrics should still exist for bookkeeping');
    assert.ok(
      result.pose?.torsoPresenceConfidence !== undefined && result.pose.torsoPresenceConfidence <= 0.2,
      'Pose heuristic should remain low when no torso is present',
    );
  });

  it('routes limb-dominant exposure for human review', async () => {
    const width = 160;
    const height = 160;
    const png = new PNG({ width, height });
    const background = { r: 20, g: 32, b: 64, a: 255 } as const;
    const skin = { r: 222, g: 188, b: 160, a: 255 } as const;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (width * y + x) << 2;
        const isSkinBand = x < 32 || x > width - 33;
        const color = isSkinBand ? skin : background;
        png.data[idx] = color.r;
        png.data[idx + 1] = color.g;
        png.data[idx + 2] = color.b;
        png.data[idx + 3] = color.a;
      }
    }

    const syntheticBuffer = PNG.sync.write(png);
    const result = await analyzeImageBuffer(Buffer.from(syntheticBuffer));

    assert.equal(result.decisions.isAdult, false, 'Limb-only exposure should not be auto-marked adult');
    assert.equal(
      result.decisions.isSuggestive,
      false,
      'Limb-only exposure should avoid automatic suggestive tagging',
    );
    assert.equal(result.decisions.needsReview, true, 'Limb-dominant exposure should be escalated');
    assert.ok(result.pose, 'Pose metrics must be emitted');
    assert.ok(
      result.pose?.limbDominanceConfidence && result.pose.limbDominanceConfidence > 0.4,
      'Pose heuristics should recognize limb-dominant geometry',
    );
    assert.ok(
      result.flags.includes('LIMB_DOMINANT'),
      'Diagnostic flags should surface limb dominance to moderators',
    );
  });
});
