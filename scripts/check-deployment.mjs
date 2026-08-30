import dns from "node:dns/promises";
import https from "node:https";
import http from "node:http";

const expectedCommit = process.argv[2]?.trim().toLowerCase() || "";

async function resolve(recordType, hostname) {
  try {
    if (recordType === "A") return await dns.resolve4(hostname);
    if (recordType === "CNAME") return await dns.resolveCname(hostname);
    if (recordType === "NS") return await dns.resolveNs(hostname);
  } catch {
    return [];
  }
  return [];
}

function request(url) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = client.get(url, { timeout: 12000, headers: { "user-agent": "lineage-deployment-check/2" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, headers: {}, error: error.message, body: "" }));
  });
}

const [apexA, wwwCname, nameservers, httpResult, httpsResult] = await Promise.all([
  resolve("A", "lineagetheater.com"),
  resolve("CNAME", "www.lineagetheater.com"),
  resolve("NS", "lineagetheater.com"),
  request("http://lineagetheater.com/"),
  request("https://lineagetheater.com/"),
]);

const buildMatch = httpsResult.body.match(/<meta name="lineage-build" content="([^"]+)"/i);
const deployedCommit = buildMatch?.[1]?.toLowerCase() || "";
const namecheapAuthority = nameservers.length > 0 && nameservers.every((server) => server.toLowerCase().endsWith("registrar-servers.com"));
const servedByVercel = String(httpsResult.headers.server || "").toLowerCase() === "vercel";
const hasApp = httpsResult.body.includes("Lineage Theatre") && httpsResult.body.includes('id="root"');
const commitMatches = expectedCommit ? deployedCommit === expectedCommit : Boolean(deployedCommit && deployedCommit !== "local");
const ready = httpsResult.status === 200 && namecheapAuthority && servedByVercel && hasApp && commitMatches;

const report = {
  checkedAt: new Date().toISOString(),
  expectedCommit: expectedCommit || null,
  deployedCommit: deployedCommit || null,
  commitMatches,
  dns: {
    nameservers,
    namecheapAuthority,
    apexA,
    wwwCname,
  },
  http: {
    status: httpResult.status,
    location: httpResult.headers.location || null,
  },
  https: {
    status: httpsResult.status,
    server: httpsResult.headers.server || null,
    error: httpsResult.error,
    containsAppShell: hasApp,
  },
  ready,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = ready ? 0 : 1;
