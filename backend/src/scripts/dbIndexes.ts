/**
 * Builds the indexes every model declares — the deploy step that replaces
 * autoIndex, which is off in production (config/database.ts).
 *
 *   npm run db:indexes                              check the local database
 *   npm run db:indexes -- --target=production      check production (read-only)
 *   npm run db:indexes -- --apply --target=production
 *
 * Default is CHECK: read-only. It reports documents that would violate a
 * unique index (duplicate emails, duplicate COD state rows by canonical state
 * name, …) and what would be created or dropped. --apply runs syncIndexes() on
 * every model, and refuses while any duplicate remains — dedupe first.
 *
 * Credentials: pass an index-capable user just for this run, e.g.
 *   MONGODB_INDEX_URI='mongodb+srv://indexer:…@cluster…/manisha_fashions' \
 *     npm run db:indexes -- --apply --target=production
 * so that account never has to live in the app's environment. Without it the
 * app's MONGODB_URI is used.
 *
 * DNS_SERVERS=8.8.8.8,1.1.1.1 works around resolvers that fail Atlas's SRV
 * lookup (seen on some macOS setups).
 */
import dns from 'dns';
import 'dotenv/config';
import mongoose, { type Model } from 'mongoose';
import { assertScriptWriteTarget, isLocalMongoUri, redactMongoUri } from '../config/dbTarget';

const APPLY = process.argv.includes('--apply');

interface Duplicate {
  collection: string;
  index: string;
  groups: number;
  sample: string[];
}

function mask(value: unknown): string {
  const text = String(value);
  const at = text.indexOf('@');
  if (at > 0) return `${text.slice(0, 2)}…${text.slice(at)}`;
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** Documents that share a value on a unique index that is about to be built. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function duplicatesFor(model: Model<any>): Promise<Duplicate[]> {
  const found: Duplicate[] = [];
  for (const [fields, options] of model.schema.indexes()) {
    if (!options?.unique) continue;
    const keys = Object.keys(fields);
    // A sparse index only covers documents that have the field.
    const match = options.sparse ? Object.fromEntries(keys.map((key) => [key, { $exists: true }])) : {};
    const groups = await model.collection
      .aggregate([
        { $match: match },
        { $group: { _id: Object.fromEntries(keys.map((key) => [key.replace(/\./g, '_'), `$${key}`])), n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();
    if (groups.length > 0) {
      found.push({
        collection: model.collection.name,
        index: JSON.stringify(fields),
        groups: groups.length,
        sample: groups.slice(0, 5).map((group) => `${Object.values(group._id).map(mask).join(', ')} ×${group.n}`),
      });
    }
  }
  return found;
}

/** Emails are lowercased by the schema, but check case-insensitively anyway. */
async function caseInsensitiveEmailDuplicates(): Promise<Duplicate | null> {
  const { User } = await import('../models/user.model');
  const groups = await User.collection
    .aggregate([
      { $match: { email: { $type: 'string' } } },
      { $group: { _id: { $toLower: { $trim: { input: '$email' } } }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  if (groups.length === 0) return null;
  return {
    collection: 'users',
    index: 'email (case-insensitive, trimmed)',
    groups: groups.length,
    sample: groups.slice(0, 5).map((group) => `${mask(group._id)} ×${group.n}`),
  };
}

/** Two rows that resolve to the same state would clash on the stateKey index. */
async function codStateDuplicates(): Promise<{ duplicate: Duplicate | null; rekey: string[] }> {
  const { CodStateConfig } = await import('../models/codStateConfig.model');
  const { stateKeyFor } = await import('../services/cod.service');
  const rows = await CodStateConfig.find({}, { state: 1, stateKey: 1, codCharge: 1, codEnabled: 1 }).lean();
  const byCanonical = new Map<string, typeof rows>();
  const rekey: string[] = [];
  for (const row of rows) {
    const canonical = stateKeyFor(row.state);
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), row]);
    if (row.stateKey !== canonical) rekey.push(`"${row.state}": stateKey "${row.stateKey}" → "${canonical}"`);
  }
  const clashes = [...byCanonical.entries()].filter(([, group]) => group.length > 1);
  return {
    duplicate:
      clashes.length === 0
        ? null
        : {
            collection: 'codstateconfigs',
            index: 'canonical state (stateKeyFor)',
            groups: clashes.length,
            sample: clashes.map(
              ([key, group]) =>
                `${key}: ${group.map((row) => `"${row.state}" ₹${row.codCharge / 100}${row.codEnabled ? '' : ' (off)'}`).join(' | ')}`,
            ),
          },
    rekey,
  };
}

async function main(): Promise<void> {
  if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(','));

  const uri = process.env.MONGODB_INDEX_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI (or MONGODB_INDEX_URI for a one-off credential).');

  // Reading a remote database still needs the explicit flag, so a check can
  // never be pointed at production by accident; writing needs it all the more.
  assertScriptWriteTarget(uri);

  console.log(`\nDatabase : ${redactMongoUri(uri)}${isLocalMongoUri(uri) ? ' (local)' : ''}`);
  console.log(`Mode     : ${APPLY ? 'APPLY — will build and drop indexes' : 'CHECK — read-only'}\n`);

  // autoCreate off as well: Mongoose 8 otherwise creates every missing
  // collection on connect, and CHECK must write nothing.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000, autoIndex: false, autoCreate: false });
  const { ALL_MODELS } = await import('../models');

  try {
    const duplicates: Duplicate[] = [];
    for (const model of ALL_MODELS) duplicates.push(...(await duplicatesFor(model)));
    const emailDupes = await caseInsensitiveEmailDuplicates();
    if (emailDupes) duplicates.push(emailDupes);
    const cod = await codStateDuplicates();
    if (cod.duplicate) duplicates.push(cod.duplicate);

    console.log('── Duplicates that would block a unique index ──');
    if (duplicates.length === 0) console.log('  none');
    for (const dup of duplicates) {
      console.log(`  ${dup.collection} ${dup.index}: ${dup.groups} group(s)`);
      for (const line of dup.sample) console.log(`    - ${line}`);
    }
    if (cod.rekey.length > 0) {
      console.log('  codstateconfigs rows whose stateKey is not the canonical key (re-save them from the admin screen):');
      for (const line of cod.rekey) console.log(`    - ${line}`);
    }

    console.log('\n── Index changes ──');
    let pending = 0;
    for (const model of ALL_MODELS) {
      const diff = await model.diffIndexes();
      const toCreate = diff.toCreate.map((spec) => JSON.stringify(spec));
      const toDrop = diff.toDrop;
      pending += toCreate.length + toDrop.length;
      if (toCreate.length === 0 && toDrop.length === 0) {
        console.log(`  ${model.collection.name}: up to date`);
        continue;
      }
      console.log(`  ${model.collection.name}:`);
      for (const spec of toCreate) console.log(`    + create ${spec}`);
      for (const name of toDrop) console.log(`    - drop   ${name}`);
    }

    if (!APPLY) {
      console.log(
        `\nCheck only. ${pending} change(s) pending.` +
          (duplicates.length ? ' Resolve the duplicates above before applying.' : ' Run again with --apply to build them.'),
      );
      return;
    }

    if (duplicates.length > 0) {
      throw new Error('Refusing to apply: duplicates above would make the unique index builds fail. Dedupe first.');
    }

    console.log('\n── Applying ──');
    for (const model of ALL_MODELS) {
      const dropped = await model.syncIndexes();
      console.log(`  ${model.collection.name}: synced${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
    }
    console.log('\nDone.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}\n`);
  process.exit(1);
});
