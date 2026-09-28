export interface ExecutionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface ExecutionMeta {
  providerId: string;
  targetId: string;
  capability: string;
  durationMs: number;
  requestId?: string;
}

export interface ExecutionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ExecutionError;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  truncated?: boolean;
  meta: ExecutionMeta;
}
