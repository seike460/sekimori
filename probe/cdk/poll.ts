/** `sleep` だけの最小ユーティリティ — poll ループから timing を分離する。 */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
