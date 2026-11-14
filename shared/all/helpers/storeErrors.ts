import {
  NO_RUNNER_STORAGE,
  RUNNER_CLOUD_KEY_MISSING,
  RUNNER_CLOUD_SEALING,
  RUNNER_DISK_FULL,
  RUNNER_NO_FFMPEG,
  VAULT_LOCKED,
  VAULT_NEVER_SHARED,
  VAULT_OLLAMA_ONLY,
  VAULT_SEALING
} from '../validators';

// The runner's refusals about its two stores, in plain words for people
// (.specs/vault.md "Friendly errors"): Oakbox web and phone, and Factiii's
// Oakbox Hub tool and runner pages, all show the same title and line for the
// same refusal. The runner's own string stays the thing matched (it is what
// crosses the link), so an app never guesses from a code it was not sent.

/** What the app can offer beside the words: open the Vault's unlock,
 *  Account > Backend to set up private AI, or keep the file on Cloud
 *  instead (a recording's store picker). */
export type StoreErrorAction = 'unlockVault' | 'setUpPrivateAi' | 'useCloud';

export type StoreError = {
  title: string;
  text: string;
  action?: StoreErrorAction;
};

const STORE_ERRORS: { said: string; error: StoreError }[] = [
  {
    said: VAULT_LOCKED,
    error: {
      title: 'Your Vault is locked',
      text: 'Unlock it with your Vault key to open, add or move what is in it. Runner Cloud and the Cloud stay open.',
      action: 'unlockVault'
    }
  },
  {
    said: VAULT_OLLAMA_ONLY,
    error: {
      title: 'Only private AI reads your Vault',
      text: 'Claude and Codex read Runner Cloud, never your Vault. Pick a Local AI model on your computer, or set one up.',
      action: 'setUpPrivateAi'
    }
  },
  {
    said: NO_RUNNER_STORAGE,
    error: {
      title: 'Runner Cloud is empty',
      text: 'Claude and Codex read Runner Cloud only, and nothing is there yet. Add files to Runner Cloud, or move some there with Move to….'
    }
  },
  {
    said: VAULT_NEVER_SHARED,
    error: {
      title: 'A Vault is never shared',
      text: 'Only its owner opens a Vault. Ask them to put what you need in Runner Cloud, which they can share with you.'
    }
  },
  {
    said: RUNNER_CLOUD_KEY_MISSING,
    error: {
      title: 'Runner Cloud is closed',
      text: 'Your computer cannot read the key Runner Cloud is encrypted with, so it keeps it closed. Nothing was deleted. Check the runner on that computer.'
    }
  },
  {
    said: RUNNER_CLOUD_SEALING,
    error: {
      title: 'Encrypting Runner Cloud',
      text: 'Your computer is encrypting Runner Cloud. Try again in a minute.'
    }
  },
  {
    said: RUNNER_DISK_FULL,
    error: {
      title: 'Your computer is out of room',
      text: 'Its disk has no space for this file. Free up space there, or keep it on Cloud instead.',
      action: 'useCloud'
    }
  },
  {
    said: RUNNER_NO_FFMPEG,
    error: {
      title: 'Your computer cannot trim it',
      text: 'Trimming a recording kept on your computer needs ffmpeg there (brew install ffmpeg). Post it untrimmed, or keep it on Cloud, which trims it.',
      action: 'useCloud'
    }
  },
  {
    said: VAULT_SEALING,
    error: {
      title: 'Encrypting your Vault',
      text: 'Your computer is encrypting your Vault. Try again in a moment.'
    }
  }
];

/** The friendly words for a runner refusal about its stores, or null for any
 *  other message. Matched by prefix, as the runner may add a reason. */
export function friendlyStoreError(
  message: string | null | undefined
): StoreError | null {
  if (!message) return null;
  return (
    STORE_ERRORS.find(({ said }) => message.startsWith(said))?.error ?? null
  );
}

/** What a shown line offers, whether it is the runner's own string or the
 *  friendly line `storeErrorText` made of it. */
export const storeErrorAction = (
  shown: string | null | undefined
): StoreErrorAction | null => {
  if (!shown) return null;
  const found = STORE_ERRORS.find(
    ({ said, error }) =>
      shown.startsWith(said) || shown.startsWith(`${error.title}. `)
  );
  return found?.error.action ?? null;
};

/** A message as one line: the friendly words when it is a store refusal,
 *  else the message as it came. */
export const storeErrorText = (message: string): string => {
  const friendly = friendlyStoreError(message);
  return friendly ? `${friendly.title}. ${friendly.text}` : message;
};

/** An error as a toast's title and body: the friendly words, else
 *  `fallbackTitle` over the message as it came. */
export function storeErrorToast(
  err: unknown,
  fallbackTitle: string
): { title: string; text: string } {
  const message = err instanceof Error ? err.message : String(err);
  const friendly = friendlyStoreError(message);
  return friendly
    ? { title: friendly.title, text: friendly.text }
    : { title: fallbackTitle, text: message };
}
