import { describe, expect, it } from "vitest";

import {
  ProgressAction,
  createProgressActionComponents,
  createProgressActionButtonCustomId,
  parseProgressActionButtonCustomId,
} from "../../../src/discord/progress-action-buttons.js";

describe("progress-action-buttons", () => {
  it("parses only current progress action custom ids", () => {
    expect(parseProgressActionButtonCustomId(createProgressActionButtonCustomId(ProgressAction.BATTLE))).toBe(
      ProgressAction.BATTLE,
    );
    expect(
      parseProgressActionButtonCustomId(createProgressActionButtonCustomId(ProgressAction.CARRYOVER)),
    ).toBe(ProgressAction.CARRYOVER);
    expect(parseProgressActionButtonCustomId(createProgressActionButtonCustomId(ProgressAction.FINISH))).toBe(
      ProgressAction.FINISH,
    );
    expect(parseProgressActionButtonCustomId(createProgressActionButtonCustomId(ProgressAction.DEFEAT))).toBe(
      ProgressAction.DEFEAT,
    );
    expect(parseProgressActionButtonCustomId(createProgressActionButtonCustomId(ProgressAction.UNDO))).toBe(
      ProgressAction.UNDO,
    );
  });

  it("rejects legacy progress action custom ids", () => {
    expect(parseProgressActionButtonCustomId("progress-action:physics")).toBeNull();
    expect(parseProgressActionButtonCustomId("progress-action:magic")).toBeNull();
  });

  it("omits buttons when the progress message is non-interactive", () => {
    expect(createProgressActionComponents({ interactive: false })).toEqual([]);
  });
});
