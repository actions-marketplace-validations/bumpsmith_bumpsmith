import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../../src/sandbox/docker.ts";
import { servicesFromWorkflow } from "../../src/sandbox/services.ts";

const enabled = process.env.BUMPSMITH_DOCKER_TESTS === "1";

const WORKFLOW = `
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/app
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: app
          POSTGRES_PASSWORD: postgres
      redis:
        image: redis:7-alpine
`;

describe.skipIf(!enabled)("CI service sidecars (requires Docker)", () => {
  let sb: DockerSandbox;
  beforeAll(async () => {
    const plan = servicesFromWorkflow(WORKFLOW);
    sb = await DockerSandbox.create({
      ecosystem: "pypi",
      label: "services-test",
      services: plan.services,
      env: plan.env,
    });
  }, 15 * 60_000);
  afterAll(async () => {
    await sb?.destroy();
  });

  it("starts the services and passes the CI env", () => {
    expect(sb.startedServices).toEqual(["postgres:16-alpine", "redis:7-alpine"]);
    expect(sb.failedServices).toEqual([]);
  });

  it("reaches them on localhost and by service name, with the sandbox network detached", async () => {
    const py = [
      "import os, socket",
      "for host, port in [('localhost', 5432), ('postgres', 5432), ('127.0.0.1', 6379), ('redis', 6379)]:",
      "    socket.create_connection((host, port), timeout=5).close()",
      "print('OK', os.environ['DATABASE_URL'])",
    ].join("\n");
    const r = await sb.exec(["python", "-c", py], { timeoutSec: 30 });
    expect(r.stdout).toContain("OK postgres://postgres:postgres@localhost:5432/app");
  });

  it("services add no route out of the sandbox", async () => {
    const r = await sb.exec(
      [
        "python",
        "-c",
        "import socket\ntry:\n  socket.create_connection(('1.1.1.1', 443), timeout=5); print('REACHED')\nexcept OSError: print('BLOCKED')",
      ],
      { timeoutSec: 30 },
    );
    expect(r.stdout.trim()).toBe("BLOCKED");
  });

  it("removes the sidecars with the sandbox", async () => {
    const { run } = await import("../../src/util/proc.ts");
    await sb.destroy();
    const ps = await run("docker", ["ps", "-aq", "--filter", `name=${sb.container}-svc-`]);
    expect(ps.stdout.trim()).toBe("");
  });
});
