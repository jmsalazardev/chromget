import https from "node:https";
import http, { type IncomingMessage } from "node:http";

/**
 * Promise-based HTTP(S) request wrapper that handles timeouts and follows up to 10 redirects.
 */
export function httpRequest(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 60_000,
  method = "GET",
  redirectCount = 0,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      return reject(new Error("Too many redirects"));
    }

    const isHttps = url.startsWith("https");
    const client = isHttps ? https : http;

    const req = client.request(url, { method, headers }, (res) => {
      const { statusCode } = res;
      if (
        statusCode &&
        statusCode >= 300 &&
        statusCode < 400 &&
        res.headers.location
      ) {
        res.resume(); // Consume the stream
        const nextUrl = new URL(res.headers.location, url).toString();
        resolve(
          httpRequest(nextUrl, headers, timeoutMs, method, redirectCount + 1),
        );
        return;
      }
      resolve(res);
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.end();
  });
}

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Fetch a JSON payload from a URL.
 */
export async function getJson<T>(url: string, timeoutMs = 60_000): Promise<T> {
  const res = await httpRequest(
    url,
    { "User-Agent": BROWSER_USER_AGENT },
    timeoutMs,
    "GET",
  );
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} while requesting ${url}`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/**
 * Fetch a text payload from a URL.
 */
export async function getText(url: string, timeoutMs = 60_000): Promise<string> {
  const res = await httpRequest(
    url,
    { "User-Agent": BROWSER_USER_AGENT },
    timeoutMs,
    "GET",
  );
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} while requesting ${url}`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}


/**
 * Verify if a URL is online using a HEAD request, falling back to GET with Range,
 * and finally a plain GET for servers that block HEAD/Range (e.g. Slimjet returns 503).
 */
export async function checkUrl(
  url: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  // 1. HEAD request
  try {
    const res = await httpRequest(
      url,
      { "User-Agent": BROWSER_USER_AGENT },
      timeoutMs,
      "HEAD",
    );
    res.resume();
    const status = res.statusCode ?? 500;
    if (status >= 200 && status < 400) {
      return true;
    }
  } catch {
    // Ignore and fall back
  }

  // 2. GET with Range
  try {
    const res = await httpRequest(
      url,
      { 
        "User-Agent": BROWSER_USER_AGENT,
        "Range": "bytes=0-0"
      },
      timeoutMs,
      "GET",
    );
    const status = res.statusCode ?? 500;
    res.destroy();
    if (status === 200 || status === 206) {
      return true;
    }
    // If not 503, it's a real error - return false
    if (status !== 503) {
      return false;
    }
  } catch {
    // Ignore and fall back
  }

  // 3. Plain GET (for servers that block HEAD/Range like Slimjet)
  try {
    const res = await httpRequest(
      url,
      { "User-Agent": BROWSER_USER_AGENT },
      timeoutMs,
      "GET",
    );
    const status = res.statusCode ?? 500;
    res.destroy();
    return status >= 200 && status < 400;
  } catch {
    return false;
  }
}

