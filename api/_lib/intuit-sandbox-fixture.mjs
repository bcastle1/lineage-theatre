// Only the published Intuit fictional fixture is accepted here. No caller-supplied card or URL.
// https://github.com/intuit/PHP-Payments-SDK/blob/master/tests/ChargeTest.php
import {randomUUID} from "node:crypto";
const endpoint="https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens";
const testCard=now=>({name:"emulate=0",number:"4111111111111111",expMonth:"12",expYear:String(new Date(now).getUTCFullYear()+2),cvc:"123",
  address:{streetAddress:"1130 Kifer Rd",city:"Sunnyvale",region:"CA",country:"US",postalCode:"94086"}});
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
