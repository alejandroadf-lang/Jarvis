// Stores the output of the autonomous daily meeting cycle (see
// dailyMeeting.js): one report per calendar day (UTC), keyed by date so a
// second run on the same day overwrites rather than duplicates.

import { readJson, writeJson } from './store.js';

const FILE = 'dailyReports.json';

function load() {
  return readJson(FILE, { reports: {} });
}

export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export function listDailyReports() {
  const { reports } = load();
  return Object.values(reports).sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getDailyReport(date) {
  const { reports } = load();
  return reports[date] || null;
}

export function getLatestDailyReport() {
  return listDailyReports()[0] || null;
}

export function hasReportForToday() {
  return Boolean(getDailyReport(todayKey()));
}

export function saveDailyReport(report) {
  const data = load();
  data.reports[report.date] = report;
  writeJson(FILE, data);
  return report;
}
