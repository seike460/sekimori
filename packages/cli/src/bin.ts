#!/usr/bin/env node
/** executable entry — `main` を呼び unhandled error を exit code へ写す薄い wrapper。 */
import { main } from "./index.js";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
