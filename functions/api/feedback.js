// Cloudflare Pages Function: POST /api/feedback
// Emails feedback from the Debug tab (subject, message, optional debug log as
// an attachment) to the developer through Resend (https://resend.com).
//
// Set in Cloudflare Pages → Settings → Variables and secrets:
//   RESEND_API_KEY  (secret)  Resend API key
//   FEEDBACK_TO               address the feedback goes to
//   FEEDBACK_FROM   (optional) sender; defaults to Resend's test sender, which
//                              can only deliver to the Resend account's own email
// The address and the key stay on the server; the page never sees them.

const MAX_SUBJECT = 150;
const MAX_MESSAGE = 10000;
const MAX_LOG = 4 * 1024 * 1024; // characters; a full recording is well below this

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  // only the site's own page may post (the page's CSP allows same-origin requests)
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Not allowed.' }, 403);
  if (!env.RESEND_API_KEY || !env.FEEDBACK_TO) return json({ error: 'Feedback is not set up on this site yet.' }, 503);

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Bad request.' }, 400);
  }
  if (data.website) return json({ ok: true }); // honeypot: bots fill in the hidden field

  const subject = String(data.subject ?? '').trim().slice(0, MAX_SUBJECT);
  const message = String(data.message ?? '').trim().slice(0, MAX_MESSAGE);
  if (!subject || !message) return json({ error: 'Please fill in a subject and a message.' }, 400);
  const log = typeof data.log === 'string' && data.log ? data.log.slice(-MAX_LOG) : '';

  const email = {
    from: env.FEEDBACK_FROM || 'Akko Cloud <onboarding@resend.dev>',
    to: [env.FEEDBACK_TO],
    subject: `[Akko Cloud] ${subject}`,
    text: `${message}\n\n--\nSent from ${new URL(request.url).origin}\nBrowser: ${request.headers.get('User-Agent') ?? '?'}\nDebug log: ${log ? 'attached' : 'not attached'}`,
    ...(log ? { attachments: [{ filename: `akko-cloud-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, content: base64(log) }] } : {}),
  };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(email),
  });
  if (!r.ok) return json({ error: 'Sending failed. Please try again later.' }, 502);
  return json({ ok: true });
}
