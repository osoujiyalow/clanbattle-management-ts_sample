export enum OperationType {
  ATTACK_DECLAR = "ATTACK_DECLAR",
  ATTACK = "ATTACK",
  LAST_ATTACK = "LAST_ATTACK",
  PROGRESS_LAP = "PROGRESS_LAP",
}

export const OPERATION_TYPE_DESCRIPTION: Readonly<Record<OperationType, string>> = {
  [OperationType.ATTACK_DECLAR]: "\u51f8\u5ba3\u8a00",
  [OperationType.ATTACK]: "\u30dc\u30b9\u3078\u306e\u51f8",
  [OperationType.LAST_ATTACK]: "\u30dc\u30b9\u306e\u8a0e\u4f10",
  [OperationType.PROGRESS_LAP]: "\u5468\u306e\u9032\u884c",
};
