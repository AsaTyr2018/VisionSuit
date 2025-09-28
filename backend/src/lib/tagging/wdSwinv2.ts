import fsPromises from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import https from 'node:https';

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const MODEL_REPO = 'SmilingWolf/wd-swinv2-tagger-v3';
const MODEL_FILENAME = 'model.onnx';
const LABEL_FILENAME = 'selected_tags.csv';
const GENERAL_THRESHOLD = 0.35;
const CHARACTER_THRESHOLD = 0.85;
const CPU_EXECUTION_PROVIDER = 'cpuExecutionProvider';

const backendRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(backendRoot, '..');
const modelDirectory = resolve(repoRoot, 'cache', 'models', MODEL_REPO);
const modelPath = resolve(modelDirectory, MODEL_FILENAME);
const labelPath = resolve(modelDirectory, LABEL_FILENAME);
const cpuBackendCandidates = [
  resolve(backendRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3'),
  resolve(backendRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v2'),
  resolve(backendRoot, 'node_modules', 'onnxruntime-node', 'build', 'Release'),
];

const isBackendUnavailableError = (error: unknown) =>
  error instanceof Error && /backend not found/i.test(error.message);

const ensureCpuBackendPath = async () => {
  if (process.env.ORT_BACKEND_PATH && process.env.ORT_BACKEND_PATH.trim().length > 0) {
    return;
  }

  for (const candidate of cpuBackendCandidates) {
    try {
      const stats = await fsPromises.stat(candidate);
      if (stats.isDirectory()) {
        process.env.ORT_BACKEND_PATH = candidate;
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(
    [
      '[startup] The ONNX Runtime CPU backend could not be located.',
      'Reinstall `onnxruntime-node` for your platform (e.g. `npm --prefix backend rebuild onnxruntime-node`)',
      'or set the ORT_BACKEND_PATH environment variable to the directory that contains the native bindings.',
    ].join(' '),
  );
};

const KAOMOJIS = new Set([
  '0_0',
  '(o)_(o)',
  '+_+',
  '+_-',
  '._.',
  '<o>_<o>',
  '<|>_<|>',
  '=_=',
  '>_<',
  '3_3',
  '6_9',
  '>_o',
  '@_@',
  '^_^',
  'o_o',
  'u_u',
  'x_x',
  '|_|',
  '||_||',
]);

const sanitizeTagName = (value: string) => (KAOMOJIS.has(value) ? value : value.replace(/_/g, ' '));

const ensureFileExists = async (targetPath: string) => {
  try {
    const stats = await fsPromises.stat(targetPath);
    if (stats.size > 0) {
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  return false;
};

const downloadFile = async (url: string, targetPath: string): Promise<void> => {
  await fsPromises.mkdir(dirname(targetPath), { recursive: true });

  const tempPath = `${targetPath}.download`;
  await fsPromises.rm(tempPath, { force: true });

  const result = await new Promise<'downloaded' | 'redirected'>((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (!response.statusCode) {
        reject(new Error(`Failed to download ${url}: no status code`));
        return;
      }

      const redirectedLocation = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && redirectedLocation) {
        response.resume();
        const redirectedUrl = (() => {
          try {
            return new URL(redirectedLocation, url).toString();
          } catch (error) {
            reject(new Error(`Failed to resolve redirect for ${url}: ${(error as Error).message}`));
            return null;
          }
        })();

        if (!redirectedUrl) {
          return;
        }

        downloadFile(redirectedUrl, targetPath)
          .then(() => resolve('redirected'))
          .catch(reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }

      const writeStream = createWriteStream(tempPath);
      writeStream.on('error', reject);
      response.on('error', reject);
      writeStream.on('finish', () => resolve('downloaded'));
      response.pipe(writeStream);
    });

    request.on('error', reject);
  });

  if (result === 'downloaded') {
    await fsPromises.rename(tempPath, targetPath);
  }
};

const ensureModelAsset = async (filename: string) => {
  const targetPath = filename === MODEL_FILENAME ? modelPath : labelPath;
  const exists = await ensureFileExists(targetPath);
  if (exists) {
    return targetPath;
  }

  const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${filename}`;
  // eslint-disable-next-line no-console
  console.info(`[startup] Downloading ${filename} from ${MODEL_REPO}...`);
  await downloadFile(url, targetPath);
  // eslint-disable-next-line no-console
  console.info(`[startup] Downloaded ${filename} to ${targetPath}`);
  return targetPath;
};

type NumericDimension = number | null | undefined;

const normalizeDimension = (value: NumericDimension, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

interface TagDefinition {
  name: string;
  category: number;
}

const loadTagDefinitions = async (): Promise<TagDefinition[]> => {
  const file = await fsPromises.readFile(await ensureModelAsset(LABEL_FILENAME), 'utf-8');
  const lines = file.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return [];
  }

  const [, ...rows] = lines;
  const tags: TagDefinition[] = [];

  for (const row of rows) {
    const parts = row.split(',');
    if (parts.length < 3) {
      continue;
    }
    const rawName = parts[1]?.trim();
    const category = Number.parseInt(parts[2]?.trim() ?? '', 10);
    if (!rawName || Number.isNaN(category)) {
      continue;
    }
    tags.push({ name: sanitizeTagName(rawName), category });
  }

  return tags;
};

export interface AutoTagScore {
  label: string;
  score: number;
}

export interface AutoTagSummary {
  general: AutoTagScore[];
  characters: AutoTagScore[];
  ratings: Record<string, number>;
  thresholds: {
    general: number;
    character: number;
  };
}

export class WdSwinv2Tagger {
  private session: ort.InferenceSession | null = null;

  private inputName: string | null = null;

  private outputName: string | null = null;

  private inputShape: number[] = [1, 448, 448, 3];

  private channelsFirst = false;

  private tagDefinitions: TagDefinition[] = [];

  private initializationPromise: Promise<void> | null = null;

  private ortRuntime: typeof ort = ort;

  private async createSession() {
    await ensureCpuBackendPath();

    const availableProviders = this.ortRuntime.getAvailableExecutionProviders?.() ?? [];

    if (Array.isArray(availableProviders) && !availableProviders.includes(CPU_EXECUTION_PROVIDER)) {
      throw new Error(
        [
          '[startup] The ONNX Runtime CPU execution provider is unavailable even though the native backend was located.',
          'Please reinstall `onnxruntime-node` for your operating system or ensure the Node.js version matches the package binary.',
        ].join(' '),
      );
    }

    try {
      this.session = await this.ortRuntime.InferenceSession.create(modelPath, {
        executionProviders: [CPU_EXECUTION_PROVIDER],
      });
    } catch (error) {
      if (isBackendUnavailableError(error)) {
        throw new Error(
          [
            '[startup] Failed to start the wd-swinv2 auto tagger because the ONNX Runtime CPU backend rejected the initialization.',
            'Reinstall the backend dependencies (`npm --prefix backend rebuild onnxruntime-node`) or set ORT_BACKEND_PATH to the directory with the native binaries.',
          ].join(' '),
        );
      }

      throw error;
    }
  }

  public async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      await Promise.all([ensureModelAsset(MODEL_FILENAME), ensureModelAsset(LABEL_FILENAME)]);
      this.tagDefinitions = await loadTagDefinitions();

      await this.createSession();

      const inputName = this.session.inputNames[0];
      const outputName = this.session.outputNames[0];
      this.inputName = inputName;
      this.outputName = outputName;

      const inputMetadata = this.session.inputMetadata[inputName];
      const dims = inputMetadata?.dimensions ?? [];
      const fallbackSize = 448;

      if (dims.length === 4) {
        if (normalizeDimension(dims[1], 0) === 3) {
          this.channelsFirst = true;
          const height = normalizeDimension(dims[2], fallbackSize);
          this.inputShape = [1, 3, height, normalizeDimension(dims[3], height)];
        } else {
          this.channelsFirst = false;
          const height = normalizeDimension(dims[1], fallbackSize);
          this.inputShape = [1, height, normalizeDimension(dims[2], height), 3];
        }
      } else {
        this.channelsFirst = false;
        this.inputShape = [1, fallbackSize, fallbackSize, 3];
      }
    })();

    return this.initializationPromise;
  }

  private ensureReady() {
    if (!this.session || !this.inputName || !this.outputName) {
      throw new Error('Tagger is not initialized');
    }
  }

  private getTargetSize() {
    return this.channelsFirst ? this.inputShape[2] : this.inputShape[1];
  }

  private async preprocess(buffer: Buffer) {
    this.ensureReady();
    const targetSize = this.getTargetSize();

    const { data } = await sharp(buffer)
      .rotate()
      .resize(targetSize, targetSize, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixelCount = targetSize * targetSize;
    const tensorData = new Float32Array(pixelCount * 3);

    if (this.channelsFirst) {
      for (let index = 0; index < pixelCount; index += 1) {
        const base = index * 3;
        tensorData[index] = data[base + 2];
        tensorData[index + pixelCount] = data[base + 1];
        tensorData[index + pixelCount * 2] = data[base];
      }
    } else {
      for (let index = 0; index < pixelCount; index += 1) {
        const base = index * 3;
        tensorData[base] = data[base + 2];
        tensorData[base + 1] = data[base + 1];
        tensorData[base + 2] = data[base];
      }
    }

    return new this.ortRuntime.Tensor('float32', tensorData, this.inputShape);
  }

  private postprocess(rawScores: Float32Array): AutoTagSummary {
    const ratings: Record<string, number> = {};
    const general: AutoTagScore[] = [];
    const characters: AutoTagScore[] = [];

    for (let index = 0; index < this.tagDefinitions.length && index < rawScores.length; index += 1) {
      const tag = this.tagDefinitions[index];
      const score = rawScores[index];
      if (!tag) {
        continue;
      }

      if (tag.category === 9) {
        ratings[tag.name] = score;
      } else if (tag.category === 0 && score >= GENERAL_THRESHOLD) {
        general.push({ label: tag.name, score });
      } else if (tag.category === 4 && score >= CHARACTER_THRESHOLD) {
        characters.push({ label: tag.name, score });
      }
    }

    general.sort((a, b) => b.score - a.score);
    characters.sort((a, b) => b.score - a.score);

    return {
      general,
      characters,
      ratings,
      thresholds: {
        general: GENERAL_THRESHOLD,
        character: CHARACTER_THRESHOLD,
      },
    };
  }

  public async tag(buffer: Buffer): Promise<AutoTagSummary> {
    await this.initialize();
    this.ensureReady();

    const tensor = await this.preprocess(buffer);
    const feeds: Record<string, ort.Tensor> = {
      [this.inputName as string]: tensor,
    };

    const results = await this.session!.run(feeds);
    const output = results[this.outputName as string];
    if (!output) {
      throw new Error('Tagger returned no outputs');
    }

    const scores = output.data as Float32Array;
    if (!scores || scores.length === 0) {
      throw new Error('Tagger produced empty scores');
    }

    return this.postprocess(scores);
  }
}

export const ensureWdSwinv2Assets = async () => {
  await Promise.all([ensureModelAsset(MODEL_FILENAME), ensureModelAsset(LABEL_FILENAME)]);
};
