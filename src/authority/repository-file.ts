import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";
import { isUnicodeScalarString } from "./json.js";
import { isAbsolute, join, parse, resolve } from "node:path";

export function repositoryPath(
  value: unknown,
  label = "Repository path",
): string {
  if (
    typeof value !== "string" ||
    !value ||
    !isUnicodeScalarString(value) ||
    isAbsolute(value) ||
    /[\\\x00-\x1f\x7f:]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label}: invalid noncanonical repository-relative path`);
  return value;
}

const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.nlink === b.nlink;

/** Read one regular file; reject links at every component and bind the bytes
 * to the inode observed before opening, after opening, and after reading.
 * Ancestors are rechecked so a renamed/substituted directory fails closed too.
 */
export function readRepositoryFile(root: string, path: string): Buffer {
  repositoryPath(path);
  const base = resolve(root);
  if (isAbsolute(root) && root !== base)
    throw new Error("Repository root: noncanonical path");
  const target = join(base, path);
  const components: { path: string; stat: BigIntStats }[] = [];
  let current = parse(target).root;
  const parts = target.slice(current.length).split("/");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const stat = lstatSync(current, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error("Repository file: symlink or non-regular path component");
    components.push({ path: current, stat });
  }
  const expected = components.at(-1)!.stat;
  // NONBLOCK prevents a substituted FIFO from hanging before fstat rejects it.
  const fd = openSync(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(expected, opened))
      throw new Error("Repository file: opened-file substitution");
    const bytes = readFileSync(fd);
    if (
      !sameFile(opened, fstatSync(fd, { bigint: true })) ||
      BigInt(bytes.length) !== opened.size
    )
      throw new Error("Repository file: changed during read");
    for (const component of components) {
      const after = lstatSync(component.path, { bigint: true });
      if (
        after.isSymbolicLink() ||
        !(component.path === target
          ? sameFile(component.stat, after)
          : sameIdentity(component.stat, after))
      )
        throw new Error("Repository file: path substitution during read");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
