/**
 * Pure helpers used to produce safe, non-sensitive HTTP error diagnostics for
 * chatbot integrations (Evolution Bot, N8N, etc).
 */

/**
 * Serializes a remote response body for logging, truncating it and redacting
 * anything that may look like a credential (apiKey, token, authorization, ...).
 */
export function sanitizeResponseBody(data: unknown): string {
  if (data === undefined || data === null) return '(empty)';

  let text: string;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    text = '[unserializable]';
  }

  text = text.replace(
    /("?(?:apiKey|api_key|token|authorization|password|secret)"?\s*[:=]\s*"?)[^",}\s]+/gi,
    '$1[REDACTED]',
  );

  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/**
 * Classifies an axios-like error into a human readable, non-sensitive message
 * that distinguishes configuration errors (404/401/403) from network failures.
 */
export function describeRemoteHttpError(error: any): string {
  const status = error?.response?.status;
  const statusText = error?.response?.statusText;

  if (status === 404) {
    return 'status=404 -> endpoint/path not found. Verify the "apiUrl" configured for this bot points to the correct endpoint.';
  }

  if (status === 401) {
    return 'status=401 -> unauthorized. Verify the bot "apiKey".';
  }

  if (status === 403) {
    return 'status=403 -> forbidden. The bot endpoint rejected this request.';
  }

  if (status) {
    return `status=${status} ${statusText ?? ''} response=${sanitizeResponseBody(error?.response?.data)}`.trim();
  }

  if (error?.code) {
    return `networkError=${error.code} message=${error?.message}`;
  }

  return `error=${error?.message ?? String(error)}`;
}
