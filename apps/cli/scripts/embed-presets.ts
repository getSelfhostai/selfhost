import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPresetsModule, GENERATED_PATH, PACKAGE_ROOT } from "./presets.js";

writeFileSync(join(PACKAGE_ROOT, GENERATED_PATH), buildPresetsModule());
console.log(`wrote ${GENERATED_PATH}`);
