/** Stable, driver-agnostic error codes. Match on `error.code`, not on messages. */
export type StorageErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "OPERATION_NOT_SUPPORTED"
  | "INVALID_PATH"
  | "AUTH"
  | "PERMISSION"
  | "DRIVER_MISMATCH"
  | "UNKNOWN";

/** Base class for every error thrown by Genera. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(message: string, code: StorageErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
    // Preserve `instanceof` across the transpilation target.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends StorageError {
  constructor(message = "Resource not found", options?: ErrorOptions) {
    super(message, "NOT_FOUND", options);
    this.name = "NotFoundError";
  }
}

export class AlreadyExistsError extends StorageError {
  constructor(message = "Resource already exists", options?: ErrorOptions) {
    super(message, "ALREADY_EXISTS", options);
    this.name = "AlreadyExistsError";
  }
}

export class InvalidPathError extends StorageError {
  constructor(message = "Invalid path", options?: ErrorOptions) {
    super(message, "INVALID_PATH", options);
    this.name = "InvalidPathError";
  }
}

export class AuthError extends StorageError {
  constructor(message = "Authentication failed", options?: ErrorOptions) {
    super(message, "AUTH", options);
    this.name = "AuthError";
  }
}

export class PermissionError extends StorageError {
  constructor(message = "Permission denied", options?: ErrorOptions) {
    super(message, "PERMISSION", options);
    this.name = "PermissionError";
  }
}

export class OperationNotSupportedError extends StorageError {
  /** The capability that was requested but not implemented by the driver. */
  readonly capability: string | undefined;

  constructor(message: string, capability?: string, options?: ErrorOptions) {
    super(message, "OPERATION_NOT_SUPPORTED", options);
    this.name = "OperationNotSupportedError";
    this.capability = capability;
  }
}

export class DriverMismatchError extends StorageError {
  constructor(message = "Driver type mismatch", options?: ErrorOptions) {
    super(message, "DRIVER_MISMATCH", options);
    this.name = "DriverMismatchError";
  }
}
