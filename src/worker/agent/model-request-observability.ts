import type { ProviderResponse } from '@earendil-works/pi-ai';

export interface ProviderResponseTelemetry {
  status: number;
  headersLatencyMs: number;
  requestId?: string;
  serverTiming?: string;
  upstreamServiceTimeMs?: number;
}

const REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'openai-request-id',
  'x-amzn-requestid',
  'cf-ray',
] as const;

export function captureProviderResponse(
  response: ProviderResponse,
  requestStartTime: number,
): ProviderResponseTelemetry {
  const headers = Object.fromEntries(
    Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const upstreamServiceTime = headers['x-envoy-upstream-service-time'];
  const parsedUpstreamServiceTime = upstreamServiceTime
    ? Number.parseInt(upstreamServiceTime, 10)
    : Number.NaN;

  return {
    status: response.status,
    headersLatencyMs: Date.now() - requestStartTime,
    requestId: REQUEST_ID_HEADERS.map((name) => headers[name]).find(Boolean),
    serverTiming: headers['server-timing'],
    upstreamServiceTimeMs: Number.isFinite(parsedUpstreamServiceTime)
      ? parsedUpstreamServiceTime
      : undefined,
  };
}
