/**
 * Map git failures from the core runner onto HTTP responses.
 */
import { GitCommandError, type GitErrorKind } from "#core/git-runner.js";

export type GitHttpStatus = 400 | 409 | 413 | 500 | 502 | 504;

/** HTTP status for a git failure kind (`failed`/unknown → 400). */
export function gitErrorStatus(kind: GitErrorKind | undefined): GitHttpStatus {
  switch (kind) {
    case "not_a_repo":
      return 400;
    case "locked":
      return 409;
    case "auth":
      return 502;
    case "timeout":
      return 504;
    case "output_too_large":
      return 413;
    case "not_found":
    case "aborted":
      return 500;
    default:
      return 400;
  }
}

/** Response body + status for an error thrown by a git helper. */
export function gitErrorResponse(
  err: unknown,
  fallbackMessage: string,
): { body: { error: string; errorKind?: GitErrorKind }; status: GitHttpStatus } {
  if (err instanceof GitCommandError) {
    return { body: { error: err.message, errorKind: err.kind }, status: gitErrorStatus(err.kind) };
  }
  return { body: { error: err instanceof Error ? err.message : fallbackMessage }, status: 400 };
}

/** Status for a `{ success, errorKind }` mutation/remote result. */
export function gitResultStatus(result: {
  success: boolean;
  errorKind?: GitErrorKind;
}): 200 | GitHttpStatus {
  return result.success ? 200 : gitErrorStatus(result.errorKind);
}
