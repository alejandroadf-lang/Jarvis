import { useCallback, useEffect, useState } from 'react';
import { fetchDailyReports, runDailyMeetingNow } from '../api/chat.js';

function TraceBadges({ trace }) {
  if (!trace || trace.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {trace.map((agent, i) => (
        <span
          key={`${agent.id}-${i}`}
          title={agent.department}
          className="text-[10px] uppercase tracking-wide text-cyan-400/70 border border-cyan-500/30 rounded-full px-2 py-0.5"
        >
          {agent.title}
        </span>
      ))}
    </div>
  );
}

function ReportSection({ title, reply, trace }) {
  return (
    <div className="border border-cyan-500/20 rounded-lg p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-3">{title}</h2>
      <TraceBadges trace={trace} />
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-cyan-50/90">{reply}</div>
    </div>
  );
}

function fmtDate(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

export default function DailyReportView() {
  const [reports, setReports] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);

  const load = useCallback((selectLatest = false) => {
    fetchDailyReports()
      .then((list) => {
        setReports(list);
        if (selectLatest || !selectedDate) setSelectedDate(list[0]?.date ?? null);
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(true);
  }, [load]);

  const handleRunNow = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await runDailyMeetingNow();
      load(true);
    } catch (err) {
      setRunError(err.response?.data?.error || err.message);
    } finally {
      setRunning(false);
    }
  };

  if (error) {
    return <p className="text-xs text-red-400 p-6">{error}</p>;
  }
  if (!reports) {
    return <p className="text-xs text-cyan-500/50 p-6">Loading daily reports…</p>;
  }

  const selected = reports.find((r) => r.date === selectedDate) || null;

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-cyan-500/20 overflow-y-auto p-3">
        <button
          onClick={handleRunNow}
          disabled={running}
          className="w-full text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-full px-3 py-2 mb-3"
        >
          {running ? 'Running…' : "Run today's meeting now"}
        </button>
        {runError && <p className="text-[11px] text-red-400 mb-3">{runError}</p>}
        {reports.length === 0 && <p className="text-[11px] text-cyan-500/50">No reports yet.</p>}
        <div className="space-y-1">
          {reports.map((r) => (
            <button
              key={r.date}
              onClick={() => setSelectedDate(r.date)}
              className={`w-full text-left text-xs rounded px-2 py-1.5 transition-colors ${
                r.date === selectedDate ? 'bg-cyan-600 text-white' : 'text-cyan-400/80 hover:bg-white/5'
              }`}
            >
              {fmtDate(r.date)}
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="text-sm font-semibold uppercase tracking-wide text-cyan-300 mb-1">Daily Report</h1>

        {!selected ? (
          <p className="text-xs text-cyan-500/50 mt-4">
            No daily reports yet. The management team runs one automatically once a day, or you
            can trigger today's now with the button on the left.
          </p>
        ) : (
          <div className="space-y-4 mt-4">
            <p className="text-xs text-cyan-500/60">
              {fmtDate(selected.date)} · generated {new Date(selected.generatedAt).toLocaleTimeString()} · treasury $
              {selected.treasury.balance.toFixed(2)} / ${selected.treasury.startingCapital}
            </p>

            <ReportSection
              title="Leadership Sync — Executive Team"
              reply={selected.leadership.reply}
              trace={selected.leadership.trace}
            />

            <ReportSection
              title="Opportunity Review — Venture Studio"
              reply={selected.studio.reply}
              trace={selected.studio.trace}
            />

            {selected.proposedVentureIds.length > 0 && (
              <p className="text-xs text-emerald-300/80 border border-emerald-500/30 rounded-lg p-3">
                Logged {selected.proposedVentureIds.length} new venture proposal
                {selected.proposedVentureIds.length > 1 ? 's' : ''} from this session — check the Ventures panel
                (Executive Team or Venture Studio tab) to review and greenlight.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
