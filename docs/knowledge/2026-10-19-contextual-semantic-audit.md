# Captured real-chat contextual audit — round 2

This review is bound to the private `contextual-round2` replay outputs generated on 2026-10-19. Later code changes require a fresh replay. No customer identities, addresses, phone numbers, original message IDs or private message text are included here.

All **49 captured customer text turns** were read against the actual preceding store replies, generated reply, persisted fields and decision reasons. Historical store replies were injected as assistant evidence at their source dates; they were never imported as owner approvals, confirmed prices, customer budgets or confirmed production dates. Network access was forbidden.

| Anonymous thread | Customer text turns | Pass | Fail |
| --- | ---: | ---: | ---: |
| AUDIT-001 | 3 | 2 | 1 |
| AUDIT-002 | 40 | 12 | 28 |
| AUDIT-003 | 6 | 5 | 1 |
| Total | 49 | 19 | 30 |

No text-turn verdict was blocked; visual-message content and completeness have separate unresolved limits below. A passing individual reply does not repair a prior failed merged order card. Zero runtime errors were observed; that is distinct from these semantic verdicts.

## Required improvements found

1. Infer a possible separate order when a customer adds another recipient/date, and ask for routing when uncertain. Do not combine different orders merely because the LINE customer is the same.
2. Keep payment-visit dates separate from delivery/use dates, including mixed thanks-plus-payment messages.
3. Resolve brief consent against the immediate store proposal. Distant payment discussion must not turn current character/lettering consent into payment intent.
4. Retain addresses, contact numbers, catalogue selections and personalized messages as sourced provisional facts. A generic acknowledgement without retaining order-card information is insufficient.
5. Preserve per-item specifications when two catalogue products have different lettering.
6. Recognize acknowledgements, thanks with common suffixes, typo corrections and deferred decisions; avoid restarting intake after delivery or at conversation close.
7. Treat shop-name corrections as lettering corrections, not as a new relocation occasion.
8. Resume pending enquiry after a rich-menu invocation; avoid losing the price/availability question.
9. Ask only unresolved facts: a full address supplied in the previous turn should prevent another municipality question.
10. Keep owner-facing decisions tied to the current ask, including callback consent, inventory alternatives and multi-order outstanding balance.

## Coverage and limits

The replay covers 124 distinct captured messages: customer text 49, customer images 3, customer unparsed/sticker messages 6, store text 44, store images 11 and store unparsed/sticker messages 11. Exact visual specifications are not accepted as understood merely because the image event is present.

Source years absent from the screen were inferred from capture date and weekday; every turn records timestamp provenance. Numeric IDs or capture order break ties within the same displayed minute, so second-level chronology is not proven.

One AUDIT-002 source variant differs in rendered read-label/blank-line formatting. Both raw variants remain available; it is not a business-content discrepancy. AUDIT-003 source metadata does not prove its acquisition boundary complete. This report therefore does not claim that every official-account conversation or every historical image was acquired and accepted.

Private per-turn verdicts and evidence reside under the local `verification-20261019/contextual-round2` audit folder. This is offline semantic review, not deployed or real-LINE delivery acceptance.
