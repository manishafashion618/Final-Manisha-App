import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlockSkeleton, PressableScale } from '../../components/motion';
import { Image } from 'expo-image';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  EmptyState,
  Group,
  NavBar,
  Screen,
  SectionLabel,
  StatusText,
} from '../../components/ui';
import { orderApi } from '../../api/endpoints';
import { useAppDispatch } from '../../store/hooks';
import { cancelOrder } from '../../store/slices/cartSlice';
import { colors, orderStatusStyle, radius, shadow, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import { moneySplit } from '../../utils/orderMoney';
import type { RootStackParamList } from '../../navigation/types';
import type { Order, OrderStatus } from '../../api/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'OrderDetail'>;
type Route = RouteProp<RootStackParamList, 'OrderDetail'>;

const TIMELINE: OrderStatus[] = ['placed', 'processing', 'shipped', 'delivered'];

const TIMELINE_HINT: Record<string, string> = {
  placed: 'Payment verified',
  processing: 'Packed at the shop',
  shipped: 'Courier and tracking number',
  delivered: 'On its way to you',
};

/**
 * PRD 4.5 — itemised breakdown at price-at-time-of-order, a status timeline,
 * and cancellation while the order is still "placed". Cancel stays quiet until
 * it is the thing you came for.
 */
export function OrderDetailScreen() {
  const { params } = useRoute<Route>();
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await orderApi.detail(params.orderId));
    } catch {
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }, [params.orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Coming back from a payment sheet that was closed: the order may now be
     paid (the webhook can settle it even when the app saw nothing), so it is
     read again. Only for an order that was still waiting — a settled order has
     nothing to re-check on every focus. */
  const awaitingPayment = order?.orderStatus === 'pending_payment';
  useEffect(() => {
    if (!awaitingPayment) return;
    return navigation.addListener('focus', () => {
      void load();
    });
  }, [awaitingPayment, navigation, load]);

  /* Re-opens the payment the order is already waiting on — the same Razorpay
     order, so retrying never creates a second one. */
  const handleCompletePayment = async () => {
    setPaying(true);
    try {
      const handle = await orderApi.paymentHandle(params.orderId);
      navigation.navigate('RazorpayCheckout', {
        orderId: params.orderId,
        handle,
        returnTo: 'order',
        description:
          order?.paymentMethod === 'cod' ? 'Shipping charge (cash on delivery)' : 'Jewellery order',
      });
    } catch {
      Alert.alert(
        'Could not open payment',
        'We could not start the payment just now. Please try again.',
      );
    } finally {
      setPaying(false);
    }
  };

  const requestCancellation = () => {
    Alert.alert(
      'Request cancellation?',
      "This order is already paid, so the store reviews cancellations. If it's cancelled, you'll be refunded in full.",
      [
        { text: 'Keep order', style: 'cancel' },
        {
          text: 'Request cancellation',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            const result = await dispatch(
              cancelOrder({ orderId: params.orderId, reason: 'Requested by customer' }),
            );
            setCancelling(false);
            if (cancelOrder.fulfilled.match(result)) {
              setOrder(result.payload);
            } else {
              Alert.alert(
                'Could not send the request',
                typeof result.payload === 'string' ? result.payload : 'Please try again.',
              );
            }
          },
        },
      ],
    );
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel this order?',
      'This cannot be undone. Your items will be returned to stock.',
      [
        { text: 'Keep order', style: 'cancel' },
        {
          text: 'Cancel order',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            const result = await dispatch(
              cancelOrder({ orderId: params.orderId, reason: 'Cancelled by customer' }),
            );
            setCancelling(false);

            if (cancelOrder.fulfilled.match(result)) {
              setOrder(result.payload);
            } else {
              Alert.alert(
                'Could not cancel',
                typeof result.payload === 'string' ? result.payload : 'Please try again.',
              );
            }
          },
        },
      ],
    );
  };

  // Keeps the nav bar: a bare LoadingView left no way back while it loaded.
  if (loading) {
    return (
      <Screen edges={['top']}>
        <NavBar onBack={() => navigation.goBack()} />
        <BlockSkeleton rows={3} />
        <BlockSkeleton rows={2} />
        <BlockSkeleton rows={3} />
      </Screen>
    );
  }
  if (!order) {
    return (
      <Screen>
        <EmptyState icon="info" title="Order not found" message="We could not load this order." />
      </Screen>
    );
  }

  const status = orderStatusStyle[order.orderStatus];
  const cancelled = order.orderStatus === 'cancelled';
  const currentStep = TIMELINE.indexOf(order.orderStatus);
  const { paidOnline, dueOnDelivery } = moneySplit(order);
  // A COD order that paid its shipping charge online, so the footer can show
  // both halves rather than one total that is true of neither.
  // (Not while it is unpaid — the card above already explains that case.)
  const splitPayment =
    order.paymentMethod === 'cod' && paidOnline > 0 && order.orderStatus !== 'pending_payment';

  return (
    <Screen edges={['top']}>
      <NavBar
        title={order.orderNumber}
        onBack={() => navigation.goBack()}
        right={<StatusText label={status.label} color={status.fg} />}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {cancelled ? (
          <View style={[styles.card, shadow]}>
            <Text style={styles.cancelledTitle}>Order cancelled</Text>
            <Text style={styles.cancelledNote}>
              {order.statusHistory.find((event) => event.status === 'cancelled')?.note ??
                'Your items were returned to stock.'}
            </Text>
          </View>
        ) : order.orderStatus === 'pending_payment' ? (
          /* Not an order yet. The timeline would be misleading here — nothing
             has happened and nothing will until the payment is made. */
          <View style={[styles.card, shadow]}>
            <Text style={styles.cancelledTitle}>Payment not completed</Text>
            <Text style={styles.cancelledNote}>
              {order.paymentMethod === 'cod'
                ? `This order isn't placed yet. Pay the ${formatPaise(paidOnline)} shipping charge online to confirm it — the ${formatPaise(dueOnDelivery)} for the items is then paid in cash on delivery.`
                : `This order isn't placed yet. Complete the ${formatPaise(paidOnline)} payment to confirm it.`}
            </Text>
            <Button
              label={paying ? 'Opening…' : 'Complete payment'}
              onPress={handleCompletePayment}
              disabled={paying}
              style={{ marginTop: spacing.lg }}
            />
            <Text style={styles.pendingHint}>
              Your items are held until then. Unpaid orders are released automatically.
            </Text>
          </View>
        ) : (
          <View style={[styles.card, shadow]}>
            {TIMELINE.map((step, index) => {
              const reached = index <= currentStep;
              const event = order.statusHistory.find((entry) => entry.status === step);
              return (
                <View key={step} style={styles.step}>
                  <View style={styles.stepRail}>
                    <View style={[styles.stepDot, reached && styles.stepDotReached]} />
                    {index < TIMELINE.length - 1 ? (
                      <View
                        style={[styles.stepLine, index < currentStep && styles.stepLineDone]}
                      />
                    ) : null}
                  </View>
                  <View
                    style={[
                      styles.stepBody,
                      index === TIMELINE.length - 1 && { paddingBottom: 0 },
                    ]}
                  >
                    <Text style={[styles.stepTitle, !reached && styles.stepTitleQuiet]}>
                      {orderStatusStyle[step].label}
                    </Text>
                    <Text style={styles.stepDetail}>
                      {event
                        ? new Date(event.at).toLocaleString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : TIMELINE_HINT[step]}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        <View style={styles.block}>
          <SectionLabel>Items · price at order</SectionLabel>
          <Group>
            {order.items.map((item, index) => (
              <View key={`${item.productId}-${index}`} style={styles.itemRow}>
                {item.image ? (
                  <Image
                    source={item.image}
                    style={styles.thumb}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                ) : (
                  <View style={styles.thumb} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  {/* PRD 8.2 — the price captured at order time, not today's price. */}
                  <Text style={styles.itemMeta}>
                    {item.quantity} × {formatPaise(item.priceAtOrder)}
                    {item.priceTier === 'wholesale' ? ' · wholesale' : ''}
                  </Text>
                </View>
                <Text style={styles.itemTotal}>{formatPaise(item.lineTotal)}</Text>
              </View>
            ))}
          </Group>
        </View>

        <View style={styles.block}>
          <SectionLabel>Delivered to</SectionLabel>
          <Group padded>
            <Text style={styles.addressName}>{order.shippingAddress.fullName}</Text>
            <Text style={styles.addressLine}>
              {order.shippingAddress.line1}
              {order.shippingAddress.line2 ? `, ${order.shippingAddress.line2}` : ''}
              {'\n'}
              {order.shippingAddress.city}, {order.shippingAddress.state}{' '}
              {order.shippingAddress.pincode}
            </Text>
            <Text style={styles.addressLine}>{order.shippingAddress.phone}</Text>
          </Group>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>
            {splitPayment
              ? 'Order total'
              : `${
                  order.paymentStatus === 'refunded'
                    ? 'Refunded'
                    : order.paymentStatus === 'paid'
                      ? 'Paid'
                      : order.paymentStatus === 'expired'
                        ? 'Not paid'
                        : 'Payable'
                } · ${order.paymentMethod === 'cod' ? 'On delivery' : 'Online'}`}
          </Text>
          <Text style={styles.totalValue}>{formatPaise(order.totalAmount)}</Text>
        </View>

        {/* Where the money actually went: the shipping charge was paid online
            when the order was placed, the rest is cash at the door. */}
        {splitPayment ? (
          <View style={styles.splitRows}>
            <View style={styles.splitRow}>
              <Text style={styles.splitLabel}>
                {order.paymentStatus === 'refunded'
                  ? 'Refunded · shipping'
                  : 'Paid online · shipping'}
              </Text>
              <Text style={styles.splitValue}>{formatPaise(paidOnline)}</Text>
            </View>
            <View style={styles.splitRow}>
              <Text style={styles.splitLabel}>
                {order.orderStatus === 'delivered' ? 'Paid in cash' : 'Pay on delivery'}
              </Text>
              <Text style={styles.splitValue}>{formatPaise(dueOnDelivery)}</Text>
            </View>
          </View>
        ) : null}

        {/* Refund progress, in the customer's words — "due" and "failed" are
            both simply "being arranged" from their side. */}
        {order.refundState && order.refundState !== 'none' ? (
          <Text style={styles.footerNote}>
            {order.refundState === 'refunded'
              ? 'Your payment has been refunded.'
              : order.refundState === 'pending'
                ? 'Refund on its way — it can take 5–7 working days to reach your account.'
                : 'Your refund is being arranged by the store.'}
          </Text>
        ) : null}

        {order.cancellable ? (
          <PressableScale onPress={handleCancel} disabled={cancelling} style={styles.cancel}>
            <Text style={styles.cancelLabel}>
              {cancelling ? 'Cancelling…' : 'Cancel order'}
            </Text>
          </PressableScale>
        ) : order.cancellationRequestable ? (
          <PressableScale onPress={requestCancellation} disabled={cancelling} style={styles.cancel}>
            <Text style={styles.cancelLabel}>
              {cancelling ? 'Sending…' : 'Request cancellation'}
            </Text>
          </PressableScale>
        ) : order.cancellationRequest && order.orderStatus !== 'cancelled' ? (
          <Text style={styles.footerNote}>
            Cancellation requested. The store will review it and contact you.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  footerNote: {
    ...typography.footnote,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  scroll: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xl },
  block: { marginTop: spacing.xl },

  card: { padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface },
  cancelledTitle: { ...typography.bodyStrong, fontWeight: '600', color: colors.text },
  cancelledNote: { ...typography.callout, color: colors.textMuted, lineHeight: 23, marginTop: 6 },
  pendingHint: {
    ...typography.footnote,
    color: colors.textFaint,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: spacing.md,
  },

  step: { flexDirection: 'row', gap: spacing.lg },
  stepRail: { alignItems: 'center', paddingTop: 4 },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
  },
  stepDotReached: { backgroundColor: colors.primary },
  stepLine: { width: 2, flex: 1, backgroundColor: colors.fill, marginVertical: 6 },
  stepLineDone: { backgroundColor: colors.primary },
  stepBody: { flex: 1, paddingBottom: spacing.xl },
  stepTitle: { ...typography.bodyStrong, fontWeight: '600', color: colors.text },
  stepTitleQuiet: { color: colors.textFaint },
  stepDetail: { ...typography.caption, color: colors.textFaint, marginTop: 3 },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md + 2,
    paddingHorizontal: spacing.lg + 2,
    paddingVertical: spacing.md + 2,
  },
  thumb: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.background },
  itemName: { ...typography.calloutStrong, color: colors.text },
  itemMeta: { ...typography.footnote, color: colors.textFaint, marginTop: 2 },
  itemTotal: { ...typography.calloutStrong, color: colors.text },

  addressName: { ...typography.bodyStrong, fontWeight: '600', color: colors.text },
  addressLine: { ...typography.callout, color: colors.textMuted, lineHeight: 23, marginTop: 6 },

  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  totalLabel: { ...typography.callout, color: colors.textMuted },
  totalValue: { ...typography.title, fontSize: 24, color: colors.text },
  splitRows: { marginTop: spacing.sm, gap: 4 },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  splitLabel: { ...typography.footnote, color: colors.textMuted },
  splitValue: { ...typography.footnoteStrong, color: colors.text },
  cancel: { height: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  cancelLabel: { ...typography.bodyStrong, color: colors.primary },
});
