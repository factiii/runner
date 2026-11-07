import { z } from 'zod';

import { type RouterInputs, type RouterOutputs } from './trpc';

const USER_TAG_VALUES = [
  'HUMAN',
  'BOT',
  'GOVERNMENT',
  'ACADEMIA',
  'BUSINESS',
  'NEW',
  'WAITLIST',
  'VERIFIED'
] as const;
export type UserTagLiteral = (typeof USER_TAG_VALUES)[number];

export interface CookiePayload {
  username: string;
  name: string | null;
  // Null for username-only accounts (passkey/password signup) until they add an email.
  email: string | null;
  tag: UserTagLiteral;
  avatarKey: string | null;
  robohash: string | null;
  hasPassword: boolean;
  hasPasskey: boolean;
  twoFaEnabled: boolean;
  // Linked OAuth providers for multi-method accounts.
  oauthProviders: ('GOOGLE' | 'APPLE')[];
  // Legacy mirror of oauthProviders[0]. Mobile builds already in the wild parse
  // this cookie with a schema that REQUIRES this key, so dropping it would fail
  // their whole payload and sign those users out. Keep emitting it until those
  // builds have aged out, then delete along with the schema entry below.
  oauthProvider: 'GOOGLE' | 'APPLE' | null;
  emailVerificationStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED';
  isPrivate: boolean;
  isIncognito: boolean;
  // Path/outcome that finished onboarding; null = still needs onboarding
  onboardingPath: string | null;
  bio: string | null;
  bannerKey: string | null;
  tronsBalance: number;
  verificationRequestedAt: string | null;
  deletionScheduledAt: string | null;
}

export type DetailsCookiePayload = CookiePayload & {
  userId: number;
  updatedAt: string;
};

export const detailsCookieSchema = z.object({
  userId: z.number(),
  updatedAt: z.string(),
  username: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  tag: z.enum(USER_TAG_VALUES),
  avatarKey: z.string().nullable(),
  robohash: z.string().nullable(),
  hasPassword: z.boolean(),
  // Defaulted so a client cookie minted before these fields existed still parses
  // (the server re-issues it with real values on the next refresh) instead of
  // failing the whole payload and flashing the user as logged out.
  hasPasskey: z.boolean().default(false),
  twoFaEnabled: z.boolean(),
  oauthProviders: z.array(z.enum(['GOOGLE', 'APPLE'])).default([]),
  // Defaulted, not just nullable: a required-but-missing key is what breaks old
  // clients, so this stays parseable once the server stops sending it.
  oauthProvider: z.enum(['GOOGLE', 'APPLE']).nullable().default(null),
  emailVerificationStatus: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED']),
  isPrivate: z.boolean(),
  isIncognito: z.boolean(),
  onboardingPath: z.string().nullable(),
  bio: z.string().nullable(),
  bannerKey: z.string().nullable(),
  tronsBalance: z.number(),
  verificationRequestedAt: z.string().nullable(),
  deletionScheduledAt: z.string().nullable()
});

type _MutualAssignable<X, Y> = [X] extends [Y]
  ? [Y] extends [X]
    ? true
    : 'DetailsCookiePayload has fields missing from detailsCookieSchema'
  : 'detailsCookieSchema has fields missing from DetailsCookiePayload';
const _schemaMatches: _MutualAssignable<
  z.infer<typeof detailsCookieSchema>,
  DetailsCookiePayload
> = true;
void _schemaMatches;

export type DetailsReturn = CookiePayload & {
  id: number;
  isAuthenticated: boolean | null;
};

export type PublicUser = RouterOutputs['users']['publicDetails'];

export type Preferences = RouterOutputs['users']['preferences'];

export type UpdateUserPayload = RouterInputs['users']['updateUser'];

export enum EmailVerificationStatus {
  UNVERIFIED = 'UNVERIFIED',
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED'
}

export type ProfileHistoryItem = {
  key: 'name' | 'username' | 'bio' | 'avatar' | 'banner' | 'robohash';
  value: string;
  date: Date;
};

export enum PreferencesEnum {
  awardsVisibilityPrivate = 'awardsVisibilityPrivate',
  allowProfanity = 'allowProfanity',
  betaAccess = 'betaAccess',
  allowPoliticalContent = 'allowPoliticalContent',
  hidePostsOnProfile = 'hidePostsOnProfile',
  hideProfileHistory = 'hideProfileHistory',
  allowNSFWContent = 'allowNSFWContent',
  publicBeta = 'publicBeta',
  factiiiCountPrivate = 'factiiiCountPrivate'
}

export enum UserType {
  PRIVATE = 'PRIVATE',
  INCOGNITO = 'INCOGNITO',
  PREMIUM = 'PREMIUM',
  PAID = 'PAID',
  INVITE = 'INVITE'
}
