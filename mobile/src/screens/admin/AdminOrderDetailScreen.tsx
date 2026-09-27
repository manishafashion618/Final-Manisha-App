import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlockSkeleton, PressableScale } from '../../components/motion';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import {
  Button,
  EmptyState,
  Group,
  NavBar,
  Row,
  Screen,
  SectionLabel,
  StatusText,
} from '../../components/ui';
import { adminApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { PERMISSIONS, usePermission } from '../../store/hooks';
import { colors, orderStatusStyle, radius, shadow, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import { codCollectionLine, moneySplit } from '../../utils/orderMoney';
import type { RootStackParamList } from '../../navigation/types';
import type { Order, OrderStatus } from '../../api/types';

type Route = RouteProp<RootStackParamList, 'AdminOrderDetail'>;

/**
 * The status transitions the backend accepts (PRD 4.5). Mirrored here so the
 * UI only ever offers a move the server will allow.
 */
const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  // Only a captured payment makes it `placed`; unpaid, it can only be cancelled.
  pending_payment: ['cancelled'],
  placed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

/**
 * PRD 4.7 — screen 27. Customer, payment, then the one move that advances the
 * order. Cancelling is the quiet text action beneath it, never a red button
 * competing with the thing you actually came to do.
 */
export function AdminOrderDetailScreen() {
  const { params } = useRoute<Route>();
  const navigation = useNavigation();
  const canUpdateStatus = usePermission(PERMISSIONS.ORDER_STATUS_UPDATE);
  const canRefund = usePermission(PERMISSIONS.ORDER_REFUND);

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await adminApi.orderDetail(params.orderId));
    } catch {
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }, [params.orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyStatus = async (next: OrderStatus) => {
    setUpdating(true);
    try {
      setOrder(await adminApi.updateOrderStatus(params.orderId, next));
    } catch (caught) {
      Alert.alert(
        'Could not update',
        caught instanceof ApiError ? caught.message : 'Please try again.',
      );
    } finally {
      setUpdating(false);
    }
  };

  const retryRefund = async () => {
    setUpdating(true);
    try {
      setOrder(await adminApi.retryRefund(params.orderId));
    } catch (caught) {
      Alert.alert('Could not refund', caught instanceof ApiError ? caught.message : 'Please try again.');
    } finally {
      setUpdating(false);
    }
  };

  const handleStatusChange = (next: OrderStatus) => {
    const label = orderStatusStyle[next].label;
    const paidOnline = order?.paymentMethod === 'razorpay' && order.paymentStatus === 'paid';
    Alert.alert(
      `Mark as ${label}?`,
      next === 'cancelled'
        ? paidOnline
          ? `This order was paid online. Cancelling returns every item to stock and refunds ${formatPaise(order?.totalAmount ?? 0)} to the customer.`
          : 'Cancelling returns every item to stock and notifies the customer.'
        : 'The customer will be notified of this update.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: `Mark ${label}`,
          style: next === 'cancelled' ? 'destructive' : 'default',
          onPress: () => void applyStatus(next),
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
      <Screen edges={['top']}>
        <NavBar onBack={() => navigation.goBack()} />
        <EmptyState icon="info" title="Order not found" />
      </Screen>
    );
  }

  const style = orderStatusStyle[order.orderStatus];
  const available = NEXT_STATUS[order.orderStatus];
  const advance = available.find((next) => next !== 'cancelled');
  const paidOnline = order.paymentMethod === 'razorpay' && order.paymentStatus === 'paid';
  // Cancelling a paid order refunds it, which only admin may do.
  const canCancel = available.includes('cancelled') && (!paidOnline || canRefund);
  const refundState = order.refundState ?? 'none';
  const paymentLabel =
    order.paymentStatus === 'paid'
      ? { text: 'Paid · verified', color: colors.success }
      : order.paymentStatus === 'refunded'
        ? { text: 'Refunded', color: colors.success }
        : order.paymentStatus === 'expired'
          ? { text: 'Expired · never paid', color: colors.textMuted }
          : order.paymentStatus === 'failed'
            ? { text: 'Failed', color: colors.danger }
            : { text: 'Pending', color: colors.warning };
  const refundLabel = {
    due: { text: 'Refund due', color: colors.warning },
    pending: { text: 'Refund pending', color: colors.warning },
    refunded: { text: 'Refunded', color: colors.success },
    failed: { text: 'Refund failed', color: colors.danger },
    none: null,
  }[refundState];
  const isWholesale = order.items.some((item) => item.priceTier === 'wholesale');

  return (
    <Screen edges={['top']}>
      <NavBar
        title={order.orderNumber}
        onBack={() => navigation.goBack()}
        right={<StatusText label={style.label} color={style.fg} />}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={styles.placedOn}>
          Placed{' '}
          {new Date(order.createdAt).toLocaleString('en-IN', {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
          })}
          {isWholesale ? ' · wholesale account' : ''}
        </Text>

        <View style={[styles.customerCard, shadow]}>
          <Text style={styles.cardLabel}>Customer</Text>
          <Text style={styles.customerName}>
            {order.customer?.name ?? order.shippingAddress.fullName}
          </Text>
          <Text style={styles.customerLine}>
            {order.shippingAddress.line1}
            {order.shippingAddress.line2 ? `, ${order.shippingAddress.line2}` : ''}
            {'\n'}
            {order.shippingAddress.city}, {order.shippingAddress.state}{' '}
            {order.shippingAddress.pincode}
          </Text>
          <Text style={styles.customerLine}>
            {order.customer?.phone ?? order.shippingAddress.phone}
          </Text>
        </View>

        <View style={styles.block}>
          <SectionLabel>Payment</SectionLabel>
          <Group>
            <Row
              label="Method"
              value={order.paymentMethod === 'cod' ? 'Cash on delivery' : 'Razorpay · online'}
            />
            <Row
              label="Status"
              right={<StatusText label={paymentLabel.text} color={paymentLabel.color} />}
            />
            {refundLabel ? (
              <Row
                label="Refund"
                detail={
                  refundState === 'failed' && order.refund?.failureReason
                    ? order.refund.failureReason
                    : order.lateCapture
                      ? 'Paid after the order was cancelled — refunded automatically'
                      : undefined
                }
                right={<StatusText label={refundLabel.text} color={refundLabel.color} />}
              />
            ) : null}
            <Row label="Subtotal" value={formatPaise(order.subtotal)} />
            <Row
              label="Shipping"
              value={order.shippingCharge === 0 ? 'Free' : formatPaise(order.shippingCharge)}
            />
            {order.paymentMethod === 'cod' ? (
              <>
                <Row
                  label={order.paymentStatus === 'refunded' ? 'Refunded online' : 'Paid online · shipping'}
                  value={formatPaise(moneySplit(order).paidOnline)}
                />
                <Row
                  label="Collect on delivery"
                  right={
                    <StatusText
                      label={formatPaise(moneySplit(order).dueOnDelivery)}
                      color={colors.text}
                    />
                  }
                />
              </>
            ) : null}
          </Group>
          {codCollectionLine(order) && order.orderStatus !== 'cancelled' ? (
            <Text style={styles.codNote}>{codCollectionLine(order)}</Text>
          ) : null}
        </View>

        <View style={styles.block}>
          <SectionLabel>
            Items · {isWholesale ? 'trade' : 'retail'} prices at order
          </SectionLabel>
          <Group>
            {order.items.map((item, index) => (
              <View key={`${item.productId}-${index}`} style={styles.itemRow}>
                <Image
                  source={item.image ? { uri: item.image } : undefined}
                  style={styles.itemThumb}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={styles.itemMeta}>
                    {item.quantity} × {formatPaise(item.priceAtOrder)}
                  </Text>
                </View>
                <Text style={styles.itemTotal}>{formatPaise(item.lineTotal)}</Text>
              </View>
            ))}
          </Group>
        </View>

        {!canUpdateStatus && available.length > 0 ? (
          <Text style={styles.terminal}>You do not have permission to change order status.</Text>
        ) : null}
        {available.length === 0 ? (
          <Text style={styles.terminal}>
            This order is {style.label.toLowerCase()} — no further status changes are possible.
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Order total</Text>
          <Text style={styles.totalValue}>{formatPaise(order.totalAmount)}</Text>
        </View>

        {order.cancellationRequest && order.orderStatus !== 'cancelled' ? (
          <Text style={styles.requestNote}>
            Customer asked to cancel
            {order.cancellationRequest.reason ? `: "${order.cancellationRequest.reason}"` : ''}.
            {canRefund ? ' Cancelling refunds them in full.' : ' An admin can cancel and refund it.'}
          </Text>
        ) : null}

        {canRefund && (refundState === 'due' || refundState === 'failed') ? (
          <Button
            label={refundState === 'failed' ? 'Retry refund' : 'Send refund'}
            onPress={() => void retryRefund()}
            loading={updating}
          />
        ) : null}

        {canUpdateStatus && advance ? (
          <Button
            label={`Mark as ${orderStatusStyle[advance].label}`}
            onPress={() => handleStatusChange(advance)}
            loading={updating}
          />
        ) : null}

        {canUpdateStatus && canCancel ? (
          <PressableScale
            onPress={() => handleStatusChange('cancelled')}
            disabled={updating}
            style={styles.cancel}
            accessibilityRole="button"
          >
            <Text style={styles.cancelLabel}>Cancel order</Text>
          </PressableScale>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  codNote: {
    ...typography.footnoteStrong,
    color: colors.text,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  requestNote: {
    ...typography.footnote,
    color: colors.warning,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  placedOn: { ...typography.caption, color: colors.textFaint, paddingTop: spacing.sm },
  block: { marginTop: spacing.xl },

  customerCard: {
    marginTop: spacing.lg,
    padding: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  cardLabel: { ...typography.tiny, color: colors.textFaint },
  customerName: { ...typography.heading, color: colors.text, marginTop: 6 },
  customerLine: { ...typography.callout, color: colors.textMuted, lineHeight: 23, marginTop: 6 },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md + 2,
    paddingHorizontal: spacing.lg + 2,
    paddingVertical: spacing.md + 2,
  },
  itemThumb: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.background },
  itemName: { ...typography.calloutStrong, color: colors.text },
  itemMeta: { ...typography.footnote, color: colors.textFaint, marginTop: 2 },
  itemTotal: { ...typography.calloutStrong, color: colors.text },

  terminal: {
    ...typography.footnote,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: spacing.xl,
    lineHeight: 19,
  },

  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.md + 2,
  },
  totalLabel: { ...typography.callout, color: colors.textMuted },
  totalValue: { ...typography.amount, color: colors.text },
  cancel: { height: 50, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xs },
  cancelLabel: { ...typography.bodyStrong, color: colors.primary },
});
