export interface ParsedDamage {
  damage: number;
  memo: string;
}

function normalizeFullWidthDigits(value: string): string {
  return value.replace(/[\uFF10-\uFF19]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

export function parseDamageMessage(input: string): ParsedDamage | null {
  const tokens = input.trim().split(/\s+/u).filter((token) => token.length > 0);
  const firstToken = tokens[0];

  if (!firstToken) {
    return null;
  }

  let damageToken = normalizeFullWidthDigits(firstToken.replaceAll("\u4e07", ""));

  if (!/^\d+$/u.test(damageToken)) {
    return null;
  }

  return {
    damage: Number.parseInt(damageToken, 10),
    memo: tokens.slice(1).join(" "),
  };
}
