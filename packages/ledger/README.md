# @selfhost/ledger

Placeholder. The append-only ledger store goes here: one table of `selfhost.event/v1` events on
Postgres 16 (self-hosted and hosted) or embedded PGlite (laptop install). The application role can
insert and read but not update or delete; only the retention job removes rows.
