// A privacy policy page, served publicly at /privacy.
//
// It exists for a concrete reason: Meta won't publish a WhatsApp app without
// a privacy policy URL, and an unpublished app receives no production
// webhooks — so without this page, messages from the founder's own phone are
// accepted by WhatsApp and never delivered to this server.
//
// Written to describe what this app genuinely does rather than to fill the
// field. Everything below is checkable against the code: the third parties
// are the ones in integrations.js, the storage description is store.js, and
// the WhatsApp allowlist is channels/whatsapp.js.

// Kept out of the HTML unless the operator opts in. Publishing a personal
// address on a public page should be a decision, not a side effect of
// wanting WhatsApp to work.
function contactBlock() {
  const email = (process.env.PRIVACY_CONTACT_EMAIL || '').trim();
  return email
    ? `<p>Questions about this policy, or a request to delete stored data, can be sent to
         <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>.</p>`
    : `<p>This application is operated privately by its owner, who is also its only
         user. Requests about stored data should be made directly to them.</p>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function privacyPolicyHtml() {
  const updated = 'September 2026';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 42rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1c2230; background: #fbfbfd;
  }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.05rem; margin: 2.25rem 0 .5rem; letter-spacing: -0.005em; }
  .updated { color: #6b7488; font-size: .85rem; margin: 0 0 2rem; }
  ul { padding-left: 1.25rem; }
  li { margin: .35rem 0; }
  a { color: #2358d4; }
  footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid #e3e6ee; color: #6b7488; font-size: .85rem; }
</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: ${updated}</p>

  <p>This application is a private assistant operated by one individual for
  their own use. It is not a commercial product, it has no public sign-up,
  and it does not accept messages from the general public.</p>

  <h2>Who can use it</h2>
  <p>Access over WhatsApp is restricted to an explicit allowlist of phone
  numbers held in the application's configuration. A message from any number
  not on that list is discarded without being read or processed. There is no
  way for an unlisted person to interact with this application.</p>

  <h2>What is collected</h2>
  <ul>
    <li>The content of messages sent to the application, and the replies to them.</li>
    <li>The sender's WhatsApp phone number, used to identify the conversation
        and to check it against the allowlist.</li>
    <li>Records the operator enters themselves, such as business notes and
        financial entries.</li>
  </ul>
  <p>No location data, contacts, advertising identifiers, or device
  information are collected. There is no analytics or tracking of any kind.</p>

  <h2>How it is stored</h2>
  <p>Data is held as files on the server that runs this application. It is not
  sold, rented, or shared with anyone for advertising or marketing, and it is
  not used to train any model. It is retained until the operator deletes it;
  there is no fixed retention period.</p>

  <h2>Third parties</h2>
  <p>Message content is sent to the services that generate the replies, and to
  those the operator has switched on:</p>
  <ul>
    <li><strong>Anthropic</strong> — processes message content to produce replies.</li>
    <li><strong>Meta / WhatsApp</strong> — delivers messages in both directions.</li>
    <li><strong>OpenRouter</strong> — optional; routes some requests to other models.</li>
    <li><strong>Honcho</strong> — optional; stores a representation of the operator's preferences.</li>
    <li><strong>GitHub</strong> — optional; stores written reports in a repository the operator owns.</li>
    <li><strong>An email provider</strong> — optional; delivers reports to the operator.</li>
  </ul>
  <p>Each of these handles data under its own privacy policy.</p>

  <h2>Deleting your data</h2>
  <p>Because the only people who can use this application are the operator and
  numbers they have explicitly allowlisted, deletion is handled directly: the
  operator can remove the stored files at any time, which erases conversation
  history permanently.</p>

  <h2>Changes</h2>
  <p>If this policy changes, the revised version replaces this page and the
  date above is updated.</p>

  <h2>Contact</h2>
  ${contactBlock()}

  <footer>Served by the application itself, so this page reflects the version currently running.</footer>
</body>
</html>`;
}
