# Connect free and Google AI Pro personal accounts through Antigravity

## Why
Consumer Gemini CLI/Code Assist support ended on 2026-06-18. The existing OAuth client cannot establish that free or Google AI Pro accounts can generate content. Preserve the copied gateway stack and implement a separately authenticated Antigravity provider, using account-observed availability rather than invented subscription permissions.

## What Changes
- Add a distinct encrypted Antigravity OAuth source, with browser-bound callback state, optional explicit free initialization, bounded Google operations and no paid-credit opt-in.
- Offer personal Google sign-in and credential import alongside retained API-key and enterprise Code Assist options.
- Adapt native Gemini requests on an explicit Antigravity base URL, preserving source ownership, key limits, usage settlement, streaming terminal evidence and resource affinity.
- Discover account-returned model IDs and quota observations, and document CLI configuration and consumer/private-protocol limitations.

## Non-goals
No API-key billing activation, paid-credit spending, fabricated free/Pro entitlement, automatic switching between provider identities, stack replacement or source-line padding. Actual account inference must be distinguished from fixture verification.
