import { isIP } from "node:net";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Checks a self-hosted server's settings before anything starts. A shared server must be
 * reached over HTTPS: either Bumpsmith terminates TLS itself, or a named reverse proxy does.
 * Plain http is only accepted for a loopback public URL (trying it out on one machine).
 */
export function serverConfig(raw: {
  publicUrl?: string;
  host?: string;
  port?: string;
  tlsCert?: string;
  tlsKey?: string;
  behindProxy?: boolean;
  trustedProxies?: string;
}) {
  if (!raw.publicUrl)
    throw new Error(
      "--public-url is required: the address people open, like https://bumpsmith.acme.dev",
    );
  let u: URL;
  try {
    u = new URL(raw.publicUrl);
  } catch {
    throw new Error(`--public-url is not a URL: ${raw.publicUrl}`);
  }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error("--public-url must be an origin only, like https://bumpsmith.acme.dev");
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
    throw new Error("--public-url must use https (plain http is allowed only for localhost)");
  if (!!raw.tlsCert !== !!raw.tlsKey) throw new Error("--tls-cert and --tls-key go together");
  const tls = raw.tlsCert && raw.tlsKey ? { cert: raw.tlsCert, key: raw.tlsKey } : null;
  if (tls && raw.behindProxy)
    throw new Error("choose one: --tls-cert/--tls-key (Bumpsmith serves HTTPS) or --behind-proxy");
  if (u.protocol === "https:" && !tls && !raw.behindProxy)
    throw new Error(
      "an https public URL needs --tls-cert and --tls-key, or --behind-proxy when a reverse proxy terminates TLS",
    );
  const trustedProxies = raw.behindProxy
    ? (raw.trustedProxies ?? "127.0.0.1,::1")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  for (const ip of trustedProxies)
    if (!isIP(ip)) throw new Error(`--trusted-proxy takes IP addresses; got "${ip}"`);
  const port = Number(raw.port ?? (tls ? 4443 : 4477));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`bad --port: ${raw.port}`);
  return {
    publicUrl: u.origin,
    host: raw.host ?? (raw.behindProxy || loopback ? "127.0.0.1" : "0.0.0.0"),
    port,
    tls,
    trustedProxies,
  };
}
