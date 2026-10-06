import { useCallback, useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Group,
  LargeTitle,
  LoadingView,
  Screen,
} from '../../components/ui';
import { QuantityStepper } from '../../components/QuantityStepper';
import { PressableScale } from '../../components/motion';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  clearError,
  fetchCart,
  removeFromCart,
  updateCartQuantity,
} from '../../store/slices/cartSlice';
import { colors, radius, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * PRD 4.3 — quantity adjustment, removal, and an order summary before checkout.
 * A stock problem tints its own row's stepper and says why in one line; the
 * checkout button greys out rather than the screen shouting.
 *
 * Each row also carries its own "Buy now", so a customer holding five pieces can
 * order one of them without checking out — or emptying — the rest. It reuses the
 * same single-product checkout the product page uses, which the server prices
 * and fulfils without touching the saved cart.
 */
export function CartScreen() {
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();
  const { cart, loading, mutating, error } = useAppSelector((state) => state.cart);

  useEffect(() => {
    void dispatch(fetchCart());
  }, [dispatch]);

  // Prices are tier-dependent and stock moves — refetch whenever the tab regains focus.
  useFocusEffect(
    useCallback(() => {
      void dispatch(fetchCart());
    }, [dispatch]),
  );

  if (loading && !cart) return <LoadingView variant="list" />;

  const items = cart?.items ?? [];
  const hasStockIssue = items.some((item) => item.stockIssue);

  if (items.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="cart"
          title="Your cart is empty"
          message="Browse the collection and add something you love."
          action={
            <Button
              label="Start shopping"
              onPress={() => navigation.navigate('CustomerTabs', { screen: 'Catalog' })}
              fullWidth={false}
            />
          }
        />
      </Screen>
    );
  }

  const count = cart?.itemCount ?? 0;

  return (
    <Screen>
      <LargeTitle
        title="Cart"
        caption={`${count} item${count === 1 ? '' : 's'}${
          cart?.priceTier === 'wholesale' ? ' · wholesale pricing' : ''
        }`}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {error ? <ErrorBanner message={error} onRetry={() => dispatch(clearError())} /> : null}

        <Group>
          {items.map((item) => (
            <View key={item.productId} style={styles.row}>
              <PressableScale
                onPress={() => navigation.navigate('ProductDetail', { productId: item.productId })}
              >
                {item.product.images[0] ? (
                  <Image
                    source={item.product.images[0]}
                    style={styles.thumb}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                ) : (
                  <View style={styles.thumb} />
                )}
              </PressableScale>

              <View style={styles.details}>
                {/* The line total sits with the name rather than at the end of
                    the controls row: with three controls down there it is the
                    only arrangement that still fits a 360dp phone. */}
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={2}>
                    {item.product.name}
                  </Text>
                  <Text style={styles.lineTotal} numberOfLines={1}>
                    {formatPaise(item.lineTotal)}
                  </Text>
                </View>

                {item.stockIssue ? (
                  <Text style={styles.stockIssue}>{item.stockIssue}</Text>
                ) : (
                  <Text style={styles.unitPrice}>{formatPaise(item.unitPrice)}</Text>
                )}

                <View style={styles.controls}>
                  <QuantityStepper
                    quantity={item.quantity}
                    onChange={(next) =>
                      dispatch(updateCartQuantity({ productId: item.productId, quantity: next }))
                    }
                    min={1}
                    max={Math.max(1, item.product.stock)}
                    disabled={mutating}
                    flagged={Boolean(item.stockIssue)}
                  />

                  {/* Buys this line alone at its current quantity. Refused
                      while the line is flagged, for the same reason Checkout is:
                      the server would reject the quantity anyway. */}
                  <PressableScale
                    onPress={() =>
                      navigation.navigate('Checkout', {
                        buyNow: { productId: item.productId, quantity: item.quantity },
                      })
                    }
                    disabled={Boolean(item.stockIssue) || mutating}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Buy ${item.product.name} now`}
                  >
                    <Text
                      style={[
                        styles.buyNow,
                        (item.stockIssue || mutating) && styles.actionDisabled,
                      ]}
                    >
                      Buy now
                    </Text>
                  </PressableScale>

                  <PressableScale
                    onPress={() => dispatch(removeFromCart(item.productId))}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.product.name}`}
                  >
                    <Text style={styles.remove}>Remove</Text>
                  </PressableScale>

                </View>
              </View>
            </View>
          ))}
        </Group>
      </ScrollView>

      <View style={styles.summary}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal</Text>
          <Text style={styles.summaryValue}>{formatPaise(cart?.subtotal ?? 0)}</Text>
        </View>
        <Text style={styles.shippingNote}>
          Shipping calculated at checkout.
        </Text>
        <Button
          label="Checkout"
          onPress={() => navigation.navigate('Checkout')}
          disabled={hasStockIssue || mutating}
          style={{ marginTop: spacing.lg }}
        />
        {hasStockIssue ? (
          <Text style={styles.blockedNote}>Fix the flagged quantity to continue</Text>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },

  row: { flexDirection: 'row', gap: spacing.lg, padding: spacing.xl },
  thumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: colors.background },
  details: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text, flex: 1, minWidth: 0 },
  unitPrice: { ...typography.caption, color: colors.textFaint, marginTop: spacing.xs },
  stockIssue: { ...typography.captionStrong, color: colors.primary, marginTop: spacing.xs },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    // Wraps rather than overflows: a stepper plus two text actions does not fit
    // one line on a 360dp handset, and clipping "Remove" is worse than a
    // second line.
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  /** The affirmative action carries the accent; Remove stays quiet beside it. */
  buyNow: { ...typography.footnoteStrong, color: colors.primary },
  remove: { ...typography.footnote, color: colors.textFaint },
  actionDisabled: { opacity: 0.4 },
  lineTotal: { ...typography.bodyStrong, color: colors.text, flexShrink: 0 },

  summary: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.lg },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  summaryLabel: { ...typography.callout, color: colors.textMuted },
  summaryValue: { ...typography.amount, color: colors.text },
  shippingNote: { ...typography.footnote, color: colors.textFaint, marginTop: spacing.xs },
  blockedNote: {
    ...typography.footnoteStrong,
    color: colors.primary,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
