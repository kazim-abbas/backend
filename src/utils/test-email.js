/**
 * Diagnostic script: send a test email to verify Resend is correctly
 * configured end-to-end. Run locally or via `railway run` to debug
 * delivery issues without going through the full signup / reset flow.
 *
 *   # Local:
 *   TEST_EMAIL_TO=you@example.com node src/utils/test-email.js
 *
 *   # Railway (uses prod env):
 *   railway run npm run test-email -- you@example.com
 *
 * Prints a clear pass/fail summary plus the exact reason for each failure
 * mode (missing API key, placeholder sender, Resend rejection). No secrets
 * are echoed — only presence / length / domain of keys.
 */
const env = require('../config/env');
const emailService = require('../services/email.service');

function redactKey(key) {
  if (!key) return '(unset)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}…${key.slice(-2)} (length ${key.length})`;
}

async function run() {
  const to = process.argv[2] || process.env.TEST_EMAIL_TO;

  console.log('\n=== Resend email diagnostic ===\n');
  console.log('NODE_ENV:           ', env.nodeEnv);
  console.log('RESEND_API_KEY:     ', redactKey(env.resend.apiKey));
  console.log('RESEND_FROM_EMAIL:  ', env.resend.fromEmail || '(unset)');
  console.log('Recipient (to):     ', to || '(unset — pass as arg or TEST_EMAIL_TO)');
  console.log('');

  const problems = [];
  if (!env.resend.apiKey) {
    problems.push('RESEND_API_KEY is not set — configure it in your environment.');
  }
  if (!env.resend.fromEmail) {
    problems.push('RESEND_FROM_EMAIL is not set.');
  } else if (env.resend.fromEmail === 'notifications@example.com') {
    problems.push(
      'RESEND_FROM_EMAIL is the placeholder default (notifications@example.com). Resend will reject it — set it to an address on a domain you have verified in the Resend dashboard.'
    );
  }
  if (!to) {
    problems.push(
      'No recipient provided. Pass as the first CLI arg or set TEST_EMAIL_TO env var.'
    );
  }

  if (problems.length) {
    console.log('✗ Cannot send — configuration problems:');
    for (const p of problems) console.log('  -', p);
    console.log('');
    process.exit(1);
  }

  console.log('→ Sending test email…\n');

  const result = await emailService.send({
    to,
    subject: 'Resend diagnostic test',
    text: 'If you received this, your Resend configuration works.',
    html: '<p>If you received this, your Resend configuration works.</p>',
  });

  if (result.sent) {
    console.log('✓ Sent successfully.');
    console.log('  Resend id:', result.id);
    console.log('  Check the inbox of:', to, '\n');
    process.exit(0);
  }

  console.log('✗ Send did not succeed.');
  console.log('  Result:', JSON.stringify(result, null, 2));
  console.log('');
  console.log('Common causes:');
  console.log('  1. RESEND_FROM_EMAIL domain not verified in Resend dashboard');
  console.log('  2. API key from wrong Resend account or revoked');
  console.log('  3. Recipient address on Resend suppression list (prior bounce/complaint)');
  console.log('');
  process.exit(1);
}

run().catch((err) => {
  console.error('\n✗ Uncaught error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
