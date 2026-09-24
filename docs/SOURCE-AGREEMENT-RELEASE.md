# Registration source agreement

Prepared September 22, 2026 for the user-authorized Lineage Theater release. This is a drafted product agreement, not an attorney-reviewed enforceability opinion.

## Scope and wording

New registrations require an unchecked, separate acceptance of the Source Materials Ownership and Use Agreement. The full document and printable version link are available before registration. The customer's entered legal name and affirmative checkbox constitute the stated electronic-signature process.

The default agreement names the operator as BROCO Technologies LLC, operating Lineage Theater, consistent with the existing verified company details in `docs/QUICKBOOKS-SETUP.md`. It assigns only rights the submitter owns or is authorized to transfer; provides a license where assignment is legally unavailable but licensing is authorized; expressly discloses commercial reuse, publication, adaptations, licensing, and sharing with providers and independent third-party companies; and reserves mandatory privacy and other nonwaivable rights. It addresses adulthood and authority, other people's copyright and likeness rights, lawful submissions, keeping originals, retention, account closure, permitted personal use, and future changes. It does not claim exclusive rights in public-domain facts or someone else's copyright.

The agreement concerns materials submitted after acceptance, not files merely selected and held on the customer's own device. It does not add any automatic source upload, public access to stored files, AI training pipeline, or new provider integration. Account credentials and payment details are outside the source-ownership grant. Existing users and prior materials are not silently enrolled or retroactively assigned.

## Product and records

- The public agreement endpoint supplies the current version and can retrieve a specified historical version.
- Registration requires explicit acceptance of the current server version and content hash. Missing, changed, invalid, or unavailable terms prevent account creation.
- The account records the server-owned accepted text, checkbox statement, version/hash, acceptance time, and account/name associated with the electronic signature. Client-supplied text or timestamps cannot substitute for this record.
- Administration → Source agreement supports editing the title, full plain text, and checkbox statement, previewing the text, and saving a new version with concurrency protection and an audit event.
- New versions apply to later registrations. Saved acceptance records are immutable historical evidence; editor saves do not rewrite them.
- `/source-agreement.html` is printable, uses text-only rendering, and retrieves the linked version without silently falling back to different terms.
- Terms, privacy information, and the landing footer link to the agreement. Pricing disclosures now explain the fixed checkout amount introduced in the same release.

No bulk third-party sharing or retrospective acceptance migration is part of this change. Before future uses of actual source materials, honor each account's recorded agreement and applicable rights and privacy requirements. The registration mechanism alone cannot verify that a customer owns every uploaded copyright or obtained every other person's consent.

## Legal drafting references

- [U.S. Copyright Office, 17 U.S.C. Chapter 2](https://www.copyright.gov/title17/92chap2.html): copyright transfer and signature requirements; ownership of a copy differs from ownership of copyright.
- [15 U.S.C. 7001](https://uscode.house.gov/view.xhtml?req=%28title%3A15+section%3A7001+edition%3Aprelim%29): electronic records and signatures; reproducible retained records.
- [FTC, changes to terms and data practices](https://www.ftc.gov/policy/advocacy-research/tech-at-ftc/2024/02/ai-other-companies-quietly-changing-your-terms-service-could-be-unfair-or-deceptive): changing terms does not justify undisclosed retroactive expansion of data uses.

These references informed the implementation and drafting. They do not establish that a checkbox alone cures missing ownership, third-party permission, jurisdiction-specific requirements, or an inaccurate disclosure. Legal review of the business's intended actual reuse and sharing practices remains advisable.

## Release verification

All 366 automated tests pass and the TypeScript/Vite production build passes. Real-handler fixture checks cover missing consent, stale versions after an administrator edit, exact accepted snapshots, historical retrieval, permissions, storage failures, and concurrent saves with zero outbound provider requests. Existing fixed-price and payment recovery fixture checks also pass.

Local browser verification completed an explicitly accepted fictional registration, the restricted pending-account state, retrieval of its exact agreement/signature record, and an administrator edit/save/readback of a new version. The user explicitly authorized merging and deploying the pricing and registration changes. The production commit, deployment state, served version and live signed-in checks are recorded in the durable release record after deployment.
