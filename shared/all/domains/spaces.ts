import { type RouterInputs, type RouterOutputs } from './trpc';

export type SpaceMembership = Exclude<Space['membership'], undefined>;
export type Space = RouterOutputs['spaces']['get'];
export type SearchedSpace = RouterOutputs['search']['spaces']['spaces'][0];
export type SpaceCard = RouterOutputs['spaces']['suggested']['spaces'][0];
export type SpaceHistoryItem = RouterOutputs['spaces']['history']['history'][0];
export type SpaceHistoryItemProps =
  RouterOutputs['spaces']['history']['currentData'] & {
    //Front end only
    date: Date | 'current';
  };
export type SpaceOptionsSend = RouterInputs['spaces']['updateOptions'];
export type Rule = Omit<Space['rules'][0], 'spaceId'>;
export type InheritedRuleTier =
  RouterOutputs['spaces']['inheritedRules']['tiers'][0];

// The one-line shorthand for a rule set applied from above.
export const inheritedRuleTierLabel = (tier: InheritedRuleTier) =>
  tier.source === 'SITEWIDE'
    ? 'Sitewide rules enforced'
    : `Rules follow s/${tier.spaceSlug}`;

export type SpaceOptions = {
  name: string;
  isPrivate: boolean;
  isPremium: boolean;
  isPaid: boolean;
  isInvite: boolean;
};

export enum MessageVisibility {
  ALL_MESSAGES = 'ALL_MESSAGES',
  SPACE_SPECIFIC = 'SPACE_SPECIFIC'
}

export enum ModerationScope {
  ALL_FACTIII = 'ALL_FACTIII',
  SPACE_SPECIFIC = 'SPACE_SPECIFIC'
}

export enum SpaceRenderType {
  USER_FACING = 'USER_FACING',
  SPACE_FACING = 'SPACE_FACING',
  BOTH = 'BOTH'
}

// Which layout a space opens on (SpaceConfig.defaultLayout). Either is
// reachable from the space header, so this only picks the first one shown.
export enum LayoutType {
  Space = 'Space',
  Board = 'Board'
}

// Whether this deployment serves the whole site or one space
// (NEXT_PUBLIC_SPACE_CONFIG.layoutType). Used to be read off the space's own
// row, which is how 'Home' ended up in LayoutType; the config moved to env in
// May 2025 and the value belongs here now.
export enum DeploymentLayout {
  Home = 'Home',
  Space = 'Space'
}

// The space a client is standing in: the one in the route (`/s/<slug>`, web
// only), otherwise the deployment's own when it is one space's site
// (healthiii.com). Undefined on factiii.com outside a space page. The tag
// picker scopes to it and the other `search.factiiis` callers rank it first.
export const getInstanceSpaceSlug = (
  config: { layoutType: DeploymentLayout; space: { slug: string } },
  pathname?: string | null
): string | undefined =>
  pathname?.match(/^\/s\/([^/]+)/)?.[1] ??
  (config.layoutType === DeploymentLayout.Space
    ? config.space.slug
    : undefined);

export enum SpaceMemberRoles {
  OWNER = 'OWNER',
  MODERATOR = 'MODERATOR',
  MEMBER = 'MEMBER',
  INVITED = 'INVITED'
}

export enum Types {
  PREMIUM = 'PREMIUM',
  INVITE = 'INVITE',
  PAID = 'PAID',
  PRIVATE = 'PRIVATE'
}

/**
 * Which spaces a space picker offers. `moderated` is the spaces you own or
 * moderate (`spaces.myModerated`, for a factiii's space); `member` is every
 * space you are a member of and can post into (`spaces.postable`, for a post
 * such as a screen recording).
 */
export type SpacePickerScope = 'moderated' | 'member';

/** What a space picker says when it has nothing to offer, web and phone. */
export const SPACE_PICKER_EMPTY_TEXT: Record<
  SpacePickerScope,
  { none: string; noMatch: string }
> = {
  moderated: {
    none: "You don't moderate any spaces yet.",
    noMatch: 'No spaces you moderate match.'
  },
  member: {
    none: "You aren't in any space you can post to yet.",
    noMatch: 'None of your spaces match.'
  }
};
