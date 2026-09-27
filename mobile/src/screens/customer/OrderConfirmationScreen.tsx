import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, EmptyState, Group, Row, Screen } from '../../components/ui';
import { BlockSkeleton } from '../../components/motion';
import { Icon } from '../../components/Icon';
import { orderApi } from '../../api/endpoints';
import { colors, radius, shadowAccent, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import { moneySplit } from '../../utils/orderMoney';
import type { RootStackParamList } from '../../navigation/types';
import type { Order } from '../../api/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'OrderConfirmation'>;
type Route = RouteProp<RootStackParamList, 'OrderConfirmation'>;

/**
 * PRD 4.4 — order confirmation. One focal mark, quiet detail below: the tick is
 * the only saturated thing on the screen.
 */
export function OrderConfirmationScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const [order, setOrder] = useState<Order | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    orderApi
      .detail(params.orderId)
      .then((result) => {
        if (!cancelled) setOrder(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [params.orderId]);

  /* The order exists — the customer has already paid or committed to COD by the
     time this screen opens. Failing to read it back is a display problem, not a
     payment one, so it says the order is placed and offers the orders list.
     Falling through to the skeleton instead would strand someone who has just
     paid on a screen that never resolves. */
  if (failed) {
    return (
      <Screen edges={['top', 'bottom']}>
        <EmptyState
          icon="info"
          title="Order placed"
          message="We could not load the details just now. You'll find this order under My orders."
          action={
            <Button
              label="Go to my orders"
              onPress={() => navigation.replace('CustomerTabs', { screen: 'Orders' })}
              fullWidth={false}
            />
          }
        />
      </Screen>
    );
  }

  if (!order) {
    return (
      <Screen edges={['top', 'bottom']}>
        <BlockSkeleton rows={2} />
        <BlockSkeleton rows={3} />
      </Screen>
    );
  }

  const pieces = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const thumbs = order.items.filter((item) => item.image).slice(0, 3);
  const { paidOnline, dueOnDelivery } = moneySplit(order);
  // COD paid its shipping charge online, so there are two amounts to state.
  const splitPayment = order.paymentMethod === 'cod' && paidOnline > 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <View style={[styles.mark, shadowAccent]}>
            <Icon name="check" size={34} color={colors.textInverse} strokeWidth={2.6} />
          </View>
          <Text style={styles.title}>Order placed</Text>
          <Text style={styles.subtitle}>
            Thank you. We've sent a confirmation to {order.shippingAddress.phone} and will notify
            you at every step.
          </Text>
        </View>

        {/* Group + Row rather than a local DetailRow: this was the last screen
            rebuilding a grouped list by hand. Group draws the hairlines, so the
            per-row `divided` flag is gone with it. */}
        <Group style={styles.card}>
          <Row label="Order" value={order.orderNumber} />
          {/* One combined line would be wrong about both halves of a split
              payment, so each is stated on its own. */}
          {splitPayment ? (
            <>
              <Row label="Paid online · shipping" value={formatPaise(paidOnline)} />
              <Row label="Pay on delivery" value={formatPaise(dueOnDelivery)} />
            </>
          ) : (
            <Row
              label={order.paymentStatus === 'paid' ? 'Paid' : 'Payable'}
              value={`${formatPaise(order.totalAmount)} · ${
                order.paymentMethod === 'cod' ? 'On delivery' : 'Online'
              }`}
            />
          )}
          <Row
            label="Delivery to"
            value={`${order.shippingAddress.city}, ${order.shippingAddress.pincode}`}
          />
          <Row
            label="Placed"
            value={new Date(order.createdAt).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
            })}
          />
        </Group>

        <View style={styles.thumbRow}>
          {thumbs.map((item, index) => (
            <Image
              key={`${item.productId}-${index}`}
              source={item.image}
              style={styles.thumb}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ))}
          <Text style={styles.thumbCaption}>
            {pieces} piece{pieces === 1 ? '' : 's'} in this order
          </Text>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Button
          label="Track this order"
          onPress={() => navigation.replace('OrderDetail', { orderId: order.id })}
        />
        <Button
          label="Keep shopping"
          onPress={() => navigation.replace('CustomerTabs', { screen: 'Catalog' })}
          variant="ghost"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xl },
  hero: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingTop: 72 },
  mark: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.display, fontSize: 30, color: colors.text, marginTop: spacing.xl + 4 },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 25,
    marginTop: spacing.md,
    maxWidth: 300,
  },

  card: { marginHorizontal: spacing.xl, marginTop: spacing.xxl },

  thumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xl,
  },
  thumb: { width: 52, height: 52, borderRadius: 12, backgroundColor: colors.surface },
  thumbCaption: { ...typography.caption, color: colors.textFaint, marginLeft: spacing.xs },

  footer: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.md },
});
