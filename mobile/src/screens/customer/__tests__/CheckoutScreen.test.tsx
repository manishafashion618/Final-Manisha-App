import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import cartReducer from '../../../store/slices/cartSlice';
import authReducer from '../../../store/slices/authSlice';
import { CheckoutScreen } from '../CheckoutScreen';
import {
  cartApi,
  configApi,
  orderApi,
  type CodOptions,
  type StoreConfig,
} from '../../../api/endpoints';

/**
 * The checkout screen is the only place in the app that adds a total up
 * itself, and that total is shown immediately before Razorpay collects it.
 * These tests pin the two halves of that agreement:
 *
 *   1. the shipping it displays is the figure the server quoted FOR THIS
 *      ADDRESS, not the store-wide default, and
 *   2. the total it displays is the amount Razorpay is then asked for.
 *
 * The regression they guard: prepaid shipping used to be read from
 * `/config.prepaidShippingCharge`, a single global. Once the server priced it
 * per state, a Tamil Nadu buyer was shown "Free" and charged ₹60.
 */

const PRICE = 60_000; // ₹600, one item
const TN_PREPAID = 6_000; // ₹60 — what Tamil Nadu actually costs
const TN_COD = 5_000; // ₹50

const mockNavigate = jest.fn();
const mockReplace = jest.fn();

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: mockReplace,
    goBack: jest.fn(),
    setParams: jest.fn(),
  }),
  useRoute: () => ({ params: undefined }),
}));

jest.mock('../../../api/endpoints', () => ({
  configApi: { get: jest.fn() },
  orderApi: { codOptions: jest.fn(), checkout: jest.fn() },
  productApi: { detail: jest.fn() },
  cartApi: { get: jest.fn() },
}));

const mockConfig = configApi.get as jest.Mock;
const mockCodOptions = orderApi.codOptions as jest.Mock;
const mockCheckout = orderApi.checkout as jest.Mock;
const mockCartGet = cartApi.get as jest.Mock;

/** One ₹600 item. The screen refetches this on mount, so the mock returns it too. */
const testCart = {
  id: 'cart-1',
  items: [
    {
      product: { id: 'p1', name: 'Jhumka', price: PRICE, images: [], stock: 5 },
      quantity: 1,
      lineTotal: PRICE,
    },
  ],
  subtotal: PRICE,
  itemCount: 1,
};

/**
 * A server that prices both methods per state. Its own prepaid default is
 * deliberately NOT Tamil Nadu's charge: if the screen reads this instead of
 * the address quote, the total it shows is ₹600 and the test fails.
 */
const storeConfig: StoreConfig = {
  currency: 'INR',
  codShippingCharge: 5_000,
  codDefaultEnabled: true,
  codPerStateSupported: true,
  prepaidShippingCharge: 10_000, // the store-wide default — wrong for this address
  prepaidPerStateSupported: true,
  codShippingPaidOnline: true,
  razorpayEnabled: true,
  razorpayKeyId: 'rzp_test_checkout',
  buyNowSupported: true,
};

const tamilNaduQuote: CodOptions = {
  addressId: 'addr-1',
  state: 'Tamil Nadu',
  codEnabled: true,
  codCharge: TN_COD,
  prepaidShippingCharge: TN_PREPAID,
  usingDefault: false,
};

function renderCheckout() {
  const store = configureStore({
    reducer: { cart: cartReducer, auth: authReducer },
    preloadedState: {
      cart: {
        cart: testCart,
        orders: [],
        loading: false,
        mutating: false,
        placingOrder: false,
        error: null,
      } as never,
      auth: {
        status: 'signedIn',
        user: {
          id: 'u1',
          name: 'Test Buyer',
          accountType: 'retail',
          permissions: [],
          addresses: [
            {
              id: 'addr-1',
              label: 'Home',
              fullName: 'Test Buyer',
              phone: '+919876500000',
              line1: '12 Test Street',
              city: 'Chennai',
              state: 'Tamil Nadu',
              pincode: '600001',
              isDefault: true,
            },
          ],
        },
        loading: false,
        error: null,
      } as never,
    },
  });

  return render(
    <Provider store={store}>
      <CheckoutScreen />
    </Provider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.mockResolvedValue(storeConfig);
  mockCodOptions.mockResolvedValue(tamilNaduQuote);
  mockCartGet.mockResolvedValue(testCart);
});

describe('what the checkout screen shows for a prepaid order', () => {
  it("uses this address's shipping charge, not the store-wide default", async () => {
    const { findByText, queryByText } = renderCheckout();

    // ₹60 for Tamil Nadu — not ₹100 (the store default) and not "Free".
    await findByText('₹60');
    expect(queryByText('Free')).toBeNull();
    // ₹600 + ₹60.
    expect(await findByText('₹660')).toBeTruthy();
  });

  it('shows no total and refuses the order until the charge arrives', async () => {
    let release: (value: CodOptions) => void = () => {};
    mockCodOptions.mockReturnValue(new Promise<CodOptions>((resolve) => { release = resolve; }));

    const { findByText, getByText, queryByText } = renderCheckout();

    // Nothing is quoted yet, so there is no total to show and nothing to pay.
    await findByText('Calculating…');
    expect(queryByText('₹660')).toBeNull();
    expect(getByText('—')).toBeTruthy();
    fireEvent.press(getByText('Pay now'));
    expect(mockCheckout).not.toHaveBeenCalled();

    release(tamilNaduQuote);
    await findByText('₹660');
  });

  it('asks Razorpay for exactly the total it displayed', async () => {
    /* The server prices the order from the saved address, the same way it
       answered the quote. Agreement between the two is the thing under test:
       the amount handed to the payment sheet is compared with the total the
       customer just read on screen. */
    mockCheckout.mockImplementation(async () => {
      const total = PRICE + tamilNaduQuote.prepaidShippingCharge;
      return {
        order: { id: 'o1', paymentMethod: 'razorpay', totalAmount: total },
        payment: {
          razorpayOrderId: 'order_test_1',
          amount: total,
          currency: 'INR',
          keyId: 'rzp_test_checkout',
        },
      };
    });

    const { findByText, getByText } = renderCheckout();
    await findByText('₹660');

    fireEvent.press(getByText('Pay now'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const [screen, params] = mockNavigate.mock.calls[0];
    expect(screen).toBe('RazorpayCheckout');
    // ₹660 on screen, ₹660 in the sheet.
    expect(params.handle.amount).toBe(66_000);
    expect(getByText('₹660')).toBeTruthy();
  });
});

describe('a state the store has not configured', () => {
  it('shows the default charge the server quoted for it', async () => {
    mockCodOptions.mockResolvedValue({
      ...tamilNaduQuote,
      state: 'Maharashtra',
      prepaidShippingCharge: 10_000,
      usingDefault: true,
    });

    const { findByText } = renderCheckout();

    // ₹600 + ₹100.
    await findByText('₹700');
  });
});
