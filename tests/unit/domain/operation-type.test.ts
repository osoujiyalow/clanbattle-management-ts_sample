import { describe, expect, it } from "vitest";

import {
  OPERATION_TYPE_DESCRIPTION,
  OperationType,
} from "../../../src/domain/operation-type.js";

describe("OperationType", () => {
  it("keeps the Python operation identifiers", () => {
    expect(OperationType.ATTACK_DECLAR).toBe("ATTACK_DECLAR");
    expect(OperationType.ATTACK).toBe("ATTACK");
    expect(OperationType.LAST_ATTACK).toBe("LAST_ATTACK");
    expect(OperationType.PROGRESS_LAP).toBe("PROGRESS_LAP");
  });

  it("maps each operation type to the expected description", () => {
    expect(OPERATION_TYPE_DESCRIPTION[OperationType.ATTACK_DECLAR]).toBe("凸宣言");
    expect(OPERATION_TYPE_DESCRIPTION[OperationType.ATTACK]).toBe("ボスへの凸");
    expect(OPERATION_TYPE_DESCRIPTION[OperationType.LAST_ATTACK]).toBe("ボスの討伐");
    expect(OPERATION_TYPE_DESCRIPTION[OperationType.PROGRESS_LAP]).toBe("周の進行");
  });
});
