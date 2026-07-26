/* Temporary: list extraction runs to tell a stale row from a fresh failure. */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const env = {};
fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
  .split(/\r?\n/)
  .forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  });

(async () => {
  const db = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  });
  await db.connect();
  const rows = await db.query(
    'SELECT id, transcription_id, kind, status, created_at, left(message, 90) AS msg FROM ai_extraction_runs ORDER BY id',
  );
  fs.writeFileSync(
    path.join(__dirname, 'tmp-runs.txt'),
    rows.rows.map((r) => JSON.stringify(r)).join('\n') || '(none)',
    'utf8',
  );
  await db.end();
})().catch((e) =>
  fs.writeFileSync(path.join(__dirname, 'tmp-runs.txt'), 'FAILED: ' + e.message, 'utf8'),
);
