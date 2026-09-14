# Registration approval

Requested behavior: administrators approve accounts for the same studio, checkout, and film workflow that customers will use. Employees can keep the customer role; approval does not grant administration or override provider readiness.

## Controls

- Administration → People → **Require approval for new registrations** defaults to enabled when no saved policy exists.
- With the setting enabled, registration creates a pending customer account. The person can sign in, see the waiting screen, manage account security, and check approval status. Protected studio, payment, film, document, and archive requests require current account approval.
- Administrators can approve an individual pending account. The server saves who approved it and when, checks concurrent writes, and records the action in the activity history.
- Disabling the setting applies to future registrations. Those new accounts receive customer access under the saved policy. Existing pending accounts still require individual approval. Enabling it again does not revoke previously approved accounts.
- Existing owner and administrator roles retain access. Existing customer accounts without recorded approval wait for review; a previous active flag or an email ending in `@brocotech.ai` does not grant approval.
- Suspension still prevents access. Reactivating a suspended applicant does not approve it. An owner-issued administrator invitation deliberately grants access to its named recipient; removing administrator permissions retains approved customer access.

The policy is stored privately at `settings/registration.json`. Updates require administrator authorization, the app origin, a matching revision, and conditional storage writes. Public registration cannot supply approval, role, or policy fields. Missing policy defaults to requiring approval; registration fails closed when the saved policy cannot be validated.

An already-issued archive upload token may remain usable for its fixed object until its existing expiration. Current account eligibility is rechecked before finalizing new archive metadata, including after media verification. Retrying a previously completed callback does not change the saved record.

## Verification and activation

The synthetic local harness exercises the actual authentication, studio, and administration handlers with fictional accounts and memory-only storage. It verifies pending-account denial, individual approval by an administrator, preserved customer permissions, policy changes in both directions, and unchanged pending/approved accounts across policy changes. Owner, administrator, and approved employee reach the same provider-availability checks. The harness blocks outbound provider requests.

September 14 validation: all **217 repository tests passed**, the TypeScript/Vite production build passed, and the actual-handler synthetic harness passed with **zero outbound calls**. Local browser checks confirmed the pending screen, account security access, saved switch states in both directions, exact-account approval, and approved customer entry without administrator navigation. These are development checks; they do not establish that the change is live.

This change does not enable real charges or rendering. On September 14, 2026, the existing Intuit app assessment was rechecked in the signed-in portal and still showed **In-Progress**, with results **N/A**. Payment code still uses the sandbox-only transport and lacks the completed customer card-entry flow. MagicLight has a saved server secret but no verified rendering adapter or deployed media worker. These integration requirements remain necessary for everyone, including administrators.

Before production release, run the repository tests and production build, review the patch, and obtain the required merge/deployment approval. Verify the released commit, signed-in administration, default enabled policy, and account waiting screen after deployment. Do not approve real accounts or disable the production policy as part of a synthetic test.
