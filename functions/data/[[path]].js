const DATA_PREFIX = "peaindex/";
const GENERATION_PATTERN = /^[a-f0-9]{20}$/;
const CATALOG_FILES = new Set(["catalog.json", "catalog.json.gz"]);
const ROOT_SHARDS = new Set(["source-fields.json", "review-adjustments.json", "build-report.json"]);
const SHARD_KINDS = new Set(["gene", "disease", "evidence"]);

function decodeDataPath(request) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/data/")) return null;
  try {
    const parts = pathname.slice("/data/".length).split("/").map(decodeURIComponent);
    if (parts.some((part) => !part || part.startsWith(".") || /[/\\\x00-\x1f\x7f]/.test(part))) return null;
    return parts;
  } catch {
    return null;
  }
}

function isAllowedDataPath(parts) {
  if (parts.length === 1) return CATALOG_FILES.has(parts[0]);
  if (parts.length !== 3 && parts.length !== 4) return false;
  if (parts[0] !== "library" || !GENERATION_PATTERN.test(parts[1])) return false;
  if (parts.length === 3) return ROOT_SHARDS.has(parts[2]);
  return SHARD_KINDS.has(parts[2]) && parts[3].endsWith(".json");
}

function responseHeaders(path, object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", CATALOG_FILES.has(path) ? "no-cache" : "public, max-age=31536000, immutable");
  headers.set("Content-Type", path.endsWith(".gz") ? "application/gzip" : "application/json");
  headers.delete("Content-Encoding");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  return headers;
}

function errorResponse(request, status, message, headers = {}) {
  return new Response(request.method === "HEAD" ? null : `${message}\n`, {
    status,
    headers: {"Cache-Control": "no-store", ...headers},
  });
}

export async function onRequest({request, env}) {
  const parts = decodeDataPath(request);
  if (!parts || !isAllowedDataPath(parts)) return errorResponse(request, 404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(request, 405, "Method not allowed", {Allow: "GET, HEAD"});
  }

  const bucket = env.PEAINDEX_DATA;
  if (!bucket) return errorResponse(request, 500, "Data binding unavailable");
  const path = parts.join("/");
  const key = `${DATA_PREFIX}${path}`;
  const head = request.method === "HEAD";
  const etag = request.headers.get("If-None-Match");
  const options = etag && CATALOG_FILES.has(path)
    ? {onlyIf: new Headers({"If-None-Match": etag})}
    : undefined;
  const object = await (head ? bucket.head(key) : bucket.get(key, options));
  if (!object) return errorResponse(request, 404, "Not found");
  const headers = responseHeaders(path, object);
  if (options && !head && !object.body) {
    headers.delete("Content-Length");
    return new Response(null, {status: 304, headers});
  }
  return new Response(head ? null : object.body, {headers});
}
