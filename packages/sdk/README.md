# @selfhost/sdk

Placeholder. A typed client for the HTTP API in
[`packages/schema/openapi.yaml`](../schema/openapi.yaml).

## Event schema versions

`EVENT_SCHEMAS` lists the event schema versions the SDK can send, newest first.
`pickEventSchema(health.event_schemas)` picks the newest one a server also accepts, from what it
lists on `GET /v1/health`; a server that lists none accepts `selfhost.event/v1` only. A test fails
once a listed version is past the 12 months the server keeps accepting it (see
[`packages/schema`](../schema/README.md#event-schema-versions)).
