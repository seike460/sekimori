import { transformSource } from "../src/index.js";

/** transform して manual findings（人手対応が要る構文）だけを返す。 */
export const manualFindings = (src: string) =>
  transformSource(src).findings.filter((f) => f.kind === "manual");
