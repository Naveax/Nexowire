/** R-04: illustrative synthetic-data helper, never a production redaction gate.
 * No filesystem, network, stdin or device access. Call with an explicitly
 * synthetic envelope. Provenance is caller-declared, not technically provable.
 */
export interface SyntheticSample { kind: 'synthetic'; text: string }
export interface RedactedSample {
  kind: 'synthetic'; text: string; replacements: number;
  warnings: readonly ['MANUAL_REVIEW_REQUIRED'];
}

export function redactSampleLog(sample: SyntheticSample): RedactedSample {
  if (!sample || sample.kind !== 'synthetic' || typeof sample.text !== 'string') {
    throw new TypeError('Only explicitly synthetic text samples are accepted');
  }
  if (sample.text.length > 1_000_000) throw new RangeError('Synthetic sample exceeds limit');
  let replacements = 0;
  let text = sample.text;
  const replace = (pattern: RegExp, value: string) => {
    text = text.replace(pattern, () => { replacements++; return value; });
  };
  // Whole header values, including Basic/custom schemes, not only Bearer.
  replace(/\b(?:proxy-authorization|authorization)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/gi,
    'authorization=[REDACTED]');
  replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|x-api-key|client[_-]?secret|password)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi,
    'secret=[REDACTED]');
  // Quoted paths may contain spaces. Unquoted paths stop at a delimiter.
  replace(/"(?:[A-Za-z]:\\+(?:Users|Documents and Settings)\\+|\/(?:home|Users)\/)[^"\r\n]*"/gi,
    '"[PERSONAL_PATH]"');
  replace(/'(?:[A-Za-z]:\\+(?:Users|Documents and Settings)\\+|\/(?:home|Users)\/)[^'\r\n]*'/gi,
    "'[PERSONAL_PATH]'");
  replace(/[A-Za-z]:\\+(?:Users|Documents and Settings)\\+[^\r\n,;"']+/gi, '[PERSONAL_PATH]');
  replace(/\/(?:home|Users)\/[^\s,;"']+/g, '[PERSONAL_PATH]');
  replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi,
    '[EMAIL]');
  // Always require review: opaque credentials, encodings, UUIDs, custom paths,
  // multiline headers and unknown formats are not exhaustively recognized.
  return {kind: 'synthetic', text, replacements, warnings: ['MANUAL_REVIEW_REQUIRED']};
}
