// Public, read-only endpoint verification. No account credentials are needed.
import {verifyQuickBooksDiscovery} from "../api/_lib/quickbooks.mjs";
try {
  const results=await Promise.all(["sandbox","production"].map(environment=>verifyQuickBooksDiscovery({environment})));
  console.log(JSON.stringify({verified:true,results},null,2));
} catch {
  console.error("Intuit discovery verification failed. Review the official endpoints before authorizing a connection.");
  process.exitCode=1;
}
