/**
 * `drizzle-kit pull` cannot parse `citext` and emits `unknown(...)`, which is
 * not a real column type. This re-applies the custom type after a pull, so
 * regenerating the schema does not quietly break name and email matching.
 */
import fs from 'node:fs';

const file = new URL('./schema.ts', import.meta.url);
let source = fs.readFileSync(file, 'utf8');
const before = (source.match(/\bunknown\(/g) ?? []).length;

source = source
  .replace(/[ \t]*\/\/ TODO: failed to parse database type 'citext'\n/g, '')
  .replace(/\bunknown\(/g, 'citext(');

if (before > 0 && !source.includes("from './citext'")) {
  source = source.replace(
    /^(import \{[\s\S]*?\} from "drizzle-orm\/pg-core"\n)/m,
    `$1import { citext } from './citext';\n`,
  );
}

fs.writeFileSync(file, source);
console.log(`citext: replaced ${before} unknown() column${before === 1 ? '' : 's'}`);
