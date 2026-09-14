# Customer and administrator visibility — September 14, 2026

## Change

Removed Studio status from the main customer navigation. Detailed model, production vendor, merchant, supplier pricing, and quality diagnostics are available under Administration → Overview → Studio status. Existing server role checks and conditional administrator navigation remain in place.

Story development, screenplay review, film availability, pricing, status messages, script downloads, and project backups now use customer-facing Lineage Theatre wording. The customer studio API returns an explicit set of capability and story fields instead of internal connection details. The final film price remains unavailable; production and checkout remain disabled. Consent and source coverage remain visible, with a link to existing privacy information. Policy pages and the existing payment disclosure were not changed.

Saved draft content, sources, cast, scenes, assumptions, and media references are preserved. Backup exports use neutral production references; normalization restores the supported production reference without treating archived jobs as current jobs. Original stored operational metadata is not rewritten.

## Automated checks

- `pnpm test`: 139 tests passed, no failures or skips.
- `pnpm run build`: TypeScript and Vite build passed. The existing large PDF-related chunk warning remains.
- `git diff --check`: passed.
- New tests cover customer payload projection, provider error handling, consent and session requirements, same-origin actions, production/checkout refusal, customer job ownership, provider diagnostics retained for admin, backup roundtrip preservation, and saved production status wording.

## Browser checks

Used an isolated local fixture with fictional accounts and family material. It invokes the real studio handler through injected dependencies; no credentials, production records, external AI requests, or payments are used.

- Customer navigation contains Create a film and Film library; Studio status and Administration are absent. A customer opening `#admin/payments` remains in the customer workspace.
- The development, script-review, and production pages contain no operational provider names or supplier prices. An older draft carrying provider attribution renders with neutral copy.
- AI development is disabled before consent. A synthetic screenplay request succeeds after consent and produces three editable scenes and two cast members; these survive reload.
- Unavailable story development shows a plain explanation and keeps manual editing available.
- Film creation remains disabled without production readiness and a confirmed price.
- Owner Overview shows Studio status, all three detailed provider connections, supplier pricing, and unverified quality status.
- Desktop (1440 × 1080) and mobile (390 × 844) layouts were inspected. Customer production and admin Overview have no horizontal overflow. No page errors or Vite error overlay were detected.

These checks verify local behavior and do not establish live provider activation, a completed film, or payment processing. Production publication requires the separate merge and deployment approval described in the user's role instructions.
