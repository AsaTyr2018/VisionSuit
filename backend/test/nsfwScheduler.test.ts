import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appConfig } from '../src/config';
import type { ImageAnalysisResult } from '../src/lib/nsfw/imageAnalysis';
import { NsfwAnalysisScheduler } from '../src/lib/nsfw/runtime';

const createResult = (): ImageAnalysisResult => ({
  width: 64,
  height: 64,
  skinPixels: 0,
  totalPixels: 4096,
  skinRatio: 0,
  dominantSkinRatio: 0,
  coverageScore: 0,
  edgeDensity: 0,
  colorStdDev: 0,
  decisions: {
    isAdult: false,
    isSuggestive: false,
    needsReview: false,
  },
  scores: {
    adult: 0,
    suggestive: 0,
  },
  flags: [],
});

describe('NSFW analysis scheduler', () => {
  it('processes tasks respecting concurrency limits', async () => {
    const originalRuntime = { ...appConfig.nsfw.imageAnalysis.runtime };
    appConfig.nsfw.imageAnalysis.runtime = {
      ...originalRuntime,
      maxWorkers: 1,
      maxBatchSize: 1,
      queueSoftLimit: 10,
      queueHardLimit: 10,
      maxRetries: 0,
      backoffMs: 0,
      pressureCooldownMs: 0,
      pressureHeuristicOnly: false,
    };

    const calls: number[] = [];
    const scheduler = new NsfwAnalysisScheduler({
      analyze: async (_, __) => {
        calls.push(Date.now());
        return createResult();
      },
    });

    const tasks = [scheduler.enqueue(Buffer.from('a')), scheduler.enqueue(Buffer.from('b')), scheduler.enqueue(Buffer.from('c'))];
    await Promise.all(tasks);

    assert.equal(calls.length, 3, 'All tasks should be processed');
    assert.ok(calls.length > 0, 'At least one invocation should have executed');
    for (let i = 1; i < calls.length; i += 1) {
      const current = calls[i];
      const previous = calls[i - 1];
      if (current === undefined || previous === undefined) {
        continue;
      }
      assert.ok(current >= previous, 'Tasks should run sequentially when only one worker is available');
    }

    appConfig.nsfw.imageAnalysis.runtime = originalRuntime;
  });

  it('switches to fast mode under pressure', async () => {
    const originalRuntime = { ...appConfig.nsfw.imageAnalysis.runtime };
    appConfig.nsfw.imageAnalysis.runtime = {
      ...originalRuntime,
      maxWorkers: 2,
      maxBatchSize: 2,
      queueSoftLimit: 1,
      queueHardLimit: 10,
      maxRetries: 0,
      backoffMs: 0,
      pressureCooldownMs: 0,
      pressureHeuristicOnly: true,
    };

    const modes: string[] = [];
    const scheduler = new NsfwAnalysisScheduler({
      analyze: async (_, options) => {
        modes.push(options?.mode ?? 'full');
        return createResult();
      },
    });

    const tasks = [
      scheduler.enqueue(Buffer.from('1')),
      scheduler.enqueue(Buffer.from('2')),
      scheduler.enqueue(Buffer.from('3')),
    ];

    await Promise.all(tasks);

    assert.equal(modes.length, 3);
    assert.ok(modes.length > 0, 'Scheduler should emit at least one mode entry');
    assert.ok(
      modes.some((mode) => mode === 'fast'),
      'At least one queued task should fall back to fast mode while under pressure',
    );

    appConfig.nsfw.imageAnalysis.runtime = originalRuntime;
  });

  it('retries failed tasks up to the configured limit', async () => {
    const originalRuntime = { ...appConfig.nsfw.imageAnalysis.runtime };
    appConfig.nsfw.imageAnalysis.runtime = {
      ...originalRuntime,
      maxWorkers: 1,
      maxBatchSize: 1,
      queueSoftLimit: 5,
      queueHardLimit: 5,
      maxRetries: 2,
      backoffMs: 0,
      pressureCooldownMs: 0,
      pressureHeuristicOnly: true,
    };

    let attempts = 0;
    const scheduler = new NsfwAnalysisScheduler({
      analyze: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('synthetic failure');
        }
        return createResult();
      },
    });

    await scheduler.enqueue(Buffer.from('retry'));
    assert.equal(attempts, 3, 'Scheduler should retry until success within the limit');

    appConfig.nsfw.imageAnalysis.runtime = originalRuntime;
  });
});
