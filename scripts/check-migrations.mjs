import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const migrationDir = path.join(root, "supabase", "migrations");
const ledgerPath = path.join(root, "supabase", "baseline-migration-ledger.json");
const baselineName = "00000000000000_production_schema_baseline.sql";
const markerText = "Production migration-history marker";

const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
const files = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
const expectedMarkers = ledger.migrations
  .map(({ version, name }) => `${version}_${name}.sql`)
  .sort();
const expected = [baselineName, ...expectedMarkers].sort();
const latestLedgerVersion = ledger.migrations
  .map(({ version }) => version)
  .filter((version) => /^\d{14}$/.test(version))
  .sort()
  .at(-1);

function fail(message) {
  console.error(`Migration integrity check failed: ${message}`);
  process.exitCode = 1;
}

const missing = expected.filter((name) => !files.includes(name));
const future = files.filter((name) => !expected.includes(name));
if (missing.length) fail(`missing active files: ${missing.join(", ")}`);
for (const name of future) {
  const match = name.match(/^(\d{14})_([a-z0-9_]+)\.sql$/);
  if (!match) {
    fail(`unexpected migration filename: ${name}`);
  } else if (match[1] <= latestLedgerVersion) {
    fail(`new migration ${name} must sort after production ledger version ${latestLedgerVersion}`);
  }
}

const versions = files.map((name) => name.slice(0, name.indexOf("_")));
const duplicateVersions = [...new Set(versions.filter((v, i) => versions.indexOf(v) !== i))];
if (duplicateVersions.length) fail(`duplicate versions: ${duplicateVersions.join(", ")}`);

for (const marker of expectedMarkers) {
  const contents = await readFile(path.join(migrationDir, marker), "utf8");
  if (!contents.includes(markerText)) fail(`${marker} is not an immutable no-op marker`);
}

const baseline = await readFile(path.join(migrationDir, baselineName), "utf8");
if (!baseline.includes("create table public.projects")) fail("baseline is missing the projects table");
if (!baseline.includes("enable row level security")) fail("baseline is missing RLS statements");
if (!baseline.includes("create policy")) fail("baseline is missing policy statements");

if (!process.exitCode) {
  const digest = createHash("sha256").update(baseline).digest("hex");
  console.log(`Migration integrity check passed: ${files.length} files, baseline sha256 ${digest}`);
}
