export type AgentCacheStrategy = 'persistent' | 'ephemeral';

export interface AgentAssetRef {
  bucket: string;
  key: string;
  cacheStrategy?: AgentCacheStrategy;
  checksum?: string | null;
}

export interface AgentWorkflowRef {
  id: string;
  version?: string | null;
  bucket?: string | null;
  minioKey?: string | null;
  localPath?: string | null;
  inline?: unknown;
}

export interface AgentOutputSpec {
  bucket: string;
  prefix: string;
}

export interface AgentWorkflowMutation {
  node: number;
  path: string;
  value: unknown;
}

export interface AgentWorkflowParameterBinding {
  parameter: string;
  node: number;
  path: string;
}

export interface AgentCallbackConfig {
  status?: string;
  completion?: string;
  failure?: string;
}

export interface AgentResolution {
  width: number;
  height: number;
}

export interface AgentJobParameters {
  prompt: string;
  negativePrompt?: string | null;
  seed?: number | null;
  cfgScale?: number | null;
  steps?: number | null;
  resolution?: AgentResolution;
  extra?: Record<string, unknown>;
}

export interface AgentDispatchEnvelope {
  jobId: string;
  user: {
    id: string;
    username: string;
  };
  workflow: AgentWorkflowRef;
  baseModel: AgentAssetRef;
  loras: AgentAssetRef[];
  parameters: AgentJobParameters;
  output: AgentOutputSpec;
  priority?: string | null;
  requestedAt?: string | null;
  workflowOverrides?: AgentWorkflowMutation[];
  workflowParameters?: AgentWorkflowParameterBinding[];
  callbacks?: AgentCallbackConfig;
}

export interface AgentHealthPayload {
  status: string;
  busy: boolean;
  raw?: unknown;
}

export type SubmitJobStatus = 'accepted' | 'busy';

export interface SubmitJobResult {
  status: SubmitJobStatus;
  response?: unknown;
  statusCode: number;
}

export class AgentRequestError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly responseBody?: string) {
    super(message);
    this.name = 'AgentRequestError';
  }
}

export class GeneratorAgentClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
      throw new Error('GPU agent base URL must not be empty.');
    }

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    this.baseUrl = withScheme.replace(/\/+$/, '');
  }

  private buildUrl(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  private async performRequest(path: string, init: RequestInit): Promise<{ statusCode: number; bodyText: string }> {
    const target = this.buildUrl(path);

    try {
      const response = await fetch(target, init);
      const bodyText = await response.text();
      return {
        statusCode: response.status,
        bodyText,
      };
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new AgentRequestError(`Failed to reach GPU agent at ${target}.`, undefined, details);
    }
  }

  async getHealth(): Promise<AgentHealthPayload> {
    const { statusCode, bodyText } = await this.performRequest('/healthz', {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
    });

    let payload: unknown = null;

    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
      } catch (error) {
        throw new AgentRequestError('GPU agent health endpoint returned invalid JSON.', statusCode, bodyText);
      }
    }

    if (statusCode >= 200 && statusCode < 300 && payload && typeof payload === 'object') {
      const record = payload as { status?: unknown; busy?: unknown };
      return {
        status: typeof record.status === 'string' ? record.status : 'ok',
        busy: Boolean(record.busy),
        raw: payload,
      };
    }

    throw new AgentRequestError(
      `GPU agent health check failed with status ${statusCode}.`,
      statusCode,
      bodyText ?? undefined,
    );
  }

  async submitJob(payload: AgentDispatchEnvelope): Promise<SubmitJobResult> {
    const { statusCode, bodyText } = await this.performRequest('/jobs', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let parsed: unknown = null;

    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch (error) {
        // Leave parsed as null; body may be empty or non-JSON.
      }
    }

    if (statusCode === 202) {
      return { status: 'accepted', response: parsed ?? bodyText, statusCode };
    }

    if (statusCode === 409) {
      return { status: 'busy', response: parsed ?? bodyText, statusCode };
    }

    throw new AgentRequestError(
      `GPU agent rejected job submission with status ${statusCode}.`,
      statusCode,
      bodyText ?? undefined,
    );
  }
}

