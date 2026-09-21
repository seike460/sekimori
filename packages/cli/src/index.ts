/** command dispatcher — コマンド追加は `COMMANDS` への 1 エントリで済む。 */
import { runDoctor } from "./commands/doctor.js";
import { runMigrate } from "./commands/migrate.js";
import { PROBE_TEXT, USAGE } from "./usage.js";

type Command = (argv: string[]) => number | Promise<number>;

/** コマンドの正本 — 新しいコマンドの追加はこの表への 1 エントリで済む。 */
const COMMANDS: Readonly<Record<string, Command>> = {
  migrate: runMigrate,
  doctor: runDoctor,
  probe: () => {
    process.stdout.write(PROBE_TEXT);
    return 0;
  },
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  // plain object の添字参照は継承プロパティも拾う（`COMMANDS["toString"]` は関数を
  // 返し unknown-command の契約を破る）— own property に限定する。
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (run === undefined) {
    process.stderr.write(`sekimori: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  return run(rest);
}
