import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlockSkeleton, PressableScale, Skeleton } from '../../components/motion';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Group,
  NavBar,
  Screen,
  SectionLabel,
  SelectionMark,
} from '../../components/ui';
import {
  configApi,
  orderApi,
  productApi,
  type CodOptions,
  type StoreConfig,
} from '../../api/endpoints';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { checkout, clearError, fetchCart } from '../../store/slices/cartSlice';
import { fetchAddresses } from '../../store/slices/authSlice';
import { colors, radius, shadow, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import type { RootStackParamList } from '../../navigation/types';
import type { PaymentMethod, Product } from '../../api/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Checkout'>;
type Route = RouteProp<RootStackParamList, 'Checkout'>;

/**
 * PRD 4.3 / 4.4 — order summary, address selection, and payment method.
 * Three grouped decisions and one total: Razorpay orders ship free, COD adds
 * the shipping charge the server owns for the delivery state.
 *
 * COD is priced per state, so the charge is fetched for the *selected address*
 * rather than read from a single store-wide setting, and the option disappears
 * entirely in a state where the store has switched COD off. None of that is
 * trusted: checkout re-derives both on the server from the saved address.
 *
 * Two sources feed the same screen. Without params it checks out the saved
 * cart. With `buyNow` it orders a single product and never touches the cart —
 * the server enforces that too, so the cart survives even if this screen is
 * wrong about it.
 */
export function CheckoutScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const dispatch = useAppDispatch();
  const buyNow = params?.buyNow;

  const cart = useAppSelector((state) => state.cart.cart);
  const placingOrder = useAppSelector((state) => state.cart.placingOrder);
  const error = useAppSelector((state) => state.cart.error);
  const addresses = useAppSelector((state) => state.auth.user?.addresses ?? []);

  const [config, setConfig] = useState<StoreConfig | null>(null);
  /** Settled either way — `config === null` alone cannot tell loading from failed. */
  const [configLoaded, setConfigLoaded] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('razorpay');

  /* COD for the selected address's state. `null` while it is being fetched,
     after a failed fetch (see `codLookupFailed`), or when the server does not
     price COD per state — only in that last case does the screen use the
     single default charge in `config`. */
  const [codOptions, setCodOptions] = useState<CodOptions | null>(null);
  const [codLookupFailed, setCodLookupFailed] = useState(false);
  /** Bumped by "Try again" to re-run the lookup for the same address. */
  const [codLookupAttempt, setCodLookupAttempt] = useState(0);

  /* The one product a Buy-now checkout is ordering. Its price comes from the
     API at the buyer's tier — this screen never computes money, it only adds
     the server's unit price up. `null` while loading, `false` once the fetch
     has failed, which is what separates "still waiting" from "gave up". */
  const [buyNowProduct, setBuyNowProduct] = useState<Product | null | false>(null);

  useEffect(() => {
    void dispatch(fetchAddresses());
    configApi
      .get()
      .then((result) => {
        setConfig(result);
        // Fall back to COD when online payment is not configured.
        if (!result.razorpayEnabled) setPaymentMethod('cod');
      })
      .catch(() => setConfig(null))
      .finally(() => setConfigLoaded(true));
  }, [dispatch]);

  useEffect(() => {
    // A Buy-now checkout deliberately does not fetch the cart: reading it would
    // only invite the summary to drift toward showing items nobody is buying.
    if (!buyNow) {
      void dispatch(fetchCart());
      return;
    }

    let cancelled = false;
    productApi
      .detail(buyNow.productId)
      .then((result) => {
        if (!cancelled) setBuyNowProduct(result);
      })
      .catch(() => {
        if (!cancelled) setBuyNowProduct(false);
      });

    return () => {
      cancelled = true;
    };
  }, [buyNow, dispatch]);

  /*
     Derived, not held in state. "Change" opens the Addresses screen, which
     records the choice by making that address the default — so the default is
     the selection. Latching the first one into state meant coming back from
     that screen changed nothing: the old address stayed on screen and was the
     one the order shipped to.
  */
  const selectedAddress = addresses.find((entry) => entry.isDefault) ?? addresses[0];
  const selectedAddressId = selectedAddress?.id ?? null;

  /*
     COD is priced by the delivery state, so this re-runs whenever the chosen
     address changes — coming back from "Change" with a Maharashtra address
     must not keep quoting the Kerala charge.

     A server that does not price COD per state (`codPerStateSupported`
     absent) is left on the store-wide default rather than being asked a
     question it cannot answer.

     A failed or unfinished lookup does NOT fall back to the default: that
     showed ₹50 for a state configured at ₹100, and the server then charged
     ₹100. Until the address's own figure arrives, COD shows no price and
     cannot be placed; a failure offers a retry.
  */
  useEffect(() => {
    if (!selectedAddressId || !configLoaded) return;
    setCodLookupFailed(false);
    if (config?.codPerStateSupported !== true) {
      setCodOptions(null);
      return;
    }

    let cancelled = false;
    setCodOptions(null);
    orderApi
      .codOptions(selectedAddressId)
      .then((result) => {
        if (!cancelled) setCodOptions(result);
      })
      .catch(() => {
        if (!cancelled) setCodLookupFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAddressId, configLoaded, config?.codPerStateSupported, codLookupAttempt]);

  /*
     Whether COD may be offered at all. Unknown counts as available: the option
     is only withdrawn on a definite "no" from the server, so a slow or failed
     lookup does not silently remove a payment method the customer can use.
  */
  const codAvailable = codOptions ? codOptions.codEnabled : true;

  /**
     The COD charge for this address, or `null` while it is not known. The
     store default is used only by a server that has no per-state pricing.
  */
  const codCharge: number | null =
    config?.codPerStateSupported === true
      ? (codOptions?.codCharge ?? null)
      : (config?.codShippingCharge ?? null);

  /*
     COD can go away under the customer — they pick an address in a state where
     the store does not offer it, or Razorpay comes back. Moving the selection
     rather than leaving it on a hidden option is what stops "Place order" from
     submitting a method that is no longer on screen.
  */
  useEffect(() => {
    if (!codAvailable && paymentMethod === 'cod' && config?.razorpayEnabled) {
      setPaymentMethod('razorpay');
    }
  }, [codAvailable, paymentMethod, config?.razorpayEnabled]);

  /** `null` while the COD figure for this address is still unknown. */
  const shippingCharge = useMemo((): number | null => {
    if (!config) return 0;
    return paymentMethod === 'cod' ? codCharge : config.prepaidShippingCharge;
  }, [config, paymentMethod, codCharge]);

  const subtotal = buyNow
    ? buyNowProduct
      ? buyNowProduct.price * buyNow.quantity
      : 0
    : (cart?.subtotal ?? 0);
  const total = shippingCharge === null ? null : subtotal + shippingCharge;

  /*
     COD collects the shipping charge online before the order is placed; only
     the items are paid in cash at the door. A ₹0 charge has nothing to collect
     online and stays a plain COD order. The server decides all of this again —
     this only tells the customer what is about to happen.
  */
  const codShippingOnline =
    paymentMethod === 'cod' &&
    config?.codShippingPaidOnline === true &&
    codCharge !== null &&
    codCharge > 0;

  /* COD that needs an online payment cannot be placed at all while Razorpay is
     off, so the option says so instead of failing at the server. */
  const codBlockedByRazorpay =
    config?.codShippingPaidOnline === true &&
    config.razorpayEnabled === false &&
    (codCharge ?? 0) > 0;

  const payableOnline = codShippingOnline ? (codCharge ?? 0) : total;
  const payableOnDelivery = codShippingOnline ? subtotal : 0;

  /* A payment that was closed or declined leaves the order unpaid and NOT
     placed, with its Razorpay order still open. Retrying reuses that one
     rather than placing a second order. */
  const pendingPayment = params?.paymentOutcome ?? null;

  const handlePlaceOrder = async () => {
    if (!selectedAddressId) return;

    const result = await dispatch(
      checkout({ addressId: selectedAddressId, paymentMethod, buyNow }),
    );
    if (!checkout.fulfilled.match(result)) return;

    const { order, payment } = result.payload;

    /* Anything with money to collect online — a full online order, or COD's
       shipping charge — goes to Razorpay first. Pushed rather than replaced, so
       closing the sheet comes back to this screen with the order retryable. */
    if (payment) {
      navigation.navigate('RazorpayCheckout', {
        orderId: order.id,
        handle: payment,
        returnTo: 'checkout',
        description:
          order.paymentMethod === 'cod' ? 'Shipping charge (cash on delivery)' : 'Jewellery order',
      });
      return;
    }
    navigation.replace('OrderConfirmation', { orderId: order.id });
  };

  const handleRetryPayment = () => {
    if (!pendingPayment) return;
    navigation.navigate('RazorpayCheckout', {
      orderId: pendingPayment.orderId,
      handle: pendingPayment.handle,
      returnTo: 'checkout',
      description: 'Complete your payment',
    });
  };

  // Waiting on whichever source this checkout is built from. The skeleton
  // mirrors the loaded screen — three grouped blocks, the total, the pay button
  // — so nothing jumps when the data arrives. The NavBar is kept: returning a
  // bare LoadingView dropped it, leaving no way back while the cart loaded.
  // A Buy-now checkout also waits on config, because that is what says whether
  // the server can honour it at all.
  if (buyNow ? buyNowProduct === null || !configLoaded : !cart) {
    return (
      <Screen edges={['top']}>
        <NavBar title="Checkout" onBack={() => navigation.goBack()} />
        <BlockSkeleton rows={2} />
        <BlockSkeleton rows={2} />
        <BlockSkeleton rows={3} />
        <View style={styles.skeletonFooter}>
          <Skeleton height={18} width="30%" />
          <Skeleton height={52} style={styles.skeletonButton} />
        </View>
      </Screen>
    );
  }

  /* An API that does not advertise buyNow support would strip the field and
     charge for the entire cart — zod drops unknown keys, so the response would
     look like a perfectly ordinary success. There is no way to detect that
     after the fact, so the order is refused before it is placed. Resolves
     itself the moment the backend is redeployed. */
  if (buyNow && config?.buyNowSupported !== true) {
    return (
      <Screen edges={['top']}>
        <NavBar title="Checkout" onBack={() => navigation.goBack()} />
        <EmptyState
          icon="info"
          title="Buy now is unavailable"
          message="This store's server needs updating before single-item orders can be placed. Add the item to your cart and check out as usual."
        />
      </Screen>
    );
  }

  // A Buy-now product that failed to load is a dead end — there is nothing to
  // order and no cart to fall back on. Say so rather than holding a skeleton on
  // screen for good.
  if (buyNowProduct === false) {
    return (
      <Screen edges={['top']}>
        <NavBar title="Checkout" onBack={() => navigation.goBack()} />
        <EmptyState
          icon="info"
          title="Product unavailable"
          message="We could not load this product. It may no longer be on sale."
        />
      </Screen>
    );
  }

  const cartItems = cart?.items ?? [];
  const [firstItem, ...restItems] = cartItems;
  const restCount = restItems.reduce((sum, item) => sum + item.quantity, 0);
  const restTotal = restItems.reduce((sum, item) => sum + item.lineTotal, 0);
  // Nothing to order is the one state that blocks the button beyond a missing
  // address: an empty cart, or a Buy-now product that never arrived.
  const hasSomethingToOrder = buyNow ? Boolean(buyNowProduct) : cartItems.length > 0;

  return (
    <Screen edges={['top']}>
      <NavBar title="Checkout" onBack={() => navigation.goBack()} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {error ? <ErrorBanner message={error} onRetry={() => dispatch(clearError())} /> : null}

        <SectionLabel>Deliver to</SectionLabel>
        {selectedAddress ? (
          <View style={[styles.addressCard, shadow]}>
            <View style={styles.addressTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.addressName}>{selectedAddress.fullName}</Text>
                <Text style={styles.addressLine}>
                  {selectedAddress.line1}
                  {selectedAddress.line2 ? `, ${selectedAddress.line2}` : ''}
                  {'\n'}
                  {selectedAddress.city}, {selectedAddress.state} {selectedAddress.pincode}
                </Text>
                <Text style={styles.addressLine}>{selectedAddress.phone}</Text>
              </View>
              <PressableScale
                onPress={() => navigation.navigate('Addresses', { selectMode: true })}
                hitSlop={8}
              >
                <Text style={styles.action}>Change</Text>
              </PressableScale>
            </View>
          </View>
        ) : (
          <View style={[styles.addressCard, shadow]}>
            <Text style={styles.addressLine}>
              You have no saved addresses yet. Add one to continue.
            </Text>
            <Button
              label="Add a delivery address"
              onPress={() => navigation.navigate('AddressForm')}
              variant="secondary"
              style={{ marginTop: spacing.lg }}
            />
          </View>
        )}

        <View style={styles.block}>
          <SectionLabel>Payment</SectionLabel>
          <Group>
            <PaymentOption
              selected={paymentMethod === 'razorpay'}
              disabled={config ? !config.razorpayEnabled : false}
              onPress={() => setPaymentMethod('razorpay')}
              title="Pay online"
              subtitle="UPI, cards & netbanking"
              note={config && !config.razorpayEnabled ? 'Unavailable' : 'Free'}
              noteTone={config && !config.razorpayEnabled ? 'muted' : 'success'}
            />
            {/* A state where the store has switched COD off does not show the
                option greyed out — it does not show it at all, leaving pay
                online as the one way to place the order. */}
            {codAvailable ? (
              <PaymentOption
                selected={paymentMethod === 'cod'}
                disabled={codBlockedByRazorpay}
                onPress={() => setPaymentMethod('cod')}
                title="Cash on delivery"
                subtitle={
                  config?.codShippingPaidOnline === true && (codCharge ?? 0) > 0
                    ? 'Shipping paid online, items in cash'
                    : 'Pay the courier on arrival'
                }
                note={
                  !config
                    ? undefined
                    : codBlockedByRazorpay
                      ? 'Unavailable'
                      : codCharge !== null
                        ? `+${formatPaise(codCharge)}`
                        : codLookupFailed
                          ? undefined
                          : '…'
                }
              />
            ) : null}
          </Group>

          {!codAvailable && codOptions ? (
            <Text style={styles.paymentNote}>
              Cash on delivery isn't available for deliveries to {codOptions.state}.
            </Text>
          ) : null}

          {/* Why COD is greyed out: the shipping charge has to be paid online
              and online payment is switched off. */}
          {codBlockedByRazorpay ? (
            <Text style={styles.paymentNote}>
              Cash on delivery needs the shipping charge paid online, and online payment is
              unavailable right now.
            </Text>
          ) : codShippingOnline ? (
            <Text style={styles.paymentNote}>
              You'll pay the {formatPaise(codCharge ?? 0)} shipping charge online now to confirm the
              order. The {formatPaise(subtotal)} for the items is paid in cash when it arrives.
            </Text>
          ) : null}

          {codLookupFailed ? (
            <View style={styles.codRetryRow}>
              <Text style={[styles.paymentNote, styles.codRetryText]}>
                Couldn't load the cash on delivery charge for this address.
              </Text>
              <PressableScale
                onPress={() => setCodLookupAttempt((attempt) => attempt + 1)}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.codRetryLabel}>Try again</Text>
              </PressableScale>
            </View>
          ) : null}
        </View>

        <View style={styles.block}>
          {/* "Buying now" rather than "Order summary": with a single line in the
              card it is the clearest way to say the cart is not part of this. */}
          <SectionLabel>{buyNow ? 'Buying now' : 'Order summary'}</SectionLabel>
          <View style={[styles.summaryCard, shadow]}>
            {buyNow && buyNowProduct ? (
              <SummaryLine
                label={`${buyNow.quantity} × ${buyNowProduct.name}`}
                value={formatPaise(buyNowProduct.price * buyNow.quantity)}
              />
            ) : (
              <>
                {firstItem ? (
                  <SummaryLine
                    label={`${firstItem.quantity} × ${firstItem.product.name}`}
                    value={formatPaise(firstItem.lineTotal)}
                  />
                ) : null}
                {restCount > 0 ? (
                  <SummaryLine
                    label={`${restCount} more item${restCount === 1 ? '' : 's'}`}
                    value={formatPaise(restTotal)}
                    divided
                  />
                ) : null}
              </>
            )}
            <SummaryLine
              label="Shipping"
              value={
                shippingCharge === null
                  ? codLookupFailed
                    ? 'Unavailable'
                    : 'Calculating…'
                  : shippingCharge === 0
                    ? 'Free'
                    : formatPaise(shippingCharge)
              }
              valueTone={shippingCharge === 0 ? 'success' : 'default'}
              divided
            />
            {/* The split, spelled out where the money is: what leaves the
                account now, and what the courier collects. */}
            {codShippingOnline ? (
              <>
                <SummaryLine
                  label="Pay online now"
                  value={formatPaise(payableOnline ?? 0)}
                  divided
                />
                <SummaryLine
                  label="Pay cash on delivery"
                  value={formatPaise(payableOnDelivery)}
                  divided
                />
              </>
            ) : null}
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{total === null ? '—' : formatPaise(total)}</Text>
        </View>

        {/* Came back from a payment that did not complete. The order is waiting
            unpaid, so the button retries that payment instead of placing
            another order; "Start over" abandons it (it expires on its own). */}
        {pendingPayment ? (
          <>
            <Text style={styles.retryNote}>
              {pendingPayment.message} Your order isn't placed until the payment goes through.
            </Text>
            <Button label="Try payment again" onPress={handleRetryPayment} />
            <Button
              label="Start over"
              variant="ghost"
              onPress={() => navigation.setParams({ paymentOutcome: undefined })}
            />
          </>
        ) : (
          <Button
            label={
              codShippingOnline
                ? `Pay ${formatPaise(payableOnline ?? 0)} & place order`
                : paymentMethod === 'cod'
                  ? 'Place order'
                  : 'Pay now'
            }
            onPress={handlePlaceOrder}
            loading={placingOrder}
            /* COD withdrawn while it was the only method — Razorpay is off too —
               leaves nothing to place the order with. The server would refuse it
               anyway; blocking here says so before the customer taps. */
            disabled={
              !selectedAddressId ||
              !hasSomethingToOrder ||
              (paymentMethod === 'cod' && (!codAvailable || codCharge === null || codBlockedByRazorpay))
            }
          />
        )}
      </View>
    </Screen>
  );
}

/** A grouped row whose leading mark carries the selection. */
function PaymentOption({
  selected,
  onPress,
  title,
  subtitle,
  note,
  noteTone = 'muted',
  disabled = false,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  subtitle: string;
  note?: string;
  noteTone?: 'muted' | 'success';
  disabled?: boolean;
}) {
  return (
    <PressableScale
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => [
        styles.option,
        disabled && styles.optionDisabled,
        pressed && !disabled && styles.optionPressed,
      ]}
    >
      <SelectionMark selected={selected} />
      <View style={{ flex: 1 }}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionSubtitle}>{subtitle}</Text>
      </View>
      {note ? (
        <Text style={noteTone === 'success' ? styles.optionFree : styles.optionNote}>{note}</Text>
      ) : null}
    </PressableScale>
  );
}

function SummaryLine({
  label,
  value,
  divided = false,
  valueTone = 'default',
}: {
  label: string;
  value: string;
  divided?: boolean;
  valueTone?: 'default' | 'success';
}) {
  return (
    <View style={[styles.summaryLine, divided && styles.summaryDivided]}>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.summaryValue, valueTone === 'success' && { color: colors.success }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xl },
  block: { marginTop: spacing.xl },

  addressCard: { padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.surface },
  addressTop: { flexDirection: 'row', gap: spacing.lg },
  addressName: { ...typography.bodyStrong, fontWeight: '600', color: colors.text },
  addressLine: { ...typography.callout, color: colors.textMuted, lineHeight: 23, marginTop: 6 },
  action: { ...typography.calloutStrong, color: colors.primary },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md + 2,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg - 2,
  },
  optionPressed: { backgroundColor: colors.surfacePressed },
  optionDisabled: { opacity: 0.5 },
  optionTitle: { ...typography.bodyStrong, color: colors.text },
  optionSubtitle: { ...typography.caption, color: colors.textFaint, marginTop: 3 },
  optionFree: { ...typography.captionStrong, color: colors.success },
  paymentNote: {
    ...typography.caption,
    color: colors.textFaint,
    lineHeight: 18,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  optionNote: { ...typography.caption, color: colors.textFaint },
  codRetryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  codRetryText: { flex: 1, marginTop: 0 },
  codRetryLabel: { ...typography.footnoteStrong, color: colors.primary },

  summaryCard: { paddingHorizontal: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.surface },
  summaryLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: 13,
  },
  summaryDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  summaryLabel: { ...typography.callout, color: colors.textMuted, flex: 1 },
  summaryValue: { ...typography.calloutStrong, color: colors.text },

  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.md + 2,
  },
  totalLabel: { ...typography.callout, color: colors.textMuted },
  retryNote: {
    ...typography.footnote,
    color: colors.textMuted,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  skeletonFooter: { paddingHorizontal: 24, marginTop: 32, gap: 16 },
  skeletonButton: { borderRadius: 999 },
  totalValue: { ...typography.title2, color: colors.text },
});
