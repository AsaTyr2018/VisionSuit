import fs from 'node:fs';

import jpeg from 'jpeg-js';
import UPNG from 'upng-js';

import { appConfig } from '../../config';

import type { OpenCVModule, OpenCvMat } from '../../types/opencv';

let openCvInstance: Promise<OpenCVModule> | null = null;

interface OnnxTensorLike {
  data?: Float32Array | number[] | Float64Array | Uint8Array;
}

interface OnnxInferenceSession {
  inputNames?: string[];
  outputNames?: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike | undefined>>;
}

interface NudityClassifierModule {
  InferenceSession: {
    create(
      modelPath: string,
      options?: { executionProviders?: string[] },
    ): Promise<OnnxInferenceSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OnnxTensorLike;
}

interface NudityClassifierContext {
  session: OnnxInferenceSession;
  inputName: string;
  outputName: string;
  provider: string;
}

interface NudityClassifierResult {
  nude: number;
  swimwear: number;
  ambiguous: number;
  delta: number;
  provider: string;
  inferenceMs: number;
}

let nudityClassifier: Promise<NudityClassifierContext | null> | null = null;

const OPEN_CV_INIT_TIMEOUT_MS = 15000;

const waitForOpenCv = (): Promise<OpenCVModule> => {
  if (openCvInstance) {
    return openCvInstance;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const imported = require('@techstark/opencv-js') as
    | Promise<OpenCVModule>
    | (OpenCVModule & { ready?: Promise<void>; onRuntimeInitialized?: () => void });

  if (imported && typeof (imported as Promise<OpenCVModule>).then === 'function') {
    openCvInstance = (imported as Promise<OpenCVModule>).then((module) => module);
    return openCvInstance;
  }

  const cv = imported as OpenCVModule & { ready?: Promise<void>; onRuntimeInitialized?: () => void };

  if (cv && typeof cv.Mat === 'function') {
    if (cv.ready && typeof cv.ready.then === 'function') {
      openCvInstance = cv.ready.then(() => cv);
    } else {
      openCvInstance = Promise.resolve(cv);
    }
    return openCvInstance;
  }

  openCvInstance = new Promise<OpenCVModule>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out while waiting for OpenCV to initialize.'));
    }, OPEN_CV_INIT_TIMEOUT_MS);

    cv.onRuntimeInitialized = () => {
      clearTimeout(timeout);
      resolve(cv);
    };
  });

  return openCvInstance;
};

const resolveNudityClassifier = (): Promise<NudityClassifierContext | null> => {
  if (nudityClassifier) {
    return nudityClassifier;
  }

  const cnnConfig = appConfig.nsfw.imageAnalysis.cnn;
  if (!cnnConfig.enabled) {
    nudityClassifier = Promise.resolve(null);
    return nudityClassifier;
  }

  nudityClassifier = (async () => {
    const modelPath = cnnConfig.modelPath;
    if (!modelPath) {
      return null;
    }

    try {
      if (!fs.existsSync(modelPath)) {
        // eslint-disable-next-line no-console
        console.warn(`NSFW swimwear classifier disabled: model not found at "${modelPath}".`);
        return null;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `Failed to verify NSFW swimwear classifier path "${modelPath}": ${(error as Error).message}`,
      );
      return null;
    }

    let runtime: NudityClassifierModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      runtime = require('onnxruntime-node') as NudityClassifierModule;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to load onnxruntime-node: ${(error as Error).message}`);
      return null;
    }

    try {
      const executionProviders =
        Array.isArray(cnnConfig.executionProviders) && cnnConfig.executionProviders.length > 0
          ? cnnConfig.executionProviders
          : undefined;

      const session = await runtime.InferenceSession.create(
        modelPath,
        executionProviders ? { executionProviders } : undefined,
      );

      const inputName = session.inputNames?.[0] ?? 'input';
      const outputName = session.outputNames?.[0] ?? 'output';

      const warmupIterations = Math.max(0, cnnConfig.warmupIterations);
      if (warmupIterations > 0) {
        const size = Math.max(1, cnnConfig.inputSize);
        const zeroInput = new runtime.Tensor(
          'float32',
          new Float32Array(3 * size * size),
          [1, 3, size, size],
        );
        for (let i = 0; i < warmupIterations; i += 1) {
          try {
            await session.run({ [inputName]: zeroInput });
          } catch (warmupError) {
            // eslint-disable-next-line no-console
            console.warn(
              `NSFW swimwear classifier warmup failed: ${(warmupError as Error).message}`,
            );
            break;
          }
        }
      }

      const provider =
        (Array.isArray(cnnConfig.executionProviders) && cnnConfig.executionProviders[0]) || 'cpu';

      return {
        session,
        inputName,
        outputName,
        provider,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `Failed to initialize NSFW swimwear classifier session: ${(error as Error).message}`,
      );
      return null;
    }
  })();

  return nudityClassifier;
};

const softmax = (values: readonly number[]): number[] => {
  if (values.length === 0) {
    return [];
  }

  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, current) => total + current, 0);

  if (sum <= 0) {
    return new Array(values.length).fill(0);
  }

  return exps.map((value) => value / sum);
};

const expandRect = (
  rect: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
  expansionRatio: number,
) => {
  const padX = Math.round(rect.width * expansionRatio);
  const padY = Math.round(rect.height * expansionRatio);

  const x = Math.max(0, rect.x - padX);
  const y = Math.max(0, rect.y - padY);
  const width = Math.min(imageWidth - x, rect.width + padX * 2);
  const height = Math.min(imageHeight - y, rect.height + padY * 2);

  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
};

const runNudityClassifier = async (roi: OpenCvMat): Promise<NudityClassifierResult | null> => {
  const context = await resolveNudityClassifier();
  if (!context) {
    return null;
  }

  const cv = await waitForOpenCv();
  const cnnConfig = appConfig.nsfw.imageAnalysis.cnn;
  const size = Math.max(32, cnnConfig.inputSize);

  const resized = new cv.Mat();
  cv.resize(roi, resized, new cv.Size(size, size), 0, 0, cv.INTER_AREA);

  const rgb = new cv.Mat();
  cv.cvtColor(resized, rgb, cv.COLOR_BGR2RGB);

  const totalPixels = size * size;
  const tensorData = new Float32Array(totalPixels * 3);
  const mean = cnnConfig.mean;
  const std = cnnConfig.std;
  const data = rgb.data;

  for (let index = 0; index < totalPixels; index += 1) {
    const pixelIndex = index * 3;
    const r = (data[pixelIndex] ?? 0) / 255;
    const g = (data[pixelIndex + 1] ?? 0) / 255;
    const b = (data[pixelIndex + 2] ?? 0) / 255;

    tensorData[index] = (r - mean[0]) / std[0];
    tensorData[totalPixels + index] = (g - mean[1]) / std[1];
    tensorData[totalPixels * 2 + index] = (b - mean[2]) / std[2];
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const runtime = require('onnxruntime-node') as NudityClassifierModule;
  const inputTensor = new runtime.Tensor('float32', tensorData, [1, 3, size, size]);

  const startedAt = Date.now();
  const outputs = await context.session.run({ [context.inputName]: inputTensor });
  const duration = Date.now() - startedAt;

  const rawOutput = outputs[context.outputName];
  const outputSource = rawOutput?.data;
  const values =
    outputSource instanceof Float32Array ||
    outputSource instanceof Float64Array ||
    Array.isArray(outputSource)
      ? Array.from(outputSource as Float32Array | Float64Array | number[]).slice(
          0,
          cnnConfig.labels.length,
        )
      : [];
  const probabilities = softmax(values);

  disposeAll([resized, rgb]);

  const map = new Map<string, number>();
  for (let i = 0; i < cnnConfig.labels.length; i += 1) {
    const label = cnnConfig.labels[i];
    if (!label) {
      continue;
    }
    map.set(label, clamp(probabilities[i] ?? 0, 0, 1));
  }

  const nude = map.get('nude') ?? 0;
  const swimwear = map.get('swimwear') ?? 0;
  const ambiguous = map.get('ambiguous') ?? 0;

  return {
    nude,
    swimwear,
    ambiguous,
    delta: nude - swimwear,
    provider: context.provider,
    inferenceMs: duration,
  };
};

const clamp = (value: number, min: number, max: number) => {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

const roundTo = (value: number, precision: number) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const asFloat = (value: number | undefined) => (Number.isFinite(value) ? (value as number) : 0);

const disposeAll = (items: Array<{ delete(): void } | null | undefined>) => {
  for (const item of items) {
    if (item && typeof item.delete === 'function') {
      item.delete();
    }
  }
};

const decodeImage = async (payload: Buffer): Promise<OpenCvMat> => {
  const cv = await waitForOpenCv();

  let width = 0;
  let height = 0;
  let rgba: Uint8Array | null = null;

  try {
    const decoded = UPNG.decode(payload);
    width = decoded.width;
    height = decoded.height;
    const frames = UPNG.toRGBA8(decoded);
    const frame = frames && frames.length > 0 ? frames[0] : null;
    rgba = frame ? new Uint8Array(frame) : null;
  } catch (pngError) {
    try {
      const decoded = jpeg.decode(payload, { useTArray: true });
      width = decoded.width;
      height = decoded.height;
      const data = decoded.data;
      rgba = data instanceof Uint8Array ? data : Uint8Array.from(data);
    } catch (jpegError) {
      throw new Error('Unable to decode the provided image buffer.');
    }
  }

  if (!rgba || width <= 0 || height <= 0) {
    throw new Error('Unable to decode the provided image buffer.');
  }

  const rgbaMat = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
  const bgr = new cv.Mat();
  cv.cvtColor(rgbaMat, bgr, cv.COLOR_RGBA2BGR);
  rgbaMat.delete();

  return bgr;
};

const resizeIfNeeded = async (image: OpenCvMat, maxEdge: number): Promise<OpenCvMat> => {
  const cv = await waitForOpenCv();
  const currentMaxEdge = Math.max(image.cols, image.rows);
  const targetEdge = maxEdge;

  if (currentMaxEdge <= targetEdge) {
    return image;
  }

  const scale = targetEdge / currentMaxEdge;
  const width = Math.max(1, Math.round(image.cols * scale));
  const height = Math.max(1, Math.round(image.rows * scale));

  const resized = new cv.Mat();
  cv.resize(
    image,
    resized,
    new cv.Size(width, height),
    0,
    0,
    cv.INTER_AREA,
  );

  image.delete();

  return resized;
};

const createSkinMask = async (image: OpenCvMat): Promise<OpenCvMat> => {
  const cv = await waitForOpenCv();

  const hsv = new cv.Mat();
  cv.cvtColor(image, hsv, cv.COLOR_BGR2HSV);

  const ycrcb = new cv.Mat();
  cv.cvtColor(image, ycrcb, cv.COLOR_BGR2YCrCb);

  const hsvMask = new cv.Mat();
  const hsvLower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 40, 30, 0]);
  const hsvUpper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [25, 255, 255, 0]);
  cv.inRange(hsv, hsvLower, hsvUpper, hsvMask);

  const ycrcbMask = new cv.Mat();
  const ycrcbLower = new cv.Mat(ycrcb.rows, ycrcb.cols, ycrcb.type(), [0, 133, 77, 0]);
  const ycrcbUpper = new cv.Mat(ycrcb.rows, ycrcb.cols, ycrcb.type(), [255, 173, 127, 0]);
  cv.inRange(ycrcb, ycrcbLower, ycrcbUpper, ycrcbMask);

  const combined = new cv.Mat();
  cv.bitwise_and(hsvMask, ycrcbMask, combined);

  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  cv.morphologyEx(combined, combined, cv.MORPH_OPEN, kernel);
  cv.morphologyEx(combined, combined, cv.MORPH_CLOSE, kernel);

  disposeAll([hsv, ycrcb, hsvMask, hsvLower, hsvUpper, ycrcbMask, ycrcbLower, ycrcbUpper, kernel]);

  return combined;
};

const analyzeSkinRegions = async (
  image: OpenCvMat,
  skinMask: OpenCvMat,
): Promise<{
  skinPixelCount: number;
  totalPixelCount: number;
  skinRatio: number;
  dominantRegionArea: number;
  dominantRegionRatio: number;
  dominantRegionRect: { x: number; y: number; width: number; height: number } | null;
  centroid: { x: number; y: number } | null;
}> => {
  const cv = await waitForOpenCv();
  const totalPixelCount = image.rows * image.cols;
  const skinPixelCount = cv.countNonZero(skinMask);
  const skinRatio = totalPixelCount > 0 ? skinPixelCount / totalPixelCount : 0;

  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  cv.connectedComponentsWithStats(
    skinMask,
    labels,
    stats,
    centroids,
    8,
    cv.CV_32S,
  );

  let dominantRegionArea = 0;
  let dominantRegionRect: { x: number; y: number; width: number; height: number } | null = null;
  let dominantRegionCentroid: { x: number; y: number } | null = null;

  for (let i = 1; i < stats.rows; i += 1) {
    const area = stats.intAt(i, cv.CC_STAT_AREA) ?? 0;
    if (area <= dominantRegionArea) {
      continue;
    }

    dominantRegionArea = area;
    dominantRegionRect = {
      x: stats.intAt(i, cv.CC_STAT_LEFT) ?? 0,
      y: stats.intAt(i, cv.CC_STAT_TOP) ?? 0,
      width: stats.intAt(i, cv.CC_STAT_WIDTH) ?? 0,
      height: stats.intAt(i, cv.CC_STAT_HEIGHT) ?? 0,
    };

    dominantRegionCentroid = {
      x: centroids.doubleAt(i, 0) ?? 0,
      y: centroids.doubleAt(i, 1) ?? 0,
    };
  }

  disposeAll([labels, stats, centroids]);

  const dominantRegionRatio = totalPixelCount > 0 ? dominantRegionArea / totalPixelCount : 0;

  return {
    skinPixelCount,
    totalPixelCount,
    skinRatio,
    dominantRegionArea,
    dominantRegionRatio,
    dominantRegionRect,
    centroid: dominantRegionCentroid,
  };
};

const evaluateCoverage = async (
  image: OpenCvMat,
  skinMask: OpenCvMat,
  regionRect: { x: number; y: number; width: number; height: number } | null,
) => {
  const cv = await waitForOpenCv();
  if (!regionRect || regionRect.width <= 0 || regionRect.height <= 0) {
    return {
      edgeDensity: 0,
      colorStdDev: 0,
      coverageScore: 1,
    };
  }

  const rect = new cv.Rect(regionRect.x, regionRect.y, regionRect.width, regionRect.height);
  const roiMask = skinMask.roi(rect);
  const roi = image.roi(rect);

  const gray = new cv.Mat();
  cv.cvtColor(roi, gray, cv.COLOR_BGR2GRAY);

  const edges = new cv.Mat();
  cv.Canny(gray, edges, 80, 160);

  const skinPixelsInRoi = cv.countNonZero(roiMask);
  const totalRoiPixels = rect.width * rect.height;

  const edgePixels = cv.countNonZero(edges);
  const edgeDensity = totalRoiPixels > 0 ? edgePixels / totalRoiPixels : 0;

  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  cv.meanStdDev(roi, mean, stddev, roiMask);

  const stdValues = stddev.data64F ?? new Float64Array(3);
  const colorStdDev = (asFloat(stdValues[0]) + asFloat(stdValues[1]) + asFloat(stdValues[2])) / 3;

  const normalizedEdgeDensity = clamp(edgeDensity / 0.18, 0, 1);
  const normalizedStd = clamp(colorStdDev / 45, 0, 1);
  const skinGap = totalRoiPixels > 0 ? 1 - skinPixelsInRoi / totalRoiPixels : 0;
  const normalizedGap = clamp(skinGap / 0.4, 0, 1);
  const coverageScore = clamp(normalizedEdgeDensity * 0.4 + normalizedStd * 0.3 + normalizedGap * 0.3, 0, 1);

  disposeAll([roiMask, roi, gray, edges, mean, stddev]);

  return {
    edgeDensity,
    colorStdDev,
    coverageScore,
    skinPixelsInRoi,
    totalRoiPixels,
  };
};

interface TorsoAnalysis {
  torsoCoverage: number;
  hipCoverage: number;
  shoulderCoverage: number;
  torsoPresenceConfidence: number;
  hipPresenceConfidence: number;
  limbDominanceConfidence: number;
  offCenterDistance: number;
  torsoContinuity: number;
  overallCentralCoverage: number;
}

const estimateTorsoPresence = async (
  image: OpenCvMat,
  skinMask: OpenCvMat,
  regionRect: { x: number; y: number; width: number; height: number } | null,
  centroid: { x: number; y: number } | null,
): Promise<TorsoAnalysis> => {
  const cv = await waitForOpenCv();

  if (!regionRect || regionRect.width <= 0 || regionRect.height <= 0) {
    return {
      torsoCoverage: 0,
      hipCoverage: 0,
      shoulderCoverage: 0,
      torsoPresenceConfidence: 0,
      hipPresenceConfidence: 0,
      limbDominanceConfidence: 0,
      offCenterDistance: 0,
      torsoContinuity: 0,
      overallCentralCoverage: 0,
    };
  }

  const rect = new cv.Rect(regionRect.x, regionRect.y, regionRect.width, regionRect.height);
  const roiMask = skinMask.roi(rect);

  try {
    const width = roiMask.cols;
    const height = roiMask.rows;

    if (width <= 0 || height <= 0 || !roiMask.data) {
      return {
        torsoCoverage: 0,
        hipCoverage: 0,
        shoulderCoverage: 0,
        torsoPresenceConfidence: 0,
        hipPresenceConfidence: 0,
        limbDominanceConfidence: 0,
        offCenterDistance: 0,
        torsoContinuity: 0,
        overallCentralCoverage: 0,
      };
    }

    const rawData = roiMask.data;
    if (!rawData) {
      return {
        torsoCoverage: 0,
        hipCoverage: 0,
        shoulderCoverage: 0,
        torsoPresenceConfidence: 0,
        hipPresenceConfidence: 0,
        limbDominanceConfidence: 0,
        offCenterDistance: 0,
        torsoContinuity: 0,
        overallCentralCoverage: 0,
      };
    }

    const data = rawData as Uint8Array;
    const centralStart = Math.floor(width * 0.2);
    const centralEnd = Math.max(centralStart + 1, Math.ceil(width * 0.8));
    const centralWidth = Math.max(1, centralEnd - centralStart);

    const centralCoverageByRow: number[] = new Array(height).fill(0);

    for (let y = 0; y < height; y += 1) {
      let centralSum = 0;

      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const pixel = data[rowOffset + x] ?? 0;
        const value = pixel > 0 ? 1 : 0;
        if (x >= centralStart && x < centralEnd) {
          centralSum += value;
        }
      }

      centralCoverageByRow[y] = centralWidth > 0 ? centralSum / centralWidth : 0;
    }

    const averageCoverage = (startRatio: number, endRatio: number) => {
      const start = Math.max(0, Math.floor(height * startRatio));
      const end = Math.min(height, Math.ceil(height * endRatio));
      if (end <= start) {
        return 0;
      }

      let sum = 0;
      for (let i = start; i < end; i += 1) {
        sum += centralCoverageByRow[i] ?? 0;
      }
      return sum / (end - start);
    };

    const torsoCoverage = clamp(averageCoverage(0.2, 0.75), 0, 1);
    const hipCoverage = clamp(averageCoverage(0.65, 1), 0, 1);
    const shoulderCoverage = clamp(averageCoverage(0, 0.2), 0, 1);

    const midStart = Math.max(0, Math.floor(height * 0.2));
    const midEnd = Math.min(height, Math.ceil(height * 0.75));
    const midLength = Math.max(1, midEnd - midStart);
    let longestRun = 0;
    let currentRun = 0;
    const continuityThreshold = 0.45;

    for (let i = midStart; i < midEnd; i += 1) {
      const coverage = centralCoverageByRow[i] ?? 0;
      if (coverage >= continuityThreshold) {
        currentRun += 1;
        longestRun = Math.max(longestRun, currentRun);
      } else {
        currentRun = 0;
      }
    }

    const torsoContinuity = clamp(longestRun / midLength, 0, 1);

    const hipStart = Math.max(midStart, Math.floor(height * 0.65));
    const hipLength = Math.max(1, height - hipStart);
    let hipRun = 0;
    currentRun = 0;
    for (let i = hipStart; i < height; i += 1) {
      const coverage = centralCoverageByRow[i] ?? 0;
      if (coverage >= continuityThreshold * 0.85) {
        currentRun += 1;
        hipRun = Math.max(hipRun, currentRun);
      } else {
        currentRun = 0;
      }
    }
    const hipContinuity = clamp(hipRun / hipLength, 0, 1);

    const torsoPresenceConfidence = clamp(torsoCoverage * 0.6 + torsoContinuity * 0.4, 0, 1);
    const hipPresenceConfidence = clamp(hipCoverage * 0.6 + hipContinuity * 0.4, 0, 1);

    let centralSum = 0;
    for (const value of centralCoverageByRow) {
      centralSum += value ?? 0;
    }
    const overallCentralCoverage = centralCoverageByRow.length > 0 ? centralSum / centralCoverageByRow.length : 0;

    const limbDominanceConfidence = clamp(
      (1 - torsoPresenceConfidence) * 0.5 +
        (1 - hipPresenceConfidence) * 0.3 +
        clamp((0.3 - overallCentralCoverage) / 0.3, 0, 1) * 0.2,
      0,
      1,
    );

    const offCenterDistance = centroid
      ? Math.min(0.5, Math.abs(centroid.x / image.cols - 0.5))
      : 0;

    return {
      torsoCoverage,
      hipCoverage,
      shoulderCoverage,
      torsoPresenceConfidence,
      hipPresenceConfidence,
      limbDominanceConfidence,
      offCenterDistance,
      torsoContinuity,
      overallCentralCoverage,
    };
  } finally {
    roiMask.delete();
  }
};

export interface ImageAnalysisResult {
  width: number;
  height: number;
  skinPixels: number;
  totalPixels: number;
  skinRatio: number;
  dominantSkinRatio: number;
  coverageScore: number;
  edgeDensity: number;
  colorStdDev: number;
  decisions: {
    isAdult: boolean;
    isSuggestive: boolean;
    needsReview: boolean;
  };
  scores: {
    adult: number;
    suggestive: number;
  };
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
    centroidX: number;
    centroidY: number;
  };
  pose?: {
    torsoCoverage: number;
    hipCoverage: number;
    shoulderCoverage: number;
    torsoPresenceConfidence: number;
    hipPresenceConfidence: number;
    limbDominanceConfidence: number;
    offCenterDistance: number;
    torsoContinuity: number;
    overallCentralCoverage: number;
  };
  cnn?: {
    nude: number;
    swimwear: number;
    ambiguous: number;
    delta: number;
    provider: string;
    inferenceMs: number;
  };
  flags: string[];
}

export type ImageAnalysisMode = 'full' | 'fast';

export interface ImageAnalysisOptions {
  mode?: ImageAnalysisMode;
}

const emptyTorsoAnalysis: TorsoAnalysis = {
  torsoCoverage: 0,
  hipCoverage: 0,
  shoulderCoverage: 0,
  torsoPresenceConfidence: 0,
  hipPresenceConfidence: 0,
  limbDominanceConfidence: 0,
  offCenterDistance: 0,
  torsoContinuity: 0,
  overallCentralCoverage: 0,
};

export const analyzeImageBuffer = async (
  payload: Buffer,
  options: ImageAnalysisOptions = {},
): Promise<ImageAnalysisResult> => {
  const decoded = await decodeImage(payload);
  const runtime = appConfig.nsfw.imageAnalysis.runtime;
  const requestedMode = options.mode ?? 'full';
  const mode: ImageAnalysisMode = requestedMode === 'fast' ? 'fast' : 'full';
  const targetEdge =
    mode === 'fast'
      ? Math.min(appConfig.nsfw.imageAnalysis.maxWorkingEdge, runtime.fastModeMaxEdge)
      : appConfig.nsfw.imageAnalysis.maxWorkingEdge;
  const working = await resizeIfNeeded(decoded, Math.max(1, targetEdge));

  const skinMask = await createSkinMask(working);
  const skinSummary = await analyzeSkinRegions(working, skinMask);
  const coverage = await evaluateCoverage(working, skinMask, skinSummary.dominantRegionRect);
  const torso =
    mode === 'fast'
      ? emptyTorsoAnalysis
      : await estimateTorsoPresence(
          working,
          skinMask,
          skinSummary.dominantRegionRect,
          skinSummary.centroid,
        );

  const thresholds = appConfig.nsfw.imageAnalysis.thresholds;
  const cnnConfig = appConfig.nsfw.imageAnalysis.cnn;
  const hasTorso = torso.torsoPresenceConfidence >= thresholds.torsoPresenceMin;
  const hasHip = torso.hipPresenceConfidence >= thresholds.hipPresenceMin;
  const limbDominant = torso.limbDominanceConfidence >= thresholds.limbDominanceMax;
  const offCenter = torso.offCenterDistance >= thresholds.offCenterTolerance;

  let adultDecision =
    skinSummary.skinRatio >= thresholds.nudeSkinRatio &&
    coverage.coverageScore <= thresholds.nudeCoverageMax &&
    hasTorso &&
    hasHip;
  let suggestiveDecision =
    !adultDecision &&
    skinSummary.skinRatio >= thresholds.suggestiveSkinRatio &&
    coverage.coverageScore <= thresholds.suggestiveCoverageMax &&
    (hasTorso || hasHip) &&
    !limbDominant;

  const flags: string[] = [];
  if (mode === 'fast') {
    flags.push('FAST_MODE');
  }
  if (skinSummary.skinRatio >= thresholds.nudeSkinRatio) {
    flags.push('SKIN_RATIO_HIGH');
  } else if (skinSummary.skinRatio >= thresholds.suggestiveSkinRatio) {
    flags.push('SKIN_RATIO_MODERATE');
  }

  if (coverage.coverageScore <= thresholds.nudeCoverageMax) {
    flags.push('COVERAGE_LOW');
  } else if (coverage.coverageScore <= thresholds.suggestiveCoverageMax) {
    flags.push('COVERAGE_MODERATE');
  }

  if (hasTorso) {
    flags.push('TORSO_DETECTED');
  } else if (skinSummary.skinRatio >= thresholds.suggestiveSkinRatio) {
    flags.push('TORSO_LOW_CONFIDENCE');
  }

  if (hasHip) {
    flags.push('HIP_DETECTED');
  } else if (skinSummary.skinRatio >= thresholds.suggestiveSkinRatio) {
    flags.push('HIP_LOW_CONFIDENCE');
  }

  if (limbDominant) {
    flags.push('LIMB_DOMINANT');
  }

  if (offCenter) {
    flags.push('TORSO_OFF_CENTER');
  }

  const reviewMargin = thresholds.reviewMargin;
  const nearBoundary =
    Math.abs(coverage.coverageScore - thresholds.nudeCoverageMax) <= reviewMargin ||
    Math.abs(skinSummary.skinRatio - thresholds.nudeSkinRatio) <= reviewMargin;
  const nearSuggestive =
    Math.abs(coverage.coverageScore - thresholds.suggestiveCoverageMax) <= reviewMargin ||
    Math.abs(skinSummary.skinRatio - thresholds.suggestiveSkinRatio) <= reviewMargin;

  const poseConfidence = clamp(
    torso.torsoPresenceConfidence * 0.7 + torso.hipPresenceConfidence * 0.3,
    0,
    1,
  );

  const needsReviewPose =
    skinSummary.skinRatio >= thresholds.suggestiveSkinRatio &&
    (!hasTorso || !hasHip || limbDominant || offCenter);

  let adultScore = clamp(
    skinSummary.skinRatio * (1 - coverage.coverageScore) * (0.6 + poseConfidence * 0.4) * (limbDominant ? 0.6 : 1),
    0,
    1,
  );
  let suggestiveScore = clamp(
    Math.max(
      skinSummary.skinRatio * 0.7,
      skinSummary.dominantRegionRatio * 0.5,
      poseConfidence * 0.8,
    ) * (limbDominant ? 0.85 : 1),
    0,
    1,
  );

  let needsReview =
    (!adultDecision && !suggestiveDecision && (nearSuggestive || needsReviewPose)) ||
    nearBoundary ||
    (adultDecision && (limbDominant || offCenter));

  let cnnResult: NudityClassifierResult | null = null;
  if (cnnConfig.enabled && skinSummary.dominantRegionRect) {
    try {
      const cv = await waitForOpenCv();
      const expanded = expandRect(
        skinSummary.dominantRegionRect,
        working.cols,
        working.rows,
        clamp(cnnConfig.cropExpansion, 0, 0.5),
      );
      const roi = working.roi(new cv.Rect(expanded.x, expanded.y, expanded.width, expanded.height));
      try {
        cnnResult = await runNudityClassifier(roi);
      } finally {
        roi.delete();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`NSFW swimwear classifier inference failed: ${(error as Error).message}`);
    }
  }

  if (cnnResult) {
    flags.push('CNN_APPLIED');
    const providerFlag = cnnResult.provider.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
    if (providerFlag) {
      flags.push(`CNN_PROVIDER_${providerFlag}`);
    }

    const cnnThresholds = cnnConfig.thresholds;
    if (cnnResult.delta >= cnnThresholds.nudeDelta) {
      flags.push('CNN_NUDE_DELTA');
    }
    if (cnnResult.swimwear >= cnnThresholds.swimwearMin) {
      flags.push('CNN_SWIMWEAR_CONFIDENT');
    }
    if (cnnResult.ambiguous >= cnnThresholds.ambiguousDelta) {
      flags.push('CNN_AMBIGUOUS');
    }

    const highSkin = skinSummary.skinRatio >= thresholds.nudeSkinRatio;
    const lowCoverage = coverage.coverageScore <= thresholds.nudeCoverageMax;

    if (highSkin && lowCoverage && cnnResult.delta >= cnnThresholds.nudeDelta) {
      adultDecision = true;
      suggestiveDecision = false;
    } else if (cnnResult.swimwear >= cnnThresholds.swimwearMin) {
      adultDecision = false;
      suggestiveDecision = true;
    } else if (!adultDecision && !suggestiveDecision && cnnResult.delta >= cnnThresholds.reviewDelta) {
      suggestiveDecision = true;
    }

    const cnnAdultScore = clamp(cnnResult.nude * 0.7 + Math.max(0, cnnResult.delta) * 0.5, 0, 1);
    adultScore = clamp(adultScore * 0.55 + cnnAdultScore * 0.45, 0, 1);

    const cnnSuggestiveScore = clamp(
      cnnResult.swimwear * 0.7 + Math.max(0, -cnnResult.delta) * 0.4 + cnnResult.ambiguous * 0.15,
      0,
      1,
    );
    suggestiveScore = clamp(suggestiveScore * 0.6 + cnnSuggestiveScore * 0.4, 0, 1);

    if (cnnResult.ambiguous >= cnnThresholds.ambiguousDelta) {
      adultScore = clamp(adultScore * 0.9, 0, 1);
      needsReview = true;
    }

    if (!needsReview) {
      const nearDelta = Math.abs(cnnResult.delta) <= cnnThresholds.reviewDelta;
      if (nearDelta) {
        needsReview = true;
      }
    }
  }

  const result: ImageAnalysisResult = {
    width: working.cols,
    height: working.rows,
    skinPixels: skinSummary.skinPixelCount,
    totalPixels: skinSummary.totalPixelCount,
    skinRatio: roundTo(skinSummary.skinRatio, 4),
    dominantSkinRatio: roundTo(skinSummary.dominantRegionRatio, 4),
    coverageScore: roundTo(coverage.coverageScore, 4),
    edgeDensity: roundTo(coverage.edgeDensity, 4),
    colorStdDev: roundTo(coverage.colorStdDev, 4),
    decisions: {
      isAdult: adultDecision,
      isSuggestive: suggestiveDecision,
      needsReview,
    },
    scores: {
      adult: roundTo(adultScore, 4),
      suggestive: roundTo(suggestiveScore, 4),
    },
    flags,
  };

  if (cnnResult) {
    result.cnn = {
      nude: roundTo(cnnResult.nude, 4),
      swimwear: roundTo(cnnResult.swimwear, 4),
      ambiguous: roundTo(cnnResult.ambiguous, 4),
      delta: roundTo(cnnResult.delta, 4),
      provider: cnnResult.provider,
      inferenceMs: Math.max(0, Math.round(cnnResult.inferenceMs)),
    };
  }

  if (skinSummary.dominantRegionRect && skinSummary.centroid) {
    result.region = {
      x: skinSummary.dominantRegionRect.x,
      y: skinSummary.dominantRegionRect.y,
      width: skinSummary.dominantRegionRect.width,
      height: skinSummary.dominantRegionRect.height,
      centroidX: roundTo(skinSummary.centroid.x, 2),
      centroidY: roundTo(skinSummary.centroid.y, 2),
    };
  }

  result.pose = {
    torsoCoverage: roundTo(torso.torsoCoverage, 4),
    hipCoverage: roundTo(torso.hipCoverage, 4),
    shoulderCoverage: roundTo(torso.shoulderCoverage, 4),
    torsoPresenceConfidence: roundTo(torso.torsoPresenceConfidence, 4),
    hipPresenceConfidence: roundTo(torso.hipPresenceConfidence, 4),
    limbDominanceConfidence: roundTo(torso.limbDominanceConfidence, 4),
    offCenterDistance: roundTo(torso.offCenterDistance, 4),
    torsoContinuity: roundTo(torso.torsoContinuity, 4),
    overallCentralCoverage: roundTo(torso.overallCentralCoverage, 4),
  };

  disposeAll([skinMask, working]);

  return result;
};

