import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedirectHandler, redirectOrigin } from "./server.mjs";

const destination = "https://twilio-comics.kindriver-a0456aa8.eastus2.azurecontainerapps.io";
const handle = createRedirectHandler(destination);

function send(method, url) {
  const result = {};
  handle({ method, url }, {
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
    },
    end(body = "") {
      result.body = body;
    },
  });
  return result;
}

test("requires a plain HTTPS destination origin", () => {
  assert.equal(redirectOrigin(destination + "/"), destination);
  for (const invalid of [undefined, "http://example.com", "https://user:pass@example.com", "https://example.com/story", "https://example.com/?x=1", "https://example.com/#x"]) {
    assert.throws(() => redirectOrigin(invalid));
  }
});

test("redirects old story links and preserves path and query", () => {
  const response = send("GET", "/story/example?source=sms&n=1");
  assert.equal(response.status, 308);
  assert.equal(response.headers.location, `${destination}/story/example?source=sms&n=1`);
  assert.equal(response.body, "");
});

test("keeps the fixed destination host for network-path-like URLs", () => {
  const response = send("GET", "//evil.example/story?x=1");
  assert.equal(response.status, 308);
  assert.equal(new URL(response.headers.location).origin, destination);
  assert.equal(response.headers.location, `${destination}//evil.example/story?x=1`);
});

test("redirects unsafe methods temporarily, preserving their method", () => {
  const response = send("POST", "/api/twilio/sms?attempt=2");
  assert.equal(response.status, 307);
  assert.equal(response.headers.location, `${destination}/api/twilio/sms?attempt=2`);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("answers existing readiness and health probes locally", () => {
  for (const path of ["/api/readyz", "/api/healthz"]) {
    const response = send("GET", path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.body, "ok\n");
  }
});
