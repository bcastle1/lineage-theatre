import dns from "node:dns/promises";
import https from "node:https";
import http from "node:http";

const expectedA = new Set([
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
]);

async function resolveA(hostname) {
  try {
    return await dns.resolve4(hostname);
  } catch {
    return [];
  }
}

async function resolveCname(hostname) {
  try {
    return await dns.resolveCname(hostname);
  } catch {
    return [];
  }
}

function request(url) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = client.get(url, { timeout: 12000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, url: res.responseUrl || url, body }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => resolve({ status: 0, url, error: error.message, body: "" }));
  });
}

const apexA = await resolveA("lineagetheater.com");
const wwwCname = await resolveCname("www.lineagetheater.com");
const httpResult = await request("http://lineagetheater.com/");
const httpsResult = await request("https://lineagetheater.com/");
const appMarkers = ["Lineage Theatre", 'id="root"', "assets/index-"];
const hasApp = (body) => appMarkers.every((marker) => body.includes(marker));

const dnsReady = apexA.length === 4 && apexA.every((ip) => expectedA.has(ip));
const wwwReady = wwwCname.some((target) => target.toLowerCase() === "bcastle1.github.io");
const siteReady =
  httpsResult.status === 200 &&
  hasApp(httpsResult.body) &&
  !httpsResult.body.includes("namecheap");

const report = {
  checkedAt: new Date().toISOString(),
  dns: {
    apexA,
    apexMatchesGitHubPages: dnsReady,
    wwwCname,
    wwwMatchesGitHubPages: wwwReady,
  },
  http: {
    status: httpResult.status,
    containsApp: hasApp(httpResult.body),
    containsNamecheapParking: httpResult.body.includes("namecheap"),
  },
  https: {
    status: httpsResult.status,
    error: httpsResult.error,
    containsApp: hasApp(httpsResult.body),
    containsNamecheapParking: httpsResult.body.includes("namecheap"),
  },
  ready: dnsReady && wwwReady && siteReady,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
