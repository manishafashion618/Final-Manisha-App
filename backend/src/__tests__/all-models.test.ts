import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { ALL_MODELS } from '../models';

/**
 * autoIndex is off in production, so a model's indexes exist there only if
 * scripts/dbIndexes.ts builds them — and it builds exactly ALL_MODELS. A model
 * left out of that list never gets its indexes (the role-change log once was).
 */
describe('ALL_MODELS', () => {
  it('lists every model in src/models', () => {
    const dir = path.join(__dirname, '..', 'models');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.model.ts'))) {
      require(path.join(dir, file));
    }
    const listed = new Set(ALL_MODELS.map((model) => model.modelName));
    expect(mongoose.modelNames().filter((name) => !listed.has(name))).toEqual([]);
  });
});
