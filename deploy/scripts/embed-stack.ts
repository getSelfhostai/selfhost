import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStackModule, GENERATED_PATH, PACKAGE_ROOT } from "./stack.js";

writeFileSync(join(PACKAGE_ROOT, GENERATED_PATH), buildStackModule());
console.log(`wrote ${GENERATED_PATH}`);
