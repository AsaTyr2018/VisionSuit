import type { ImageAnalysisMode, ImageAnalysisOptions, ImageAnalysisResult } from './imageAnalysis';
import { analyzeImageBuffer } from './imageAnalysis';

import { appConfig } from '../../config';

type PriorityLevel = 'normal' | 'high';

export interface AnalyzerTaskOptions {
  priority?: PriorityLevel;
  mode?: ImageAnalysisMode;
}

interface ScheduledTask extends AnalyzerTaskOptions {
  priority: PriorityLevel;
  payload: Buffer;
  resolve: (result: ImageAnalysisResult) => void;
  reject: (error: unknown) => void;
  attempts: number;
  enqueuedAt: number;
}

export interface NsfwAnalysisMetrics {
  queueDepth: number;
  activeWorkers: number;
  pressureActive: boolean;
  lastDurationMs: number | null;
  lastMode: ImageAnalysisMode | null;
  totalCompleted: number;
  totalFailed: number;
  totalRetried: number;
  lastUpdatedAt: number | null;
}

export interface SchedulerDependencies {
  analyze?: (payload: Buffer, options?: ImageAnalysisOptions) => Promise<ImageAnalysisResult>;
  now?: () => number;
}

const DEFAULT_PRIORITY: PriorityLevel = 'normal';

export class NsfwAnalysisScheduler {
  private readonly analyze: (payload: Buffer, options?: ImageAnalysisOptions) => Promise<ImageAnalysisResult>;

  private readonly now: () => number;

  private queue: ScheduledTask[] = [];

  private activeWorkers = 0;

  private pressureActive = false;

  private lastPressureAt = 0;

  private backoffTimer: NodeJS.Timeout | null = null;

  private metrics: NsfwAnalysisMetrics = {
    queueDepth: 0,
    activeWorkers: 0,
    pressureActive: false,
    lastDurationMs: null,
    lastMode: null,
    totalCompleted: 0,
    totalFailed: 0,
    totalRetried: 0,
    lastUpdatedAt: null,
  };

  constructor(dependencies: SchedulerDependencies = {}) {
    this.analyze = dependencies.analyze ?? analyzeImageBuffer;
    this.now = dependencies.now ?? (() => Date.now());
  }

  public getMetrics(): NsfwAnalysisMetrics {
    return { ...this.metrics };
  }

  public enqueue(payload: Buffer, options: AnalyzerTaskOptions = {}): Promise<ImageAnalysisResult> {
    const runtime = this.getRuntime();
    if (this.queue.length + this.activeWorkers >= runtime.queueHardLimit) {
      throw new Error('NSFW analysis queue overloaded');
    }

    const priority = options.priority ?? DEFAULT_PRIORITY;
    const task: ScheduledTask = {
      payload,
      priority,
      resolve: () => {},
      reject: () => {},
      attempts: 0,
      enqueuedAt: this.now(),
    };

    if (options.mode) {
      task.mode = options.mode;
    }

    const promise = new Promise<ImageAnalysisResult>((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });

    this.queue.push(task);
    this.metrics.queueDepth = this.queue.length;
    this.processQueue();

    return promise;
  }

  private getRuntime() {
    return appConfig.nsfw.imageAnalysis.runtime;
  }

  private scheduleBackoff(delayMs: number) {
    if (this.backoffTimer) {
      return;
    }
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.processQueue();
    }, delayMs);
  }

  private dequeue(): ScheduledTask | undefined {
    if (this.queue.length === 0) {
      return undefined;
    }

    let bestIndex = 0;
    let bestPriority = this.queue[0]?.priority ?? DEFAULT_PRIORITY;
    for (let i = 1; i < this.queue.length; i += 1) {
      const candidate = this.queue[i];
      if (!candidate) {
        continue;
      }
      if ((candidate.priority ?? DEFAULT_PRIORITY) === 'high' && bestPriority !== 'high') {
        bestPriority = 'high';
        bestIndex = i;
        continue;
      }
      if ((candidate.priority ?? DEFAULT_PRIORITY) === bestPriority) {
        if (candidate.enqueuedAt < (this.queue[bestIndex]?.enqueuedAt ?? Number.MAX_SAFE_INTEGER)) {
          bestIndex = i;
        }
      }
    }

    const [task] = this.queue.splice(bestIndex, 1);
    this.metrics.queueDepth = this.queue.length;
    return task;
  }

  private updatePressureState(queueDepth: number) {
    const runtime = this.getRuntime();
    const now = this.now();

    if (queueDepth >= runtime.queueSoftLimit) {
      this.pressureActive = true;
      this.lastPressureAt = now;
      return;
    }

    if (this.pressureActive && now - this.lastPressureAt >= runtime.pressureCooldownMs) {
      this.pressureActive = false;
    }
  }

  private processQueue() {
    if (this.backoffTimer) {
      return;
    }

    const runtime = this.getRuntime();
    this.updatePressureState(this.queue.length);

    if (this.queue.length === 0 || this.activeWorkers >= runtime.maxWorkers) {
      return;
    }

    if (this.queue.length >= runtime.queueSoftLimit && runtime.backoffMs > 0) {
      this.scheduleBackoff(runtime.backoffMs);
      return;
    }

    const availableSlots = Math.max(0, runtime.maxWorkers - this.activeWorkers);
    const batchSize = Math.min(runtime.maxBatchSize, availableSlots, this.queue.length);

    for (let i = 0; i < batchSize; i += 1) {
      const task = this.dequeue();
      if (!task) {
        break;
      }
      this.startTask(task);
    }
  }

  private startTask(task: ScheduledTask) {
    const runtime = this.getRuntime();
    this.activeWorkers += 1;
    this.metrics.activeWorkers = this.activeWorkers;

    const queueDepth = this.queue.length;
    const underPressure = queueDepth >= runtime.queueSoftLimit || this.pressureActive;
    if (underPressure) {
      this.pressureActive = true;
      this.lastPressureAt = this.now();
    }

    const selectedMode: ImageAnalysisMode = task.mode
      ? task.mode
      : underPressure && runtime.pressureHeuristicOnly
        ? 'fast'
        : 'full';

    const startedAt = this.now();

    this.analyze(task.payload, { mode: selectedMode })
      .then((result) => {
        this.metrics.totalCompleted += 1;
        this.metrics.lastDurationMs = this.now() - startedAt;
        this.metrics.lastMode = selectedMode;
        this.metrics.lastUpdatedAt = this.now();
        task.resolve(result);
      })
      .catch((error) => {
        if (task.attempts < this.getRuntime().maxRetries) {
          const retryTask: ScheduledTask = {
            ...task,
            attempts: task.attempts + 1,
            enqueuedAt: this.now(),
          };
          this.metrics.totalRetried += 1;
          this.queue.push(retryTask);
          this.metrics.queueDepth = this.queue.length;
        } else {
          this.metrics.totalFailed += 1;
          this.metrics.lastUpdatedAt = this.now();
          task.reject(error);
        }
      })
      .finally(() => {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        this.metrics.activeWorkers = this.activeWorkers;
        this.processQueue();
      });
  }
}

export const nsfwAnalysisScheduler = new NsfwAnalysisScheduler();
