import { z } from 'zod';

import { APP_SLUGS } from './domains/apps';
import { MIN_THRESHOLD_TRONS } from './domains/autoTopUp';
import { FactiiiRequirement } from './domains/factiiis';
import {
  MAX_TRANSCRIPT_CHARS,
  TITLE_TRANSCRIPT_CHARS,
  TRANSCRIBE_MAX_SECONDS
} from './domains/mediaTranscript';
import { PASSWORD_CODE_LENGTH } from './domains/passwordCode';
import {
  isValidTimeZone,
  MAX_POSTS_PER_DAY,
  MINUTES_PER_DAY
} from './domains/scheduledPosts';
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_DESCRIPTION_MIN,
  SKILL_TITLE_MAX,
  SKILL_TITLE_MIN
} from './domains/skills';
import { LayoutType } from './domains/spaces';
import { UserType } from './domains/user';
import { WATCH_PROGRESS_MAX_SECONDS } from './domains/watchProgress';
import { ALLOWED_CONTENT_TYPES_TUPLE } from './uploadTypes';

const usernameValidationRegex = /^[a-zA-Z0-9_]+$/;

export const MIN_PASSWORD_LENGTH = 8;

export const signupSchema = z.object({
  username: z.string().min(1).regex(usernameValidationRegex, {
    message: 'Username can only contain letters, numbers, and underscores'
  }),
  email: z.string().email(),
  password: z
    .string()
    .min(8, { message: 'Password must contain at least 8 characters' }),
  types: z.array(z.nativeEnum(UserType)),
  referrerUserId: z.number().optional(),
  instanceId: z.number()
});

export const usernameSchema = z.string().min(1).regex(usernameValidationRegex, {
  message: 'Username can only contain letters, numbers, and underscores'
});

// Fields shared by every username-first signup path (passkey + password). Email
// is deliberately absent — username-only accounts add an email later.
const baseRegisterSchema = z.object({
  username: usernameSchema,
  types: z.array(z.nativeEnum(UserType)).default([]),
  referrerUserId: z.number().optional(),
  instanceId: z.number(),
  platform: z.enum(['web', 'mobile']).optional(),
  // Which app is registering. Names the session it creates, the same way the
  // package's own routes do (apps/server/src/auth/config.ts → `app`). Absent
  // means factiii.
  app: z.enum(['oakbox-ios', 'oakbox-android', 'oakbox-web']).optional()
});

// Password path: username + password, no email. reCAPTCHA still enforced server-side.
export const passwordRegisterSchema = baseRegisterSchema.extend({
  password: z
    .string()
    .min(8, { message: 'Password must contain at least 8 characters' }),
  recaptchaToken: z.string().optional()
});

// The emailed code that proves the inbox before a password is set or changed
// from Oakbox's Account screen (.specs/oakbox-email-login.md → Password). The
// server adds the password field from @factiii/auth's own `resetPasswordSchema`,
// so the password rules stay the package's.
export const passwordCodeSchema = z.object({
  code: z.string().regex(new RegExp(`^\\d{${PASSWORD_CODE_LENGTH}}$`), {
    message: 'Enter the 6-digit code from the email.'
  })
});

export const createSourceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  requirements: z.array(
    z.enum([
      FactiiiRequirement.GOVERNMENT_SOURCE,
      FactiiiRequirement.ENTERPRISE_SOURCE,
      FactiiiRequirement.ANONYMOUS_SOURCE,
      FactiiiRequirement.HUMAN_SOURCE
    ])
  )
});

export const contactFormSchema = z
  .object({
    name: z.string().min(1).max(100),
    email: z.string().max(254).optional(),
    phone: z.string().max(20).optional(),
    message: z.string().min(1).max(2000),
    age: z.string().optional()
  })
  .refine((data) => !!data.email || !!data.phone, {
    message: 'Either email or phone is required'
  });

export const donationSchema = z.object({
  amount: z.number().int().min(100).max(1000000), // Amount in cents (integer)
  email: z.string().email()
});

// Step 1: get TWO presigned PUTs (raw + view) plus a created Upload row.
//
// Sizes and hashes are declared here, before a URL exists, because both are
// signed into it: the size becomes the exact-length contract that replaces the
// POST policy's content-length-range, and the hash binds the bytes to what the
// client says they are. Compose has already produced both blobs by this point
// (ComposeOutput carries rawSize/viewSize/sha256/viewSha256), so nothing extra
// is computed to satisfy this.
export const getUploadUrlsSchema = z
  .object({
    contentType: z.enum(ALLOWED_CONTENT_TYPES_TUPLE),
    name: z.string().optional(),
    width: z.number().int().positive().max(25000).optional(),
    height: z.number().int().positive().max(25000).optional(),
    isPrivate: z.boolean().optional().default(false),
    // Chat attachments pass the conversation instead of an isPrivate flag: the
    // server resolves privacy from the channel's space so the client can't
    // decide to make a PRIVATE space's files public. See uploads.getUploadUrls.
    conversationId: z.string().guid().optional(),
    // A file for a post. It lands in the private bucket and the post request
    // moves it to the public one if the post is published outside a PRIVATE
    // space. The flag can only make an upload more private: without it the
    // file lands public, as an avatar or a product image must.
    forPost: z.boolean().optional().default(false),
    // A screen recording from /record (.specs/screen-recording.md). Premium
    // only: the server refuses it from anyone else. It has no 100 MB cap; its
    // bytes count against the owner's storage quota instead. Only valid on a
    // post video.
    screenRecording: z.boolean().optional().default(false),
    // The camera factiii this image was captured through, or null. Presence is
    // the watermark signal: the server derives UploadVariant.watermarked from
    // it and rejects a factiii that does not carry the CAMERA requirement.
    // See .specs/watermarking.md.
    cameraFactiiiId: z.number().int().positive().nullable(),
    rawSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'rawSha256 must be 64 hex chars'),
    rawSize: z.number().int().positive(),
    // Images only — a non-image upload has no VIEW variant to presign.
    viewSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'viewSha256 must be 64 hex chars')
      .optional(),
    viewSize: z.number().int().positive().optional()
  })
  .refine((d) => (d.viewSha256 === undefined) === (d.viewSize === undefined), {
    message: 'viewSha256 and viewSize must be provided together'
  })
  .refine(
    (d) =>
      (d.width === undefined && d.height === undefined) ||
      (d.width !== undefined && d.height !== undefined),
    { message: 'width and height must be provided together' }
  );

// Step 2: confirm both PUTs landed; server validates magic bytes + sha256 + variant insert
// How long the shortest trimmed video may be, in seconds. The recorder's trim
// handles keep this gap too (recorderState.ts).
export const MIN_TRIM_SECONDS = 1;

// A trim range on a video, in seconds from its start.
export const videoTrimSchema = z
  .object({
    startSec: z.number().finite().min(0),
    endSec: z.number().finite().positive()
  })
  .refine((trim) => trim.endSec - trim.startSec >= MIN_TRIM_SECONDS, {
    message: `A trim must keep at least ${MIN_TRIM_SECONDS} second.`
  });

// Plain text: no control characters but tab and newline. The client cleans a
// transcript before it sends it (cleanTranscriptText), so this refuses only a
// caller that did not.

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

// A video's or audio file's speech, transcribed on the device before upload
// (.specs/file-vault.md → Speech). Stored as the file's text, source SPEECH.
// `durationSec` is the file's length; `partial` says only its start was heard
// (TRANSCRIBE_MAX_SECONDS) or the recognizer stopped early.
export const mediaTranscriptSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAX_TRANSCRIPT_CHARS)
    .refine((text) => !CONTROL_CHARACTERS.test(text), {
      message: 'A transcript is plain text.'
    }),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .max(35)
    .optional(),
  // A day: a phone video is hours at most, and the cap is on what is heard,
  // not on the file.
  durationSec: z
    .number()
    .finite()
    .nonnegative()
    .max(TRANSCRIBE_MAX_SECONDS * 144),
  partial: z.boolean()
});

// A title for a screen recording from what was said in it
// (.specs/screen-recording.md → Transcript). The client sends the start of its
// transcript; the server asks a small model and charges the caller in Trons.
export const recordingTitleSchema = z.object({
  transcript: z
    .string()
    .trim()
    .min(1)
    .max(TITLE_TRANSCRIPT_CHARS)
    .refine((text) => !CONTROL_CHARACTERS.test(text), {
      message: 'A transcript is plain text.'
    })
});

// A transcript that finished after its file was handed over
// (onedriveEmbed.addTranscript): the job and name the file was finalized
// under, which together are its object key.
export const vaultDropTranscriptSchema = z.object({
  jobId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  transcript: mediaTranscriptSchema
});

export const finalizeUploadSchema = z.object({
  uploadId: z.string(),
  // Same value the client sent to getUploadUrls. The server re-checks the
  // factiii and derives VIEW.watermarked from `cameraFactiiiId !== null`.
  cameraFactiiiId: z.number().int().positive().nullable(),
  raw: z.object({
    // Bare-uuid keys; variant kind is the DB-level discriminator, no key prefix.
    key: z.string().min(1),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional()
  }),
  view: z
    .object({
      key: z.string().min(1),
      size: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
    .nullable(), // null for non-image uploads
  // Cut a video to [startSec, endSec] on the server before it is used
  // (.specs/screen-recording.md → Trim). Premium video uploads only. Absent
  // means the file is kept whole.
  trim: videoTrimSchema.optional(),
  // A video's speech, transcribed on the device (.specs/screen-recording.md →
  // Transcript). A screen recording's is filed in the owner's vault when it is
  // posted; anything else ignores it.
  transcript: mediaTranscriptSchema.optional()
});

// One upload of the caller's, by id (uploads.trimStatus).
export const uploadIdSchema = z.object({ uploadId: z.string().guid() });

// Admin storage waiver (.specs/uploads.md → "Admin storage waiver"): the
// charged uploads of one post, and waiving or un-waiving one of them.
// `postId` is the post's uuid, the id every post DTO carries.
export const adminPostUploadStorageSchema = z.object({
  postId: z.string().uuid()
});
export const adminSetUploadStorageWaiverSchema = z.object({
  uploadId: z.string().guid(),
  waived: z.boolean()
});

// Purchase validation schemas
export const checkPurchaseSchema = z.object({
  productId: z.string(),
  type: z.enum(['STRIPE', 'GOOGLE', 'APPLE']),
  receivedPrice: z
    .number()
    .int()
    .min(0, 'Received price must be a positive integer in cents'),
  currency: z.string().length(3).default('USD'),
  // Explicit consent to keep this card for auto top-up. Card-network rules
  // require the buyer to agree before a card may be charged while they are not
  // present, so this must come from a checkbox they ticked — never a default.
  saveCardForAutoTopUp: z.boolean().default(false),
  // The buyer read that Apple or Google goes on billing their store plan — we
  // cannot stop it — and ticked that they will cancel it themselves. Web
  // only, and only ever from that checkbox; without it a web purchase over a
  // renewing store plan is refused, so they cannot pay twice by accident.
  acknowledgeStoreBilling: z.boolean().default(false),
  // WHICH APP is buying. The shop and the till must agree (.specs/products.md):
  // the catalogue lists a product only where it has a store listing for the
  // asking app, so the till has to refuse the same product on the same rule —
  // otherwise a client that names a product by id buys one it was never shown.
  app: z.enum(APP_SLUGS)
});

export const creditPurchaseSchema = z.object({
  orderId: z.string(),
  transactionDate: z.number(),
  receivedPrice: z
    .number()
    .int()
    .min(0, 'Received price must be a positive integer in cents'),
  type: z.enum(['STRIPE', 'GOOGLE', 'APPLE']),
  secret: z.string(),
  // Required for APPLE/GOOGLE IAP — used for server-side receipt verification
  purchaseToken: z.string().optional(),
  // WHICH APP is crediting. A product carries a different SKU per app, so this
  // decides which SKU the store is asked about.
  app: z.enum(APP_SLUGS)
});

export const dsarFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Please enter your name.')
    .max(100, 'Please keep your name under 100 characters.'),
  email: z
    .string()
    .trim()
    .min(1, 'Please enter your email address.')
    .email('Please enter a valid email address.'),
  selectedAs: z.enum(['person', 'agent']),
  requestUnder: z.enum(['GDPR', 'CCPA', 'OTHER']),
  selectedTo: z.enum(['knowledge', 'delete', 'optOut', 'optIn', 'other']),
  details: z
    .string()
    .trim()
    .min(1, 'Please provide details about your request.')
    .max(5000, 'Please keep details under 5000 characters.'),
  confirmAccuracy: z
    .boolean()
    .refine((value) => value, 'Please confirm your information is accurate.'),
  confirmConsequences: z
    .boolean()
    .refine(
      (value) => value,
      'Please acknowledge the deletion/restriction consequences.'
    ),
  confirmVerification: z
    .boolean()
    .refine((value) => value, 'Please acknowledge the email verification step.')
});

export type DSARFormInput = z.infer<typeof dsarFormSchema>;

// Zod validator for map link parameters
export const mapLinkSchema = z.object({
  startPosition: z.object({
    postId: z.string().optional(),
    latitude: z
      .number()
      .min(-90)
      .max(90, { message: 'Latitude must be between -90 and 90' }),
    longitude: z
      .number()
      .min(-180)
      .max(180, { message: 'Longitude must be between -180 and 180' })
  }),
  pins: z
    .array(
      z.object({
        postId: z.string().uuid({ message: 'Pin ID must be a valid UUID' }),
        latitude: z
          .number()
          .min(-90)
          .max(90, { message: 'Pin latitude must be between -90 and 90' }),
        longitude: z
          .number()
          .min(-180)
          .max(180, { message: 'Pin longitude must be between -180 and 180' })
      })
    )
    .optional()
    .default([])
});

export const mapLinkHref = mapLinkSchema.transform((data) => {
  const latParam = `latitude=${encodeURIComponent(data.startPosition.latitude)}`;
  const lonParam = `longitude=${encodeURIComponent(
    data.startPosition.longitude
  )}`;
  const pinsParam =
    data.pins.length > 0
      ? `pins=${encodeURIComponent(JSON.stringify(data.pins))}`
      : '';
  return {
    startPosition: {
      postId: data.startPosition.postId,
      latitude: data.startPosition.latitude,
      longitude: data.startPosition.longitude
    },
    href: `${data.startPosition.postId ? `postId=${data.startPosition.postId}&` : ''}${latParam}&${lonParam}${pinsParam ? `&${pinsParam}` : ''}`
  };
});

// Only http(s) URLs count as links to render. Other schemes (emb:, mailto:,
// javascript:) parse as valid URLs but must never be shown as clickable sources.
export const isUrl = (str: string) => {
  try {
    const { protocol } = new URL(str);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

// Wikipedia-specific URL validation
export const wikipediaUrlSchema = z.string().refine(
  (url) => {
    try {
      const parsedUrl = new URL(url);
      // Check if it's a valid Wikipedia URL
      return (
        parsedUrl.hostname.endsWith('.wikipedia.org') &&
        parsedUrl.protocol === 'https:' &&
        parsedUrl.pathname.startsWith('/wiki/') &&
        parsedUrl.pathname.length > 6 // Must have content after /wiki/
      );
    } catch {
      return false;
    }
  },
  {
    message:
      'Invalid Wikipedia URL. Must be a valid HTTPS URL from wikipedia.org with /wiki/ path and article title'
  }
);

// Enhanced URL validation with better error messages
export const validateWikipediaUrl = (
  url: string
): { isValid: boolean; error?: string } => {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== 'https:') {
      return { isValid: false, error: 'URL must use HTTPS protocol' };
    }

    if (!parsedUrl.hostname.endsWith('.wikipedia.org')) {
      return {
        isValid: false,
        error:
          'URL must be from a wikipedia.org subdomain (e.g., en.wikipedia.org)'
      };
    }

    if (!parsedUrl.pathname.startsWith('/wiki/')) {
      return { isValid: false, error: 'URL must have /wiki/ path structure' };
    }

    if (parsedUrl.pathname.length <= 6) {
      return {
        isValid: false,
        error: 'URL must have an article title after /wiki/'
      };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Invalid URL format' };
  }
};

// General URL validation for any root URL
export const validateUrlForRoot = (
  url: string,
  rootUrl: string
): { isValid: boolean; error?: string } => {
  try {
    const parsedUrl = new URL(url);
    const parsedRootUrl = new URL(rootUrl);

    if (parsedUrl.protocol !== 'https:') {
      return {
        isValid: false,
        error: 'URL must use HTTPS protocol'
      };
    }

    // Check if the URL is from the same domain as the root URL
    if (parsedUrl.hostname !== parsedRootUrl.hostname) {
      return {
        isValid: false,
        error: `URL must be from the same domain as ${parsedRootUrl.hostname}`
      };
    }

    // Check if the URL path starts with the root URL path
    if (!parsedUrl.pathname.startsWith(parsedRootUrl.pathname)) {
      return {
        isValid: false,
        error: `URL path must start with ${parsedRootUrl.pathname}`
      };
    }

    // Ensure the URL has content after the root path
    const rootPathLength = parsedRootUrl.pathname.length;
    if (parsedUrl.pathname.length <= rootPathLength) {
      return {
        isValid: false,
        error: 'URL must have content after the root path'
      };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Invalid URL format' };
  }
};

// Generic URL validation (basic format check)
export const validateUrlFormat = (
  url: string
): { isValid: boolean; error?: string } => {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== 'https:') {
      return {
        isValid: false,
        error: 'URL must use HTTPS protocol'
      };
    }

    if (!parsedUrl.hostname) {
      return {
        isValid: false,
        error: 'URL must have a valid hostname'
      };
    }

    if (!parsedUrl.pathname) {
      return {
        isValid: false,
        error: 'URL must have a valid path'
      };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Invalid URL format' };
  }
};

export const productSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  createdAt: z.date(),
  active: z.boolean(),
  originalInventory: z
    .number()
    .optional()
    .nullable()
    .transform((val) => (val === undefined ? null : val)),
  inventory: z.number(),
  discount: z.number(),
  type: z.enum(['TRON', 'MONTHLY_SUBSCRIPTION', 'FOUNDERS_TOKEN', 'DONATION']),
  // Gigabytes an Oakbox storage plan grants while its subscription is paid
  // (helpers/seedOakbox.ts). Null on every other product, and the thing that
  // makes a subscription a storage plan at all: `storagePlans` lists on "not
  // null" and the vault quota reads the number, so a plan without it is
  // invisible to the app and grants no room. Optional so the rest of the admin
  // form can leave it alone, like originalInventory above.
  storageGb: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .transform((val) => (val === undefined ? null : val)),
  spaceSlug: z.string(),
  images: z.array(z.string()),
  // Trons granted to the buyer on purchase + premium days granted. Only meaningful
  // for TRON and FOUNDERS_TOKEN; other product types ignore these. Optional so the
  // admin form can omit them when editing subscription/donation rows.
  tronQuantity: z.number().int().min(0).optional(),
  tronPremiumDays: z.number().int().min(0).optional()
});

export const adminTransferSpaceOwnershipSchema = z.object({
  spaceId: z.number(),
  newOwnerUserId: z.number()
});

/** Cards a board column loads at a time on web (BoardList), and the most a
 *  page may ask for. */
export const BOARD_PAGE_SIZE = 40;
const BOARD_PAGE_SIZE_MAX = 100;

const baseSchema = {
  cursor: z.union([z.string(), z.number()]).optional(),
  type: z.enum(['new', 'trending', 'popular', 'board']).optional(),
  filterBots: z.boolean().optional(),
  // Omitted = show; hiding new accounts is opt-in via the quick filter.
  filterNewAccounts: z.boolean().optional(),
  showBoards: z.boolean().optional(),
  factiiiIds: z.number().array().optional(),
  strictFactiiiIds: z.number().array().optional(), //used for getting posts by relatedfactiiicountgroup
  dataFilter: z.string().optional(),
  start: z.date().optional(),
  end: z.date().optional(),
  // A board column (type 'board') in pages of this many cards, with
  // nextCursor, nextPos and total in the answer. Omitted = the whole column,
  // which is what shipped apps and the board MCP still ask for.
  boardPageSize: z.number().int().min(1).max(BOARD_PAGE_SIZE_MAX).optional()
};

export const postFeedInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('home'),
    ...baseSchema
  }),
  z.object({
    source: z.literal('explore'),
    ...baseSchema
  }),
  z.object({
    source: z.literal('user'),
    username: z.string(),
    // The author's "show archived" view: only their ARCHIVED posts. Ignored on
    // anyone else's profile.
    archived: z.boolean().optional(),
    ...baseSchema
  }),
  z.object({
    source: z.literal('space'),
    spaceSlug: z.string(),
    spaceRenderType: z.enum(['USER_FACING', 'SPACE_FACING', 'BOTH']).optional(),
    ...baseSchema
  }),
  z.object({
    source: z.literal('saved'),
    ...baseSchema
  }),
  z.object({
    source: z.literal('factiiis'),
    ...baseSchema
  }),
  // Every anonymous post, author masked. Backs /user/Anonymous%20User, which is
  // where anonymous posts' author links point.
  z.object({
    source: z.literal('anonymous'),
    ...baseSchema
  }),
  z.object({
    source: z.literal('search'),
    query: z.string().optional(),
    spaceRenderType: z.enum(['USER_FACING', 'SPACE_FACING', 'BOTH']).optional(),
    userIds: z.number().array().optional(),
    spaceIds: z.number().array().optional(),
    ...baseSchema
  })
]);

export type PostFeedInput = z.infer<typeof postFeedInputSchema>;

// posts.setArchived: the author archives a PUBLISHED post or restores it.
export const postSetArchivedInputSchema = z.object({
  postId: z.string(),
  archived: z.boolean()
});

// posts.restore and posts.restorable: the author taking back their own delete
// inside the restore window. `postId` is the uuid or the slug.
export const postRestoreInputSchema = z.object({
  postId: z.string()
});

// spaces.my: the spaces the caller is a member of, pinned first, then the
// last visited. `search` narrows by name or slug; `defaultLayout` keeps only
// the spaces that open on that layout (the terminal window's board search
// passes Board). `recent` orders by last visited alone, pins ignored (the
// launcher's board picker). `cursor` is the last row's `membershipId`.
export const mySpacesInputSchema = z.object({
  cursor: z.number().optional(),
  search: z.string().optional(),
  defaultLayout: z.nativeEnum(LayoutType).optional(),
  recent: z.boolean().optional()
});

// board.moveTargets: the boards a card of `spaceSlug` can be moved to. With
// `fromColumnId`, also how many cards of that list `moveAllCards` would move.
export const boardMoveTargetsInputSchema = z.object({
  spaceSlug: z.string(),
  fromColumnId: z.number().optional()
});

// The board team of a space and its team-only lists (.specs/spaces.md →
// "Board team"). Owner and moderators only.
export const boardSetTeamMemberInputSchema = z.object({
  spaceSlug: z.string(),
  userId: z.number().int().positive(),
  onTeam: z.boolean()
});

export const boardSetListTeamOnlyInputSchema = z.object({
  spaceSlug: z.string(),
  listId: z.number().int().positive(),
  teamOnly: z.boolean()
});

// A card id as the board MCP tools take it (apps/server/src/mcp/board.ts): the
// post's full uuid. Checked before the id reaches a query, because Postgres
// refuses anything else for the uuid column and the database error that comes
// back says nothing an agent can act on.
export const boardCardIdSchema = z
  .string()
  .uuid({ message: "postId must be the card's full uuid" });

// board.moveCardToBoard: one card (post uuid) leaves its board for a list of
// another board.
export const boardMoveCardToBoardInputSchema = z.object({
  postId: z.string(),
  toSpaceSlug: z.string(),
  toColumnId: z.number()
});

// board.moveAllCards: every card of the list `fromColumnId` of `spaceSlug`
// goes to one list of another board.
export const boardMoveAllCardsInputSchema = z.object({
  spaceSlug: z.string(),
  fromColumnId: z.number(),
  toSpaceSlug: z.string(),
  toColumnId: z.number()
});

// postWatch.status: whether the viewer watches one board card (post uuid).
export const postWatchStatusInputSchema = z.object({
  postId: z.string()
});

// postWatch.set: Watch / Unwatch one board card. Unwatch keeps a muted row, so
// nothing re-creates the watch (.specs/notifications.md → Card watch).
export const postWatchSetInputSchema = z.object({
  postId: z.string(),
  watching: z.boolean()
});

// watchProgress.get: where the viewer stopped in one video (upload id).
export const watchProgressGetInputSchema = z.object({
  uploadId: z.string().uuid()
});

// watchProgress.save: the viewer's position in one video, in whole seconds.
// `0` clears it: near the start, or finished (.specs/uploads.md → "Resume
// where you stopped"). The client decides which (domains/watchProgress.ts).
export const watchProgressSaveInputSchema = z.object({
  uploadId: z.string().uuid(),
  seconds: z.number().int().min(0).max(WATCH_PROGRESS_MAX_SECONDS)
});

// messages.restoreMessage: the sender takes back a delete inside the window.
export const messageRestoreInputSchema = z.object({
  messageId: z.number()
});

// --- Trons community pool ---

// Donate trons from the user's own balance into the shared community pool.
export const donateTronsSchema = z.object({
  amount: z.number().int().positive()
});

const communityPoolModeSchema = z.enum(['OFF', 'WHITELIST', 'OPEN']);

// Admin config: access mode + the two 4h-window tron spend caps.
export const communityPoolConfigSchema = z.object({
  mode: communityPoolModeSchema,
  userCapPer4h: z.number().int().min(0),
  poolCapPer4h: z.number().int().min(0)
});

// --- Cross-posting ---

export const crossPostPlatformEnum = z.enum([
  'TIKTOK',
  'YOUTUBE',
  'INSTAGRAM',
  'FACEBOOK',
  'TWITTER',
  'LINKEDIN',
  'REDDIT'
]);
export type CrossPostPlatform = z.infer<typeof crossPostPlatformEnum>;

// scheduledFor: hold the cross-post until this time instead of posting now.
// A time in the past is treated as "post now" by the server.
export const crossPostSubmitSchema = z.object({
  postId: z.string(),
  platforms: z.array(crossPostPlatformEnum).min(1).max(5),
  scheduledFor: z.coerce.date().optional()
});

// crosspost.rescheduleCrossPost: a new time for a cross-post still waiting.
export const crossPostRescheduleSchema = z.object({
  crossPostId: z.number().int().positive(),
  scheduledFor: z.coerce.date()
});

// Scheduled posts (.specs/scheduled-posts.md)
const MAX_SCHEDULED_PLATFORMS = 5;

export const postScheduleRuleSchema = z
  .object({
    postsPerDay: z.number().int().min(1).max(MAX_POSTS_PER_DAY),
    windowStartMinute: z
      .number()
      .int()
      .min(0)
      .max(MINUTES_PER_DAY - 1),
    windowEndMinute: z.number().int().min(1).max(MINUTES_PER_DAY),
    timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone')
  })
  // Each post needs at least a minute of the window to itself.
  .refine((r) => r.windowEndMinute - r.windowStartMinute >= r.postsPerDay, {
    message: 'The window is too short for that many posts',
    path: ['windowEndMinute']
  });

export const schedulePostSchema = z.object({
  postId: z.string(),
  platforms: z
    .array(crossPostPlatformEnum)
    .max(MAX_SCHEDULED_PLATFORMS)
    .default([]),
  // Left out, the post takes the next free slot of the auto schedule.
  scheduledFor: z.coerce.date().optional(),
  // The author's zone, so a first schedule lands at 9am their time.
  timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone').optional()
});

export const scheduledPostTimeSchema = z.object({
  postId: z.string(),
  scheduledFor: z.coerce.date()
});

export const scheduledPostIdSchema = z.object({ postId: z.string() });

export const apiCostUpdateSchema = z.object({
  platform: crossPostPlatformEnum,
  readCostTrons: z.number().int().min(0),
  pushCostTrons: z.number().int().min(0),
  // Added to the push when the text sent contains a URL (X bills link posts higher).
  urlSurchargeTrons: z.number().int().min(0),
  costSource: z.enum(['manual', 'api']),
  notes: z.string().max(500).optional()
});
// Fact or Fiction game
export const startSessionSchema = z.object({
  isDaily: z.boolean().default(false)
});

export const submitAnswerSchema = z.object({
  sessionId: z.number().int(),
  postId: z.number().int(),
  answeredFact: z.boolean(),
  timeMs: z.number().int().min(0).max(15000)
});

export const endSessionSchema = z.object({
  sessionId: z.number().int()
});

export const getLeaderboardSchema = z.object({
  period: z.enum(['daily', 'weekly', 'allTime']),
  limit: z.number().int().min(1).max(50).default(50)
});

export const getSessionResultSchema = z.object({
  sessionId: z.number().int()
});

/* ---------------------------------- Arcade --------------------------------- */

/** Element names are matched against existing rows, so bound the input length. */
const forgeElementName = z.string().trim().min(1).max(24);

export const forgeCombineSchema = z.object({
  a: forgeElementName,
  b: forgeElementName
});

export const forgeLeaderboardSchema = z.object({
  limit: z.number().int().min(1).max(50).default(25)
});

/** Registry slugs for the arcade games that keep a score. */
export const arcadeGameSlug = z.enum([
  'circle',
  'password',
  'forge',
  'spend',
  'dilemmas',
  'clicker',
  'deep',
  'robot',
  'space'
]);

export const recordGameStatSchema = z.object({
  game: arcadeGameSlug,
  /** Canonical sortable score for that game; direction is decided client-side. */
  best: z.number().finite(),
  /** Per-game extras, kept small — this lands in a JSON column. */
  detail: z.record(z.string(), z.union([z.string(), z.number()])).optional()
});

export const dilemmaVoteSchema = z.object({
  dilemmaId: z.number().int().min(1).max(200),
  pulled: z.boolean()
});

// ── Agent skills (SKILL.md) ──
// The Agent Skills standard (agentskills.io/specification) plus what the two
// CLIs add, so one editor serves both. The standard's fields are {name,
// description, license, compatibility, metadata, allowed-tools}; Claude Code
// additionally honours `model`. Codex (0.144) allows exactly {name,
// description, license, allowed-tools, metadata} and rejects anything else.
// `disable-model-invocation` is recognised by Codex but must be false, so it is
// parsed and preserved rather than offered as an editable field.

/** The standard's skill name: lowercase letters, digits and single hyphens,
 *  neither leading nor trailing (`prod-check`, not `Prod_Check` or `a--b`).
 *  Every NEW skill is held to this; see SKILL_DIR_NAME_REGEX for the ones that
 *  already exist. */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The looser rule this repo used before it followed the standard: any single
 *  path segment of letters, digits, dots, dashes and underscores. Still what an
 *  EXISTING skill is read, edited and deleted by, because hosts already hold
 *  skills named that way and both CLIs still load them: tightening this would
 *  leave such a skill listed but impossible to open or remove. It is also the
 *  path-safety guard (it excludes every separator), so it must never widen. */
export const SKILL_DIR_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/** The standard's caps (agentskills.io/specification). */
export const SKILL_MD_NAME_MAX = 64;
export const SKILL_MD_DESCRIPTION_MAX = 1024;
export const SKILL_MD_COMPATIBILITY_MAX = 500;

/** A skill's directory name, which must also be its frontmatter `name`. Kept
 *  to a single path segment: it is joined onto a skills root on the host.
 *  Parsed with the legacy rule so an existing skill still opens and saves; a
 *  new name is checked against SKILL_NAME_REGEX where it is created. */
const skillNameSchema = z
  .string()
  .min(1)
  .max(SKILL_MD_NAME_MAX)
  .regex(SKILL_DIR_NAME_REGEX, {
    message: 'Use only lowercase letters, numbers and dashes'
  });

// Strict on purpose: Codex hard-fails a skill whose frontmatter carries an
// unrecognised key ("Unexpected key(s) in SKILL.md frontmatter"), so silently
// stripping one here would hide a skill that will not load.
export const skillFrontmatterSchema = z
  .object({
    name: skillNameSchema,
    description: z
      .string()
      .min(1, { message: 'Description is required' })
      .max(SKILL_MD_DESCRIPTION_MAX, {
        message: `Keep the description to ${SKILL_MD_DESCRIPTION_MAX} characters`
      }),
    // Both CLIs accept a comma-separated string or a YAML list; normalised to
    // a list on parse and written back as a list.
    'allowed-tools': z.array(z.string()).optional(),
    model: z.string().optional(),
    license: z.string().optional(),
    // What the skill needs from its environment (a product, system packages,
    // network access), in a sentence. Part of the standard, so a skill
    // installed from skills.sh may carry it.
    compatibility: z.string().min(1).max(SKILL_MD_COMPATIBILITY_MAX).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'disable-model-invocation': z.literal(false).optional()
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

// Auto top-up config (.specs/products.md → "Auto top-up"). Caps are in cents
// and 0 means no ceiling, which the UI discourages but does not forbid.
export const autoTopUpSchema = z.object({
  enabled: z.boolean(),
  productId: z.number().int().positive(),
  thresholdTrons: z.number().int().min(MIN_THRESHOLD_TRONS),
  dailyCapCents: z.number().int().min(0),
  monthlyCapCents: z.number().int().min(0),
  // Alerts. `alertBalanceTrons` is null when the low-balance warning is off;
  // it works independently of `enabled`, since with auto top-up off it is the
  // only safety net there is.
  alertOnTopUp: z.boolean(),
  alertBalanceTrons: z.number().int().min(MIN_THRESHOLD_TRONS).nullable(),
  alertNearCap: z.boolean()
});

// A space read as a blog (apps/server/src/routers/blog.ts). Oakbox reads the
// `oakbox` space this way; any public space could be.
export const blogPostsInputSchema = z.object({
  spaceSlug: z.string().min(1),
  // The uuid of the last post on the previous page.
  cursor: z.string().uuid().optional()
});

export const blogPostInputSchema = z.object({
  spaceSlug: z.string().min(1),
  postId: z.string().uuid()
});

// A research skill as its author submits it (skills.submit, .specs/skills.md).
// The forms parse with it too, so the button is armed only for what the server
// will accept.
export const submitSkillSchema = z.object({
  /** Also the skill's description, which lists and the agent read. */
  title: z.string().trim().min(SKILL_TITLE_MIN).max(SKILL_TITLE_MAX),
  description: z
    .string()
    .trim()
    .min(SKILL_DESCRIPTION_MIN)
    .max(SKILL_DESCRIPTION_MAX)
});

// The same skill, rewritten by its author (skills.edit).
export const editSkillSchema = submitSkillSchema.extend({
  uuid: z.string().uuid()
});
// Shared runner jobs + secrets relay (.specs/runner-secrets-gate.md).
export * from './validators/runnerJobs';
// Body of an embed request to the runner Vault's embedder.
export * from './validators/embed';
// The runner's installable parts (factiii-runner parts, Runner > Parts).
export * from './validators/runnerParts';
export * from './validators/runnerVault';
// Oakbox > Account > Backend: Factiii, a runner, or both.
export * from './validators/oakboxBackend';
// The IDE git panel's writes (bareGitAct, .specs/ide-git-panel.md).
export * from './validators/runnerGit';

// One board-agent GitHub token, sent by a runner to be revoked at GitHub
// (github.revokeToken). Charset and length are GitHub's token formats with
// room to spare; nothing else belongs in a request made with our app secret.
const GITHUB_TOKEN_MAX_LENGTH = 255;
export const githubRevokeTokenSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(GITHUB_TOKEN_MAX_LENGTH)
    .regex(/^[A-Za-z0-9_]+$/, { message: 'Invalid token' })
});
