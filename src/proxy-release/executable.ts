import { requireDigest, type Platform } from "./build-identity.js";

/** Inspect the actual Go string variable through the ELF symbol table. Do not
 * execute candidate code or trust an ldflags string copied into build metadata.
 * Release builds retain symbols (-w, without -s) for this independent read.
 */
export function executableBuildIdentity(
  bytes: Buffer,
  platform: Platform,
): string {
  const fail = (): never => {
    throw new Error(
      "Executable: invalid ELF or missing embedded BuildIdentityV1",
    );
  };
  const range = (offset: number, size: number) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > bytes.length
    )
      fail();
    return bytes.subarray(offset, offset + size);
  };
  const u64 = (offset: number) => {
    const v = Number(range(offset, 8).readBigUInt64LE());
    if (!Number.isSafeInteger(v)) fail();
    return v;
  };
  if (
    !range(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    range(16, 2).readUInt16LE() !== 2 ||
    range(18, 2).readUInt16LE() !==
      (platform.architecture === "amd64" ? 62 : 183)
  )
    fail();
  const sectionOffset = u64(40),
    sectionSize = range(58, 2).readUInt16LE(),
    count = range(60, 2).readUInt16LE();
  if (sectionSize !== 64 || !count) fail();
  const sections = Array.from({ length: count }, (_, i) => {
    const at = sectionOffset + i * sectionSize;
    range(at, 64);
    return {
      type: bytes.readUInt32LE(at + 4),
      flags: u64(at + 8),
      address: u64(at + 16),
      offset: u64(at + 24),
      size: u64(at + 32),
      link: bytes.readUInt32LE(at + 40),
      entrySize: u64(at + 56),
    };
  });
  const addressBytes = (address: number, size: number) => {
    const matches = sections.filter(
      (s) =>
        s.type === 1 &&
        (s.flags & 2) !== 0 &&
        address >= s.address &&
        address + size <= s.address + s.size,
    );
    if (matches.length !== 1) fail();
    return range(matches[0]!.offset + address - matches[0]!.address, size);
  };
  const matches: string[] = [];
  for (const symbols of sections.filter((s) => s.type === 2)) {
    const names = sections[symbols.link];
    if (
      !names ||
      names.type !== 3 ||
      symbols.entrySize !== 24 ||
      symbols.size % 24
    )
      fail();
    const strings = range(names!.offset, names!.size);
    for (let i = 0; i < symbols.size; i += 24) {
      const at = symbols.offset + i;
      range(at, 24);
      const start = bytes.readUInt32LE(at),
        end = strings.indexOf(0, start);
      if (start >= strings.length || end < 0) fail();
      if (
        !strings.subarray(start, end).equals(Buffer.from("main.buildIdentity"))
      )
        continue;
      if (u64(at + 16) !== 16) fail();
      const header = addressBytes(u64(at + 8), 16);
      const address = Number(header.readBigUInt64LE()),
        length = Number(header.readBigUInt64LE(8));
      if (!Number.isSafeInteger(address) || length !== 71) fail();
      const value = addressBytes(address, length);
      if (value.some((b) => b > 127)) fail();
      matches.push(value.toString("ascii"));
    }
  }
  if (matches.length !== 1) fail();
  requireDigest(matches[0]);
  return matches[0];
}
