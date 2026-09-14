// Local test driver ONLY. Never accepts card input, environment URLs, or credentials.
// Default: offline preview. --check-cors: OPTIONS only. --tokenize: explicitly
// create one sandbox token for Intuit's fabricated Visa test card; never charge it.
// Source: IntuitDeveloper/SampleApp-Dotnet_Payments, Default.aspx.cs;
// intuit/PHP-Payments-SDK, tests/ChargeTest.php and src/Operations/TokenOperations.php.
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
const endpoint="https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens";
const origin="https://lineagetheater.com";
const testCard=now=>({name:"emulate=0",number:"4111111111111111",expMonth:"12",expYear:String(new Date(now).getUTCFullYear()+2),cvc:"123",
  address:{streetAddress:"1130 Kifer Rd",city:"Sunnyvale",region:"CA",country:"US",postalCode:"94086"}});
export async function checkSandboxTokenCors({fetchImpl=fetch}={}) {
  const response=await fetchImpl(endpoint,{method:"OPTIONS",redirect:"error",signal:AbortSignal.timeout(10_000),
    headers:{Origin:origin,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type,request-id"}});
  const allowedOrigin=response.headers.get("access-control-allow-origin");
  const methods=(response.headers.get("access-control-allow-methods")||"").toUpperCase().split(/\s*,\s*/);
  const headers=(response.headers.get("access-control-allow-headers")||"").toLowerCase().split(/\s*,\s*/);
  return {checkedAt:new Date().toISOString(),status:response.status,origin,preflightAllowed:response.ok&&(allowedOrigin===origin||allowedOrigin==="*")&&methods.includes("POST")&&headers.includes("content-type")&&headers.includes("request-id"),
    actualBrowserTokenizationVerified:false,notice:"A successful preflight does not establish a hosted card form or PCI compliance."};
}
export async function tokenizeSandboxFixture({fetchImpl=fetch,now=Date.now}={}) {
  const response=await fetchImpl(endpoint,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),
    headers:{"Content-Type":"application/json",Accept:"application/json","Request-Id":randomUUID()},body:JSON.stringify({card:testCard(now())})});
  if(![200,201].includes(response.status))throw new Error("The fabricated sandbox card could not be tokenized.");
  const raw=await response.text();if(raw.length>4096)throw new Error("The sandbox token reply could not be verified.");
  let data;try{data=JSON.parse(raw);}catch{throw new Error("The sandbox token reply could not be verified.");}
  if(typeof data.value!=="string"||data.value.length<8||data.value.length>2048||!/^[A-Za-z0-9_.=-]+$/.test(data.value))throw new Error("The sandbox token reply could not be verified.");
  // Returned only to an explicit in-process sandbox test caller, never logged or persisted.
  return data.value;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const flags=process.argv.slice(2);
  if(flags.some(flag=>!["--check-cors","--tokenize"].includes(flag))) {
    console.error("Allowed options: --check-cors or --tokenize. Card input and credentials are not accepted.");process.exitCode=1;
  } else try {
    if(flags.includes("--check-cors"))console.log(JSON.stringify(await checkSandboxTokenCors(),null,2));
    if(flags.includes("--tokenize")) {
      await tokenizeSandboxFixture();
      console.log(JSON.stringify({environment:"sandbox",fixture:"Intuit fabricated Visa test card",tokenReceived:true,tokenStored:false,charged:false}));
    }
    if(!flags.length)console.log(JSON.stringify({mode:"offline",environment:"sandbox",fixture:"Intuit fabricated Visa test card",networkRequests:0,charged:false,
      usage:"--check-cors performs OPTIONS only; --tokenize explicitly creates one fabricated sandbox token and discards it. No payment or refund is submitted."},null,2));
  } catch {
    console.error("Sandbox test did not complete. No charge was attempted and no token or card response was logged.");process.exitCode=1;
  }
}
