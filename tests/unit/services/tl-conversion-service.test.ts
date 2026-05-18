import { describe, expect, it } from "vitest";

import {
  TlConversionService,
  parseTlCarryoverSeconds,
} from "../../../src/services/tl-conversion-service.js";

describe("TlConversionService", () => {
  it("converts half-width and full-width timestamps while keeping non-time text intact", () => {
    const service = new TlConversionService();

    const result = service.convert({
      carryoverSeconds: 70,
      tlBody: "１：１０ ライラ 😀\n0:41 フィオ オートOFF",
    });

    expect(result).toEqual({
      ok: true,
      convertedLineCount: 2,
      convertedText: "0:50 ライラ 😀\n0:21 フィオ オートOFF",
    });
  });

  it("keeps line structure and trailing text untouched", () => {
    const service = new TlConversionService();

    const result = service.convert({
      carryoverSeconds: 10,
      tlBody: "0:40 イリヤ　 \r\n\r\n0:20 アカリ  ",
    });

    expect(result).toEqual({
      ok: true,
      convertedLineCount: 2,
      convertedText: "-0:40 イリヤ　 \n\n-1:00 アカリ  ",
    });
  });

  it("returns an error when no timestamps are found", () => {
    const service = new TlConversionService();

    expect(
      service.convert({
        carryoverSeconds: 30,
        tlBody: "ライラ オートOFF",
      }),
    ).toEqual({
      ok: false,
      message: "TL本文に時刻が見つかりませんでした。",
    });
  });

  it("parses carryover seconds from full-width digits", () => {
    expect(parseTlCarryoverSeconds("９０")).toBe(90);
    expect(parseTlCarryoverSeconds("　７０　")).toBe(70);
  });
});
