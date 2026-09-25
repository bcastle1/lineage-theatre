# BROCOTech Private AI Core: Patrick's QuickBooks reads

Patrick uses the existing Lineage Theater production QuickBooks authorization. The private AI runtime receives only a dedicated read-service credential; Intuit credentials and rotating tokens remain in the existing Lineage token manager. The Intuit registration remains Lineage Theater.

`POST /api/patrick-quickbooks` requires `PAC_QUICKBOOKS_READ_KEY` and exposes only the four tools in `api/_lib/quickbooks-finance-contract.mjs`. `PAC_QUICKBOOKS_REALM_ID` pins the intended production company before renewal. Each call verifies the company name through CompanyInfo. The transport's separate finance mode forbids all Accounting writes. Existing checkout transport behavior is unchanged. No browser session substitutes for the service credential.

Provision a cryptographically random 32-byte base64url key as a production-only sensitive Vercel variable and as the Worker's `QBO_LINEAGE_READ_KEY` secret. Never use a public variable, OneDrive document, model prompt, or source file for the key. Do not copy the Intuit secret or refresh token into the Private AI Core.

The daily authenticated Vercel cron checks the connection using the existing serialized refresh manager. It shares the current owner's connection, not a second grant. Revocation, expiry, owner suspension, credential changes, uncertain refresh, and company changes fail closed. Intuit can still require administrator reconnection. Query results explicitly include paging; reports require dates and Cash/Accrual basis. Oversized responses fail rather than silently truncate financial data.

Before release, run the full test suite and build, inspect fresh origin/main, preserve the previous production deployment, and verify the new route denies missing credentials. After release, verify company info, a small entity page and a dated report through the Private AI Core, then verify a different assistant cannot invoke the tools. Retain only safe result metadata in the deployment receipt.

Rollback the Vercel deployment and remove or rotate the dedicated read-service key to disable this path. Keep the existing QuickBooks authorization intact; disconnecting it also affects Lineage Theater checkout. The unused BROCOTech Private AI Core Intuit registration created during discovery is not used by this implementation.
