/** Entry point of the GitHub Action bundle (dist/action.js). */

import { esc, main } from "./action.ts";
import { maskSecrets } from "./security/secrets.ts";

main().catch((err: unknown) => {
  process.stdout.write(
    `::error::${esc(maskSecrets(err instanceof Error ? err.message : String(err)).text)}\n`,
  );
  process.exitCode = 1;
});
