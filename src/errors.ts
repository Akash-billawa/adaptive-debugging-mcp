/** Machine-readable error categories shared by every tool (see Tool Catalogue §4.3). */

export const ErrorCategory = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  STORAGE_ERROR: "STORAGE_ERROR",
  CAPTURE_INCOMPLETE: "CAPTURE_INCOMPLETE",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/** Error thrown by tool/domain logic. Must never leak secrets. */
export class McpError extends Error {
  category: ErrorCategory;
  details?: Record<string, unknown>;
  constructor(category: ErrorCategory, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpError";
    this.category = category;
    this.details = details;
  }

  toJSON() {
    return { category: this.category, message: this.message, details: this.details ?? {} };
  }
}

export function notFound(message: string, details?: Record<string, unknown>) {
  return new McpError(ErrorCategory.NOT_FOUND, message, details);
}
export function validationError(message: string, details?: Record<string, unknown>) {
  return new McpError(ErrorCategory.VALIDATION_ERROR, message, details);
}
export function conflict(message: string, details?: Record<string, unknown>) {
  return new McpError(ErrorCategory.CONFLICT, message, details);
}
export function storageError(message: string, details?: Record<string, unknown>) {
  return new McpError(ErrorCategory.STORAGE_ERROR, message, details);
}
