import chalk from 'chalk';
import Table from 'cli-table3';

const VERSION = '0.1.0';

export function info(msg: string): void {
  console.log(`${chalk.cyan('[furlpay]')} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${chalk.green('[✓]')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${chalk.yellow('[⚠]')} ${msg}`);
}

export function error(msg: string): void {
  console.log(`${chalk.red('[✗]')} ${msg}`);
}

export function debug(msg: string): void {
  if (process.env.FURLPAY_DEBUG) {
    console.log(`${chalk.gray('[debug]')} ${msg}`);
  }
}

export function table(headers: string[], rows: string[][]): void {
  const t = new Table({
    head: headers.map((h) => chalk.cyan(h)),
    style: { head: [], border: [] },
  });
  for (const row of rows) {
    t.push(row);
  }
  console.log(t.toString());
}

export function banner(): void {
  const art = chalk.cyan(`
  ╔═══════════════════════════════════════════════╗
  ║   ___         _  ___                          ║
  ║  | __|  _ _ _| || _ \\ __ _  _  _             ║
  ║  | _| || | '_| ||  _// _\` || || |            ║
  ║  |_| \\_,_|_| |_||_|  \\__,_| \\_, |            ║
  ║                              |__/             ║
  ║  Institutional x402 Payment Infrastructure    ║
  ║  v${VERSION}                                       ║
  ╚═══════════════════════════════════════════════╝
`);
  console.log(art);
}
