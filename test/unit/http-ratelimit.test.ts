import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchText } from "../../src/util/http.ts";

describe("rate limits", () => {
  let base = "";
  let server: http.Server;
  let shortHits = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/long") {
        // GitHub's unauthenticated quota: resets in about an hour.
        res.writeHead(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        });
        return res.end("API rate limit exceeded");
      }
      if (req.url === "/short") {
        shortHits++;
        if (shortHits === 1) {
          res.writeHead(429, { "retry-after": "1" });
          return res.end("slow down");
        }
        return res.end("ok");
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("fails fast instead of sitting through a long reset", async () => {
    const t = Date.now();
    await expect(fetchText(`${base}/long`)).rejects.toThrow(/rate limited for \d+s/);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("waits out a short limit and retries", async () => {
    expect(await fetchText(`${base}/short`)).toBe("ok");
    expect(shortHits).toBe(2);
  });
});
