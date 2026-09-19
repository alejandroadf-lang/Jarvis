// A client for the Amadeus Self-Service APIs, so the advisor can quote real
// fares rather than describe how one would look them up.
//
// The advisor knows Amadeus the way a trainer does — the cryptic entries, the
// PNR lifecycle, what a fare basis means — and that is most of the value on
// day one, because it is what agencies ring a helpdesk about. But an advisor
// who can only explain how to search is a manual with a voice. With these
// credentials it searches: live flight offers and airport lookups from
// developers.amadeus.com, on the test environment by default so a wrong
// query costs nothing.
//
// Raw fetch, like every other provider client in this app. OAuth2 client
// credentials, one token cached until shortly before it expires.

import { readSecret, hasSecret } from '../env.js';

const HOSTS = {
  test: 'https://test.api.amadeus.com',
  production: 'https://api.amadeus.com',
};

export function isAmadeusConfigured() {
  return hasSecret('AMADEUS_CLIENT_ID') && hasSecret('AMADEUS_CLIENT_SECRET');
}

export function amadeusEnvironment() {
  const env = (process.env.AMADEUS_ENV || '').trim().toLowerCase();
  return env === 'production' ? 'production' : 'test';
}

export function amadeusHost() {
  return HOSTS[amadeusEnvironment()];
}

let cachedToken = null; // { value, expiresAt }

export function __resetTokenForTests() {
  cachedToken = null;
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: readSecret('AMADEUS_CLIENT_ID'),
    client_secret: readSecret('AMADEUS_CLIENT_SECRET'),
  });
  const res = await fetch(`${amadeusHost()}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Amadeus refused the credentials (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data?.access_token) throw new Error('Amadeus returned no access token');
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 1799) * 1000,
  };
  return cachedToken.value;
}

async function get(path, params) {
  if (!isAmadeusConfigured()) throw new Error('Amadeus is not configured — set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET');
  const token = await accessToken();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const res = await fetch(`${amadeusHost()}${path}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const first = data?.errors?.[0];
    const detail = first ? `${first.title || ''}${first.detail ? `: ${first.detail}` : ''}` : `HTTP ${res.status}`;
    const err = new Error(`Amadeus ${path} failed — ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Airports and cities matching a keyword — "par" finds Paris and its
 * airports. The advisor calls this before searching when a caller names a
 * city rather than a code.
 */
export async function lookupLocations(keyword, { max = 5 } = {}) {
  const data = await get('/v1/reference-data/locations', {
    subType: 'AIRPORT,CITY',
    keyword: String(keyword || '').trim(),
    'page[limit]': max,
  });
  return (data.data || []).map((loc) => ({
    iataCode: loc.iataCode,
    name: loc.name,
    subType: loc.subType,
    city: loc.address?.cityName || null,
    country: loc.address?.countryCode || null,
  }));
}

/**
 * Live flight offers. Returns the handful of fields a person would read out
 * over the phone, not the full offer — the raw response runs to kilobytes
 * per itinerary and none of it is what a caller asked.
 */
export async function searchFlightOffers({
  origin,
  destination,
  departureDate,
  returnDate,
  adults = 1,
  travelClass,
  nonStop,
  currency,
  max = 5,
}) {
  const data = await get('/v2/shopping/flight-offers', {
    originLocationCode: String(origin || '').toUpperCase(),
    destinationLocationCode: String(destination || '').toUpperCase(),
    departureDate,
    returnDate,
    adults: Math.max(1, Number(adults) || 1),
    travelClass: travelClass ? String(travelClass).toUpperCase() : undefined,
    nonStop: nonStop === true ? 'true' : undefined,
    currencyCode: currency ? String(currency).toUpperCase() : undefined,
    max: Math.min(10, Math.max(1, Number(max) || 5)),
  });

  const carriers = data.dictionaries?.carriers || {};
  return (data.data || []).map(summarizeOffer(carriers));
}

function summarizeOffer(carriers) {
  return (offer) => ({
    id: offer.id,
    price: { total: offer.price?.grandTotal || offer.price?.total, currency: offer.price?.currency },
    seatsLeft: offer.numberOfBookableSeats ?? null,
    validatingAirline: (offer.validatingAirlineCodes || []).map((code) => carriers[code] || code).join(', ') || null,
    lastTicketingDate: offer.lastTicketingDate || null,
    itineraries: (offer.itineraries || []).map((it) => ({
      duration: it.duration,
      stops: Math.max(0, (it.segments || []).length - 1),
      segments: (it.segments || []).map((seg) => ({
        from: seg.departure?.iataCode,
        departs: seg.departure?.at,
        to: seg.arrival?.iataCode,
        arrives: seg.arrival?.at,
        flight: `${seg.carrierCode}${seg.number}`,
        airline: carriers[seg.carrierCode] || seg.carrierCode,
        aircraft: seg.aircraft?.code || null,
        duration: seg.duration,
      })),
    })),
    fareBasis: [
      ...new Set(
        (offer.travelerPricings || [])
          .flatMap((tp) => tp.fareDetailsBySegment || [])
          .map((fd) => fd.fareBasis)
          .filter(Boolean)
      ),
    ],
    cabin: [
      ...new Set(
        (offer.travelerPricings || [])
          .flatMap((tp) => tp.fareDetailsBySegment || [])
          .map((fd) => fd.cabin)
          .filter(Boolean)
      ),
    ],
  });
}
