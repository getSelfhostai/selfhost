import type * as OpenSandbox from "@alibaba-group/opensandbox";
import type * as Daytona from "@daytona/sdk";
import type * as E2B from "e2b";
import type * as Modal from "modal";
import type { DaytonaSdk } from "../src/adapters/daytona.js";
import type { E2BSdk } from "../src/adapters/e2b.js";
import type { ModalSdk } from "../src/adapters/modal.js";
import type { OpenSandboxSdk } from "../src/adapters/opensandbox.js";

declare const e2b: typeof E2B;
declare const daytona: typeof Daytona;
declare const modal: typeof Modal;
declare const opensandbox: typeof OpenSandbox;
export const a: E2BSdk = e2b;
export const b: DaytonaSdk = daytona;
export const c: ModalSdk = modal;
export const d: OpenSandboxSdk = opensandbox;
