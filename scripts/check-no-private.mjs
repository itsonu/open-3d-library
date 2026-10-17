// Fails if git tracks anything from the private local collection. Run via `npm run check:private`.
// The names to guard come from your own (git-ignored) local-assets/ folder, so this file never has to list them.
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';

let local = [];
try { local = readdirSync('local-assets', {withFileTypes: true}).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name); } catch {}
const bad = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0')
  .filter(p => p && (p.startsWith('local-assets/') || local.some(id => p.split('/').includes(id))));
if (bad.length) { console.error('Private files are tracked by git:\n' + bad.map(p => '  ' + p).join('\n')); process.exit(1); }
console.log(`check:private ok (${local.length} local folder name${local.length === 1 ? '' : 's'} guarded)`);
