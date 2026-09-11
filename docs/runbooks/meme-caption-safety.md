# Meme caption safety

- Imgflip outputs are public-by-URL. Birthday, holiday and delivery-preparation images use only code-owned generic occasion prompts; project names, people, contacts and financial details are not supplied to that caption-generation request. Custom/scheduled/ad-hoc briefings stay as text in the existing Slack destination instead of becoming public images. This does not change Slack audience permissions.
- Image captions use readable ASCII text. Smart punctuation, accents and whitespace are normalized. Emoji, unsupported Unicode, common encoding corruption, oversized captions and invalid box counts never reach the image renderer. Valid emoji remain readable in the Slack text fallback.
- Caption prompts disallow invented client replies or approvals. Provider errors/timeouts and unexpected image URLs use the text fallback. Provider response bodies are not copied into logs.
- A file handled in `02_Delivery` triggers **Delivery files ready**, not **We shipped it**. Client receipt/approval is not inferred from folder contents. Existing project/day deduplication remains.
- The September 11 Fabric IQ post was edited in place to a clean text meme and the corrected delivery wording. No extra announcement was sent. Removing its image block does not delete the old image from Imgflip's servers.

Verification: caption normalization/encoding, form serialization, renderer outage, public-prompt isolation, text fallback, weekly timesheet parity, and delivery wording/deduplication are covered by automated tests. The original Slack edit was verified through an independent read-back.
