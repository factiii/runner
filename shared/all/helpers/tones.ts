// The Tone key (.specs/analytics.md "Tone is passive", .specs/auto-tag.md):
// a reader's tone is the Tone of what they read, from the auto-tag Tone
// factiiis. Those are told apart by id, which comes from the server
// (`stats.toneConfig`); this file knows only their slugs: the decided list
// (happy, funny, angry, sad, fearful, hopeful, calm, neutral, sarcastic), and
// Laughing, Funny's slug before the
// rename (an older runner or device may still hold it). A slug not listed
// here has no emoji and no score: it is shown by name and left out of the
// tone tests.

/** One Tone factiii as the server lists it. */
export type ToneFactiii = { id: number; slug: string; name: string };

type ToneKey = {
  emoji: string;
  /** How the tone tests score it: +1 pleasant, −1 unpleasant, 0 neither. */
  valence: number;
};

const POSITIVE = 1;
const NEGATIVE = -1;
const NEITHER = 0;

export const TONE_KEY: Readonly<Record<string, ToneKey>> = {
  happy: { emoji: '😊', valence: POSITIVE },
  funny: { emoji: '😂', valence: POSITIVE },
  // Funny's slug before the rename (auto-tag.md: Laughing → Funny).
  laughing: { emoji: '😂', valence: POSITIVE },
  hopeful: { emoji: '🌱', valence: POSITIVE },
  calm: { emoji: '😌', valence: POSITIVE },
  neutral: { emoji: '😐', valence: NEITHER },
  sarcastic: { emoji: '😏', valence: NEITHER },
  sad: { emoji: '😢', valence: NEGATIVE },
  angry: { emoji: '😠', valence: NEGATIVE },
  fearful: { emoji: '😨', valence: NEGATIVE }
};

/** A tone's emoji, or a plain dot for a slug the key does not know. */
export const toneEmoji = (slug: string): string => TONE_KEY[slug]?.emoji ?? '•';

/** Tone factiii id → its score, for the tone tests. Tones the key does not
 *  know are left out. */
export const toneValenceById = (
  tones: readonly Pick<ToneFactiii, 'id' | 'slug'>[]
): Record<number, number> => {
  const out: Record<number, number> = {};
  for (const tone of tones) {
    const key = TONE_KEY[tone.slug];
    if (key) out[tone.id] = key.valence;
  }
  return out;
};
