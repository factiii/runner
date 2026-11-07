// The rules a secrets backup's passphrase must meet. On their own, away from
// secrets-backup.ts, so the form in the app can check them without pulling the
// runner's crypto into a browser bundle.

/** Longer than a board password has to be: this one guards a file that leaves
 *  the machine, with no guess limit once it has. */
const MIN_BACKUP_PASSPHRASE = 12;

/** '' when the passphrase may seal a backup. Shared with the form. */
export function backupPassphraseProblem(
  passphrase: string,
  boardPassword: string
): string {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE) {
    return `The backup passphrase needs at least ${MIN_BACKUP_PASSPHRASE} characters.`;
  }
  if (passphrase === boardPassword) {
    // The point of a second one: a leaked board password must not also open
    // every backup ever made.
    return 'The backup passphrase must differ from the board password.';
  }
  return '';
}

/** A value shorter than this shows no tail at all: four characters of a short
 *  one is most of it. */
const MIN_LENGTH_FOR_TAIL = 12;
const TAIL = 4;

/** How a secret is drawn on screen: never whole. Its last four characters,
 *  enough to tell two keys apart, or only dots when it is too short for that
 *  to be safe. The full value is copied, never rendered. */
export function maskedSecret(value: string): string {
  const dots = '••••••••';
  if (value.length < MIN_LENGTH_FOR_TAIL) return dots;
  return `${dots}${value.slice(-TAIL)}`;
}
