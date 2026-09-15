import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  parseVerificationProfilePin,
  validateProfilePin,
} from "../verification/preflight.js";
import { git, gitEnvironment } from "./inputs.js";

/** Schema 2 locates authority only in the clean runtime tree, never the
 * preregistration-containing revision or a target repository.
 */
export function validatePreregisteredProfile(
  pilot: Record<string, unknown>,
  checkout: string,
) {
  const pin = parseVerificationProfilePin(pilot.verificationProfile);
  const commit = pilot.stirpiCommit;
  if (
    pilot.schemaVersion !== 2 ||
    typeof commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(commit)
  )
    throw new Error(
      "Preflight: schema-2 requires an exact pinned runtime commit",
    );
  const assertCheckout = () => {
    if (
      git(checkout, "rev-parse", "--show-toplevel") !== resolve(checkout) ||
      git(checkout, "rev-parse", "HEAD") !== commit ||
      git(
        checkout,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
      )
    )
      throw new Error("Preflight: runtime checkout dirty or identity mismatch");
  };
  assertCheckout();
  const loaded = validateProfilePin(checkout, pin);
  const entry = git(checkout, "ls-tree", commit, "--", pin.path);
  if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry))
    throw new Error("Preflight: profile must be a committed regular file");
  const committed = execFileSync(
    "git",
    ["--no-replace-objects", "-C", checkout, "show", `${commit}:${pin.path}`],
    { env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  if (!committed.equals(loaded.bytes))
    throw new Error(
      "Preflight: profile bytes differ from pinned runtime commit",
    );
  assertCheckout();
  return pin;
}
