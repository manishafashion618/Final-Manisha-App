import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { cartApi, orderApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { Cart, CheckoutResult, Order } from '../../api/types';

/**
 * PRD 8.1 cartSlice — items, quantities and total. The total always comes from
 * the server, which prices the cart at the account's tier; the client never
 * computes or sends prices.
 */

interface CartState {
  cart: Cart | null;
  orders: Order[];
  loading: boolean;
  mutating: boolean;
  placingOrder: boolean;
  error: string | null;
}

const initialState: CartState = {
  cart: null,
  orders: [],
  loading: false,
  mutating: false,
  placingOrder: false,
  error: null,
};

function messageFor(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export const fetchCart = createAsyncThunk<Cart>('cart/fetch', async () => cartApi.get());

export const addToCart = createAsyncThunk<
  Cart,
  { productId: string; quantity?: number },
  { rejectValue: string }
>('cart/add', async ({ productId, quantity = 1 }, { rejectWithValue }) => {
  try {
    return await cartApi.add(productId, quantity);
  } catch (error) {
    return rejectWithValue(messageFor(error, 'Could not add this item to your cart.'));
  }
});

export const updateCartQuantity = createAsyncThunk<
  Cart,
  { productId: string; quantity: number },
  { rejectValue: string }
>('cart/updateQuantity', async ({ productId, quantity }, { rejectWithValue }) => {
  try {
    return await cartApi.updateQuantity(productId, quantity);
  } catch (error) {
    return rejectWithValue(messageFor(error, 'Could not update the quantity.'));
  }
});

export const removeFromCart = createAsyncThunk<Cart, string>('cart/remove', async (productId) =>
  cartApi.remove(productId),
);

export const checkout = createAsyncThunk<
  CheckoutResult,
  {
    addressId: string;
    paymentMethod: 'razorpay' | 'cod';
    /** "Buy now" — order this product alone and leave the saved cart untouched. */
    buyNow?: { productId: string; quantity: number };
  },
  { rejectValue: string }
>('cart/checkout', async (input, { rejectWithValue }) => {
  try {
    return await orderApi.checkout(input);
  } catch (error) {
    return rejectWithValue(messageFor(error, 'Could not place your order.'));
  }
});

export const confirmPayment = createAsyncThunk<
  Order,
  { orderId: string; razorpayPaymentId: string; razorpaySignature: string },
  { rejectValue: string }
>('cart/confirmPayment', async (input, { rejectWithValue }) => {
  try {
    return await orderApi.confirmPayment(input);
  } catch (error) {
    return rejectWithValue(messageFor(error, 'We could not verify your payment.'));
  }
});

export const fetchOrders = createAsyncThunk<Order[]>('cart/fetchOrders', async () => {
  const { data } = await orderApi.listMine(1, 50);
  return data;
});

export const cancelOrder = createAsyncThunk<
  Order,
  { orderId: string; reason?: string },
  { rejectValue: string }
>('cart/cancelOrder', async ({ orderId, reason }, { rejectWithValue }) => {
  try {
    return await orderApi.cancel(orderId, reason);
  } catch (error) {
    return rejectWithValue(messageFor(error, 'Could not cancel this order.'));
  }
});

const cartSlice = createSlice({
  name: 'cart',
  initialState,
  reducers: {
    clearError(state) {
      state.error = null;
    },
    resetCart(state) {
      state.cart = null;
      state.orders = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCart.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchCart.fulfilled, (state, action) => {
        state.loading = false;
        state.cart = action.payload;
      })
      .addCase(fetchCart.rejected, (state) => {
        state.loading = false;
      })

      .addCase(checkout.pending, (state) => {
        state.placingOrder = true;
        state.error = null;
      })
      .addCase(checkout.fulfilled, (state, action) => {
        state.placingOrder = false;
        state.orders = [action.payload.order, ...state.orders];
        // Mirrors the server: an order confirmed at checkout (COD with nothing to
        // pay online) empties the cart now; one that still owes an online
        // payment — any Razorpay order, and COD whose shipping is paid online —
        // keeps it until the payment is confirmed. A Buy-now order was never
        // built from the cart, so it is left alone either way.
        if (!action.payload.payment && !action.payload.order.fromBuyNow) {
          state.cart = { items: [], itemCount: 0, subtotal: 0, priceTier: 'retail', currency: 'INR' };
        }
      })
      .addCase(checkout.rejected, (state, action) => {
        state.placingOrder = false;
        state.error = action.payload ?? 'Could not place your order.';
      })

      .addCase(confirmPayment.fulfilled, (state, action) => {
        // Mirrors the server: paying for a Buy-now order does not touch the cart.
        if (!action.payload.fromBuyNow) {
          state.cart = { items: [], itemCount: 0, subtotal: 0, priceTier: 'retail', currency: 'INR' };
        }
        state.orders = [action.payload, ...state.orders.filter((o) => o.id !== action.payload.id)];
      })
      .addCase(confirmPayment.rejected, (state, action) => {
        state.error = action.payload ?? 'We could not verify your payment.';
      })

      .addCase(fetchOrders.fulfilled, (state, action) => {
        state.orders = action.payload;
      })

      .addCase(cancelOrder.fulfilled, (state, action) => {
        state.orders = state.orders.map((order) =>
          order.id === action.payload.id ? action.payload : order,
        );
      })
      .addCase(cancelOrder.rejected, (state, action) => {
        state.error = action.payload ?? 'Could not cancel this order.';
      })

      // Every cart mutation returns the whole recomputed cart, so one matcher
      // keeps the three thunks in sync without repeating reducers.
      .addMatcher(
        (action) =>
          [addToCart.fulfilled.type, updateCartQuantity.fulfilled.type, removeFromCart.fulfilled.type].includes(
            action.type,
          ),
        (state, action: { payload: Cart }) => {
          state.mutating = false;
          state.cart = action.payload;
        },
      )
      .addMatcher(
        (action) =>
          [addToCart.pending.type, updateCartQuantity.pending.type, removeFromCart.pending.type].includes(
            action.type,
          ),
        (state) => {
          state.mutating = true;
          state.error = null;
        },
      )
      .addMatcher(
        (action) =>
          [addToCart.rejected.type, updateCartQuantity.rejected.type, removeFromCart.rejected.type].includes(
            action.type,
          ),
        (state, action: { payload?: string }) => {
          state.mutating = false;
          state.error = action.payload ?? 'Could not update your cart.';
        },
      );
  },
});

export const { clearError, resetCart } = cartSlice.actions;
export default cartSlice.reducer;
