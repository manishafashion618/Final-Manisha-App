import { clearTestDb, connectTestDb, disconnectTestDb } from './helpers/testServer';
import { ROLE_CHANGE_RETENTION_SECONDS, RoleChange } from '../models/roleChange.model';

/**
 * The privacy policy says records of account role changes are kept for 3
 * years. A TTL index on createdAt enforces it; autoIndex is off in production,
 * so it exists there once scripts/dbIndexes.ts builds it (ALL_MODELS).
 */
beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const DAY = 24 * 60 * 60;

describe('role-change log retention', () => {
  it('declares a TTL of three full years on createdAt', () => {
    const declared = RoleChange.schema.indexes().filter(([, options]) => options?.expireAfterSeconds !== undefined);
    expect(declared).toEqual([[{ createdAt: -1 }, expect.objectContaining({ expireAfterSeconds: ROLE_CHANGE_RETENTION_SECONDS })]]);
    // Three calendar years hold at most one leap day: 1096 days, never fewer.
    expect(ROLE_CHANGE_RETENTION_SECONDS / DAY).toBeGreaterThanOrEqual(1096);
    expect(ROLE_CHANGE_RETENTION_SECONDS / DAY).toBeLessThan(1100);
  });

  it('is built as a TTL index by the database', async () => {
    await RoleChange.createIndexes();
    const index = (await RoleChange.collection.indexes()).find((candidate) => candidate.name === 'createdAt_-1');
    expect(index?.expireAfterSeconds).toBe(ROLE_CHANGE_RETENTION_SECONDS);
  });
});
