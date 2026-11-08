// Runs the ledger migrations without starting the server, against the same database: DATABASE_URL,
// else the embedded one in SELFHOST_DATA_DIR. deploy/docker/upgrade.sh runs it in a one-off
// container before it switches releases, so a failed migration never stops the running release.
//
//   node dist/migrate.js             apply every pending migration
//   node dist/migrate.js --to <v>    move to version v (like 0008, or 0 for none): down with the
//                                    rollbacks of newer migrations, or up to v
//   node dist/migrate.js --status    print where the schema is as JSON, and change nothing
import { parseArgs } from "node:util";
import { connect, migrate, resolveDataDir, rollback, schemaStatus } from "@selfhost/ledger";

const { values } = parseArgs({
  options: { to: { type: "string" }, status: { type: "boolean" } },
});

const db = await connect({ url: process.env.DATABASE_URL, dataDir: resolveDataDir() });
try {
  if (values.status) {
    console.log(JSON.stringify(await schemaStatus(db)));
  } else {
    const to = values.to;
    const undone = to === undefined ? [] : await rollback(db, to);
    const applied = await migrate(db, undefined, to === undefined ? {} : { to });
    if (undone.length > 0) console.log(`rolled back ${undone.join(", ")}`);
    if (applied.length > 0) console.log(`applied ${applied.join(", ")}`);
    const status = await schemaStatus(db);
    console.log(
      `schema at ${status.current ?? "none"}; this release knows up to ${status.latest ?? "none"}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
