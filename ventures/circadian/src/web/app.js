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
    node.scrollIntoView({ behavior: "smooth", block: "center" });
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
      melatonin: true, caffeine: true, example: true,
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
    for (const k of ["sleep_start", "sleep_end", "chronotype", "preflight_days"]) {
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
      preflight_days: $("preflight_days").value, melatonin: $("melatonin").checked, caffeine: $("caffeine").checked,
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

  function dayTitle(local, zone) {
    const [y, m, d] = local.slice(0, 10).split("-").map(Number);
    const text = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
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

  function renderPlan(container, title, plan) {
    const now = new Date();
    const head = el("div", "card summary");
    head.appendChild(el("h2", "", title));
    head.appendChild(el("p", "", plan.summary));
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

  function renderNow(container, plans) {
    const now = new Date();
    const upcoming = plans.flatMap((p) => p.plan.events)
      .filter((e) => e.type !== "flight" && e.type !== "stopover" && new Date(e.end || e.start) > now)
      .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 3);
    if (!upcoming.length) return;
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Coming up"));
    const box = el("div", "events");
    for (const e of upcoming) box.appendChild(eventRow(e, now));
    card.appendChild(box);
    container.appendChild(card);
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
    const text = el("p", "", "A tap on the shoulder when it is time for light, bed, or the last coffee.");
    card.appendChild(text);
    const button = el("button", "secondary", "Turn on reminders"); button.type = "button";
    card.appendChild(button);
    container.appendChild(card);

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

  async function renderWhoop(container, tripReq) {
    const card = el("div", "card");
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
    try { st = await api(`app/whoop/status?device=${device()}`); } catch { return; }
    if (!st.configured) { text.textContent = "WHOOP is coming soon to Circadian."; button.hidden = true; return; }
    if (!st.connected) return;

    button.textContent = "Disconnect WHOOP";
    button.href = "#";
    button.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await api("app/whoop/disconnect", { device: device() }).catch(() => {});
      body.replaceChildren(); text.textContent = "WHOOP is disconnected. Nothing from it is kept here.";
      button.hidden = true;
    });
    text.textContent = "Checking your sleep…";
    try {
      const p = await api("app/whoop/progress", { device: device(), trip: tripReq });
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
          row.appendChild(el("small", "", bits.join(" · ")));
        }
        body.appendChild(row);
      }
      for (const a of p.advice) body.appendChild(el("p", "", a));
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

  function remember(trip) {
    const key = tripInfo(trip).key;
    const all = savedTrips().filter((t) => tripInfo(t).key !== key);
    all.unshift(trip);
    save(K.trips, all.slice(0, 10));
    save(K.current, trip);
    renderTrips();
  }

  // --- submit -----------------------------------------------------------------------------

  async function makePlan(trip, { quiet = false } = {}) {
    const error = $("error"); error.hidden = true;
    let req;
    try { req = toRequest(trip); } catch (err) { if (!quiet) { error.textContent = err.message; error.hidden = false; } return; }
    const button = $("go"); button.disabled = true; button.textContent = "Making your plan…";
    try {
      const { journeys } = await api("app/itinerary", req, quiet ? {} : { "x-circadian-intent": "submit" });
      const plans = journeys.map((plan, i) => ({
        title: (journeys.length > 1 ? `Flight ${i + 1}: ` : "") + `${cityOf(plan.home_tz)} to ${cityOf(plan.destination_tz)}`,
        plan,
      }));
      save("circadian.plans.v3", { req, plans });
      show(plans, trip, req);
    } catch (err) {
      const cached = load("circadian.plans.v3", null);
      if (cached && !navigator.onLine) show(cached.plans, trip, cached.req);
      else if (!quiet) { error.textContent = err.message; error.hidden = false; }
    } finally {
      button.disabled = false; button.textContent = "Make my plan";
    }
  }

  function show(plans, trip, req) {
    const out = $("result"); out.replaceChildren();
    renderNow(out, plans);
    renderActions(out, req, plans);
    // Reminders and WHOOP take the whole trip, so a return or a second city
    // gets its reminders and its nights too.
    if (!trip.example) {
      renderReminders(out, req);
      renderWhoop(out, req);
    }
    for (const p of plans) renderPlan(out, p.title, p.plan);
    out.appendChild(el("p", "disclaimer", plans[0].plan.disclaimer));
  }

  $("trip").addEventListener("submit", (e) => {
    e.preventDefault();
    const trip = read();
    $("example-note").hidden = true;
    remember(trip);
    makePlan(trip);
  });

  // First look: the current trip if there is one, otherwise a real example.
  const current = upgrade(load(K.current, null));
  const trip = current || exampleTrip();
  fill(trip);
  renderTrips();
  makePlan(trip, { quiet: true });

  const flag = new URLSearchParams(location.search).get("whoop");
  if (flag) {
    history.replaceState(null, "", location.pathname);
    const msg = { connected: "WHOOP is connected. Your progress appears below your plan.", failed: "Connecting WHOOP did not work. Try again.", cancelled: "WHOOP was not connected." }[flag];
    if (msg) { const e = $("error"); e.textContent = msg; e.className = flag === "connected" ? "ok" : "error"; e.hidden = false; }
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
