// Cancelling a monthly plan, from the link in its confirmation email.
//
// California's automatic renewal law wants cancelling online to be at least
// as easy as signing up, and signing up was one button on Stripe's page. So
// this is one button too, with no login: the signed link (payments.js) is the
// proof of whose plan it is.
//
// The GET only shows the button. Mail scanners and link previews follow every
// URL in an email, and one that cancelled on GET would cancel customers who
// never clicked anything; the POST is what does it.

import { verifyCancelToken, cancelSubscription, contactEmail } from './payments.js';

function page(title, body, form = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}
button{font:inherit;padding:.75rem 1.25rem;min-height:44px;border-radius:.5rem;border:1px solid #111;background:#111;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}</style></head>
<body><main><h1>${title}</h1><p>${body}</p>${form}</main></body></html>`;
}

function byHand(prefix) {
  const contact = contactEmail();
  return `${prefix}${contact ? ` Write to ${contact} and your plan will be cancelled by hand.` : ''}`;
}

export function showCancel(req, res) {
  const t = String(req.query?.t || '');
  if (!verifyCancelToken(t)) {
    return res.status(400).type('html').send(page('This link does not work', byHand('It may have been copied incompletely.')));
  }
  return res.type('html').send(page(
    'Cancel your subscription',
    'This stops the next charge. You keep what you have paid for until the end of the current month.',
    `<form method="post" action="/billing/cancel?t=${encodeURIComponent(t)}"><button type="submit">Cancel my subscription</button></form>`
  ));
}

export async function confirmCancel(req, res) {
  const subscriptionId = verifyCancelToken(String(req.query?.t || ''));
  if (!subscriptionId) {
    return res.status(400).type('html').send(page('This link does not work', byHand('Nothing was changed.')));
  }
  try {
    const { endsAt } = await cancelSubscription(subscriptionId);
    const until = endsAt ? ` It ends on ${new Date(endsAt).toUTCString().slice(0, 16)}.` : '';
    console.log(`Subscription ${subscriptionId} cancelled by the customer.`);
    return res.type('html').send(page('Cancelled', `You will not be charged again.${until}`));
  } catch (err) {
    console.error(`Could not cancel ${subscriptionId}: ${err.message}`);
    const contact = contactEmail();
    return res.status(502).type('html').send(page(
      'Not cancelled yet',
      `The payment provider did not answer, so nothing changed. Try the button again in a minute${contact ? `, or write to ${contact}` : ''}.`
    ));
  }
}
