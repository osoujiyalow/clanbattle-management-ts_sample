import {
  NumericTokenizationError,
  parseNormalizedIntegerToken,
  tokenizeNumericInput,
} from "../shared/numeric-tokenizer.js";

const TIME_TOKEN_PATTERN = /(?<![\d０-９])([0-9０-９]+)([:：])([0-9０-９]{1,2})(?![\d０-９])/gu;

export interface TlConversionRequest {
  carryoverSeconds: number;
  tlBody: string;
}

export interface TlConversionSuccess {
  ok: true;
  convertedText: string;
  convertedLineCount: number;
}

export interface TlConversionFailure {
  ok: false;
  message: string;
}

export type TlConversionResult = TlConversionSuccess | TlConversionFailure;

function normalizeFullWidthDigit(char: string): string {
  return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
}

function normalizeTimeDigits(text: string): string {
  let normalized = "";
  for (const char of text) {
    if (char >= "０" && char <= "９") {
      normalized += normalizeFullWidthDigit(char);
      continue;
    }

    if (char === "：") {
      normalized += ":";
      continue;
    }

    normalized += char;
  }

  return normalized;
}

function formatOffsetTime(totalSeconds: number): string {
  const negative = totalSeconds < 0;
  const absoluteSeconds = Math.abs(totalSeconds);
  const minutes = Math.floor(absoluteSeconds / 60);
  const seconds = absoluteSeconds % 60;
  return `${negative ? "-" : ""}${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function parseNonNegativeInteger(rawValue: string, fieldName: string): number | TlConversionFailure {
  let tokens: string[];
  try {
    tokens = tokenizeNumericInput(rawValue);
  } catch (error) {
    if (!(error instanceof NumericTokenizationError)) {
      throw error;
    }

    return {
      ok: false,
      message: `${fieldName}は0以上の整数で入力してください。`,
    };
  }

  if (tokens.length !== 1) {
    return {
      ok: false,
      message: `${fieldName}は0以上の整数で入力してください。`,
    };
  }

  const parsed = parseNormalizedIntegerToken(tokens[0]!);
  if (parsed === null || parsed < 0) {
    return {
      ok: false,
      message: `${fieldName}は0以上の整数で入力してください。`,
    };
  }

  return parsed;
}

export function parseTlCarryoverSeconds(rawValue: string): number | TlConversionFailure {
  return parseNonNegativeInteger(rawValue, "持越秒数");
}

export class TlConversionService {
  convert(request: TlConversionRequest): TlConversionResult {
    if (request.tlBody.trim().length === 0) {
      return {
        ok: false,
        message: "TL本文を入力してください。",
      };
    }

    const offsetSeconds = 90 - request.carryoverSeconds;
    let convertedLineCount = 0;
    const converted = request.tlBody.replace(
      TIME_TOKEN_PATTERN,
      (_matched, minutesText: string, _separator: string, secondsText: string) => {
        const normalizedMinutes = normalizeTimeDigits(minutesText);
        const normalizedSeconds = normalizeTimeDigits(secondsText);
        const totalSeconds =
          Number.parseInt(normalizedMinutes, 10) * 60 +
          Number.parseInt(normalizedSeconds, 10) -
          offsetSeconds;
        convertedLineCount += 1;
        return formatOffsetTime(totalSeconds);
      },
    );

    if (convertedLineCount === 0) {
      return {
        ok: false,
        message: "TL本文に時刻が見つかりませんでした。",
      };
    }

    return {
      ok: true,
      convertedText: converted.replace(/\r\n?/gu, "\n"),
      convertedLineCount,
    };
  }
}
