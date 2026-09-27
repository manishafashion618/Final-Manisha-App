import { Platform } from 'react-native';

/**
 * One design token set for the whole app — screens never hard-code a hex value.
 *
 * The language is Apple-style and near-monochrome: white and #F5F5F7 ground,
 * #1D1D1F ink, and the brand crimson reserved for actions and highlights alone.
 * Structure comes from soft diffused shadows and inset grouped cards rather than
 * rules and borders.
 */
export const colors = {
  /* ── The one accent ─────────────────────────────────────────────────────── */
  primary: '#E71B4C',
  primaryDark: '#CF1743',
  /** Tinted ground for an accent-flagged control (a flagged quantity stepper). */
  primarySoft: '#FDECF0',
  /** Accent at rest — a disabled "+" inside an accent-flagged control. */
  primaryFaint: '#F0A6BB',

  /* ── Near-monochrome base ───────────────────────────────────────────────── */
  /** Grouped ground: everything that is not an elevated card. */
  background: '#F5F5F7',
  /** Elevated surface: cards, grouped row lists, bars. */
  surface: '#FFFFFF',
  /** A quiet inset block sitting *on* a white surface. */
  surfaceAlt: '#F5F5F7',
  /** Filled controls (search field, segmented track) sitting on the ground. */
  fill: '#EBEBED',

  text: '#1D1D1F',
  /** Secondary copy — body text that is not the headline. */
  textMuted: '#6E6E73',
  /** Tertiary copy — captions, meta, field labels. */
  textFaint: '#86868B',
  /** Placeholder text and inactive tab items. */
  textPlaceholder: '#8E8E93',
  /** Struck-through prices, disabled glyphs, chevrons. */
  textDisabled: '#C7C7CC',
  textInverse: '#FFFFFF',

  /** Hairline between grouped rows — never a full-strength rule. */
  border: 'rgba(0,0,0,0.06)',
  /** An empty timeline dot, a sheet grabber, an unselected radio ring. */
  borderStrong: '#D9D9DE',

  /* ── Status, used as coloured text far more often than as blocks ────────── */
  success: '#34A853',
  successSoft: '#E8F5EA',
  warning: '#B26A00',
  warningSoft: '#FBF1E3',
  danger: '#E71B4C',
  dangerSoft: '#FDECF0',
  info: '#6E6E73',
  infoSoft: '#F5F5F7',

  /**
   * Retained so the admin screens keep compiling. This direction has one accent
   * and no second brand hue, so both resolve to neutrals.
   */
  gold: '#86868B',
  goldSoft: '#F5F5F7',

  /* ── Promoted from repeated literals ────────────────────────────────────
   * These values were already hardcoded in several screens. They are named
   * here so a screen never invents its own; every value is copied verbatim,
   * so nothing renders any differently than before.
   */
  /** A grouped row while the finger is down. */
  surfacePressed: '#FAFAFB',
  /** Dimming behind a modal sheet. */
  scrim: 'rgba(29,29,31,0.32)',
  /** Frosted control floating over a product photograph. */
  glass: 'rgba(255,255,255,0.82)',
  /** The same treatment on a smaller card, where it sits slightly denser. */
  glassStrong: 'rgba(255,255,255,0.85)',
  /** An inactive gallery dot over a photograph. */
  glassFaint: 'rgba(255,255,255,0.5)',
  /** Label on a disabled filled button. */
  textOnDisabled: '#A1A1A6',
  /** Dark scrim over a photograph (image-slot remove button). */
  scrimStrong: 'rgba(29,29,31,0.55)',
  /** Hairline rule inside a filled input, dividing prefix from field. */
  borderFaint: 'rgba(0,0,0,0.1)',
} as const;

/** 8px scale (with a 4px half-step). */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

/** 10–22px — nothing in this direction is square. */
export const radius = {
  sm: 10,
  md: 14,
  lg: 16,
  xl: 18,
  sheet: 22,
  pill: 999,
} as const;

/**
 * SF-style system type. Tracking tightens as size grows, which is what makes a
 * large title read as Apple's rather than merely big.
 */
export const typography = {
  /** 34px — the focal headline on a screen that has only one (sign in, verify). */
  hero: { fontSize: 34, fontWeight: '600' as const, letterSpacing: -0.75 },
  /** 32px — the large title on a scroll view (Collection, Cart, Orders, Saved). */
  display: { fontSize: 32, fontWeight: '600' as const, letterSpacing: -0.7 },
  /** 28px — a product name, a total. */
  title2: { fontSize: 28, fontWeight: '600' as const, letterSpacing: -0.56 },
  /** 26px — an amount shown against a label. */
  amount: { fontSize: 26, fontWeight: '600' as const, letterSpacing: -0.52 },
  title: { fontSize: 22, fontWeight: '600' as const, letterSpacing: -0.44 },
  /** 17px — a nav bar title, a primary button label, a grouped row value. */
  heading: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  row: { fontSize: 17, fontWeight: '400' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, fontWeight: '500' as const },
  callout: { fontSize: 15, fontWeight: '400' as const },
  calloutStrong: { fontSize: 15, fontWeight: '500' as const },
  caption: { fontSize: 14, fontWeight: '400' as const },
  captionStrong: { fontSize: 14, fontWeight: '500' as const },
  /** 13px — section labels above a grouped card, timestamps, hints. */
  footnote: { fontSize: 13, fontWeight: '400' as const },
  footnoteStrong: { fontSize: 13, fontWeight: '500' as const },
  tiny: { fontSize: 12, fontWeight: '500' as const },
};

/**
 * Elevation is a soft diffused fall, not a drop. React Native takes one shadow
 * per view, so this is the wide ambient half of the design's two-shadow pair —
 * the 1px contact shadow is what the hairline borders stand in for.
 */
export const shadow = Platform.select({
  ios: {
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  android: { elevation: 2 },
  default: {},
}) as object;

/** A chip or a thumbnail — present, but barely. */
export const shadowSoft = Platform.select({
  ios: {
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  android: { elevation: 1 },
  default: {},
}) as object;

/** The accent button's coloured glow. */
export const shadowAccent = Platform.select({
  ios: {
    shadowColor: colors.primary,
    shadowOpacity: 0.22,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  android: { elevation: 4 },
  default: {},
}) as object;

/**
 * Status as coloured text (PRD 4.5). `fg` is what screens should render; `bg` is
 * kept for the admin screens that still show status as a pill.
 */
export const orderStatusStyle: Record<string, { bg: string; fg: string; label: string }> = {
  pending_payment: { bg: colors.warningSoft, fg: colors.warning, label: 'Awaiting payment' },
  placed: { bg: colors.primarySoft, fg: colors.primary, label: 'Placed' },
  processing: { bg: colors.warningSoft, fg: colors.warning, label: 'Processing' },
  shipped: { bg: colors.warningSoft, fg: colors.warning, label: 'Shipped' },
  delivered: { bg: colors.successSoft, fg: colors.success, label: 'Delivered' },
  cancelled: { bg: colors.infoSoft, fg: colors.textMuted, label: 'Cancelled' },
};

export const wholesaleStatusStyle: Record<string, { bg: string; fg: string; label: string }> = {
  pending: { bg: colors.primarySoft, fg: colors.primary, label: 'Under review' },
  approved: { bg: colors.successSoft, fg: colors.success, label: 'Approved' },
  rejected: { bg: colors.infoSoft, fg: colors.textMuted, label: 'Not approved' },
  none: { bg: colors.infoSoft, fg: colors.textMuted, label: 'Retail' },
};
