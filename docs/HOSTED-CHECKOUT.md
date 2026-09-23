# QuickBooks-hosted checkout

The customer checkout uses QuickBooks Online invoices. Card entry is on Intuit's payment page; Lineage Theatre does not collect card numbers, security codes, or payment tokens. This flow is separate from the legacy Payments API adapter and its signed review controls. The internal review format is not an Intuit requirement.

## Owner setup

Open Administration > Pricing or Payments > QuickBooks-hosted checkout. Load the company's service catalog and select its active film-production Service item. The item's income account is managed in QuickBooks. This release accepts USD invoices with the explicitly selected NON tax treatment only; it does not determine tax liability.

Enter delivery and refund terms, confirm the company's payment capability and review of hosted-checkout PCI responsibilities, and verify that **Automatically send imported invoices** is off in QuickBooks Sales settings. Save the settings before enabling checkout. Disabled drafts can be saved with incomplete setup. Settings are versioned and bound to the current OAuth company, environment, and grant. Reconnection requires reviewing and saving setup again. `LINEAGE_PAYMENT_ACCESS=owner` restricts initial production checkout to the persisted active owner.

The owner requested non-taxable invoices, delivery within 24 hours after payment, and full refund requests within 10 calendar days after payment through admin@brocotech.ai. Faster processing of 5–10 minutes is a target requiring actual generation measurements. These business choices are saved through owner administration, not automatically enabled by code deployment.

## Customer flow and records

1. Prepare pricing saves the opted-in film plan and computes the fixed price from a verified provider quote or the saved planning rates plus markup. A later pricing change does not alter an existing invoice.
2. GET `checkoutConfiguration` reads saved availability. POST `prepareCheckout` may refresh the current accounting grant. Both return either `{available:false}` or a hosted method, environment, and delivery/refund terms. Neither creates an invoice.
3. POST `quote` accepts the project, prepared reference, and idempotency key. It validates the saved preparation and returns the server-computed total, order identity, expiry, and policy snapshot. No client amount or account mapping is accepted.
4. POST `checkoutCheck` obtains a short-lived one-use CAPTCHA proof for that account and quote. POST `checkout` accepts only the quote reference, idempotency key, proof, and explicit consent. The browser durably saves the order reference before this request.
5. A durable claim precedes each customer/invoice write. The invoice uses one selected service line, the fixed USD total, the account email, and a generic Film production description. Family materials and the private film title are not included. Only a validated Intuit invoice link is returned. Unknown write results are retained for review and never automatically resubmitted.
6. Customers open the payment page, then explicitly check payment status in Lineage Theatre. GET order/receipt reads stored records only; POST `checkPayment` reads the existing invoice and linked accounting Payment records. An invoice balance of zero alone does not confirm payment.

Production order identity is shared with the legacy flow and excludes the OAuth grant, preventing reconnection or switching payment methods from silently creating another order for the same film. Ownership, preparation, amount, currency, environment, item, and invoice/customer references must match. Expired quotes cannot create new invoices.

If the durable order proves that no invoice submission was attempted, an explicit CAPTCHA-backed retry may resume the original request while its price, terms, connection, and consent remain valid. It keeps the same quote, order, and request identity. A recorded invoice attempt never permits a creation retry. Pausing new checkout does not stop reading an existing invoice, and reconnecting the same company permits a verified read without changing its original creation binding.

## Confirmation and operational limits

A matched accounting Payment is displayed as **Payment recorded by QuickBooks**. It may have been entered manually in QuickBooks; it is not independent processor capture or settlement evidence. Downloaded records preserve that distinction. Hosted accounting records do not authorize the legacy rendering adapter. No automatic video generation is activated by checkout setup.

Refunds are managed in QuickBooks. Hosted invoice IDs and accounting Payment IDs must never be sent to the legacy card refund API. The application does not infer a refund from a changed invoice balance or claim that stored payment records reflect all later refunds. No duplicate journal entry or invoice is posted by the accounting export.

The application never calls Invoice `/send`. QuickBooks can nevertheless email API-created invoices if its company-wide automatic imported-invoice setting is turned on; `EmailStatus: NotSet` alone does not prevent this. Keep the setting off. The owner acknowledgment records a reviewed setting, not continuous remote enforcement. Intuit documents automatic reminders as applying to invoices already emailed.

Setup and mocked tests do not establish a live successful invoice payment, bank settlement, refund, or completed film. Verify each separately and do not use the merchant's own card to manufacture a sale. MagicLight generation remains unavailable until its supported API and actual output are verified.

## Official references

- [Invoice API, invoice links, and imported-invoice email behavior](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice)
- [Accounting Payment API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment)
- [Automatic invoice reminders](https://quickbooks.intuit.com/learn-support/en-us/help-article/invoicing/send-invoice-reminders-automatically-manually/L84cQjpxo_US_en_US)
- [QuickBooks PCI responsibilities](https://quickbooks.intuit.com/learn-support/en-us/help-article/data-security/quickbooks-pci-service-faqs/L7ipNg7n9_US_en_US)
- [Intuit merchant terms](https://www.intuit.com/legal/terms/en-us/quickbooks/online/)
