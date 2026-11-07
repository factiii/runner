// Setting or changing a password from Oakbox's Account screen
// (.specs/oakbox-email-login.md → Password). A live session is not enough: the
// person asks for a code to their confirmed email, then sends the code and the
// new password in one call (`authPassword.requestCode`, `authPassword.setWithCode`).
//
// Platform-free and dependency-free, like emailLogin.ts: the server, the web
// screen and the phone all read these, so the numbers, the sentences and the
// form's states cannot drift between them.

/** Digits in the emailed code. The same length as the sign-in code. */
export const PASSWORD_CODE_LENGTH = 6;

/** Wrong codes one emailed code survives; the last one spends it. */
export const PASSWORD_CODE_MAX_TRIES = 5;

// The package's own limits (`resetPasswordSchema` in @factiii/auth). Checked on
// the client only to answer before the round trip; the server enforces them
// with the package's schema itself.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

/** What the server says for a code that is wrong, spent or expired. */
export const PASSWORD_CODE_INVALID =
  'That code did not work. Check it, or ask for a new one.';

/** What the server says when the account's email was never confirmed. */
export const PASSWORD_NEEDS_CONFIRMED_EMAIL =
  'Confirm your email before setting a password.';

/** What the server says once too many codes or tries were asked for. */
export const PASSWORD_CODE_TOO_MANY =
  'Too many tries. Wait a few minutes, then ask for a new code.';

const SAID_BY_SERVER = new Set([
  PASSWORD_CODE_INVALID,
  PASSWORD_NEEDS_CONFIRMED_EMAIL,
  PASSWORD_CODE_TOO_MANY
]);

/**
 * What a screen says for a refusal: the server's sentence when it is one of
 * the three above, and a plain one for anything else, so a fault's wording
 * never reaches the person.
 */
export const passwordErrorSaid = (message: string | undefined): string =>
  message && SAID_BY_SERVER.has(message)
    ? message
    : 'That did not work. Try again.';

/** The button and the heading: an account with no password sets its first. */
export const passwordActionLabel = (hasPassword: boolean): string =>
  hasPassword ? 'Change password' : 'Set a password';

/** The line under the heading, before anything is asked for. */
export const passwordIntro = (hasPassword: boolean): string =>
  hasPassword
    ? 'You can sign in with your email and a password. To change it, we email you a code first.'
    : 'You sign in with a code we email you. You can add a password as well. We email you a code first, to check it is you.';

/** Said once it is saved. Every other device is signed out by the server. */
export const PASSWORD_SAVED =
  'Password saved. Your other devices were signed out.';

/** Why the control is not offered to an unconfirmed address. */
export const PASSWORD_CONFIRM_EMAIL_FIRST =
  'Confirm your email before you set or change a password.';

/**
 * What is wrong with the two password fields, or null. The same answers the
 * Oakbox reset page gives.
 */
export const passwordProblem = (
  password: string,
  confirm: string
): string | null => {
  if (password.length < PASSWORD_MIN) return 'Use at least 8 characters.';
  if (password.length > PASSWORD_MAX) return 'Use 72 characters or fewer.';
  if (password !== confirm) return 'Those two passwords do not match.';
  return null;
};

// The form both clients draw, as one reducer so web and phone step the same
// way. `closed` is the button alone; `open` is the code and the two fields.
type PasswordFormState = {
  step: 'closed' | 'open';
  // Which call is out: asking for the code, or saving.
  busy: 'request' | 'save' | null;
  code: string;
  password: string;
  confirm: string;
  // How long the server said the code works for, once it has answered.
  expiresInMs: number | null;
  error: string | null;
};

type PasswordFormAction =
  | { type: 'requesting' }
  | { type: 'sent'; expiresInMs: number }
  | { type: 'code'; value: string }
  | { type: 'password'; value: string }
  | { type: 'confirm'; value: string }
  | { type: 'saving' }
  | { type: 'failed'; error: string }
  | { type: 'close' };

export const PASSWORD_FORM_CLOSED: PasswordFormState = {
  step: 'closed',
  busy: null,
  code: '',
  password: '',
  confirm: '',
  expiresInMs: null,
  error: null
};

export const passwordFormReducer = (
  state: PasswordFormState,
  action: PasswordFormAction
): PasswordFormState => {
  switch (action.type) {
    case 'requesting':
      return { ...state, busy: 'request', error: null };
    // A new code replaces the old one on the server, so the typed one goes.
    case 'sent':
      return {
        ...state,
        step: 'open',
        busy: null,
        code: '',
        expiresInMs: action.expiresInMs,
        error: null
      };
    case 'code':
      return {
        ...state,
        code: action.value.replace(/\D/g, '').slice(0, PASSWORD_CODE_LENGTH),
        error: null
      };
    case 'password':
      return { ...state, password: action.value, error: null };
    case 'confirm':
      return { ...state, confirm: action.value, error: null };
    case 'saving':
      return { ...state, busy: 'save', error: null };
    // The form stays as typed, so it can be corrected.
    case 'failed':
      return { ...state, busy: null, error: action.error };
    // Closing, or saved: nothing typed is kept.
    case 'close':
      return PASSWORD_FORM_CLOSED;
  }
};
