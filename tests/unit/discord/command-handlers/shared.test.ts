import { describe, expect, it } from "vitest";

import {
  resolvePreferredGuildMemberDisplayName,
  resolvePreferredUserDisplayName,
} from "../../../../src/discord/command-handlers/shared.js";

describe("display name resolution helpers", () => {
  it("prefers guild nickname over global name and user id", () => {
    expect(
      resolvePreferredGuildMemberDisplayName({
        id: "123",
        nickname: "Guild Nick",
        user: {
          id: "123",
          globalName: "Global Nick",
        },
      }),
    ).toBe("Guild Nick");
  });

  it("falls back from global name to user id", () => {
    expect(
      resolvePreferredGuildMemberDisplayName({
        id: "123",
        nickname: null,
        user: {
          id: "123",
          globalName: "Global Nick",
        },
      }),
    ).toBe("Global Nick");

    expect(
      resolvePreferredGuildMemberDisplayName({
        id: "123",
        nickname: null,
        user: {
          id: "123",
          globalName: null,
        },
      }),
    ).toBe("123");

    expect(resolvePreferredUserDisplayName({ id: "456", globalName: "Global Nick" })).toBe("Global Nick");
    expect(resolvePreferredUserDisplayName({ id: "456", globalName: null })).toBe("456");
  });
});
