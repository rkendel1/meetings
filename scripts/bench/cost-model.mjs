// Cost model for the Meetings benchmark: reads the measured results (docs/bench/conventional-results.json) and the
// unit rates below, writes docs/bench/cost-model.json and prints the tables used in ARTIFACT-ECONOMICS-BENCHMARK.md.
//   node scripts/bench/cost-model.mjs
// Change a rate here (or pass RATES_JSON=<file>) and re-run: every derived figure is recomputed.
import { readFileSync, writeFileSync } from "node:fs";

const results = JSON.parse(readFileSync("docs/bench/conventional-results.json", "utf8"));
const R = Object.fromEntries(results.results.map((r) => [r.scenario, r]));
const v = (s, k) => R[s]?.observed?.[k]?.value ?? null;

const rates = JSON.parse(process.env.RATES_JSON ? readFileSync(process.env.RATES_JSON, "utf8") : JSON.stringify({
  vmMonthlyEur: {
    low: 3.79, high: 5.49,
    kind: "estimate (unverified)",
    source: "Third-party price aggregators for Hetzner Cloud shared-vCPU entry plans (CX22 ≈ €3.79–4.59, CX23 ≈ €5.49 after 2026 increases), excl. VAT; Hetzner's official page was not reached. Replace with the provider's current price.",
    shape: "2 vCPU (shared), 4 GiB RAM class; the smallest class that holds the measured footprint with headroom",
  },
  hoursPerMonth: { value: 730, kind: "convention" },
  turnUsdPerGb: { value: 0.05, freeGbPerMonth: 1000, kind: "published", source: "Cloudflare Realtime TURN docs (developers.cloudflare.com/realtime/turn/faq): $0.05/GB egress from Cloudflare to the TURN client, first 1,000 GB/month free (shared with SFU)" },
  appboundry: { value: null, kind: "unavailable", source: "No published AppBoundry pricing; managed execution answers NO_EXECUTION_CAPACITY (rkendel1/feltkit docs/APPBOUNDRY.md). Not estimated." },
}));

const perPm = (s) => {
  const pm = v(s, "participantMinutes");
  if (!pm) return null;
  return {
    participantMinutes: pm,
    serverCpuSecondsPerPm: Number((v(s, "serverCpuSeconds") / pm).toFixed(4)),
    appTrafficKiBPerPm: Number(((v(s, "appTrafficToServerBytes") + v(s, "appTrafficToClientsBytes")) / 1024 / pm).toFixed(1)),
    stateKiBPerPm: Number((v(s, "stateBytesDelta") / 1024 / pm).toFixed(1)),
    peerToPeerMediaMiBPerPm: v(s, "peerToPeerMediaBytes") === null ? null : Number((v(s, "peerToPeerMediaBytes") / 2 ** 20 / pm).toFixed(2)),
  };
};

const unit = { small: perPm("small"), normal: perPm("normal"), busy: perPm("busy") };
const idle = { cpuSeconds: v("idle", "serverCpuSeconds"), durationS: R.idle.period.durationS, rssAvgMiB: v("idle", "serverRssAvgMb"), rssPeakMiB: v("idle", "serverRssPeakMb") };
const peakRss = Math.max(...results.results.map((r) => r.observed.serverRssPeakMb.value ?? 0));

const H = rates.hoursPerMonth.value;
const perHour = { low: rates.vmMonthlyEur.low / H, high: rates.vmMonthlyEur.high / H };
// Projected months: workloads stated, not observed. Media relayed through TURN is a parameter (share of
// participant-minutes that need a relay), not a measurement: the lab and this benchmark needed none.
const workloads = [
  { name: "W0 idle all month", meetingHours: 0, peoplePerMeeting: 0 },
  { name: "W1 20 meeting-hours/month, 4 people", meetingHours: 20, peoplePerMeeting: 4 },
  { name: "W2 200 meeting-hours/month, 4 people", meetingHours: 200, peoplePerMeeting: 4 },
  { name: "W3 2,000 meeting-hours/month, 4 people", meetingHours: 2000, peoplePerMeeting: 4 },
];
const mediaMiBPerPm = unit.normal.peerToPeerMediaMiBPerPm; // 4-person mesh, fake 640x480 video: a lower bound for real cameras
const projections = workloads.map((w) => {
  const pm = w.meetingHours * 60 * w.peoplePerMeeting;
  const cpuSecondsNeeded = pm * unit.normal.serverCpuSecondsPerPm + idle.cpuSeconds / idle.durationS * H * 3600;
  const availableCpuSeconds = 2 * H * 3600;
  const relay = Object.fromEntries([0, 0.2, 1].map((share) => {
    const gb = (pm * share * mediaMiBPerPm) / 1024;
    const billable = Math.max(0, gb - rates.turnUsdPerGb.freeGbPerMonth);
    return [`relayShare${share * 100}%`, { relayedGb: Number(gb.toFixed(1)), usd: Number((billable * rates.turnUsdPerGb.value).toFixed(2)) }];
  }));
  return {
    workload: w.name,
    participantMinutes: pm,
    instanceEurPerMonth: { low: rates.vmMonthlyEur.low, high: rates.vmMonthlyEur.high, kind: "estimate: fixed, independent of use" },
    serverCpuUtilisationOf2vCpu: { value: Number(((cpuSecondsNeeded / availableCpuSeconds) * 100).toFixed(3)), unit: "%", kind: "calculated from observed CPU-s per participant-minute; not a capacity claim" },
    eurPer1000ParticipantMinutes: pm ? { low: Number(((rates.vmMonthlyEur.low / pm) * 1000).toFixed(4)), high: Number(((rates.vmMonthlyEur.high / pm) * 1000).toFixed(4)), kind: "estimate: allocated instance cost / participant-minutes" } : null,
    stateGrowthMiB: { value: Number(((pm * unit.normal.stateKiBPerPm) / 1024).toFixed(1)), kind: "calculated from observed state growth per participant-minute" },
    turnRelayIfNeeded: { ...relay, kind: "calculated at stated relay shares (parameters, not observations); media per participant-minute observed with fake video" },
  };
});

const model = {
  schema: "meetings.bench.cost/1",
  sourceResults: "docs/bench/conventional-results.json",
  rates,
  observedUnits: { idle, peakRssMiBAcrossScenarios: peakRss, perParticipantMinute: unit },
  conventional: {
    perApplicationHourEur: { low: Number(perHour.low.toFixed(5)), high: Number(perHour.high.toFixed(5)), kind: "estimate: allocated instance" },
    idle24hEur: { low: Number((perHour.low * 24).toFixed(4)), high: Number((perHour.high * 24).toFixed(4)), kind: "estimate: allocated instance; the observed idle CPU is 0.25% of one core" },
    observedIdleUtilisation: { cpuCores: Number((idle.cpuSeconds / idle.durationS).toFixed(4)), rssMiB: idle.rssAvgMiB, kind: "observed" },
    perActiveMeetingHourEur: { note: "With a fixed instance, the cost of a meeting-hour is the instance cost divided by the meeting-hours it carries: see projections. The marginal server CPU of a 4-person meeting-hour is observed", marginalCpuSecondsPerMeetingHour4p: Number((unit.normal.serverCpuSecondsPerPm * 4 * 60).toFixed(1)) },
  },
  appboundry: { meetings: null, reason: "Meetings cannot be built into an artifact (docs/bench/appboundry-build-refusal.txt); no AppBoundry pricing exists to apply. Runtime idle footprint for the same starter app: docs/bench/runtime-idle-starter.json." },
  projections,
};
writeFileSync("docs/bench/cost-model.json", JSON.stringify(model, null, 2));
console.log(JSON.stringify({ unit, idle, perHour, projections: projections.map((p) => ({ w: p.workload, pm: p.participantMinutes, util: p.serverCpuUtilisationOf2vCpu.value, per1000pm: p.eurPer1000ParticipantMinutes, relay: p.turnRelayIfNeeded, state: p.stateGrowthMiB.value })) }, null, 1));
