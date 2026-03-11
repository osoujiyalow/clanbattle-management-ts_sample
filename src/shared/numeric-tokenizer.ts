const FULL_WIDTH_ZERO = 0xff10;
const FULL_WIDTH_NINE = 0xff19;
const FULL_WIDTH_COMMA = "\uFF0C";
const FULL_WIDTH_SPACE = "\u3000";
const FULL_WIDTH_MINUS = "\uFF0D";

export class NumericTokenizationError extends Error {
  constructor(message = "invalid numeric input") {
    super(message);
    this.name = "NumericTokenizationError";
  }
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isFullWidthDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= FULL_WIDTH_ZERO && code <= FULL_WIDTH_NINE;
}

function normalizeDigit(char: string): string {
  if (isAsciiDigit(char)) {
    return char;
  }

  return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
}

export function tokenizeNumericInput(input: string): string[] {
  const tokens: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.length === 0) {
      return;
    }

    tokens.push(current);
    current = "";
  };

  for (const char of input) {
    if (isAsciiDigit(char) || isFullWidthDigit(char)) {
      current += normalizeDigit(char);
      continue;
    }

    if (char === " " || char === FULL_WIDTH_SPACE) {
      pushCurrent();
      continue;
    }

    if (char === "," || char === FULL_WIDTH_COMMA) {
      continue;
    }

    if (char === "-" || char === FULL_WIDTH_MINUS) {
      if (current.length > 0) {
        throw new NumericTokenizationError();
      }

      current = "-";
      continue;
    }

    throw new NumericTokenizationError();
  }

  pushCurrent();
  return tokens;
}

export function parseNormalizedIntegerToken(token: string): number | null {
  if (!/^-?\d+$/u.test(token)) {
    return null;
  }

  const value = Number.parseInt(token, 10);
  return Number.isSafeInteger(value) ? value : null;
}
