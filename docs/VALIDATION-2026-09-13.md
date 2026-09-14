# Internal studio branch validation

This is implementation validation, not proof of a live MagicLight film or payment.

- `pnpm run build`: TypeScript and Vite production build pass. The existing dynamically loaded document-parser chunk produces a bundle-size advisory.
- `node --test tests/*.test.mjs`: 27 tests pass, covering authentication, complete source extraction, source coverage, strict screenplay validation, source/cast reference integrity, disclosed dramatization, documentary restrictions, prompt boundaries, source consent and unavailable-provider behavior.
- Local browser UI test used a temporary mock server and entirely fictional Ada Example materials. Entering the story, consenting to source processing and developing the film returned script, supporting cast and assumptions together. These fixtures are excluded from Git and deployment.
- The script, cast and assumptions are editable. Project title and narrative restored after reload under the synthetic QA identity.
- Production review displays MagicLight, highest-available quality preference, pending provider/payment setup and a disabled Create my film button. No provider request or charge was made.
- Desktop layout was visually reviewed. At 390 x 844 the document scroll width was 375 pixels: no horizontal overflow. The inspected production page had zero outbound video-provider links. Temporary viewport override was reset.
- Existing project/film normalization and downloaded brief were checked for default settings, saved output compatibility, family-narrative references and dramatization details.
- `git diff --check`: clean.

Not verified: live OpenAI generation with the selected account, MagicLight API entitlement/contracts, highest permitted animation tier, complete rendered-film output, customer checkout, payment settlement, provider expense, production deployment or authenticated production behavior after this change. Do not merge or report the requested film workflow complete until these are resolved.
