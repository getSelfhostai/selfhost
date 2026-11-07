import { defaultPerson } from "../import.js";
import { readMembership } from "../team/config.js";
import type { AlertIo } from "./settings.js";

/** The person whose usage this machine imports: --person, the team membership, the git email. */
export function localPerson(flag: string | undefined, io: Pick<AlertIo, "env" | "configPath">) {
  return flag ?? readMembership(io.configPath)?.person ?? defaultPerson(io.env);
}
