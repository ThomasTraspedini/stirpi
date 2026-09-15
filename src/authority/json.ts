/** JSON authority is decoded before schema validation, without lossy repair. */
export type AuthorityJson =
  | null
  | boolean
  | number
  | string
  | AuthorityJson[]
  | { [key: string]: AuthorityJson };

export const isUnicodeScalarString = (value: string) =>
  !/[\uD800-\uDFFF]/u.test(value);

export function parseAuthorityJson(bytes: Buffer | string): AuthorityJson {
  const fail = (): never => {
    throw new Error(
      "Authority JSON: invalid UTF-8 JSON, duplicate key, surrogate, or unsafe number",
    );
  };
  let source: string;
  try {
    source =
      typeof bytes === "string"
        ? bytes
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            bytes,
          );
  } catch {
    return fail();
  }
  if (source.startsWith("\uFEFF")) fail();
  let offset = 0;
  const space = () => {
    while (/[\x20\t\r\n]/.test(source[offset] ?? "x")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") {
        offset++;
        continue;
      }
      if (char !== '"') continue;
      let value: string;
      try {
        value = JSON.parse(source.slice(start, offset)) as string;
      } catch {
        return fail();
      }
      if (!isUnicodeScalarString(value)) fail();
      return value;
    }
    return fail();
  };
  const value = (): AuthorityJson => {
    space();
    if (source[offset] === '"') return string();
    if (source[offset] === "{") {
      offset++;
      space();
      const result: { [key: string]: AuthorityJson } = {};
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset++;
        return result;
      }
      for (;;) {
        if (source[offset] !== '"') fail();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        space();
        if (source[offset++] !== ":") fail();
        Object.defineProperty(result, key, {
          value: value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        space();
        const next = source[offset++];
        if (next === "}") return result;
        if (next !== ",") fail();
        space();
      }
    }
    if (source[offset] === "[") {
      offset++;
      space();
      const result: AuthorityJson[] = [];
      if (source[offset] === "]") {
        offset++;
        return result;
      }
      for (;;) {
        result.push(value());
        space();
        const next = source[offset++];
        if (next === "]") return result;
        if (next !== ",") fail();
      }
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }
    }
    const match =
      /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/.exec(
        source.slice(offset),
      );
    if (!match) return fail();
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) fail();
    // Check the decimal value as well: IEEE-754 rounding must not turn a
    // fractional or out-of-range authority input into an accepted integer.
    const digits = (match[2]! + (match[3] ?? "")).replace(/^0+/, "");
    if (digits) {
      const significant = digits.replace(/0+$/, "");
      const scale =
        Number(match[4] ?? 0) -
        (match[3]?.length ?? 0) +
        digits.length -
        significant.length;
      if (
        scale < 0 ||
        scale > 16 ||
        significant.length + scale > 16 ||
        BigInt(significant) * 10n ** BigInt(scale) >
          BigInt(Number.MAX_SAFE_INTEGER)
      )
        fail();
    }
    offset += match[0].length;
    return number;
  };
  const result = value();
  space();
  if (offset !== source.length) fail();
  return result;
}

export function authorityObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}: expected object`);
  return value as Record<string, unknown>;
}

export function closedAuthorityObject(
  value: unknown,
  keys: readonly string[],
  label: string,
) {
  const record = authorityObject(value, label);
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(record, key))
  )
    throw new Error(`${label}: unknown or missing field`);
  return record;
}
