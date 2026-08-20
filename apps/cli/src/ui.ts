import pc from 'picocolors';

/**
 * Terminal output.
 *
 * §5 calls a fast first run "a critical adoption factor", and §15.8 makes onboarding the whole
 * adoption funnel. So this module is deliberately dependency-light — no spinner library, no
 * prompt framework — because the CLI's startup time is part of that first impression, and every
 * import is paid before the first character is printed.
 */

const isTty = process.stdout.isTTY === true;
const noColor = process.env.NO_COLOR !== undefined || process.env.KNA_NO_COLOR !== undefined;

/** ESC by code point rather than as a literal control character in the source. */
const ESC = String.fromCharCode(27);
const CLEAR_LINE = `${ESC}[2K\r`;

const paint = {
  dim: (s: string) => (noColor ? s : pc.dim(s)),
  bold: (s: string) => (noColor ? s : pc.bold(s)),
  red: (s: string) => (noColor ? s : pc.red(s)),
  yellow: (s: string) => (noColor ? s : pc.yellow(s)),
  green: (s: string) => (noColor ? s : pc.green(s)),
  cyan: (s: string) => (noColor ? s : pc.cyan(s)),
};

export const ui = {
  ...paint,

  log(message = ''): void {
    process.stdout.write(`${message}\n`);
  },

  info(message: string): void {
    process.stdout.write(`${message}\n`);
  },

  success(message: string): void {
    process.stdout.write(`${paint.green('OK')} ${message}\n`);
  },

  warn(message: string): void {
    process.stderr.write(`${paint.yellow('!')} ${message}\n`);
  },

  error(message: string): void {
    process.stderr.write(`${paint.red('x')} ${message}\n`);
  },

  heading(message: string): void {
    process.stdout.write(`\n${paint.bold(message)}\n`);
  },

  detail(message: string): void {
    process.stdout.write(`${paint.dim(`  ${message}`)}\n`);
  },

  /**
   * Minimal progress line. Falls back to plain lines on a non-TTY so CI logs stay readable —
   * a spinner rendered into a log file is thousands of useless lines.
   */
  progress(label: string): { update: (message: string) => void; done: (message?: string) => void } {
    if (!isTty) {
      process.stdout.write(`${label}...\n`);
      return {
        update: () => undefined,
        done: (message?: string) => {
          if (message) process.stdout.write(`${message}\n`);
        },
      };
    }

    let current = label;
    const frames = ['|', '/', '-', '\\'];
    let frame = 0;
    const timer = setInterval(() => {
      const spinner = paint.cyan(frames[frame++ % frames.length]!);
      process.stdout.write(`${CLEAR_LINE}${spinner} ${current}`);
    }, 100);
    timer.unref();

    return {
      update: (message: string) => {
        current = message;
      },
      done: (message?: string) => {
        clearInterval(timer);
        process.stdout.write(CLEAR_LINE);
        if (message) process.stdout.write(`${paint.green('OK')} ${message}\n`);
      },
    };
  },

  table(rows: Array<[string, string]>, indent = '  '): void {
    const width = Math.max(...rows.map(([k]) => k.length), 0);
    for (const [key, value] of rows) {
      process.stdout.write(`${indent}${key.padEnd(width)}  ${paint.dim(value)}\n`);
    }
  },
};

/**
 * Print an error the way a developer can act on.
 *
 * The pattern throughout: state what happened, then what to do about it. §15.8's "self-service
 * 'why is my repo stale or shallow?' diagnostic" is the same idea applied to a whole command.
 */
export function reportError(error: unknown): void {
  if (error instanceof Error) {
    ui.error(error.message);
    if (process.env.KNA_DEBUG && error.stack) {
      process.stderr.write(`${paint.dim(error.stack)}\n`);
    }
  } else {
    ui.error(String(error));
  }
}
