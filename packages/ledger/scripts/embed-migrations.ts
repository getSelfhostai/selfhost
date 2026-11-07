import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMigrationsModule, GENERATED_PATH, PACKAGE_ROOT } from "./migrations.js";

writeFileSync(join(PACKAGE_ROOT, GENERATED_PATH), buildMigrationsModule());
console.log(`wrote ${GENERATED_PATH}`);
