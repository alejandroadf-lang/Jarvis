// The Amadeus Self-Service client. Pinned: one token, cached until it is
// about to expire; the sandbox by default; and a flight offer summarised to
// what a person would read out rather than the whole response.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let amadeus;
let originalFetch;
const saved = {};
const KEYS = ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'AMADEUS_ENV'];

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  amadeus = await import('../travelVoice/amadeus.js');
});

after(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  amadeus.__resetTokenForTests();
  global.fetch = originalFetch;
});

const OFFER = {
  id: '1',
  numberOfBookableSeats: 4,
  lastTicketingDate: '2026-09-30',
  validatingAirlineCodes: ['IB'],
  price: { currency: 'EUR', total: '180.00', grandTotal: '189.40' },
  itineraries: [
    {
      duration: 'PT2H5M',
      segments: [
        { departure: { iataCode: 'MAD', at: '2026-10-01T07:00:00' }, arrival: { iataCode: 'CDG', at: '2026-10-01T09:05:00' }, carrierCode: 'IB', number: '3402', aircraft: { code: '320' }, duration: 'PT2H5M' },
      ],
    },
  ],
  travelerPricings: [{ fareDetailsBySegment: [{ fareBasis: 'ONNAZ', cabin: 'ECONOMY' }] }],
  dictionaries: {},
};

test('unconfigured is refused plainly, and the sandbox is the default host', async () => {
  assert.equal(amadeus.isAmadeusConfigured(), false);
  assert.equal(amadeus.amadeusEnvironment(), 'test');
  assert.match(amadeus.amadeusHost(), /^https:\/\/test\.api\.amadeus\.com$/);
  await assert.rejects(() => amadeus.lookupLocations('Paris'), /not configured/);

  process.env.AMADEUS_ENV = 'production';
  assert.equal(amadeus.amadeusHost(), 'https://api.amadeus.com');
});

test('one token is fetched with client credentials and reused across calls', async () => {
  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'secret';
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/oauth2/token')) {
      assert.equal(init.method, 'POST');
      assert.match(String(init.body), /grant_type=client_credentials/);
      assert.match(String(init.body), /client_id=id/);
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 1799 }) };
    }
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return { ok: true, json: async () => ({ data: [{ iataCode: 'CDG', name: 'CHARLES DE GAULLE', subType: 'AIRPORT', address: { cityName: 'PARIS', countryCode: 'FR' } }] }) };
  };

  const first = await amadeus.lookupLocations('Paris');
  await amadeus.lookupLocations('Paris');

  assert.equal(calls.filter((c) => c.url.includes('/oauth2/token')).length, 1, 'the token is cached');
  assert.deepEqual(first, [{ iataCode: 'CDG', name: 'CHARLES DE GAULLE', subType: 'AIRPORT', city: 'PARIS', country: 'FR' }]);
  assert.match(calls[1].url, /keyword=Paris/);
  assert.match(calls[1].url, /subType=AIRPORT%2CCITY/);
});

test('a flight offer is summarised to what gets read out over the phone', async () => {
  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'secret';
  let query;
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 1799 }) };
    query = new URL(String(url)).searchParams;
    return { ok: true, json: async () => ({ data: [OFFER], dictionaries: { carriers: { IB: 'IBERIA' } } }) };
  };

  const offers = await amadeus.searchFlightOffers({ origin: 'mad', destination: 'cdg', departureDate: '2026-10-01', adults: 2, nonStop: true, currency: 'eur', max: 50 });

  assert.equal(query.get('originLocationCode'), 'MAD');
  assert.equal(query.get('adults'), '2');
  assert.equal(query.get('nonStop'), 'true');
  assert.equal(query.get('currencyCode'), 'EUR');
  assert.equal(query.get('max'), '10', 'capped: the raw response is kilobytes per itinerary');
  assert.equal(query.has('returnDate'), false);

  assert.equal(offers.length, 1);
  const offer = offers[0];
  assert.deepEqual(offer.price, { total: '189.40', currency: 'EUR' });
  assert.equal(offer.validatingAirline, 'IBERIA');
  assert.equal(offer.seatsLeft, 4);
  assert.equal(offer.itineraries[0].stops, 0);
  assert.equal(offer.itineraries[0].segments[0].flight, 'IB3402');
  assert.equal(offer.itineraries[0].segments[0].airline, 'IBERIA');
  assert.deepEqual(offer.fareBasis, ['ONNAZ']);
  assert.deepEqual(offer.cabin, ['ECONOMY']);
});

test('an Amadeus error names the endpoint and the reason', async () => {
  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'secret';
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 1799 }) };
    return { ok: false, status: 400, json: async () => ({ errors: [{ title: 'INVALID DATE', detail: 'Date/Time is in the past' }] }) };
  };
  await assert.rejects(
    () => amadeus.searchFlightOffers({ origin: 'MAD', destination: 'CDG', departureDate: '2020-01-01' }),
    /flight-offers failed — INVALID DATE: Date\/Time is in the past/
  );
});

test('rejected credentials say so', async () => {
  process.env.AMADEUS_CLIENT_ID = 'id';
  process.env.AMADEUS_CLIENT_SECRET = 'wrong';
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid_client' });
  await assert.rejects(() => amadeus.lookupLocations('x'), /refused the credentials \(401\)/);
});
