---
'@scribear/node-server': minor
'@scribear/node-server-schema': minor
---

Add inbound service-API-key authentication to node-server (monitoring plan
B1.1, second of four PRs — the auth infrastructure only; no route consumes it
until the status endpoint lands).

Node Server had no inbound-authed HTTP route at all: its OpenAPI security
schemes were empty, there was no hooks directory, and its only authentication
was per-WebSocket and performed inside the stream controller. The status
endpoint that B1.1 exposes carries per-session operational detail, so it needs
a trust boundary that did not exist yet. This builds one by mirroring Session
Manager's `ServiceAuthService` + `serviceApiKeyHook` pair rather than inventing
a second scheme.

The key is a new `NODE_SERVER_SERVICE_API_KEY`, deliberately distinct from the
`SESSION_MANAGER_SERVICE_API_KEY` this service already holds. That one is
presented *outbound* to Session Manager; the new one is required *inbound* from
observability consumers. They are opposite directions across different trust
boundaries, and sharing one string would mean that compromising the monitoring
sidecar also grants Session Manager access.

Comparison goes through `constantTimeEqual`, which HMACs both operands to a
fixed-width digest before `timingSafeEqual` — so the comparison cannot throw on
a length mismatch and the secret's length is not observable from response
timing. The service also refuses to construct when the key is still the literal
`CHANGEME` placeholder.

The hook is attached per route rather than plugin-scoped, so adding it cannot
accidentally put an API key in front of the liveness and readiness probes or
the transcription WebSocket.

Note for reviewers: the 401 body's `code` is declared as a schema `const` of
`INVALID_SERVICE_KEY` while the thrown error's code is the generic
`UNAUTHORIZED`. The serializer emits the constant, so the wire response is
`INVALID_SERVICE_KEY` — this matches Session Manager's existing behaviour, and
the two services now document and emit the same code for the same failure.
