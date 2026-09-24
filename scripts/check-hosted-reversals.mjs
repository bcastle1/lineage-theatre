import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {checkHostedReversals} from "../api/_lib/hosted-reversal-diagnostics.mjs";

export const REQUIRED_ENV=["BLOB_READ_WRITE_TOKEN","QUICKBOOKS_ENVIRONMENT","QUICKBOOKS_CLIENT_ID","QUICKBOOKS_CLIENT_SECRET","QUICKBOOKS_TOKEN_ENCRYPTION_KEY"];
export async function runHostedReversalCheck(args,{env=process.env,check=checkHostedReversals,output=value=>process.stdout.write(`${JSON.stringify(value)}\n`)}={}) {
  if(args.length===1&&args[0]==="--help") {
    output({usage:"node scripts/check-hosted-reversals.mjs --order-id <saved-order-id>",requiredEnvironment:REQUIRED_ENV,
      scope:"Recorded QuickBooks Accounting reversals only; ordinary OAuth refresh is permitted. No payment or generation is initiated."});
    return 0;
  }
  if(args.length!==2||args[0]!=="--order-id"||!/^[a-f0-9]{64}$/.test(args[1])) {
    output({recordedReversalsVerified:false,productionReady:false,code:"USAGE_INVALID"});return 1;
  }
  if(REQUIRED_ENV.some(key=>typeof env[key]!=="string"||!env[key])) {
    output({recordedReversalsVerified:false,productionReady:false,code:"RUNTIME_CONFIGURATION_REQUIRED"});return 1;
  }
  try {
    const result=await check({orderId:args[1],env});output(result);return result.recordedReversalsVerified===true?0:1;
  }catch {
    output({recordedReversalsVerified:false,productionReady:false,code:"RECORDED_REVERSAL_CHECK_FAILED"});return 1;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runHostedReversalCheck(process.argv.slice(2));
