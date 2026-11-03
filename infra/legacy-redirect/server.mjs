import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const HEALTH_PATHS = new Set(["/api/healthz", "/api/readyz"]);

export function redirectOrigin(value) {
  if (!value) {
    throw new Error("REDIRECT_BASE_URL is required");
  }

  const target = new URL(value);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("REDIRECT_BASE_URL must be an HTTPS origin without a path or credentials");
  }

  return target.origin;
}

export function createRedirectHandler(baseUrl) {
  const origin = redirectOrigin(baseUrl);

  return (request, response) => {
    const requestTarget = request.url ?? "/";
    if (
      !requestTarget.startsWith("/") ||
      /[\u0000-\u001f\u007f]/.test(requestTarget)
    ) {
      response.writeHead(400, { "cache-control": "no-store" });
      response.end("Invalid request target\n");
      return;
    }

    const path = requestTarget.split("?", 1)[0];
    if (HEALTH_PATHS.has(path)) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("ok\n");
      return;
    }

    const safeMethod = request.method === "GET" || request.method === "HEAD";
    response.writeHead(safeMethod ? 308 : 307, {
      "cache-control": safeMethod ? "public, max-age=3600" : "no-store",
      location: `${origin}${requestTarget}`,
    });
    response.end();
  };
}

export function createRedirectServer(baseUrl) {
  return createServer(createRedirectHandler(baseUrl));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  createRedirectServer(process.env.REDIRECT_BASE_URL).listen(port, "0.0.0.0", () => {
    console.log(`Legacy redirect listening on port ${port}`);
  });
}
