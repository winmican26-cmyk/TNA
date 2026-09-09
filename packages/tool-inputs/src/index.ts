import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_INPUT_BYTES = 256;

export const demoDeployInput = z.object({
  release: z.string().regex(/^(?:release-[a-z0-9]+(?:\.[a-z0-9]+)*|prod\.deploy\.[a-z0-9]+)$/).max(64),
  environment: z.literal('demo-production'),
}).strict();

export type DemoDeployInput = z.infer<typeof demoDeployInput>;

export type ToolInputSchema = z.ZodType<Record<string, unknown>>;

export type ToolInputMetadata = {
  readonly tool: string;
  readonly action: string;
  readonly operation: string;
  readonly resourceType: string;
  readonly inputSchema: ToolInputSchema;
  readonly runtimeLimitMs: number;
  readonly outputLimitBytes: number;
  readonly networkRequired: boolean;
};

export type ParsedToolInput<T extends Record<string, unknown> = Record<string, unknown>> = {
  readonly input: T;
  readonly canonical: string;
  readonly input_hash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function byteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : MAX_INPUT_BYTES + 1;
  } catch {
    return MAX_INPUT_BYTES + 1;
  }
}

export class ToolInputError extends Error {
  constructor(message = 'Invalid tool input') {
    super(message);
    this.name = 'ToolInputError';
  }
}

export class ToolInputRegistry {
  private readonly tools = new Map<string, ToolInputMetadata>();

  register(metadata: ToolInputMetadata): void {
    if (this.tools.has(metadata.tool)) throw new ToolInputError(`Tool already registered: ${metadata.tool}`);
    if (!Number.isInteger(metadata.runtimeLimitMs) || metadata.runtimeLimitMs <= 0 || !Number.isInteger(metadata.outputLimitBytes) || metadata.outputLimitBytes <= 0) {
      throw new ToolInputError('Invalid tool limits');
    }
    this.tools.set(metadata.tool, Object.freeze({ ...metadata }));
  }

  get(tool: string): ToolInputMetadata | null {
    return this.tools.get(tool) ?? null;
  }

  list(): ToolInputMetadata[] {
    return [...this.tools.values()].sort((left, right) => left.tool.localeCompare(right.tool));
  }

  parseAndHash<T extends Record<string, unknown>>(tool: string, input: unknown): ParsedToolInput<T> {
    const metadata = this.tools.get(tool);
    if (!metadata) throw new ToolInputError('Unknown tool');
    if (byteLength(input) > MAX_INPUT_BYTES) throw new ToolInputError('Tool input is oversized');
    const parsed = metadata.inputSchema.safeParse(input);
    if (!parsed.success) throw new ToolInputError('Invalid tool input');
    const canonicalInput = canonical(parsed.data);
    return { input: parsed.data as T, canonical: canonicalInput, input_hash: createHash('sha256').update(canonicalInput).digest('hex') };
  }

  verifyHash(tool: string, input: unknown, expectedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
    try { return this.parseAndHash(tool, input).input_hash === expectedHash; } catch { return false; }
  }
}

export const demoToolInputMetadata: ToolInputMetadata = {
  tool: 'demo.deploy.execute', action: 'production.deploy', operation: 'write', resourceType: 'infrastructure',
  inputSchema: demoDeployInput as unknown as ToolInputSchema, runtimeLimitMs: 30_000, outputLimitBytes: 64 * 1024, networkRequired: false,
};
