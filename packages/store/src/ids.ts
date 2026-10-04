const SAFE_SAVE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function assertSafeSaveId(saveId: string): void {
  if (typeof saveId !== "string" || !SAFE_SAVE_ID.test(saveId) || saveId.includes("..")) {
    throw new Error(
      `Invalid save id ${JSON.stringify(saveId)}: use 1-64 letters, digits, "_", "." or "-", starting with a letter or digit`,
    );
  }
}
