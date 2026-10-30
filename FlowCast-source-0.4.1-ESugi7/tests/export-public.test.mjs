import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {PUBLIC_FILES, PUBLIC_TREES, collectPublicFiles, exportPublicSource} from '../scripts/export-public.mjs';

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'flowcast-export-test-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 async function put(file, content = '// test source\n') {
  const target = join(root, file);
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, content);
 }
 for (const file of PUBLIC_FILES) await put(file, file === 'package.json' ? '{"version":"0.4.1"}' : file === 'remote/.env.example' ? 'FLOWCAST_REMOTE_ACCESS_KEY=CHANGE_ME_ACCESS_KEY\n' : '// test source\n');
 for (const tree of PUBLIC_TREES) await mkdir(join(root, tree), {recursive: true});
 return {root, put};
}

test('source export excludes private directories, credentials and build outputs, retaining the template', async t => {
 const {root, put} = await fixture(t);
 for (const file of ['.flowcast/key.pem', 'recordings/private.webm', '.qa/qr.png', 'android/app/build/private.txt',
  'public/.env', 'android/app/src/main/release.jks', 'desktop/debug.log']) await put(file, 'private');
 await put('public/app.js', '// source');
 const result = await exportPublicSource(root);
 const manifest = JSON.parse(await readFile(join(result.directory, 'SOURCE_MANIFEST.json')));
 assert.ok(manifest.files.some(file => file.path === 'remote/.env.example'));
 assert.ok(manifest.files.some(file => file.path === 'public/app.js'));
 assert.ok(!manifest.files.some(file => /private|release.jks|debug.log|public\/\.env/.test(file.path)));
 for (const file of manifest.files) {
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!file.path.includes(root));
 }
});

test('source export refuses embedded private keys without printing the value', async t => {
 const {root, put} = await fixture(t);
 const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
 await put('public/app.js', marker);
 await assert.rejects(collectPublicFiles(root), error => {
  assert.match(error.message, /public\/app.js:1: private key/);
  assert.ok(!error.message.includes(marker));
  return true;
 });
});

test('source export refuses live values in the environment example', async t => {
 const {root, put} = await fixture(t);
 await put('remote/.env.example', 'FLOWCAST_REMOTE_ACCESS_KEY=not-an-example');
 await assert.rejects(collectPublicFiles(root), /non-example configuration/);
});

test('source export refuses credential-like URLs in the environment example', async t => {
 const {root, put} = await fixture(t);
 await put('remote/.env.example', 'FLOWCAST_REMOTE_ACCESS_KEY=https://connect.example.com?key=private');
 await assert.rejects(collectPublicFiles(root), /non-example configuration/);
});

test('source export rejects links to files outside the release', async t => {
 const {root} = await fixture(t);
 try {await symlink(root, join(root, 'public/linked'), process.platform === 'win32' ? 'junction' : 'dir');}
 catch (error) {if (error.code === 'EPERM' || error.code === 'EACCES') {t.skip('Symlinks are unavailable in this environment');return;}throw error;}
 await assert.rejects(collectPublicFiles(root), /symbolic links/);
});
