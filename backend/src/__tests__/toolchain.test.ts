import fs from 'fs';
import path from 'path';

/**
 * What Render builds with. Render installs the newest Node that satisfies
 * engines.node, so the major is pinned to the one these tests run on; and the
 * lockfile Render installs from must not carry the axios advisory range
 * (1.0.0–1.19.0) — that fix once missed main because the commit was never
 * pushed, while local audits looked clean.
 */

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const major = (version: string) => Number(version.replace(/^v/, '').split('.')[0]);

describe('the Node version Render uses', () => {
  it('pins engines.node to one major, in package.json and the lockfile alike', () => {
    expect(pkg.engines.node).toMatch(/^\d+\.x$/);
    expect(lock.packages[''].engines.node).toBe(pkg.engines.node);
  });

  it('is the major these tests run on', () => {
    expect(major(process.version)).toBe(major(pkg.engines.node));
  });
});

describe('the lockfile Render installs from', () => {
  it('resolves axios outside the advisory range (fixed in 1.20.0)', () => {
    const [maj, min] = lock.packages['node_modules/axios'].version.split('.').map(Number);
    expect(maj > 1 || (maj === 1 && min >= 20)).toBe(true);
  });
});
