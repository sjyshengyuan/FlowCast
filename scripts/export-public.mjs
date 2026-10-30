import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Explicit roots prevent new runtime directories from entering a source release.
export const PUBLIC_FILES = [
 '.gitignore', '.dockerignore', 'README.md', 'DEVELOPMENT.md', 'CHANGELOG.md',
 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'package.json',
 'package-lock.json', 'server.mjs', 'android/settings.gradle', 'android/build.gradle',
 'android/gradle.properties', 'android/app/build.gradle',
 'remote/.env.example', 'remote/README.md', 'remote/hub.mjs',
 'remote/Dockerfile', 'remote/compose.yaml', 'remote/Caddyfile',
];
export const PUBLIC_TREES = ['desktop', 'lib', 'public', 'scripts', 'tests', 'android/app/src/main'];
const textExtensions = new Set(['.mjs', '.cjs', '.js', '.java', '.gradle', '.properties',
 '.xml', '.html', '.css', '.svg', '.md', '.json', '.ps1']);
const ignoredDirectories = new Set(['build', '.gradle', 'node_modules', 'recordings',
 'dist', '.qa', '.flowcast', '.toolchain', '.git', '.publish', '.idea', '.vscode']);
const privateFiles = /(?:^\.env(?:\.|$)|^local\.properties$|^(?:keystore|key|signing)\.properties$|\.(?:pem|key|jks|keystore|p12|pfx|log|webm|mp4|apk|exe|zip|bak|tmp)$)/i;
const rules = [
 ['private key', new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'].join(''))],
 ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
 ['personal Windows path', /[A-Za-z]:[\\/](?:Users|ME)[\\/]/i],
];

const exampleValues = new Map(Object.entries({
 FLOWCAST_REMOTE_DOMAIN: 'connect.example.com',
 FLOWCAST_REMOTE_PUBLIC_URL: 'https://connect.example.com',
 FLOWCAST_REMOTE_ACCESS_KEY: 'CHANGE_ME_ACCESS_KEY',
 FLOWCAST_TURN_SECRET: 'CHANGE_ME_TURN_SECRET',
 FLOWCAST_TURN_PUBLIC_IP: 'CHANGE_ME_PUBLIC_IPV4',
 FLOWCAST_STUN_URLS: 'stun:connect.example.com:3478',
 FLOWCAST_TURN_URLS: 'turn:connect.example.com:3478?transport=udp,turn:connect.example.com:3478?transport=tcp',
 FLOWCAST_RELAY_ONLY: '0',
}));

function checkText(file, data) {
 const text = data.toString('utf8');
 for (const [category, pattern] of rules) {
  const match = pattern.exec(text);
  if (match) {
   const line = text.slice(0, match.index).split('\n').length;
   throw new Error(file + ':' + line + ': ' + category + ' (value omitted)');
  }
 }
 if (file === 'remote/.env.example') {
  for (const line of text.split(/\r?\n/).filter(line => line && !line.startsWith('#'))) {
   const separator = line.indexOf('=');
   const key = line.slice(0, separator), value = line.slice(separator + 1);
   if (!exampleValues.has(key) || value !== exampleValues.get(key)) {
    throw new Error(file + ': non-example configuration value (value omitted)');
   }
  }
 }
}

// This is a targeted publication check, not a comprehensive secret scanner.
export async function collectPublicFiles(root) {
 root = await realpath(root);
 const files = new Map();
 async function sourcePath(file) {
  let current = root;
  for (const segment of file.split('/')) {
   current = join(current, segment);
   if ((await lstat(current)).isSymbolicLink()) throw new Error(file + ': symbolic links are not exported');
  }
  return current;
 }
 async function add(file) {
  const source = await sourcePath(file);
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(file + ': expected a regular source file');
  if (stat.size > 4 * 1024 * 1024) throw new Error(file + ': source file exceeds 4 MiB');
  const data = await readFile(source);
  if (!/\.(?:png|ico)$/.test(file)) checkText(file, data);
  files.set(file, data);
 }
 async function walk(relative) {
  const stat = await lstat(await sourcePath(relative));
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(relative + ': expected a source directory');
  for (const entry of (await readdir(join(root, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
   if (ignoredDirectories.has(entry.name) || privateFiles.test(entry.name)) continue;
   const file = relative + '/' + entry.name;
   if (entry.isSymbolicLink()) throw new Error(file + ': symbolic links are not exported');
   if (entry.isDirectory()) await walk(file);
   else if (textExtensions.has(extname(entry.name)) ||
     /^public\/assets\/(?:flowcast(?:-\d+)?\.(?:png|ico)|favicon\.png)$/.test(file)) await add(file);
   else throw new Error(file + ': unrecognized source file; review before export');
  }
 }
 for (const file of PUBLIC_FILES) await add(file);
 for (const tree of PUBLIC_TREES) await walk(tree);
 return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

export async function exportPublicSource(root) {
 root = await realpath(root);
 const files = await collectPublicFiles(root);
 const pkg = JSON.parse(files.get('package.json').toString());
 if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
 const parent = join(root, '.publish');
 await mkdir(parent).catch(error => {if (error.code !== 'EEXIST') throw error;});
 const stat = await lstat(parent);
 if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('.publish must be a real directory');
 const destination = await mkdtemp(join(parent, 'FlowCast-source-' + pkg.version + '-'));
 const manifest = [];
 for (const [file, data] of files) {
  const target = join(destination, file);
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, data, {flag: 'wx'});
  manifest.push({path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')});
 }
 await writeFile(join(destination, 'SOURCE_MANIFEST.json'), JSON.stringify({version: pkg.version, files: manifest}, null, 2) + '\n', {flag: 'wx'});
 return {directory: destination, files: files.size, version: pkg.version};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const root = fileURLToPath(new URL('..', import.meta.url));
 try {
  const result = await exportPublicSource(root);
  console.log(JSON.stringify({...result, directory: '.publish/' + result.directory.split(/[\\/]/).pop()}));
 } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
 }
}
