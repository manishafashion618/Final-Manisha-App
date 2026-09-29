jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

import { siteUrlFrom } from '../legalLinks';

describe('siteUrlFrom', () => {
  it.each([
    ['https://final-manisha-app.onrender.com/api/v1', 'https://final-manisha-app.onrender.com'],
    ['https://final-manisha-app.onrender.com/api/v1/', 'https://final-manisha-app.onrender.com'],
    ['http://10.0.2.2:4000/api/v2', 'http://10.0.2.2:4000'],
    // A base without the prefix is already the site.
    ['https://example.com', 'https://example.com'],
  ])('%s → %s', (apiBase, site) => {
    expect(siteUrlFrom(apiBase)).toBe(site);
  });
});
