import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/feedback.js';

const env = { RESEND_API_KEY: 'key', FEEDBACK_TO: 'dev@example.com' };
const post = (body, headers = {}) => new Request('https://akko-cloud.pages.dev/api/feedback', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

function mockResend(status = 200) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return new Response('{}', { status }); };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test('feedback: subject, message and log are emailed through Resend', async () => {
  const m = mockResend();
  try {
    const r = await onRequestPost({ request: post({ subject: 'Drops', message: 'It dropped', log: 'line 1\nline 2 ✓' }), env });
    assert.equal(r.status, 200);
    assert.equal(m.sent.length, 1);
    const { url, init, body } = m.sent[0];
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers.Authorization, 'Bearer key');
    assert.deepEqual(body.to, ['dev@example.com']);
    assert.equal(body.subject, '[Akko Cloud] Drops');
    assert.match(body.text, /^It dropped/);
    assert.equal(Buffer.from(body.attachments[0].content, 'base64').toString('utf8'), 'line 1\nline 2 ✓');
  } finally { m.restore(); }
});

test('feedback: no attachment without a log; missing fields and other sites are refused', async () => {
  const m = mockResend();
  try {
    await onRequestPost({ request: post({ subject: 'Idea', message: 'More colours' }), env });
    assert.equal(m.sent[0].body.attachments, undefined);
    assert.equal((await onRequestPost({ request: post({ subject: '', message: 'x' }), env })).status, 400);
    assert.equal((await onRequestPost({ request: post({ subject: 'a', message: 'b' }, { Origin: 'https://evil.example' }), env })).status, 403);
    assert.equal((await onRequestPost({ request: post({ subject: 'a', message: 'b' }), env: {} })).status, 503);
    assert.equal((await onRequestPost({ request: post({ subject: 'a', message: 'b', website: 'spam' }), env })).status, 200);
    assert.equal(m.sent.length, 1, 'honeypot and refusals send nothing');
  } finally { m.restore(); }
});

test('feedback: a Resend failure is reported', async () => {
  const m = mockResend(500);
  try {
    assert.equal((await onRequestPost({ request: post({ subject: 'a', message: 'b' }), env })).status, 502);
  } finally { m.restore(); }
});
