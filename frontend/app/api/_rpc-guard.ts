const WINDOW_MS = 10 * 60 * 1000;

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

function readHeader(headers: Record<string, string | string[] | undefined>, key: string) {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export function getClientKey(headers: Record<string, string | string[] | undefined>) {
  const forwardedFor = readHeader(headers, "x-forwarded-for");
  const forwarded = forwardedFor?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  const realIp = readHeader(headers, "x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}

export function limitRpcRoute(
  headers: Record<string, string | string[] | undefined>,
  limit: number,
) {
  const now = Date.now();
  const key = getClientKey(headers);
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + WINDOW_MS };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
}

