/* Temporary: does a run succeed on a small credit budget by asking for less? */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const kind = process.argv[2] === 'evidence' ? 'evidence' : 'glossary';
const out = [];

const unwrap = (body) =>
  body && typeof body === 'object' && 'data' in body ? body.data : body;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return unwrap(await res.json());
}

(async () => {
  const started = await call('POST', `/ai-extraction/${kind}`, { transcription_id: 9 });
  let run = started;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 4000));
    run = await call('GET', `/ai-extraction/runs/${started.id}`);
    if (run.status !== 'processing') break;
  }
  out.push(`run ${run.id} (${kind}) status=${run.status}`);
  out.push(`message: ${run.message}`);
  out.push(`warnings: ${JSON.stringify(run.warnings)}`);
  out.push(
    `response_chars=${run.response_chars} duration=${run.duration_ms ? Math.round(run.duration_ms / 1000) + 's' : '-'}`,
  );
  (run.candidates ?? []).forEach((c) => {
    out.push(
      kind === 'glossary'
        ? `  ${c.term} [${c.category_label}] imp=${c.importance} occ=${c.occurrence_count} problems=${c.problems?.length ?? 0}`
        : `  "${c.title}" [${c.type_label}] imp=${c.importance} seg=${c.segment_index} anchored=${c.anchored} cov=${c.coverage}`,
    );
  });
})()
  .catch((error) => out.push('FAILED: ' + error.message))
  .finally(() =>
    fs.writeFileSync(path.join(__dirname, `tmp-degraded-${kind}.txt`), out.join('\n'), 'utf8'),
  );
