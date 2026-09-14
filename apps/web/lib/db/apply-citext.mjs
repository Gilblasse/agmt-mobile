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

// The real schema has exactly these five citext columns (drivers.name,
// drivers.email, office_users.email, passengers.name, vehicles.label). If
// drizzle-kit changes how it reports an unparseable type, this patch would
// otherwise no-op silently and leave name matching case-sensitive.
const EXPECTED = 5;
if (before !== EXPECTED) {
  console.error(
    `citext: expected ${EXPECTED} unparsed citext columns, found ${before}. ` +
      `Either the schema changed — update EXPECTED — or drizzle-kit changed its output ` +
      `and this patch no longer applies. Not writing.`,
  );
  process.exit(1);
}

fs.writeFileSync(file, source);
console.log(`citext: replaced ${before} unknown() columns`);
