import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { transformSync } from 'esbuild';

// Forge compiles the UI Kit page only at deploy time, so a syntax error or a
// component name that does not exist would first show up on the founder's
// first `forge deploy`. This compiles every frontend file and checks each
// named import from @forge/react against the package's real exports.

const dir = new URL('../src/frontend/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.jsx?$/.test(f));
const reactExports = readFileSync(new URL('../node_modules/@forge/react/out/components/ui-kit-components.d.ts', import.meta.url), 'utf8');
const hookExports = readFileSync(new URL('../node_modules/@forge/react/out/index.d.ts', import.meta.url), 'utf8');

for (const file of files) {
  test(`${file} compiles and imports only real UI Kit components`, () => {
    const code = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotThrow(() => transformSync(code, { loader: 'jsx', jsx: 'automatic' }));
    const block = /import ForgeReconciler,\s*{([^}]+)}\s*from '@forge\/react'/m.exec(code);
    assert.ok(block, 'imports ForgeReconciler and components from @forge/react');
    const names = block[1].split(',').map((s) => s.trim()).filter(Boolean);
    const missing = names.filter((n) => !new RegExp(`export declare const ${n}\\b`).test(reactExports) && !new RegExp(`\\b${n}\\b`).test(hookExports));
    assert.deepEqual(missing, []);
  });
}
