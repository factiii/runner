// The Printify merch shop (.specs/shop.md). Shared by the server, web and
// mobile so the cart, the labels and the US-only rule agree everywhere.

/** The space every MERCH product belongs to. Created by the first sync. */
export const SHOP_SPACE_SLUG = 'shop';

/** Shipping is US only (Jon, 2026-11-09). The one place to widen it. */
export const SHOP_SHIP_TO_COUNTRIES = ['US'] as const;
export type ShopCountry = (typeof SHOP_SHIP_TO_COUNTRIES)[number];

/** Most of one variant a cart may hold, and most lines a cart may hold. */
export const SHOP_MAX_QUANTITY = 10;
export const SHOP_MAX_LINES = 20;

/**
 * Stripe Tax product codes. A merch product with no `Product.taxCode` is taxed
 * as general tangible goods; set a product's own code (clothing is
 * txcd_30011000) when a state taxes it differently. Shipping has its own code
 * because states differ on whether shipping is taxable.
 */
export const MERCH_DEFAULT_TAX_CODE = 'txcd_99999999';
export const SHIPPING_TAX_CODE = 'txcd_92010001';

/** The 50 states, DC, and the territories Printify ships to as US. */
export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'PR', name: 'Puerto Rico' }
];

export const US_STATE_CODES = US_STATES.map((state) => state.code);

export type FulfillmentStatusName =
  | 'PENDING_PAYMENT'
  | 'AUTHORIZED'
  | 'SUBMITTED'
  | 'IN_PRODUCTION'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'ON_HOLD'
  | 'CANCELED'
  | 'FAILED';

/** What a buyer reads for each fulfilment status. */
export const FULFILLMENT_LABELS: Record<FulfillmentStatusName, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  AUTHORIZED: 'Payment authorised',
  SUBMITTED: 'Order placed',
  IN_PRODUCTION: 'Being made',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  ON_HOLD: 'On hold',
  CANCELED: 'Cancelled',
  FAILED: 'Could not be placed'
};

export type ShopVariantOption = {
  id: number;
  color: string | null;
  colorHex: string | null;
  size: string | null;
  price: number;
  available: boolean;
};

/** The distinct colours of a product's variants, in variant order. */
export const variantColors = (
  variants: ShopVariantOption[]
): Array<{ name: string; hex: string | null }> => {
  const seen = new Map<string, string | null>();
  for (const variant of variants) {
    if (variant.color && !seen.has(variant.color))
      seen.set(variant.color, variant.colorHex);
  }
  return [...seen].map(([name, hex]) => ({ name, hex }));
};

/** The distinct sizes, in variant order, optionally only those in a colour. */
export const variantSizes = (
  variants: ShopVariantOption[],
  color: string | null
): string[] => {
  const sizes: string[] = [];
  for (const variant of variants) {
    if (color && variant.color !== color) continue;
    if (variant.size && !sizes.includes(variant.size)) sizes.push(variant.size);
  }
  return sizes;
};

/** The variant for a colour and size pick; null colour/size match any. */
export const pickVariant = <T extends ShopVariantOption>(
  variants: T[],
  color: string | null,
  size: string | null
): T | null =>
  variants.find(
    (variant) =>
      (!color || variant.color === color) && (!size || variant.size === size)
  ) ?? null;
