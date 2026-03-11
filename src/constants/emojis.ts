export const EMOJIS = {
  physics: "⚔️",
  magic: "🧙",
  carryover: "☕",
  only: "🚫",
  any: "⚠️",
  taskKill: "💀",
  setting: "📝",
  cancel: "❌",
  reverse: "↩️",
  attack: "☑️",
  lastAttack: "🏁",
  yes: "🙆",
  no: "🙅",
} as const;

export type EmojiKey = keyof typeof EMOJIS;
