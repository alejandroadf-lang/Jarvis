// Circadian, the consumer app. Plain script, no build step: this page is
// served by the API's own host and must work on any phone browser.
//
// People think in cities, not IANA zones, so city fields resolve against the
// browser's own zone list. Plans come back with every event already on the
// clock of wherever the traveller is; this page groups and shows them, saves
// trips on the phone, and switches on reminders and WHOOP. There are no
// accounts: a random device id, made here and kept here, is the only link
// between this phone and its reminders or WHOOP connection.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const K = { trips: "circadian.trips.v2", current: "circadian.current.v2", device: "circadian.device" };

  const LABELS = {
    sleep: "Sleep", light_seek: "Bright light", light_avoid: "Avoid light", melatonin: "Melatonin",
    caffeine_ok: "Coffee OK", nap: "Nap", flight: "Flight", stopover: "Stopover",
    focus: "Clearest thinking", fog: "Foggy stretch",
  };
  const CHRONO = { early: ["22:00", "06:00"], intermediate: ["23:00", "07:00"], late: ["00:30", "08:30"] };

  // --- storage: conveniences only; the app works without it -----------------------------

  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v === null ? fallback : v; } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }
  function device() {
    let id = load(K.device, null);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      }));
      save(K.device, id);
    }
    return id;
  }

  // --- time zones -----------------------------------------------------------------------

  const FALLBACK = ["Europe/London", "Europe/Paris", "Europe/Madrid", "Europe/Berlin", "America/New_York",
    "America/Los_Angeles", "America/Chicago", "America/Sao_Paulo", "Asia/Bangkok", "Asia/Tokyo",
    "Asia/Singapore", "Asia/Dubai", "Asia/Hong_Kong", "Asia/Kolkata", "Australia/Sydney", "Pacific/Auckland"];
  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : FALLBACK)
    .filter((z) => z.includes("/") && !z.startsWith("Etc/"));
  const cityOf = (z) => z.split("/").pop().replace(/_/g, " ");
  const labelOf = (z) => `${cityOf(z)} (${z.split("/")[0]})`;
  const byLabel = new Map(), byCity = new Map();
  for (const z of zones) {
    byLabel.set(labelOf(z).toLowerCase(), z);
    if (!byCity.has(cityOf(z).toLowerCase())) byCity.set(cityOf(z).toLowerCase(), z);
    const o = document.createElement("option"); o.value = labelOf(z); $("zones").appendChild(o);
  }
  function resolveZone(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return "";
    return byLabel.get(t) || byCity.get(t) || zones.find((z) => z.toLowerCase() === t)
      || zones.find((z) => cityOf(z).toLowerCase().startsWith(t)) || "";
  }

  // --- the form -------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, "0");
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // A trip is journeys separated by stays. The panel is laid out the way
  // flight search sites are: Return, One way or Multi-city on top, From and
  // To with a swap, the times, and a Stops choice that is Direct until the
  // traveller says otherwise. The plan needs each connection (a stopover has
  // its own clock and light advice), but nobody is asked about stops they
  // don't have. Return keeps the second journey's cities mirrored from the
  // first; an open jaw is Multi-city with a different city in the second row.
  const MAX_STOPS = 2;
  function journeyNodes() { return [...$("journeys").querySelectorAll(".journey")]; }
  function stopNodes(journey) { return [...journey.querySelectorAll(".stop")]; }
  const firstFrom = () => journeyNodes()[0]?.querySelector(".from")?.value || "";
  const mode = () => document.querySelector('input[name="trip_type"]:checked')?.value || "oneway";
  const val = (node, cls) => node.querySelector("." + cls).value;

  // The form thinks in flights with stops; the plan thinks in legs between
  // cities. Both directions, so a saved trip opens as it was entered.
  function legsOf(journey) {
    const stops = stopNodes(journey).map((n) => ({ city: val(n, "stop-city"), arrival: val(n, "stop-arrival"), departure: val(n, "stop-departure") }));
    const points = [{ city: val(journey, "from"), departure: val(journey, "departure") }, ...stops, { city: val(journey, "to"), arrival: val(journey, "arrival") }];
    return points.slice(1).map((to, i) => ({ from: points[i].city, to: to.city, departure: points[i].departure, arrival: to.arrival }));
  }
  function flightOf(legs = []) {
    const first = legs[0] || {}, last = legs.at(-1) || {};
    return {
      from: first.from || "", to: last.to || "", departure: first.departure || "", arrival: last.arrival || "",
      stops: legs.slice(1).map((l, i) => ({ city: l.from || legs[i].to || "", arrival: legs[i].arrival || "", departure: l.departure || "" })),
    };
  }

  // What kind of trip a saved one is, so the switch shows it the same way.
  function tripType(trip) {
    const js = trip.journeys || [];
    if (js.length <= 1) return "oneway";
    const out = js[0].legs, back = js[1].legs;
    const mirrored = js.length === 2 && back.length === 1
      && back[0].from === out.at(-1).to && back[0].to === out[0].from;
    return mirrored ? "return" : "multi";
  }

  function mirrorReturn() {
    if (mode() !== "return") return;
    const [out, back] = journeyNodes();
    if (!out || !back) return;
    back.querySelector(".from").value = val(out, "to");
    back.querySelector(".to").value = val(out, "from");
  }

  function renumber() {
    const m = mode();
    const journeys = journeyNodes();
    journeys.forEach((j, ji) => {
      j.querySelector(".journey-head").hidden = m === "oneway";
      j.querySelector(".journey-title").textContent = m === "return" ? (ji === 0 ? "Outbound" : "Return") : `Flight ${ji + 1}`;
      j.querySelector(".remove-journey").hidden = m !== "multi" || ji === 0;
      const mirrored = m === "return" && ji === 1;
      j.classList.toggle("mirrored", mirrored);
      for (const f of ["from", "to"]) j.querySelector("." + f).readOnly = mirrored;
      stopNodes(j).forEach((n, i) => { n.querySelector(".stop-head").textContent = `Stop ${i + 1}`; });
      const count = stopNodes(j).length;
      j.querySelectorAll(".stops-choice button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.stops) === count)));
    });
    $("add-journey").hidden = m !== "multi";
    mirrorReturn();
  }

  function addStop(journey, values = {}) {
    const node = $("stop-template").content.firstElementChild.cloneNode(true);
    if (values.city) node.querySelector(".stop-city").value = values.city;
    if (values.arrival) node.querySelector(".stop-arrival").value = values.arrival;
    if (values.departure) node.querySelector(".stop-departure").value = values.departure;
    journey.querySelector(".stops").appendChild(node);
    return node;
  }

  function setStops(journey, n) {
    while (stopNodes(journey).length > n) stopNodes(journey).at(-1).remove();
    while (stopNodes(journey).length < n) addStop(journey);
    renumber();
  }

  // Moving the departure moves the landing and any stop times by the same
  // amount, so the flight keeps its length. Without it, changing the date you
  // leave left the landing on the old date: a 13-hour Bangkok-London flight
  // became three days and was refused.
  const asMinutes = (v) => (v ? Date.parse(v + "Z") / 60000 : NaN);
  const fromMinutes = (m) => new Date(m * 60000).toISOString().slice(0, 16);
  //
  // Every value the field passes through counts, on "input" as well as
  // "change": the iPhone's date wheel reports each step, but scrolling back to
  // the starting date fires no "change" (the value is what it was on focus),
  // so the landing kept the forward step and ended days after its departure.
  const MAX_SHIFT_MINUTES = 366 * 24 * 60;
  function keepFlightLength(journey) {
    const dep = journey.querySelector(".departure");
    let before = dep.value;
    const follow = () => {
      const at = asMinutes(dep.value);
      if (!Number.isFinite(at)) return; // half-typed: wait for a whole date
      const shift = at - asMinutes(before);
      if (Math.abs(shift) > MAX_SHIFT_MINUTES) return; // mid-way through typing a year
      before = dep.value;
      if (!shift) return; // also the first date put into an empty field
      for (const input of journey.querySelectorAll(".arrival, .stop-arrival, .stop-departure")) {
        if (input.value) input.value = fromMinutes(asMinutes(input.value) + shift);
      }
    };
    dep.addEventListener("input", follow);
    dep.addEventListener("change", follow);
  }

  function addJourney(values = {}) {
    const node = $("journey-template").content.firstElementChild.cloneNode(true);
    const flight = flightOf(values.legs);
    for (const k of ["from", "to", "departure", "arrival"]) if (flight[k]) node.querySelector("." + k).value = flight[k];
    for (const stop of flight.stops.slice(0, MAX_STOPS)) addStop(node, stop);
    node.querySelector(".remove-journey").addEventListener("click", () => { node.remove(); renumber(); });
    node.querySelector(".swap").addEventListener("click", () => {
      const from = node.querySelector(".from"), to = node.querySelector(".to");
      [from.value, to.value] = [to.value, from.value];
      mirrorReturn();
    });
    for (const f of ["from", "to"]) node.querySelector("." + f).addEventListener("input", mirrorReturn);
    keepFlightLength(node);
    node.querySelectorAll(".stops-choice button").forEach((b) => b.addEventListener("click", () => {
      setStops(node, Number(b.dataset.stops));
      if (Number(b.dataset.stops)) stopNodes(node).at(-1).querySelector(".stop-city").focus();
    }));
    $("journeys").appendChild(node);
    renumber();
    return node;
  }

  // Switching the trip type keeps what was typed: One way drops the later
  // flights, Return needs exactly two with the second mirrored, Multi-city
  // shows every flight with its own cities.
  function setMode(next) {
    document.querySelector(`input[name="trip_type"][value="${next}"]`).checked = true;
    const journeys = journeyNodes();
    if (next === "oneway") journeys.slice(1).forEach((j) => j.remove());
    if (next === "return") {
      journeys.slice(2).forEach((j) => j.remove());
      if (journeyNodes().length < 2) addJourney();
    }
    if (next === "multi" && journeyNodes().length < 2) {
      const last = journeyNodes().at(-1);
      addJourney({ legs: [{ from: val(last, "to"), to: firstFrom() }] });
    }
    renumber();
  }

  $("trip-type").addEventListener("change", () => setMode(mode()));

  // The next flight starts where the last one landed and, by default, goes
  // home, so another city or an open jaw is one edit.
  $("add-journey").addEventListener("click", () => {
    const from = val(journeyNodes().at(-1), "to");
    const node = addJourney({ legs: [{ from, to: firstFrom() === from ? "" : firstFrom() }] });
    node.querySelector(".departure").focus();
    node.scrollIntoView({ behavior: scrollMode, block: "center" });
  });

  $("chronotype").addEventListener("change", () => {
    const [bed, wake] = CHRONO[$("chronotype").value];
    $("sleep_start").value = bed; $("sleep_end").value = wake;
  });

  function exampleTrip() {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
    const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(19, 0, 0, 0);
    const a = new Date(d); a.setDate(a.getDate() + 1); a.setHours(15, 0, 0, 0);
    const from = zones.includes(here) ? here : "Europe/London";
    const to = from.startsWith("Asia/") ? "Europe/London" : "Asia/Tokyo";
    const back = new Date(d); back.setDate(back.getDate() + 14); back.setHours(12, 0, 0, 0);
    const home = new Date(back); home.setDate(home.getDate() + 1); home.setHours(6, 0, 0, 0);
    return {
      journeys: [
        { legs: [{ from: labelOf(from), to: labelOf(to), departure: localInput(d), arrival: localInput(a) }] },
        { legs: [{ from: labelOf(to), to: labelOf(from), departure: localInput(back), arrival: localInput(home) }] },
      ],
      sleep_start: "23:00", sleep_end: "07:00", chronotype: "intermediate", preflight_days: "2",
      light_device: "none", melatonin: true, caffeine: true, example: true,
    };
  }

  // Trips saved before journeys existed had one list of legs and a return
  // pair. They become a journey, and a second one for the return.
  function upgrade(trip) {
    if (!trip || trip.journeys) return trip;
    const legs = trip.legs || [];
    const journeys = [{ legs }];
    if (trip.return_departure && trip.return_arrival && legs.length) {
      journeys.push({ legs: [{ from: legs.at(-1).to, to: legs[0].from, departure: trip.return_departure, arrival: trip.return_arrival }] });
    }
    const { legs: _legs, return_departure: _rd, return_arrival: _ra, ...rest } = trip;
    return { ...rest, journeys };
  }

  function fill(trip) {
    $("journeys").replaceChildren();
    for (const j of trip.journeys || []) addJourney(j);
    if (!journeyNodes().length) addJourney();
    setMode(tripType(trip));
    for (const k of ["sleep_start", "sleep_end", "chronotype", "preflight_days", "light_device"]) {
      if (trip[k] !== undefined) $(k).value = trip[k];
    }
    $("melatonin").checked = trip.melatonin !== false;
    $("caffeine").checked = trip.caffeine !== false;
    $("example-note").hidden = !trip.example;
  }

  function read() {
    return {
      journeys: journeyNodes().map((j) => ({ legs: legsOf(j) })),
      sleep_start: $("sleep_start").value, sleep_end: $("sleep_end").value, chronotype: $("chronotype").value,
      preflight_days: $("preflight_days").value, light_device: $("light_device").value,
      melatonin: $("melatonin").checked, caffeine: $("caffeine").checked,
    };
  }

  function toLegs(legs, journeyNo) {
    const on = journeyNo ? ` on flight ${journeyNo}` : "";
    const pick = " Start typing a city and pick it from the list.";
    return legs.map((l, i) => {
      const dz = resolveZone(l.from), az = resolveZone(l.to);
      const last = i === legs.length - 1;
      if (!dz) throw new Error(i === 0 ? `We could not find "${l.from}"${on}.${pick}` : `We could not find the city of stop ${i}${on}.${pick}`);
      if (!az) throw new Error(last ? `We could not find "${l.to}"${on}.${pick}` : `We could not find the city of stop ${i + 1}${on}.${pick}`);
      if (!l.departure) throw new Error(i === 0 ? `Add the departure time${on} from your ticket.` : `Add when you leave stop ${i}${on}.`);
      if (!l.arrival) throw new Error(last ? `Add the landing time${on} from your ticket.` : `Add when you arrive at stop ${i + 1}${on}.`);
      return { departure: l.departure, departure_tz: dz, arrival: l.arrival, arrival_tz: az };
    });
  }

  function common(trip) {
    return {
      sleep_start: trip.sleep_start || null, sleep_end: trip.sleep_end || null, chronotype: trip.chronotype || "intermediate",
      preflight_days: Number(trip.preflight_days || 0), melatonin: !!trip.melatonin, caffeine: !!trip.caffeine,
      light_device: trip.light_device || "none",
    };
  }

  // The whole trip as one request: the server chains the journeys so each
  // starts from where the body clock will be, and clips them at the next flight.
  function toRequest(trip) {
    const many = trip.journeys.length > 1;
    return { ...common(trip), journeys: trip.journeys.map((j, i) => ({ legs: toLegs(j.legs, many ? i + 1 : 0) })) };
  }

  // --- API ------------------------------------------------------------------------------

  // Every URL here is relative to the page, so the app works both at the root of
  // its own host and under a path such as /circadian/ on a shared one.
  const APP_URL = new URL(".", location.href).href;

  // The anonymous device id rides along so usage can be counted per phone
  // (see analytics.py); it is the same id reminders and WHOOP already use.
  async function api(path, body, extraHeaders = {}) {
    const headers = { "x-circadian-device": device(), ...extraHeaders };
    const res = await fetch(path, body === undefined ? { headers } : {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.detail?.[0]?.msg || (res.status === 429
        ? "Too many requests in a minute. Wait a moment and try again." : `Something went wrong (${res.status}).`);
      const err = new Error(msg); err.status = res.status; err.code = data?.error?.code; throw err;
    }
    return data;
  }

  // --- rendering ------------------------------------------------------------------------

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const hm = (local) => (local ? local.slice(11, 16) : "");
  // People who asked for less motion get instant scrolling; the CSS option
  // does not reach a scroll asked for from here.
  const scrollMode = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

  // The two pieces Today is built from, so every tile and every row of
  // answers is the same size, reads the same to a screen reader, and changes
  // in one place. Not a component system: two functions.
  //
  // A tile: label, the number, and under it the word that says what the
  // number is (typical for you, short of need) and its range. `band` colours
  // the top rule; `state` is that word. Colour is never the only carrier of
  // the meaning (WCAG 1.4.1), which is why a band without a state is only used
  // where the label already says it.
  function tile(label, value, sub, { band = "", state = "" } = {}) {
    const d = el("div", `tile${band ? " " + band : ""}`);
    d.append(el("small", "", label), el("b", "", value));
    if (state) d.appendChild(el("span", "state", state));
    if (sub) d.appendChild(el("span", "", sub));
    return d;
  }

  // A row of answers where one can be chosen: Done / Skipped / Couldn't under
  // a moment, the five faces, the rating after the trip. Real buttons, at
  // least 44px tall (index.html), the chosen one marked with aria-pressed so
  // the state is read out and not only drawn. A face is a symbol with its
  // word under it; the word is the accessible name.
  function choices(options, current, onPick, cls = "") {
    const row = el("div", cls);
    for (const o of options) {
      const b = el("button"); b.type = "button";
      if (o.face) { b.append(el("span", "", o.face), el("small", "", o.label)); b.setAttribute("aria-label", o.label); }
      else b.textContent = o.label;
      b.setAttribute("aria-pressed", String(o.value === current));
      b.addEventListener("click", () => onPick(o.value));
      row.appendChild(b);
    }
    return row;
  }

  // With `now`, today and tomorrow are named as such, judged on that city's clock.
  function dayTitle(local, zone, now) {
    const [y, m, d] = local.slice(0, 10).split("-").map(Number);
    let text = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    if (now) {
      const dateThere = (t) => new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(t); // YYYY-MM-DD
      if (local.slice(0, 10) === dateThere(now)) text = `Today, ${text}`;
      else if (local.slice(0, 10) === dateThere(new Date(now.getTime() + 864e5))) text = `Tomorrow, ${text}`;
    }
    return `${text} · ${cityOf(zone)} time`;
  }

  function eventRow(e, now) {
    const live = new Date(e.start) <= now && e.end && new Date(e.end) > now;
    const row = el("div", `event t-${e.type}${live ? " now" : ""}`);
    const time = el("time", "", hm(e.start_local));
    if (e.end_local) time.appendChild(el("small", "", `to ${hm(e.end_local)}`));
    row.appendChild(time);
    const body = el("div");
    body.appendChild(el("b", "", (live ? "Now: " : "") + (LABELS[e.type] || e.type)));
    if (e.note) body.appendChild(el("span", "", e.note));
    row.appendChild(body);
    return row;
  }

  function calendarLink(req) {
    const json = JSON.stringify(req);
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `app/plan.ics?t=${b64}`;
  }

  const signed = (h) => `${h > 0 ? "+" : ""}${h}`;

  function renderPlan(container, title, plan, adjustMinutes = 0) {
    const now = new Date();
    const head = el("div", "card summary");
    head.appendChild(el("h2", "", title));
    head.appendChild(el("p", "", plan.summary));
    if (adjustMinutes) {
      head.appendChild(el("p", "adjusted", `Times from now on are ${Math.abs(adjustMinutes)} min ${adjustMinutes > 0 ? "later" : "earlier"} than first planned, to match last night's sleep from WHOOP.`));
    }
    const stats = el("div", "stats");
    const diff = plan.time_difference_hours, local = plan.local_time_difference_hours;
    // After a stay the body is not on the local clock, so the hours to shift
    // differ from the map. Both are shown, or the first reads as a mistake.
    stats.appendChild(el("span", "stat", local !== undefined && local !== diff
      ? `${signed(diff)} h for your body clock (${signed(local)} h between the cities)`
      : `${signed(diff)} h time difference`));
    if (plan.mode === "adapt") stats.appendChild(el("span", "stat", `${plan.days_to_adapt_after_arrival} day${plan.days_to_adapt_after_arrival === 1 ? "" : "s"} to adapt there`));
    head.appendChild(stats);
    container.appendChild(head);

    // The few things that matter most for this flight, before the day list.
    if (plan.briefing?.length) {
      const brief = el("div", "card brief");
      brief.appendChild(el("h2", "", "Your plan in brief"));
      const list = el("div", "brief-list");
      for (const b of plan.briefing) {
        const item = el("div", "brief-item");
        item.append(el("b", "", b.title), el("p", "", b.text));
        list.appendChild(item);
      }
      brief.appendChild(list);
      container.appendChild(brief);
    }

    const groups = new Map();
    for (const e of plan.events) {
      const key = `${e.start_local.slice(0, 10)}|${e.local_tz}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const [key, events] of groups) {
      const day = el("section", "day");
      day.appendChild(el("h3", "", dayTitle(events[0].start_local, key.split("|")[1])));
      const box = el("div", "events");
      for (const e of events) box.appendChild(eventRow(e, now));
      day.appendChild(box);
      container.appendChild(day);
    }
  }

  function renderActions(container, req, plans) {
    const actions = el("div", "actions");
    const cal = el("a", "button", "Add to calendar"); cal.href = calendarLink(req);
    actions.appendChild(cal);
    const share = el("button", "secondary", "Share"); share.type = "button";
    share.addEventListener("click", async () => {
      const text = `My jet lag plan: ${plans[0].plan.summary}`;
      try {
        if (navigator.share) await navigator.share({ title: "Circadian", text, url: APP_URL });
        else { await navigator.clipboard.writeText(`${text} ${APP_URL}`); share.textContent = "Copied"; }
      } catch { /* cancelled */ }
    });
    actions.appendChild(share);
    container.appendChild(actions);
  }

  // --- reminders ------------------------------------------------------------------------

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  function b64ToBytes(s) {
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function renderReminders(container, tripReq) {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Reminders"));
    const text = el("p", "", $("whoop-button").classList.contains("connected")
      ? "A tap on the shoulder when it is time for light, bed, or the last coffee, and a check-in each morning once WHOOP has scored your night: how it went against the plan, and today's times."
      : "A tap on the shoulder when it is time for light, bed, or the last coffee.");
    card.appendChild(text);
    const button = el("button", "secondary", "Turn on reminders"); button.type = "button";
    card.appendChild(button);
    container.appendChild(card);

    // iPhone allows Web Push only to an app opened from the Home Screen (iOS
    // 16.4+), and not at all in the EU since iOS 17.4, where PushManager is
    // simply absent: the message below is what those travellers see too.
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      if (isIOS && !standalone) text.textContent = "On iPhone: tap Share, then Add to Home Screen, and open Circadian from there to turn on reminders. Meanwhile, Add to calendar gives you alarms.";
      else text.textContent = "This browser cannot show reminders. Use Add to calendar for alarms instead.";
      button.hidden = true;
      return;
    }
    const setOn = (n) => { button.textContent = "Turn off reminders"; text.innerHTML = ""; text.append(el("span", "ok", `On: ${n} reminder${n === 1 ? "" : "s"} scheduled for this trip.`)); button.dataset.on = "1"; };
    try {
      const st = await api(`app/push/status?device=${device()}`);
      if (st.subscribed) setOn(st.pending);
    } catch { /* offline */ }

    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        if (button.dataset.on) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
          await api("app/push/unsubscribe", { device: device() });
          button.textContent = "Turn on reminders"; delete button.dataset.on;
          text.textContent = "Reminders are off.";
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== "granted") { text.textContent = "Notifications are blocked for this site. Allow them in your browser settings to get reminders."; return; }
        const { public_key } = await api("app/push/key");
        const sub = (await reg.pushManager.getSubscription())
          || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(public_key) });
        const res = await api("app/push/subscribe", { device: device(), subscription: sub.toJSON(), trip: tripReq });
        setOn(res.reminders);
      } catch (err) {
        text.textContent = err.message || "Could not turn on reminders.";
      } finally {
        button.disabled = false;
      }
    });
  }

  // --- WHOOP ------------------------------------------------------------------------------

  // The WHOOP button in the header: always visible, so connecting doesn't
  // depend on finding a card below a plan. Its label says what a tap does.
  let lastWhoopStatus = null;
  async function refreshWhoopButton() {
    const button = $("whoop-button"), label = $("whoop-label");
    let st;
    try { st = await api(`app/whoop/status?device=${device()}`); } catch { return null; }
    lastWhoopStatus = st;
    button.classList.toggle("connected", !!st.connected);
    button.classList.toggle("ready", !!st.configured && !st.connected);
    if (st.connected) { label.textContent = "WHOOP connected"; button.href = "#whoop-card"; }
    else if (st.configured) { label.textContent = "Connect WHOOP"; button.href = `whoop/connect?device=${device()}`; }
    else { label.textContent = "WHOOP"; button.href = "#whoop-card"; }
    return st;
  }

  async function renderWhoop(container, tripReq, example = false, { progress = null, rerender = null } = {}) {
    const card = el("div", "card");
    card.id = "whoop-card";
    card.appendChild(el("h2", "", "Progress from WHOOP"));
    const text = el("p", "", "Connect WHOOP to see each night you actually slept next to the plan.");
    card.appendChild(text);
    const body = el("div");
    card.appendChild(body);
    const button = el("a", "button secondary", "Connect WHOOP");
    button.href = `whoop/connect?device=${device()}`;
    card.appendChild(button);
    container.appendChild(card);

    let st;
    // The redraw after WHOOP moved the plan already knows the status.
    try { st = (progress && lastWhoopStatus) || await api(`app/whoop/status?device=${device()}`); } catch { return; }
    if (!st.configured) { text.textContent = "WHOOP is coming soon to Circadian."; button.hidden = true; return; }
    if (!st.connected) {
      if (example) text.textContent = "Connect WHOOP now; once you plan your own trip, each night you actually slept shows up here next to the plan.";
      return;
    }

    button.textContent = "Disconnect WHOOP";
    button.href = "#";
    button.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await api("app/whoop/disconnect", { device: device() }).catch(() => {});
      body.replaceChildren(); text.textContent = "WHOOP is disconnected. Nothing from it is kept here.";
      button.hidden = true;
      refreshWhoopButton();
    });
    if (example) { text.textContent = "WHOOP is connected. Plan your own trip and your real nights show up here next to the plan."; return; }
    text.textContent = "Checking your sleep…";
    try {
      const p = progress || await api("app/whoop/progress", { device: device(), trip: tripReq });
      // Today is drawn before WHOOP answers. Once it has, draw the whole page
      // again with what WHOOP said, once: the plan moved if last night was off
      // it, and the morning's tiles either way. (Redrawing only when the plan
      // moved left an adapted traveller's last mornings without their tiles.)
      if (!progress && rerender) { rerender(p); return; }
      text.textContent = p.summary;
      for (const n of p.nights) {
        const row = el("div", "night");
        const left = el("div", "", `Night of ${n.night_of}: plan ${n.planned_bed}–${n.planned_wake}`);
        const pill = el("span", `pill ${!n.tracked ? "none" : n.on_track ? "good" : "off"}`,
          !n.tracked ? "No data" : n.on_track ? "On track" : `${n.bed_minutes_late > 0 ? "+" : ""}${n.bed_minutes_late} min`);
        row.append(left, pill);
        if (n.tracked) {
          const bits = [`slept ${n.actual_bed}–${n.actual_wake}`];
          if (n.sleep_performance != null) bits.push(`sleep ${n.sleep_performance}%`);
          if (n.recovery != null) bits.push(`recovery ${n.recovery}%`);
          const felt = load(FEEL, {})[morningOf(n)];
          if (felt) bits.push(`felt ${felt}/5`);
          row.appendChild(el("small", "", bits.join(" · ")));
        }
        body.appendChild(row);
      }
      for (const a of p.advice) body.appendChild(el("p", "", a));
      if (p.adjustment?.note) body.appendChild(el("p", p.adjustment.minutes ? "adjusted" : "", p.adjustment.note));
      if (p.adaptation?.verdict) {
        const v = el("p", "verdict");
        v.appendChild(el("b", "", p.adaptation.adapted_after_nights ? "Adapted. " : "Adapting. "));
        v.appendChild(document.createTextNode(p.adaptation.verdict));
        body.appendChild(v);
      }
    } catch (err) {
      text.textContent = err.code === "whoop_not_connected" ? "WHOOP was disconnected. Connect it again to see progress." : err.message;
      if (err.code === "whoop_not_connected") { button.textContent = "Connect WHOOP"; button.href = `whoop/connect?device=${device()}`; }
    }
  }

  // --- trips ------------------------------------------------------------------------------

  // My trips lives in its own window, opened from the header, so the page
  // itself is the form and the plan. Rows are identified by route and first
  // departure day: re-planning the same trip with corrected times replaces it
  // rather than adding a second row that reads exactly like the first.
  const cityName = (label) => String(label || "").split(" (")[0];
  const shortDate = (local) => {
    if (!local) return "";
    const [y, m, d] = local.slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  };

  function tripInfo(trip) {
    const js = trip.journeys || [];
    const first = js[0]?.legs?.[0];
    if (!first) return { key: "", route: "Trip", when: "", kind: "" };
    const home = cityName(first.from);
    const stops = js.map((j) => cityName(j.legs.at(-1)?.to));
    const type = tripType(trip);
    const route = type === "return" ? `${home} ⇄ ${stops[0]}`
      : stops.length > 1 && stops.at(-1) === home ? `${[home, ...stops.slice(0, -1)].join(" → ")} → ${home}`
      : [home, ...stops].join(" → ");
    const when = js.length > 1
      ? `${shortDate(first.departure)} – ${shortDate(js.at(-1).legs[0]?.departure)}`
      : shortDate(first.departure);
    const connections = js.reduce((n, j) => n + Math.max(0, j.legs.length - 1), 0);
    const kind = { return: "Return", oneway: "One way", multi: "Multi-city" }[type]
      + (connections ? ` · ${connections} stop${connections === 1 ? "" : "s"}` : "");
    const key = `${[home, ...stops].join(">")}|${(first.departure || "").slice(0, 10)}`;
    return { key, route, when, kind };
  }

  function savedTrips() {
    // Newest first; drop older copies of the same trip (see tripInfo).
    const seen = new Set();
    const trips = load(K.trips, []).map(upgrade).filter((t) => {
      const { key } = tripInfo(t);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return trips;
  }

  function renderTrips() {
    const trips = savedTrips();
    save(K.trips, trips);
    const current = tripInfo(load(K.current, null) ? upgrade(load(K.current, null)) : {}).key;
    $("open-trips").hidden = trips.length === 0;
    $("trips-count").textContent = String(trips.length);
    const box = $("trips"); box.replaceChildren();
    for (const t of trips) {
      const info = tripInfo(t);
      const row = el("div", `trip${info.key === current ? " current" : ""}`);
      row.appendChild(el("div", "trip-route", info.route));
      const meta = el("div", "trip-meta");
      meta.append(el("span", "", info.when), el("span", "", info.kind));
      if (info.key === current) meta.appendChild(el("span", "", "Open now"));
      row.appendChild(meta);
      const actions = el("div", "trip-actions");
      const open = el("button", "", "Open plan"); open.type = "button";
      open.addEventListener("click", () => {
        $("trips-dialog").close();
        fill(t); makePlan(t); scrollTo({ top: 0 });
      });
      const del = el("button", "secondary", "Delete"); del.type = "button";
      del.setAttribute("aria-label", `Delete ${info.route}, ${info.when}`);
      del.addEventListener("click", () => {
        save(K.trips, savedTrips().filter((x) => tripInfo(x).key !== info.key));
        renderTrips();
        if (!savedTrips().length) $("trips-dialog").close();
      });
      actions.append(open, del);
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  $("open-trips").addEventListener("click", () => { renderTrips(); $("trips-dialog").showModal(); });
  $("close-trips").addEventListener("click", () => $("trips-dialog").close());
  // A tap on the dimmed area outside the sheet closes it, as on any phone sheet.
  $("trips-dialog").addEventListener("click", (e) => { if (e.target === $("trips-dialog")) $("trips-dialog").close(); });

  // Trips and plans live only in this browser's storage, and WebKit may clear
  // a site's script-writable storage after seven days without a visit. Asking
  // for persistence stops that where the browser agrees (Safari: installed
  // apps and sites used often; Chrome: after enough engagement). When it does
  // not, the iPhone card on Today says what to do; no other prompt, since a
  // refusal on a desktop browser costs nothing.
  function persistStorage() {
    try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not supported */ }
  }

  function remember(trip) {
    const key = tripInfo(trip).key;
    const all = savedTrips().filter((t) => tripInfo(t).key !== key);
    all.unshift(trip);
    save(K.trips, all.slice(0, 10));
    save(K.current, trip);
    persistStorage();
    renderTrips();
  }

  // --- submit -----------------------------------------------------------------------------

  const PLANS = "circadian.plans.v3";
  function showError(message) {
    const error = $("error");
    error.textContent = message; error.className = "error"; error.hidden = false;
    // The form is long; the message is put in view rather than left below the fold.
    error.scrollIntoView({ behavior: scrollMode, block: "center" });
  }

  async function makePlan(trip, { quiet = false } = {}) {
    $("error").hidden = true;
    let req;
    try { req = toRequest(trip); } catch (err) { if (!quiet) showError(err.message); return; }
    // Opening the app shows the plan it made last time at once, when it is for
    // this same trip; the fresh one replaces it only if it differs. On a plane
    // or a slow network the screen is never blank, and nothing is drawn twice.
    const cached = load(PLANS, null);
    const sameTrip = cached && JSON.stringify(cached.req) === JSON.stringify(req);
    if (quiet && sameTrip) show(cached.plans, trip, cached.req, cached.supplements);
    const button = $("go"); button.disabled = true; button.textContent = "Making your plan…";
    try {
      const { journeys, supplements } = await api("app/itinerary", req, quiet ? {} : { "x-circadian-intent": "submit" });
      const plans = journeys.map((plan, i) => ({
        title: (journeys.length > 1 ? `Flight ${i + 1}: ` : "") + `${cityOf(plan.home_tz)} to ${cityOf(plan.destination_tz)}`,
        plan,
      }));
      const fresh = { req, plans, supplements };
      if (quiet && sameTrip && JSON.stringify(fresh) === JSON.stringify(cached)) return;
      save(PLANS, fresh);
      show(plans, trip, req, supplements);
    } catch (err) {
      if (quiet && sameTrip) return; // the saved plan is on screen
      if (cached && !navigator.onLine) show(cached.plans, trip, cached.req, cached.supplements);
      else if (!quiet) showError(err.message);
    } finally {
      button.disabled = false; button.textContent = "Make my plan";
    }
  }

  // Graded by the evidence for this use; the grade is the first thing read.
  const GRADE = (evidence) => /^good/i.test(evidence) ? "good" : /^some/i.test(evidence) ? "some"
    : /^weak/i.test(evidence) ? "weak" : "none";

  function renderSupplements(container, supplements) {
    if (!supplements?.items?.length) return;
    const card = el("div", "card supplements");
    card.appendChild(el("h2", "", "Supplements for this trip"));
    card.appendChild(el("p", "", "What the evidence supports, with your dates. Only melatonin has good evidence for jet lag itself."));
    for (const s of supplements.items) {
      const item = el("div", "supp");
      const head = el("div", "supp-head");
      head.append(el("b", "", s.name), el("span", `pill grade-${GRADE(s.evidence)}`, s.evidence));
      item.appendChild(head);
      item.appendChild(el("p", "supp-when", s.when));
      item.appendChild(el("p", "", s.why));
      if (s.caution) item.appendChild(el("p", "supp-caution", s.caution));
      card.appendChild(item);
    }
    card.appendChild(el("p", "disclaimer", supplements.caution));
    container.appendChild(card);
  }

  // After the trip: how bad was it, and how much of the plan was followed.
  // The only real evidence a plan works; asked once per trip.
  const RATED = "circadian.rated.v1";

  function renderRating(container, plans, trip) {
    if (trip.example) return;
    const nights = plans.flatMap((p) => p.plan.events).filter((e) => e.type === "sleep" && e.where === "destination");
    const last = nights.map((e) => new Date(e.end)).sort((a, b) => b - a)[0];
    if (!last || new Date() < last) return;
    const key = tripInfo(trip).key;
    if (load(RATED, []).includes(key)) return;
    const card = el("div", "card");
    card.appendChild(el("h2", "", "How was your jet lag?"));
    const text = el("p", "", `Your ${tripInfo(trip).route} trip is over. Two taps help us check the plans work.`);
    card.appendChild(text);
    // What was logged day by day on this trip answers "how much did you follow".
    const pts = clockPoints(plans);
    const inTrip = (d) => pts.length && new Date(d + "T12:00:00Z").getTime() >= pts[0].t - DAY_MS && new Date(d + "T12:00:00Z").getTime() <= pts.at(-1).t + DAY_MS;
    const logged = Object.entries(load(LOG, {})).filter(([k]) => inTrip(k.split("|")[1]));
    // For "how much was followed", couldn't counts with skipped: either way the
    // moment did not happen. The per-tap log keeps them apart (app/log).
    const counts = { done: logged.filter(([, v]) => v === "done").length, skipped: logged.filter(([, v]) => v !== "done").length };
    const done = (rating, followed) => {
      const first = plans[0].plan;
      api("app/feedback", { device: device(), rating, followed, shift_hours: first.shift_hours || null, strategy: first.strategy || null,
        done: counts.done, skipped: counts.skipped }).catch(() => {});
      save(RATED, [...load(RATED, []), key].slice(-50));
      card.replaceChildren(el("h2", "", "Thanks"), el("p", "", "That's how we know whether the plans work."));
    };
    const scale = choices(["None", "Mild", "Moderate", "Bad", "Severe"].map((label, i) => ({ value: i + 1, label })), null, (rating) => {
      if (counts.done + counts.skipped >= 3) {
        const share = counts.done / (counts.done + counts.skipped);
        done(rating, share >= 0.7 ? "mostly" : share >= 0.3 ? "partly" : "hardly");
        return;
      }
      text.textContent = "And how much of the plan did you follow?";
      const followed = [["mostly", "Most of it"], ["partly", "Some of it"], ["hardly", "Hardly any"]].map(([value, label]) => ({ value, label }));
      scale.replaceWith(choices(followed, null, (value) => done(rating, value), "followed"));
    }, "rating");
    card.appendChild(scale);
    container.appendChild(card);
  }

  // The plan with everything still to come moved by `minutes`: what WHOOP
  // says last night did to the body clock (whoop.py, _adjustment). Past
  // events, flights and stopovers stay where they were.
  function shiftPlans(plans, minutes) {
    const now = Date.now();
    const move = (iso) => (iso ? new Date(new Date(iso).getTime() + minutes * 60000).toISOString() : iso);
    const moveLocal = (local) => (local ? fromMinutes(asMinutes(local) + minutes) : local);
    return plans.map((p) => ({ ...p, plan: { ...p.plan, events: p.plan.events.map((e) => {
      if (e.type === "flight" || e.type === "stopover" || new Date(e.start).getTime() <= now) return e;
      return { ...e, start: move(e.start), end: move(e.end), start_local: moveLocal(e.start_local), end_local: moveLocal(e.end_local) };
    }) } }));
  }

  // A collapsible section of the page below Today, opened by its button.
  function fold(id, title) {
    const d = el("details", "fold"); d.id = id;
    d.appendChild(el("summary", "", title));
    return d;
  }

  function show(plans, trip, req, supplements, progress = null) {
    const minutes = progress?.adjustment?.minutes || 0;
    const shown = minutes ? shiftPlans(plans, minutes) : plans;
    renderToday(shown, trip, progress);
    const out = $("result"); out.replaceChildren();
    const whoopOpts = { progress, rerender: (p) => show(plans, trip, req, supplements, p) };
    if (trip.example) {
      // A first visit: the plan itself is the point, with WHOOP as an offer.
      renderActions(out, req, shown);
      renderWhoop(out, req, true, whoopOpts);
      renderSupplements(out, supplements);
      for (const p of shown) renderPlan(out, p.title, p.plan, minutes);
      out.appendChild(el("p", "disclaimer", shown[0].plan.disclaimer));
      return;
    }
    renderRating(out, shown, trip);
    // Once there is a trip, Today says what matters; the rest waits behind three folds.
    const history = fold("history", "History: your body clock and every night");
    const graphBox = el("div", "graph"); history.appendChild(graphBox);
    renderClockGraph(graphBox, shown, progress);
    renderWhoop(history, req, false, whoopOpts);
    out.appendChild(history);
    const full = fold("fullplan", "Full plan");
    renderActions(full, req, shown);
    renderSupplements(full, supplements);
    for (const p of shown) renderPlan(full, p.title, p.plan, minutes);
    full.appendChild(el("p", "disclaimer", shown[0].plan.disclaimer));
    out.appendChild(full);
    const reminders = fold("reminders", "Reminders");
    renderReminders(reminders, req);
    out.appendChild(reminders);
  }

  // --- today -------------------------------------------------------------------------------
  //
  // The first screen once there is a trip. Its centre is the body-clock graph:
  // the plan's line for how far the body is from the local clock across the
  // whole trip, and a dot for every night WHOOP has measured. Under it, last
  // night in one row and today's few moments. The form waits behind Edit trip.

  let editing = false;
  const DAY_MS = 864e5;
  // The day-by-day log, on the phone: moments marked done or skipped, keyed by
  // type and local date (stable when the day's times move), and each morning's
  // "how sharp" 1-5, keyed by local date. Each tap is also counted server-side.
  const LOG = "circadian.log.v1", FEEL = "circadian.feel.v1", INSTALL = "circadian.install.v1";
  const ACTIONABLE = ["light_seek", "light_avoid", "caffeine_ok", "melatonin", "nap"];
  // Three answers, not two. "Skipped" is a choice; "Couldn't" is a day that
  // did not allow it (a meeting through the light window), and it gets the
  // next-best thing on the same line. Habit apps that fold the two together
  // lose the people who had no choice, and a plan that only says "missed"
  // gives nothing to do about it.
  const ANSWERS = [{ value: "done", label: "Done" }, { value: "skipped", label: "Skipped" }, { value: "couldnt", label: "Couldn't" }];
  const NEXT_BEST = {
    light_seek: "Next best: the brightest lamp you can find, close, for as long as you can; or the next window of daylight.",
    light_avoid: "Next best: sunglasses from now, dim rooms until bed.",
    caffeine_ok: "Next best: make that the last one, and keep the planned bedtime even if sleep comes later.",
    melatonin: "Next best: leave it tonight rather than take it late; late melatonin nudges the clock the wrong way.",
    nap: "Next best: an early night; no napping in the evening, which would take from it.",
  };
  // The morning's one question, as faces: a numbered 1-5 wears people out
  // faster than a picture scale does, and the value kept is still 1-5.
  const FACES = [["😩", "Foggy"], ["😕", "Rough"], ["😐", "OK"], ["🙂", "Good"], ["😃", "Sharp"]].map(([face, label], i) => ({ value: i + 1, face, label }));
  // The word under each WHOOP number, from whoop.py's _states.
  const STATE_WORDS = { typical: "typical for you", above: "above your usual", below: "below your usual", short: "short of need", met: "need met" };
  const momentKey = (e) => `${e.type}|${e.start_local.slice(0, 10)}`;
  const nextDay = (iso) => new Date(new Date(iso + "T12:00:00Z").getTime() + DAY_MS).toISOString().slice(0, 10);
  // The morning a night belongs to: night_of is the date the sleep started, so
  // a bed at 23:30 wakes the next day and a bed at 00:10 wakes the same day.
  const morningOf = (n) => (n.planned_bed < n.planned_wake ? n.night_of : nextDay(n.night_of));
  const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / DAY_MS);
  const cityOfZone = (tz) => cityOf(tz);

  function clockPoints(plans) {
    return plans.flatMap((p) => p.plan.clock || []).map((c) => ({ ...c, t: new Date(c.at).getTime() }));
  }

  // The plan's value at a moment, between the points either side of it.
  function planAt(points, t) {
    if (!points.length) return null;
    if (t <= points[0].t) return points[0].hours;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].t) {
        const a = points[i - 1], b = points[i];
        return b.t === a.t ? b.hours : a.hours + (b.hours - a.hours) * (t - a.t) / (b.t - a.t);
      }
    }
    return points.at(-1).hours;
  }

  const zoneAt = (points, t) => (points.filter((p) => p.t <= t).at(-1) || points[0])?.local_tz;

  function describeHours(h, tz) {
    const city = cityOfZone(tz);
    if (Math.abs(h) < 0.25) return `on ${city} time`;
    const n = Math.abs(h) < 10 ? Math.abs(h).toFixed(1).replace(/\.0$/, "") : Math.round(Math.abs(h));
    return `${n} h ${h > 0 ? "ahead of" : "behind"} ${city} time`;
  }

  // The plan whose span holds this moment: on a return, the leg you are on.
  function currentPlan(plans, t) {
    return plans.find((p) => { const c = p.plan.clock || []; return c.length && t >= new Date(c[0].at).getTime() && t <= new Date(c.at(-1).at).getTime(); })
      || plans.find((p) => (p.plan.clock || []).length && t < new Date(p.plan.clock[0].at).getTime()) || plans.at(-1);
  }

  const recoveryBand = (r) => (r == null ? "" : r >= 67 ? "green" : r < 34 ? "red" : "yellow");

  function renderToday(plans, trip, progress) {
    const card = $("today");
    const points = clockPoints(plans);
    if (trip.example || !points.length) {
      card.hidden = true; $("trip-card").hidden = false;
      return;
    }
    card.hidden = false;
    $("trip-card").hidden = !editing;
    card.replaceChildren();
    const now = new Date(), t = now.getTime();
    const t0 = points[0].t, t1 = points.at(-1).t;
    const total = Math.max(1, Math.ceil((t1 - t0) / DAY_MS));
    const dayNo = Math.floor((t - t0) / DAY_MS) + 1;
    const zone = zoneAt(points, t);
    const cur = currentPlan(plans, t).plan;
    const nights = (progress?.nights || []).filter((n) => n.tracked && n.clock_measured != null);
    const lastNight = nights.at(-1);
    const measuredRecent = lastNight && t - new Date(lastNight.clock_at).getTime() < 30 * 36e5;
    // Progress from WHOOP is proof of a connection; the header button's status
    // call may still be in flight on the first draw.
    const connected = !!progress || !!lastWhoopStatus?.connected || $("whoop-button").classList.contains("connected");

    const head = el("div", "today-head");
    head.appendChild(el("h2", "", tripInfo(trip).route));
    head.appendChild(el("span", "day", t < t0 ? `Starts in ${Math.ceil((t0 - t) / DAY_MS)} day${Math.ceil((t0 - t) / DAY_MS) === 1 ? "" : "s"}`
      : t > t1 ? "Trip over" : `Day ${dayNo} of ${total} · ${cityOfZone(zone)}`));
    card.appendChild(head);

    // 1. Where the body clock is: one line and a bar from home to there.
    const hoursNow = measuredRecent ? lastNight.clock_measured : planAt(points, t);
    const home = cur.home_tz, dest = cur.destination_tz;
    // Hours off the destination's clock, whichever clock the line is on right now.
    const offDest = zone === dest ? hoursNow : hoursNow - (cur.local_time_difference_hours ?? cur.time_difference_hours);
    const span = Math.max(Math.abs(cur.shift_hours || cur.time_difference_hours || 0), 0.01);
    const progressPct = Math.max(0, Math.min(100, Math.round((1 - Math.abs(offDest) / span) * 100)));
    const hero = el("div", "hero");
    const adapted = progress?.adaptation?.adapted_after_nights;
    hero.appendChild(el("p", "hero-line", t < t0 ? `Your body is on ${cityOfZone(home)} time.`
      : adapted ? `You are back on ${cityOfZone(dest)} time.` : `Your body is ${describeHours(hoursNow, zone)}.`));
    if (span > 0.5 && home !== dest) {
      const bar = el("div", "clockbar");
      bar.appendChild(el("span", "", cityOfZone(home)));
      const track = el("div", "track");
      const fill = el("div", "fill"); fill.style.width = `${progressPct}%`; track.appendChild(fill);
      bar.append(track, el("span", "", cityOfZone(dest)));
      hero.appendChild(bar);
    }
    // What the line is based on, always: a night WHOOP measured, or the plan's
    // expectation. A body clock is an estimate, and one shown without its
    // source reads as a fact.
    const sub = [];
    if (measuredRecent) sub.push(`from last night on WHOOP; the plan expected ${describeHours(lastNight.clock_planned, lastNight.local_tz)}`);
    else if (t >= t0 && t <= t1) sub.push(connected ? "by the plan, until WHOOP scores last night" : "by the plan");
    if (t < t0) sub.push(`the plan starts moving it on ${shortDate(points[0].at)}`);
    else if (!adapted && cur.adapted_by && cur.mode === "adapt") sub.push(`on ${cityOfZone(dest)} time by ${shortDate(cur.adapted_by)}`);
    if (sub.length) hero.appendChild(el("p", "hero-sub", sub.join(" · ")));
    card.appendChild(hero);

    // 2. What WHOOP says this morning. Two numbers the eye lands on, recovery
    //    in WHOOP's own bands and sleep against need, each with the word for
    //    where it sits in the traveller's own range; the rest one tap down.
    //    Four equal tiles read as four verdicts on the day, and a number with
    //    no range reads as a mark out of a hundred. The body clock above stays
    //    the one thing this screen is about.
    if (measuredRecent) {
      const w = lastNight.whoop || {}, b = progress.baseline || {}, st = lastNight.states || {};
      const usual = (key, unit = "") => (b[key] != null ? `usual ${b[key]}${unit}` : "");
      const first = el("div", "tiles");
      if (lastNight.recovery != null) first.appendChild(tile("Recovery", `${lastNight.recovery}%`, usual("recovery", "%"), { band: recoveryBand(lastNight.recovery), state: STATE_WORDS[st.recovery] || "" }));
      if (w.asleep_hours != null) {
        first.appendChild(tile("Sleep", `${w.asleep_hours} h`, w.need_total_hours != null ? `of ${w.need_total_hours} h needed` : `${lastNight.actual_bed}–${lastNight.actual_wake}`,
          { band: st.sleep === "short" ? "yellow" : st.sleep === "met" ? "green" : "", state: STATE_WORDS[st.sleep] || "" }));
      }
      if (first.childElementCount) card.appendChild(first);
      const rest = [];
      if (w.hrv != null) rest.push(tile("HRV", `${w.hrv} ms`, usual("hrv"), { band: st.hrv === "below" ? "yellow" : st.hrv ? "green" : "", state: STATE_WORDS[st.hrv] || "" }));
      if (w.rhr != null) rest.push(tile("Resting HR", `${w.rhr}`, usual("rhr"), { band: st.rhr === "above" ? "yellow" : st.rhr ? "green" : "", state: STATE_WORDS[st.rhr] || "" }));
      if (w.skin_temp != null) rest.push(tile("Skin temp", `${w.skin_temp}°C`, usual("skin_temp", "°C")));
      if (w.spo2 != null) rest.push(tile("SpO₂", `${w.spo2}%`, ""));
      if (rest.length) {
        const more = el("details", "more-whoop");
        more.appendChild(el("summary", "", "HRV, resting heart rate and more"));
        const grid = el("div", "tiles"); grid.append(...rest); more.appendChild(grid);
        card.appendChild(more);
      }
      const late = Math.round((lastNight.bed_minutes_late + lastNight.wake_minutes_late) / 2);
      const bits = [`Slept ${lastNight.actual_bed}–${lastNight.actual_wake}` + (Math.abs(late) < 15 ? ", on the plan" : `, ${Math.abs(late)} min ${late > 0 ? "later" : "earlier"} than planned`)];
      if (w.rem_hours != null) bits.push(`REM ${w.rem_hours} h · deep ${w.deep_hours} h`);
      card.appendChild(el("p", "night-line", bits.join(" · ")));
      if (progress.insight) card.appendChild(el("p", "insight", progress.insight));
      if (progress.adjustment?.minutes) card.appendChild(el("p", "adjusted", `Today's times are moved ${Math.abs(progress.adjustment.minutes)} min ${progress.adjustment.minutes > 0 ? "later" : "earlier"} to match your clock.`));
    } else if (connected && t >= t0 && t <= t1) {
      card.appendChild(el("p", "night-line", "WHOOP has not scored last night yet. This fills in when it has."));
    } else if (!connected) {
      const p = el("p", "night-line");
      const a = el("a", "", "Connect WHOOP"); a.href = `whoop/connect?device=${device()}`;
      p.append(a, document.createTextNode(" and each morning shows recovery, HRV, sleep against need, and what they mean for today."));
      card.appendChild(p);
    }

    // Before the trip: how rested you are going in, from the last week on WHOOP.
    if (t < t0 && connected) {
      const pre = el("div", "pretrip");
      pre.appendChild(el("h3", "", "Before you fly"));
      const body = el("p", "", "Reading your last week on WHOOP…");
      pre.appendChild(body);
      card.appendChild(pre);
      getBaseline(Math.ceil((t0 - t) / DAY_MS)).then((b) => {
        if (!b || b.nights === undefined) return;
        const tiles = el("div", "tiles compact");
        if (b.recovery_week != null) tiles.appendChild(tile("Recovery", `${b.recovery_week}%`, b.recovery != null ? `usual ${b.recovery}%` : "this week"));
        if (b.asleep_hours != null) tiles.appendChild(tile("Sleep", `${b.asleep_hours} h`, "a night, this week"));
        if (b.debt_hours != null) tiles.appendChild(tile("Sleep debt", `${b.debt_hours} h`, "per WHOOP"));
        body.replaceChildren();
        if (tiles.childElementCount) pre.insertBefore(tiles, body);
        for (const a of b.advice || []) body.appendChild(el("span", "advice", a));
      }).catch(() => { body.textContent = "WHOOP did not answer just now."; });
    }

    // 3. Today's moments, on the clock where the traveller is, with Done / Skip.
    const todayKey = new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(now);
    const all = plans.flatMap((p) => p.plan.events).sort((x, y) => new Date(x.start) - new Date(y.start));
    const moments = all.filter((e) => !["flight", "stopover", "fog", "sleep"].includes(e.type) && e.local_tz === zone && e.start_local.slice(0, 10) === todayKey);
    const tonight = progress?.tonight;
    if (moments.length || tonight) {
      card.appendChild(el("h3", "", `Today · ${cityOfZone(zone)} time`));
      const list = el("div", "moments");
      const log = load(LOG, {});
      for (const e of moments) {
        const live = new Date(e.start) <= now && e.end && new Date(e.end) > now;
        const past = new Date(e.end || e.start) <= now;
        const state = log[momentKey(e)];
        const row = el("div", `moment t-${e.type}${live ? " now" : past && !state ? " past" : ""}${state ? " " + state : ""}`);
        const time = el("time", "", hm(e.start_local));
        if (e.end_local) time.appendChild(document.createTextNode(`–${hm(e.end_local)}`));
        row.append(time, el("span", "", (live ? "Now: " : "") + (LABELS[e.type] || e.type)));
        if (ACTIONABLE.includes(e.type) && (past || live)) {
          row.appendChild(choices(ANSWERS, state, (value) => {
            const all2 = load(LOG, {}); all2[momentKey(e)] = value; save(LOG, all2);
            api("app/log", { device: device(), kind: "moment", type: e.type, value, day_number: dayNo }).catch(() => {});
            renderToday(plans, trip, progress);
          }, "mark"));
          if (state === "couldnt" && NEXT_BEST[e.type]) row.appendChild(el("p", "fallback", NEXT_BEST[e.type]));
        }
        list.appendChild(row);
      }
      if (tonight?.note) {
        const row = el("div", "moment t-sleep tonight");
        row.append(el("time", "", tonight.bed_by || tonight.bed), el("span", "", "Tonight: " + tonight.note));
        list.appendChild(row);
      } else {
        const bed = all.find((e) => e.type === "sleep" && ["home", "destination"].includes(e.where) && new Date(e.start) > now && new Date(e.start) - now < 30 * 36e5);
        if (bed) { const row = el("div", "moment t-sleep"); row.append(el("time", "", `${hm(bed.start_local)}–${hm(bed.end_local)}`), el("span", "", "Sleep")); list.appendChild(row); }
      }
      card.appendChild(list);
    } else if (t >= t0 && t <= t1) {
      card.appendChild(el("p", "", "Nothing more on the plan today."));
    }

    // 4. How sharp do you feel: one tap a morning.
    if (t >= t0 && t <= t1 + 3 * DAY_MS) {
      const feels = load(FEEL, {});
      const feel = el("div", "feel");
      if (feels[todayKey]) {
        const f = FACES[feels[todayKey] - 1] || FACES[2];
        feel.appendChild(el("p", "", `This morning: ${f.face} ${f.label.toLowerCase()}`
          + (lastNight?.recovery != null && measuredRecent ? ` · WHOOP recovery ${lastNight.recovery}%` : "") + "."));
      } else {
        feel.appendChild(el("p", "", "How do you feel this morning?"));
        feel.appendChild(choices(FACES, null, (value) => {
          const all2 = load(FEEL, {}); all2[todayKey] = value; save(FEEL, all2);
          api("app/log", { device: device(), kind: "feel", value: String(value), day: todayKey,
            recovery: measuredRecent ? lastNight?.recovery ?? null : null, day_number: dayNo }).catch(() => {});
          renderToday(plans, trip, progress);
        }, "faces"));
      }
      card.appendChild(feel);
    }

    // iPhone, in Safari rather than from the Home Screen: the two things that
    // only work installed are reminders (WebKit allows Web Push only there) and
    // keeping the trip past a week away from the site (WebKit's storage policy).
    // Said once, after a real trip exists, and before anything asks for a
    // notification permission it could not use.
    if (isIOS && !standalone && !load(INSTALL, false)) {
      const box = el("div", "install");
      box.appendChild(el("h3", "", "Keep this trip on your phone"));
      box.appendChild(el("p", "", "Added to the Home Screen, Circadian keeps your trip past a week away and can send reminders."));
      const steps = el("ol");
      for (const step of ["Tap Share at the bottom of Safari.", "Tap Add to Home Screen, then Add.", "Open Circadian from there."]) steps.appendChild(el("li", "", step));
      box.appendChild(steps);
      const later = el("button", "link", "Not now"); later.type = "button";
      later.addEventListener("click", () => { save(INSTALL, true); box.remove(); });
      box.appendChild(later);
      card.appendChild(box);
    }

    const actions = el("div", "today-actions");
    const edit = el("button", "secondary", editing ? "Hide trip form" : "Edit trip"); edit.type = "button";
    edit.addEventListener("click", () => {
      editing = !editing;
      $("trip-card").hidden = !editing;
      edit.textContent = editing ? "Hide trip form" : "Edit trip";
      if (editing) $("trip-card").scrollIntoView({ behavior: scrollMode, block: "start" });
    });
    const open = (id, label) => {
      const b = el("button", "secondary", label); b.type = "button";
      b.addEventListener("click", () => { const d = $(id); if (d) { d.open = true; d.scrollIntoView({ behavior: scrollMode, block: "start" }); } });
      return b;
    };
    actions.append(edit, open("history", "History"), open("fullplan", "Full plan"));
    card.appendChild(actions);
  }

  // The body-clock graph with its legend and caption, in the History fold.
  function renderClockGraph(container, plans, progress) {
    const points = clockPoints(plans);
    if (!points.length) return;
    const now = new Date(), t = now.getTime();
    const nights = (progress?.nights || []).filter((n) => n.tracked && n.clock_measured != null);
    const caption = el("p", "chart-caption");
    const lastNight = nights.at(-1);
    caption.textContent = lastNight
      ? `Latest night, ${shortDate(lastNight.night_of)}: your body was ${describeHours(lastNight.clock_measured, lastNight.local_tz)}; the plan expected ${describeHours(lastNight.clock_planned, lastNight.local_tz)}. Tap a dot for another night.`
      : `By the plan, your body is now ${describeHours(planAt(points, t), zoneAt(points, t))}. Nights from WHOOP land here as dots.`;
    container.appendChild(clockChart(points, nights, now, caption));
    const legend = el("p", "legend");
    const a = el("span"); a.append(el("i"), document.createTextNode("Plan"));
    const b = el("span"); b.append(el("b"), document.createTextNode("WHOOP nights"));
    legend.append(a, b);
    container.append(legend, caption);
  }

  // The graph, as plain SVG. x is the trip's span, y is hours off the local
  // clock (0 = adapted). Marks: the plan as a 2px line, WHOOP nights as 10px
  // dots with a surface ring, hairline grid, a "now" line. Tapping a dot puts
  // that night into the caption; there is no hover on a phone.
  function clockChart(points, nights, now, caption) {
    const NS = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs = {}, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const W = Math.max(300, Math.min(540, ($("today").clientWidth || 360) - 32)), H = 200;
    const m = { l: 36, r: 14, t: 22, b: 26 };
    const t = now.getTime();
    const dotTs = nights.map((n) => new Date(n.clock_at).getTime());
    const x0 = Math.min(points[0].t, ...dotTs), x1 = Math.max(points.at(-1).t, ...dotTs, t < points.at(-1).t + 3 * DAY_MS ? t : 0);
    const hours = [...points.map((p) => p.hours), ...nights.map((n) => n.clock_measured), 0];
    let yMin = Math.floor(Math.min(...hours)) - 0.5, yMax = Math.ceil(Math.max(...hours)) + 0.5;
    if (yMax - yMin < 3) { yMin -= 1; yMax += 1; }
    const X = (tt) => m.l + (tt - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
    const Y = (h) => m.t + (yMax - h) / (yMax - yMin) * (H - m.t - m.b);
    const svg = svgEl("svg", { class: "clock-chart", viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Your body clock against the local clock over the trip: the plan as a line, nights measured by WHOOP as dots." });

    // Grid: whole hours, one label each; the zero line a shade stronger.
    const step = yMax - yMin > 12 ? 3 : yMax - yMin > 6 ? 2 : 1;
    for (let h = Math.ceil(yMin); h <= Math.floor(yMax); h += step) {
      svg.appendChild(svgEl("line", { class: h === 0 ? "zero" : "grid", x1: m.l, x2: W - m.r, y1: Y(h), y2: Y(h) }));
      svg.appendChild(svgEl("text", { x: m.l - 6, y: Y(h) + 4, "text-anchor": "end" }, h === 0 ? "0" : `${h > 0 ? "+" : "−"}${Math.abs(h)} h`));
    }
    // Where the traveller is: a label per stretch, a hairline at each change.
    let segStart = x0, segZone = points[0].local_tz;
    const segments = [];
    for (const p of points) {
      if (p.local_tz !== segZone) { segments.push([segStart, p.t, segZone]); segStart = p.t; segZone = p.local_tz; }
    }
    segments.push([segStart, x1, segZone]);
    for (const [sa, sb, z] of segments) {
      if (sa !== x0) svg.appendChild(svgEl("line", { class: "grid", x1: X(sa), x2: X(sa), y1: m.t - 4, y2: H - m.b }));
      if (X(sb) - X(sa) > 40) svg.appendChild(svgEl("text", { x: (X(sa) + X(sb)) / 2, y: m.t - 8, "text-anchor": "middle" }, cityOfZone(z)));
    }
    // Dates along the bottom: about five, on day boundaries.
    const days = Math.max(1, Math.round((x1 - x0) / DAY_MS));
    const every = Math.max(1, Math.ceil(days / 4));
    let lastLabelX = -Infinity;
    for (let d = 0; d <= days; d += every) {
      const tt = x0 + d * DAY_MS;
      if (tt > x1 || X(tt) - lastLabelX < 56) continue;   // no two dates on top of each other
      lastLabelX = X(tt);
      svg.appendChild(svgEl("text", { x: X(tt), y: H - 8, "text-anchor": d === 0 ? "start" : "middle" }, shortDate(new Date(tt).toISOString()).replace(/^\w+, /, "")));
    }
    // Now.
    if (t >= x0 && t <= x1) {
      svg.appendChild(svgEl("line", { class: "now", x1: X(t), x2: X(t), y1: m.t, y2: H - m.b }));
      svg.appendChild(svgEl("text", { x: X(t) + 4, y: H - m.b - 4 }, "now"));
    }
    // The plan.
    svg.appendChild(svgEl("polyline", { class: "plan", points: points.map((p) => `${X(p.t)},${Y(p.hours)}`).join(" ") }));
    // WHOOP nights, with a bigger invisible hit target under each dot.
    const dots = [];
    nights.forEach((n, i) => {
      const cx = X(dotTs[i]), cy = Y(n.clock_measured);
      const hit = svgEl("circle", { class: "hit", cx, cy, r: 16 });
      const dot = svgEl("circle", { class: "dot", cx, cy, r: 5 });
      dot.appendChild(svgEl("title", {}, `Night of ${n.night_of}: ${describeHours(n.clock_measured, n.local_tz)}`));
      const pick = () => {
        dots.forEach((d) => d.classList.remove("picked")); dot.classList.add("picked");
        caption.textContent = `Night of ${shortDate(n.night_of)}: your body was ${describeHours(n.clock_measured, n.local_tz)}; the plan expected ${describeHours(n.clock_planned, n.local_tz)}.`
          + (n.recovery != null ? ` Recovery ${n.recovery}%.` : "");
      };
      hit.addEventListener("click", pick); dot.addEventListener("click", pick);
      svg.append(hit, dot); dots.push(dot);
    });
    return svg;
  }

  // One way, direct, landing days after take-off: that is someone flying out on
  // one day and back on another, which is how a business trip is booked and how
  // people think of it. Read it that way instead of refusing it: out on the
  // first date, back on the second, with both flights' times estimated from
  // the distance until the ticket's times replace them.
  const TRIP_NOT_FLIGHT_HOURS = 8; // later than the estimated landing by more than this
  async function asReturnTrip(trip) {
    if (mode() !== "oneway" || trip.journeys.length !== 1 || trip.journeys[0].legs.length !== 1) return null;
    const [l] = trip.journeys[0].legs;
    const dz = resolveZone(l.from), az = resolveZone(l.to);
    if (!dz || !az || !l.departure || !l.arrival) return null;
    const estimate = (departure, departure_tz, arrival_tz) =>
      api(`app/estimate?${new URLSearchParams({ departure, departure_tz, arrival_tz })}`);
    try {
      const out = await estimate(l.departure, dz, az);
      if ((asMinutes(l.arrival) - asMinutes(out.arrival)) / 60 <= TRIP_NOT_FLIGHT_HOURS) return null;
      const back = await estimate(l.arrival, az, dz);
      return {
        trip: { ...trip, journeys: [
          { legs: [{ ...l, arrival: out.arrival }] },
          { legs: [{ from: l.to, to: l.from, departure: l.arrival, arrival: back.arrival }] },
        ] },
        backOn: l.arrival, minutes: out.minutes,
      };
    } catch { return null; } // no estimate: the plan's own check explains the dates
  }

  const whenText = (v) => new Date(v + "Z").toLocaleString(undefined,
    { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

  $("trip").addEventListener("submit", async (e) => {
    e.preventDefault();
    let trip = read();
    $("example-note").hidden = true;
    const note = $("estimate-note"); note.hidden = true;
    const converted = await asReturnTrip(trip);
    if (converted) {
      trip = converted.trip;
      fill(trip);
      const h = Math.floor(converted.minutes / 60), m = converted.minutes % 60;
      note.textContent = `Made this a return trip: you fly back ${whenText(converted.backOn)}. `
        + `Flight times are estimated from the distance (about ${h} h${m ? ` ${m} min` : ""} each way); `
        + "put in the landing times from your ticket for an exact plan.";
      note.hidden = false;
    }
    remember(trip);
    editing = false;
    makePlan(trip);
    scrollTo({ top: 0, behavior: scrollMode });
  });

  // First look: the current trip if there is one, otherwise a real example.
  const current = upgrade(load(K.current, null));
  const trip = current || exampleTrip();
  fill(trip);
  renderTrips();
  makePlan(trip, { quiet: true });

  const flag = new URLSearchParams(location.search).get("whoop");
  const why = new URLSearchParams(location.search).get("why");
  const werr = new URLSearchParams(location.search).get("error") || "";
  const wstatus = Number(new URLSearchParams(location.search).get("status")) || 0;
  if (flag) {
    history.replaceState(null, "", location.pathname);
    // Why it failed, from the server (see whoop.ConnectFailed): each has a different fix.
    const callback = new URL("whoop/callback", APP_URL).href;
    const failed = {
      keys: "WHOOP did not accept this app's keys. In Railway, check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET match the WHOOP developer dashboard exactly, with no spaces, then redeploy.",
      redirect: `WHOOP did not accept the return address. In the WHOOP developer dashboard, the Redirect URL must be exactly ${callback}`,
      expired: "The WHOOP sign-in expired before it finished. Tap Connect WHOOP again.",
      link: "The WHOOP sign-in took more than 10 minutes or was started elsewhere. Tap Connect WHOOP again.",
      network: "Could not reach WHOOP. Try again in a minute.",
      refused: `WHOOP stopped the sign-in with "${werr || "an error"}". `
        + (/scope/.test(werr) ? "The app asks for read:sleep, read:recovery and offline: tick those in the WHOOP developer dashboard."
          : /client/.test(werr) ? "Check WHOOP_CLIENT_ID in Railway matches the WHOOP developer dashboard."
          : "The details are in the server's logs."),
      whoop: wstatus === 403
        ? "WHOOP's firewall refused this server's request (HTTP 403), after you approved it. Nothing is wrong with your account or the keys; the server's logs name the firewall rule."
        : `WHOOP refused the sign-in${wstatus ? ` (HTTP ${wstatus})` : ""}. Try again; if it keeps happening, the reason is in the server's logs.`,
    }[why] || "WHOOP refused the sign-in. Try again; if it keeps happening, the reason is in the server's logs.";
    const msg = { connected: "WHOOP is connected. Your progress appears below your plan.", failed, cancelled: "WHOOP was not connected." }[flag];
    if (msg) { const e = $("error"); e.textContent = msg; e.className = flag === "connected" ? "ok" : "error"; e.hidden = false; }
  }

  // With WHOOP connected, the usual bedtime and wake time come from the last
  // two weeks of real nights instead of the chronotype's guess. Only fields
  // the traveller has not typed into are changed: untouched defaults, or the
  // values this put there last time.
  const BASELINE = "circadian.baseline.v1";
  const baselinePromises = {};
  // One fetch per page and question: the form pre-fill (no advice needed) and
  // Today's pre-trip block (advice for the days left) each reuse their own.
  const getBaseline = (daysUntil) => (baselinePromises[daysUntil ?? "none"] ||= api(`app/whoop/baseline?device=${device()}`
    + (daysUntil == null ? "" : `&days_until=${daysUntil}`)));
  async function applyBaseline(st) {
    const note = $("baseline-note");
    if (!st?.connected) { note.hidden = true; return; }
    let b;
    try { b = await getBaseline(null); } catch { return; }
    if (!b.bed || !b.wake) return;
    const bed = $("sleep_start"), wake = $("sleep_end");
    const [defBed, defWake] = CHRONO[$("chronotype").value] || CHRONO.intermediate;
    const before = load(BASELINE, null);
    const untouched = (bed.value === defBed && wake.value === defWake)
      || (before && bed.value === before.bed && wake.value === before.wake);
    if (untouched && (bed.value !== b.bed || wake.value !== b.wake)) {
      bed.value = b.bed; wake.value = b.wake;
      save(BASELINE, { bed: b.bed, wake: b.wake });
      const trip = read();
      save(K.current, trip);
      makePlan(trip, { quiet: true });
    }
    if (bed.value === b.bed && wake.value === b.wake) {
      note.textContent = `From your WHOOP, last ${b.days} nights: bed ${b.bed}, up ${b.wake}. Change them if this trip is different.`;
      note.hidden = false;
    }
  }

  refreshWhoopButton().then(applyBaseline);
  // From the Home Screen app, iPhone runs the WHOOP sign-in in a separate
  // browser sheet; the app underneath never reloads, so it kept saying
  // "Connect WHOOP" after connecting. Look again whenever it comes back.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const wasConnected = $("whoop-button").classList.contains("connected");
    const st = await refreshWhoopButton();
    if (st?.connected && !wasConnected) {
      const e = $("error"); e.textContent = "WHOOP is connected. Your progress appears below your plan."; e.className = "ok"; e.hidden = false;
      applyBaseline(st);
    }
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
