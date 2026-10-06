import { env } from '../config/env';
import { INDIAN_STATES, canonicalStateName } from '../constants/indianStates';
import { CodStateConfig, type ICodStateConfig } from '../models/codStateConfig.model';
import { User } from '../models/user.model';
import { ApiError } from '../utils/ApiError';
import type { PaymentMethod } from '../types';

/**
 * Shipping, per state (PRD 4.4 / 6).
 *
 * Both payment methods are priced here. COD used to be one flat charge from
 * COD_SHIPPING_CHARGE and prepaid orders a second from PREPAID_SHIPPING_CHARGE,
 * both applied everywhere. The store now decides per state whether COD is
 * offered at all, what it costs, and what a prepaid order pays to ship; a
 * state with no row — or a row that leaves a figure unset — falls back to the
 * env defaults, so nothing has to be configured before either method works.
 *
 * The two charges are independent. Switching COD off in a state says nothing
 * about what prepaid orders to it cost.
 *
 * Every figure here is integer paise, like the rest of the codebase.
 */

/**
 * Case, punctuation and whitespace folded: "Tamil  Nadu" → "tamil nadu".
 *
 * This is the *storage* format of `CodStateConfig.stateKey`. Match through
 * `stateKeyFor`, not this: on its own it leaves "Tamilnadu" as "tamilnadu",
 * which is exactly the mismatch that priced Tamil Nadu orders at the default.
 */
export function normalizeStateKey(state: string): string {
  return state
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The key a state is saved and looked up under.
 *
 * Addresses store `state` as free text, so one state arrives as "Tamil Nadu",
 * "Tamilnadu", "TN" or "tamil-nadu". Every recognisable form is first mapped to
 * its catalogue name, so all of them — and the admin's row — share one key.
 * Only a string that is not recognisably any state (a real typo) keeps its own
 * key, and so finds no row and gets the default.
 */
export function stateKeyFor(state: string): string {
  return normalizeStateKey(canonicalStateName(state) ?? state);
}

export interface StateShipping {
  /** The state this was resolved for, as it was asked about. */
  state: string;
  codEnabled: boolean;
  /** Integer paise. Meaningless when codEnabled is false. */
  codCharge: number;
  /**
   * Integer paise, already resolved: the row's own figure, or the store
   * default where the row leaves it unset. Never null — callers price with
   * this directly rather than repeating the fallback.
   */
  prepaidCharge: number;
  /** 'state' when an explicit row matched; 'default' when the fallback applied. */
  source: 'state' | 'default';
}

export interface ShippingDefaults {
  codEnabled: boolean;
  codCharge: number;
  prepaidCharge: number;
}

export function shippingDefaults(): ShippingDefaults {
  return {
    codEnabled: env.COD_DEFAULT_ENABLED,
    codCharge: env.COD_SHIPPING_CHARGE,
    prepaidCharge: env.PREPAID_SHIPPING_CHARGE,
  };
}

/**
 * The shipping rules that apply to a delivery address in this state — both
 * methods, in one lookup.
 *
 * A missing, blank or unrecognised state resolves to the defaults rather than
 * throwing: checkout must still reach a price for an address typed by hand.
 */
export async function resolveStateShipping(
  state: string | null | undefined,
): Promise<StateShipping> {
  const defaults = shippingDefaults();
  const key = stateKeyFor(state ?? '');
  if (!key) return { state: state ?? '', ...defaults, source: 'default' };

  const config = await CodStateConfig.findOne({ stateKey: key });
  if (!config) return { state: state ?? '', ...defaults, source: 'default' };

  return {
    state: config.state,
    codEnabled: config.codEnabled,
    codCharge: config.codCharge,
    // A row that predates per-state prepaid pricing, or one the admin has not
    // given a prepaid figure, takes the store default rather than ₹0.
    prepaidCharge: config.prepaidCharge ?? defaults.prepaidCharge,
    source: 'state',
  };
}

/**
 * The shipping charge for an order, and the rules behind it.
 *
 * This is the only place checkout gets a shipping figure, for either payment
 * method. The client sends a payment method and an address id and nothing
 * else — no charge, no state, no total — so there is no field to tamper with:
 * the state is read from the saved address server-side and the charge from
 * the configuration.
 *
 * Throws when COD is switched off for the state, which leaves Razorpay as the
 * remaining option rather than failing the order outright. A prepaid order is
 * never refused on that basis: `codEnabled` governs COD alone.
 */
export async function resolveShipping(
  paymentMethod: PaymentMethod,
  state: string | null | undefined,
): Promise<{ shippingCharge: number; shipping: StateShipping }> {
  const shipping = await resolveStateShipping(state);

  if (paymentMethod !== 'cod') {
    return { shippingCharge: shipping.prepaidCharge, shipping };
  }

  if (!shipping.codEnabled) {
    throw new ApiError(
      409,
      `Cash on delivery is not available for deliveries to ${state?.trim() || 'this state'}. Please pay online instead.`,
      'COD_UNAVAILABLE',
    );
  }

  return { shippingCharge: shipping.codCharge, shipping };
}

/* ── Checkout-time lookup ───────────────────────────────────────────────── */

export interface CodOptionsForAddress {
  addressId: string;
  /** The state on the saved address, exactly as the customer typed it. */
  state: string;
  codEnabled: boolean;
  /** Integer paise. Only meaningful when codEnabled is true. */
  codCharge: number;
  /**
   * Integer paise: what this state charges to ship a prepaid (online) order.
   * Already resolved against the store default, and unaffected by codEnabled.
   */
  prepaidShippingCharge: number;
  /**
   * True when no row matched this state and the defaults applied — usually a
   * state the store has not configured, occasionally one typed unusually.
   */
  usingDefault: boolean;
}

/**
 * What the checkout screen needs to price either payment method for one saved
 * address.
 *
 * Keyed on the customer's *own* address id rather than a state string, so this
 * cannot be used to enumerate the store's per-state rules, and so the screen
 * asks about exactly the state the order will be priced against.
 */
export async function codOptionsForAddress(
  userId: string,
  addressId: string,
): Promise<CodOptionsForAddress> {
  const user = await User.findById(userId).select('addresses');
  if (!user) throw ApiError.notFound('Account not found');

  const address = user.addresses.id(addressId);
  if (!address) throw ApiError.notFound('Address not found');

  const shipping = await resolveStateShipping(address.state);
  return {
    addressId,
    state: address.state,
    codEnabled: shipping.codEnabled,
    codCharge: shipping.codCharge,
    prepaidShippingCharge: shipping.prepaidCharge,
    usingDefault: shipping.source === 'default',
  };
}

/* ── Admin configuration ────────────────────────────────────────────────── */

export interface SerializedCodStateConfig {
  state: string;
  codEnabled: boolean;
  /** Integer paise. */
  codCharge: number;
  /**
   * Integer paise, already resolved against the store default — this is what
   * a prepaid order to this state actually pays, so the admin screen can show
   * one number per row without repeating the fallback.
   */
  prepaidCharge: number;
  /**
   * False when this state has no prepaid figure of its own and is following
   * the store default. Lets the screen say so, and distinguishes it from a
   * state deliberately set to the same amount.
   */
  prepaidUsingDefault: boolean;
  /** False for a state shown only because it is in the catalogue. */
  configured: boolean;
  updatedAt?: string;
}

function serialize(config: ICodStateConfig, defaults: ShippingDefaults): SerializedCodStateConfig {
  return {
    state: config.state,
    codEnabled: config.codEnabled,
    codCharge: config.codCharge,
    prepaidCharge: config.prepaidCharge ?? defaults.prepaidCharge,
    prepaidUsingDefault: config.prepaidCharge == null,
    configured: true,
    updatedAt: config.updatedAt.toISOString(),
  };
}

export interface CodConfigListing {
  defaults: ShippingDefaults;
  /** Only the states with an explicit row — what the store has actually set. */
  configured: SerializedCodStateConfig[];
  /**
   * Every state in the catalogue merged with its row (or the default), plus
   * any configured state that is not in the catalogue. This is what the admin
   * screen renders, so it never has to merge two lists itself.
   */
  states: SerializedCodStateConfig[];
}

export async function listStateConfigs(): Promise<CodConfigListing> {
  const defaults = shippingDefaults();
  const rows = await CodStateConfig.find().sort({ state: 1 });
  const byKey = new Map(rows.map((row) => [row.stateKey, row]));

  const states: SerializedCodStateConfig[] = INDIAN_STATES.map((state) => {
    const row = byKey.get(normalizeStateKey(state));
    // Keep the catalogue's spelling on an unconfigured state so the screen
    // always shows the canonical name.
    return row
      ? serialize(row, defaults)
      : { state, ...defaults, prepaidUsingDefault: true, configured: false };
  });

  // A row for a state the catalogue does not list — an older spelling, or a
  // state added by hand. Hiding it would make it uneditable from the app.
  const catalogueKeys = new Set(INDIAN_STATES.map(normalizeStateKey));
  for (const row of rows) {
    if (!catalogueKeys.has(row.stateKey)) states.push(serialize(row, defaults));
  }

  states.sort((a, b) => a.state.localeCompare(b.state));

  return { defaults, configured: rows.map((row) => serialize(row, defaults)), states };
}

export interface UpsertStateConfigInput {
  codEnabled: boolean;
  codCharge: number;
  /**
   * Integer paise, or null to follow the store default.
   *
   * ABSENT IS NOT NULL. An admin build that predates per-state prepaid pricing
   * sends no such field — and `validate()` strips unknown keys, so it cannot
   * be distinguished from a deliberate one later. Leaving the key out
   * therefore means "do not touch this state's prepaid charge", so saving an
   * ordinary COD edit from an older build cannot wipe a configured amount.
   */
  prepaidCharge?: number | null;
}

/** Creates the state's row if it has none, so an unconfigured state is editable. */
export async function upsertStateConfig(
  state: string,
  input: UpsertStateConfigInput,
): Promise<SerializedCodStateConfig> {
  const trimmed = state.trim();
  const stateKey = stateKeyFor(trimmed);
  if (!stateKey) throw ApiError.badRequest('Enter a state name');

  const $set: Record<string, unknown> = {
    state: canonicalStateName(trimmed) ?? trimmed,
    codEnabled: input.codEnabled,
    codCharge: input.codCharge,
  };
  if ('prepaidCharge' in input) $set.prepaidCharge = input.prepaidCharge ?? null;

  const config = await CodStateConfig.findOneAndUpdate(
    { stateKey },
    { $set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  return serialize(config, shippingDefaults());
}

/** Removes the override so the state falls back to the global defaults. */
export async function deleteStateConfig(state: string): Promise<StateShipping> {
  const stateKey = stateKeyFor(state);
  const deleted = await CodStateConfig.findOneAndDelete({ stateKey });
  if (!deleted) throw ApiError.notFound('No shipping override is set for this state');

  return { state: deleted.state, ...shippingDefaults(), source: 'default' };
}
