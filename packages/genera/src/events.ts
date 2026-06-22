/**
 * Observability seam (plan Phase 5). A `Disk` emits these around each operation so
 * apps can wire logging, metrics, and tracing without the driver knowing about it.
 */

export interface OperationEvent {
  /** The operation name, e.g. "put" | "get" | "list" | "copy". */
  operation: string;
  /** The user-facing path the operation targeted, when applicable. */
  path?: string | undefined;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface OperationErrorEvent extends OperationEvent {
  error: unknown;
}

export interface RetryEvent {
  operation: string;
  path?: string | undefined;
  /** 1-based attempt number that failed and triggered the retry. */
  attempt: number;
  error: unknown;
  /** Milliseconds waited before the next attempt. */
  delayMs: number;
}

/** Hooks invoked by a `Disk`. All optional; throwing inside a hook is the caller's concern. */
export interface StorageEvents {
  onSuccess?(event: OperationEvent): void;
  onError?(event: OperationErrorEvent): void;
  onRetry?(event: RetryEvent): void;
}
