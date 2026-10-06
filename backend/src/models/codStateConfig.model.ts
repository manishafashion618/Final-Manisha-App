import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Per-state shipping rules (PRD 6 — commerce settings, admin-tunable).
 *
 * One document per state, covering both payment methods: whether COD is
 * offered there and what it costs, and what shipping costs on a prepaid
 * (online) order. A state with no document — or a document that leaves
 * `prepaidCharge` unset — falls back to the global defaults
 * (COD_DEFAULT_ENABLED / COD_SHIPPING_CHARGE / PREPAID_SHIPPING_CHARGE), so
 * both methods price correctly on a fresh database without the store
 * configuring 36 rows first.
 *
 * The collection is still named `codstateconfigs`: it predates prepaid
 * pricing, and renaming it would cost a migration for no behavioural gain.
 */
export interface ICodStateConfig extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  /** The state as the admin entered it — what gets shown back on the screen. */
  state: string;
  /**
   * The lookup key (see cod.service.stateKeyFor): the state's catalogue name,
   * normalised. Delivery addresses store `state` as free text, so "Tamil Nadu",
   * "Tamilnadu" and "TN" all reach checkout; keying on the catalogue name
   * means one row covers every spelling rather than only the admin's.
   */
  stateKey: string;
  codEnabled: boolean;
  /** Integer paise, like every other monetary field in this codebase. */
  codCharge: number;
  /**
   * Shipping on a prepaid (online) order, in integer paise.
   *
   * Null — the default, and the value on every row written before prepaid was
   * priced per state — means "not set for this state", which resolves to
   * PREPAID_SHIPPING_CHARGE. That is deliberately not the same as 0: a row
   * configured for COD long ago must not silently start shipping free.
   *
   * Independent of `codEnabled`. A state that does not offer COD still ships
   * prepaid orders at this price.
   */
  prepaidCharge: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const codStateConfigSchema = new Schema<ICodStateConfig>(
  {
    state: { type: String, required: true, trim: true, maxlength: 80 },
    stateKey: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    codEnabled: { type: Boolean, required: true, default: true },
    codCharge: { type: Number, required: true, min: 0, default: 0 },
    prepaidCharge: { type: Number, min: 0, default: null },
  },
  { timestamps: true },
);

export const CodStateConfig = model<ICodStateConfig>('CodStateConfig', codStateConfigSchema);
