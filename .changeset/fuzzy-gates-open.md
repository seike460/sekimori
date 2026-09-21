---
"sekimori": minor
---

Initial release. EventBridge and SQS boundaries: inject (W3C carrier + native X-Ray header where it
helps), extract with a documented precedence order, and per-record CONSUMER spans linked to the
producer. Contract-tested against a plain OTel SDK and the ADOT Lambda layer propagator set.
