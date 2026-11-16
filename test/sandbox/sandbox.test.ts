import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../../src/sandbox/docker.ts";

const enabled = process.env.BUMPSMITH_DOCKER_TESTS === "1";

describe.skipIf(!enabled)("sandbox isolation (requires Docker)", () => {
  let sb: DockerSandbox;
  beforeAll(async () => {
    process.env.BUMPSMITH_TEST_SECRET = "should-never-appear";
    sb = await DockerSandbox.create({ ecosystem: "npm" });
    const dir = await mkdtemp(join(tmpdir(), "bumpsmith-sb-"));
    await writeFile(join(dir, "hello.txt"), "hi\n");
    await sb.copyIn(dir);
  }, 15 * 60_000);
  afterAll(async () => {
    await sb?.destroy();
  });

  it("runs as an unprivileged user", async () => {
    const r = await sb.exec(["id", "-u"]);
    expect(r.stdout.trim()).toBe("10001");
  });

  it("does not receive host environment variables", async () => {
    const r = await sb.exec(["env"]);
    expect(r.stdout).not.toContain("should-never-appear");
    expect(r.stdout).not.toMatch(/ANTHROPIC|GITHUB_TOKEN|AWS_/);
  });

  it("has no network when detached", async () => {
    const r = await sb.exec(
      [
        "node",
        "-e",
        "fetch('https://example.com').then(()=>console.log('REACHED')).catch(e=>console.log('BLOCKED', e.cause?.code))",
      ],
      { timeoutSec: 30 },
    );
    expect(r.stdout).toContain("BLOCKED");
  });

  it("reaches the registry only through the read-only mirror when attached", async () => {
    const ok = await sb.exec(["npm", "view", "left-pad", "version"], {
      network: true,
      timeoutSec: 120,
    });
    expect(ok.exitCode).toBe(0);
    // Exfiltration via the registry is closed: the mirror refuses anything but GET/HEAD.
    const put = await sb.exec(
      [
        "node",
        "-e",
        "fetch('https://registry.npmjs.org/some-attacker-pkg',{method:'PUT',body:'{}'}).then(r=>console.log('STATUS',r.status)).catch(e=>console.log('ERR',e.cause?.code??e.message))",
      ],
      { network: true, timeoutSec: 60 },
    );
    expect(put.stdout).toContain("STATUS 405");
    const publish = await sb.exec(
      [
        "sh",
        "-c",
        'mkdir -p /tmp/p && cd /tmp/p && printf \'{"name":"bumpsmith-exfil-test-zz","version":"1.0.0"}\' > package.json && npm publish --registry https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=npm_fake 2>&1; echo EXIT $?',
      ],
      { network: true, timeoutSec: 120 },
    );
    expect(publish.stdout).toMatch(/405|E405|read-only/);
    expect(publish.stdout).not.toContain("EXIT 0");
    // Other hosts: no DNS, no route.
    const other = await sb.exec(
      [
        "node",
        "-e",
        "fetch('https://example.com').then(r=>console.log('REACHED',r.status)).catch(e=>console.log('BLOCKED',e.cause?.code??e.message))",
      ],
      { network: true, timeoutSec: 60 },
    );
    expect(other.stdout).toContain("BLOCKED");
    const direct = await sb.exec(
      [
        "node",
        "-e",
        "require('net').connect(443,'1.1.1.1').on('connect',()=>console.log('REACHED')).on('error',e=>console.log('BLOCKED',e.code)).setTimeout(5000,function(){console.log('BLOCKED timeout');this.destroy()})",
      ],
      { network: true, timeoutSec: 30 },
    );
    expect(direct.stdout).toContain("BLOCKED");
    // A registry hostname pinned to the mirror cannot be used to reach another site.
    const sni = await sb.exec(
      [
        "node",
        "-e",
        "require('https').get({host:'registry.npmjs.org',servername:'registry.npmjs.org',path:'/',headers:{host:'example.com'}},r=>console.log('STATUS',r.statusCode)).on('error',e=>console.log('ERR',e.message))",
      ],
      { network: true, timeoutSec: 60 },
    );
    expect(sni.stdout).toContain("STATUS 421");
  }, 300_000);

  it("cannot write outside the workspace", async () => {
    const r = await sb.exec(["sh", "-c", "echo x > /etc/bumpsmith-test || echo DENIED"]);
    expect(r.stdout).toContain("DENIED");
  });

  it("kills commands that exceed the time limit", async () => {
    const r = await sb.exec(["sleep", "30"], { timeoutSec: 2 });
    expect(r.timedOut).toBe(true);
  });

  it("copies files in and out", async () => {
    await sb.exec([
      "sh",
      "-c",
      "echo changed > hello.txt && mkdir -p node_modules/x && echo junk > node_modules/x/a",
    ]);
    const out = await mkdtemp(join(tmpdir(), "bumpsmith-out-"));
    await sb.copyOut(out);
    expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("changed\n");
    await expect(readFile(join(out, "node_modules/x/a"), "utf8")).rejects.toThrow();
  });
  it("limits process count", async () => {
    const r = await sb.exec(
      [
        "sh",
        "-c",
        "n=0; for i in $(seq 1 800); do sleep 2 & n=$((n+1)); done 2>&1 | tail -1; wait; echo DONE",
      ],
      { timeoutSec: 30 },
    );
    expect(r.stdout + r.stderr).toMatch(/fork|Resource temporarily unavailable|Cannot/i);
  }, 60_000);
});
