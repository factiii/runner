import readline from 'readline';

/**
 * Read a password from the terminal without echoing it.
 *
 * Muted by intercepting the readline output stream rather than by raw-mode
 * key handling, so Ctrl-C, backspace and paste keep working as the terminal
 * already defines them.
 *
 * Returns '' when there is no TTY (systemd, launchd, a CI container) - callers
 * treat that as "nobody is here to type it" and carry on locked.
 */
export function promptPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  // The prompt itself must print; everything after it must not.
  let muted = false;
  const write = (
    rl as unknown as { _writeToOutput: (text: string) => void }
  )._writeToOutput.bind(rl);
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput =
    (text: string) => {
      if (!muted) write(text);
    };

  return new Promise<string>((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

/**
 * Read one visible line from the terminal (a 6-digit code, a yes/no).
 *
 * Returns '' when there is no TTY, like `promptPassword`: an agent or a CI
 * step cannot answer, and the caller says what a person must run instead.
 */
export function promptLine(label: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise<string>((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
