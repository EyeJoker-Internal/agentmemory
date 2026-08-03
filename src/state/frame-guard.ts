// The pinned iii engine (0.11.2) refuses any WebSocket frame larger than
// tungstenite's 16 MiB default (max_frame_size). A function result or HTTP
// response body that serializes past this dies on the worker->engine hop,
// which drops and re-registers the worker and 404s every endpoint for ~1s
// (issue #1142, and the mesh/export twin #890). We cannot raise the engine
// limit without moving off the pin, so oversized payloads must be refused as
// one clean request instead of being shipped and taking the daemon down.
//
// The cap sits below the frame limit to leave headroom for the SDK's own
// framing/serialization overhead on top of the raw JSON we measure here.
const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
export const SAFE_PAYLOAD_BYTES = 15 * 1024 * 1024;

export type OversizedPayload = {
  success: false;
  error: string;
  oversized: true;
  bytes: number;
  limitBytes: number;
};

export function payloadByteLength(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
}

export function oversizedPayloadError(
  bytes: number,
  hint: string,
): OversizedPayload {
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  return {
    success: false,
    error: `Response is ${mib} MiB, over the ~${SAFE_PAYLOAD_BYTES / (1024 * 1024)} MiB engine transport frame limit; ${hint}`,
    oversized: true,
    bytes,
    limitBytes: SAFE_PAYLOAD_BYTES,
  };
}

// Returns the oversized error when the payload would exceed the safe cap,
// otherwise null. Serializes once; callers that also return the payload pay a
// second serialization, which is acceptable on these cold export paths.
export function checkPayloadFrameSize(
  payload: unknown,
  hint: string,
): OversizedPayload | null {
  const bytes = payloadByteLength(payload);
  if (bytes <= SAFE_PAYLOAD_BYTES) return null;
  return oversizedPayloadError(bytes, hint);
}

export const FRAME_LIMIT_BYTES_FOR_TEST = FRAME_LIMIT_BYTES;
