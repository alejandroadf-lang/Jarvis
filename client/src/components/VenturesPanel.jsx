import { useCallback, useEffect, useState } from 'react';
import {
  fetchVentures,
  fetchLedger,
  killVenture,
  linkVentureRepo,
  enableVentureDeployment,
  disableVentureDeployment,
  linkVentureOutreach,
  enableVentureOutreach,
  disableVentureOutreach,
  fetchKillSwitch,
  haltRealActions,
  resumeRealActions,
  fetchSpend,
  fetchIntegrations,
  fetchWhatsAppActivity,
  fetchDailyPlan,
  approveDailyPlan,
  rejectDailyPlan,
} from '../api/chat.js';
import { Integrations, WhatsAppActivity, DailyPlan, KillSwitch } from './ventures/FounderControls.jsx';
import VentureCard from './ventures/VentureCard.jsx';

function formatUsd(amount) {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export default function VenturesPanel({ reloadKey }) {
  const [ledger, setLedger] = useState(null);
  const [ventures, setVentures] = useState([]);
  const [killSwitch, setKillSwitch] = useState(null);
  const [spend, setSpend] = useState(null);
  const [integrations, setIntegrations] = useState(null);
  const [checkingIntegrations, setCheckingIntegrations] = useState(false);
  const [dailyPlan, setDailyPlan] = useState(null);
  const [decidingPlan, setDecidingPlan] = useState(false);
  const [whatsapp, setWhatsapp] = useState(null);
  const [checkingWhatsapp, setCheckingWhatsapp] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    Promise.all([fetchLedger(), fetchVentures(), fetchKillSwitch(), fetchSpend()])
      .then(([l, v, k, s]) => {
        setLedger(l);
        setVentures(v);
        setKillSwitch(k);
        setSpend(s);
      })
      .catch((err) => setError(err.message));
    // Kept out of the Promise.all above on purpose: it makes real network
    // calls to two third parties, so it's slower than the rest and must not
    // hold the whole panel behind it — or fail it.
    fetchIntegrations()
      .then(setIntegrations)
      .catch(() => {});
    fetchWhatsAppActivity()
      .then(setWhatsapp)
      .catch(() => {});
    fetchDailyPlan()
      .then(setDailyPlan)
      .catch(() => {});
  }, []);

  const decidePlan = useCallback(async (decide, value) => {
    setDecidingPlan(true);
    try {
      await decide(value);
      setDailyPlan(await fetchDailyPlan());
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingPlan(false);
    }
  }, []);

  const refreshWhatsapp = useCallback(async () => {
    setCheckingWhatsapp(true);
    try {
      setWhatsapp(await fetchWhatsAppActivity());
    } catch {
      // Same as integrations: keep the last known state rather than blanking.
    } finally {
      setCheckingWhatsapp(false);
    }
  }, []);

  const recheckIntegrations = useCallback(async () => {
    setCheckingIntegrations(true);
    try {
      setIntegrations(await fetchIntegrations());
    } catch {
      // The panel keeps showing the last known state rather than blanking.
    } finally {
      setCheckingIntegrations(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const handleKill = async (id) => {
    const reason = window.prompt('Why is this venture being killed?');
    if (reason === null) return; // cancelled
    setBusyId(id);
    setError(null);
    try {
      await killVenture(id, reason);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleLinkRepo = async (id, repoConfig) => {
    setBusyId(id);
    setError(null);
    try {
      await linkVentureRepo(id, repoConfig);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleEnableDeployment = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await enableVentureDeployment(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDisableDeployment = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await disableVentureDeployment(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleHalt = async () => {
    const reason = window.prompt('Why are you halting all real actions?');
    if (reason === null) return; // cancelled
    setBusyId('kill-switch');
    setError(null);
    try {
      setKillSwitch(await haltRealActions(reason));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleResume = async () => {
    setBusyId('kill-switch');
    setError(null);
    try {
      setKillSwitch(await resumeRealActions());
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleLinkOutreach = async (id, outreachConfig) => {
    setBusyId(id);
    setError(null);
    try {
      await linkVentureOutreach(id, outreachConfig);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleEnableOutreach = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await enableVentureOutreach(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDisableOutreach = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await disableVentureOutreach(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return <p className="text-xs text-red-400 p-4">{error}</p>;
  }
  if (!ledger) {
    return <p className="text-xs text-cyan-500/50 p-4">Loading…</p>;
  }

  const active = ventures.filter((v) => v.status === 'active');

  return (
    <div className="p-4 border-t border-cyan-500/20">
      <DailyPlan
        state={dailyPlan}
        onApprove={(note) => decidePlan(approveDailyPlan, note)}
        onReject={(reason) => decidePlan(rejectDailyPlan, reason)}
        busy={decidingPlan}
      />
      <Integrations status={integrations} onRefresh={recheckIntegrations} busy={checkingIntegrations} />
      <WhatsAppActivity activity={whatsapp} onRefresh={refreshWhatsapp} busy={checkingWhatsapp} />

      <KillSwitch
        state={killSwitch}
        onHalt={handleHalt}
        onResume={handleResume}
        busy={busyId === 'kill-switch'}
      />

      <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-2">Performance</h2>
      <p className="text-2xl font-semibold text-cyan-100">
        {formatUsd(ledger.net)}
        <span className="text-xs text-cyan-500/50 font-normal"> net</span>
      </p>
      <p className="text-[11px] text-cyan-500/50 mt-0.5">
        {formatUsd(ledger.revenue)} earned · {formatUsd(ledger.expenses)} spent
      </p>
      {spend && (
        <p className={`text-[11px] mt-1 ${spend.overCap ? 'text-red-400/80' : 'text-cyan-500/50'}`}>
          Agent spend today: {formatUsd(spend.spentUsd)} / {formatUsd(spend.capUsd)} cap
          {spend.overCap && ' — model calls paused until the UTC day rolls over'}
        </p>
      )}

      {active.length === 0 && (
        <p className="text-[11px] text-cyan-500/50 mt-3">
          No ventures yet — brainstorm above until an idea clears the bar.
        </p>
      )}

      {active.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-[11px] uppercase tracking-wide text-cyan-500/60">Active</h3>
          {active.map((v) => (
            <VentureCard
              key={v.id}
              venture={v}
              onKill={handleKill}
              onLinkRepo={handleLinkRepo}
              onEnableDeployment={handleEnableDeployment}
              onDisableDeployment={handleDisableDeployment}
              onLinkOutreach={handleLinkOutreach}
              onEnableOutreach={handleEnableOutreach}
              onDisableOutreach={handleDisableOutreach}
              busy={busyId === v.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

