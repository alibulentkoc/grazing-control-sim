// grazing-control-sim engine v1.1. Ported from grazing-sim v0.1.0 (weather.js, pasture.js, animal.js,
// sensors.js, fusion.js, rng.js). Lumped to the paddock mean, one species (tall fescue).
// Every sensor reading is a record {day, paddock, type, value, animal, n, sd, role}. The observer
// (estimator plus controller) reads records only. The simulator is one source of records; field data
// entered by hand or imported as CSV is another. Both go through the same observer.
// v1.2: sensor errors measured against clips in field records can replace the simulator placeholders.
// v1.3: historical daily weather (NOAA GHCN-Daily CSV or a plain date,tmax,tmin,rain file) can drive the season.
(function (root) {
"use strict";
var VERSION = "1.4.0";

// ---------- RNG (mulberry32, as grazing-sim rng.js) ----------
function makeRng(seed) {
  var a = seed >>> 0;
  function next() {
    a = (a + 0x6D2B79F5) >>> 0; var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    uniform: next,
    normal: function (mu, sd) { var u = 0, v = 0; while (u === 0) u = next(); while (v === 0) v = next();
      return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    exponential: function (m) { return -m * Math.log(1 - next()); },
    poisson: function (l) { var L = Math.exp(-l), k = 0, p = 1; do { k++; p *= next(); } while (p > L); return k - 1; },
    bernoulli: function (p) { return next() < p; },
    fork: function (tag) { var h = 0, s = String(tag); for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return makeRng((a ^ h) >>> 0); }
  };
}
function mean(x) { if (!x.length) return NaN; var s = 0; for (var i = 0; i < x.length; i++) s += x[i]; return s / x.length; }
function sdOf(x) { if (x.length < 2) return NaN; var m = mean(x), s = 0; for (var i = 0; i < x.length; i++) s += (x[i] - m) * (x[i] - m); return Math.sqrt(s / (x.length - 1)); }
function median(x) { if (!x.length) return NaN; var s = x.slice().sort(function (a, b) { return a - b; }); var h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lsSlope(xs, ys) {
  var n = xs.length; if (n < 2) return { slope: NaN, se: NaN, n: n };
  var mx = mean(xs), my = mean(ys), sxx = 0, sxy = 0, i;
  for (i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx === 0) return { slope: NaN, se: NaN, n: n };
  var b = sxy / sxx, sse = 0;
  for (i = 0; i < n; i++) { var e = ys[i] - (my + b * (xs[i] - mx)); sse += e * e; }
  return { slope: b, se: n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : NaN, n: n };
}

// ---------- Parameters (grazing-sim config/default.json unless noted) ----------
var BASE = {
  seasonStartDoy: 91, seasonDays: 214, seasonStartDate: "2026-04-01",
  weather: { tempDailySdC: 3.0, rainProbability: 0.33, rainMeanMm: 12.0,
    soil: { fieldCapacityMm: 100, wiltingMm: 30, etPerDegC: 0.12, fWmin: 0.10 } },
  scenarios: { average: { rainMult: 1.0, tempOffsetC: 0.0 }, dry: { rainMult: 0.6, tempOffsetC: 1.0 }, wet: { rainMult: 1.4, tempOffsetC: 0.0 } },
  grass: { Rmax: 62, Tmin: 0, Topt: 20, Tmax: 34, Bmax: 5000, Bref: 700, senescence: 0.006, TDNmax: 66, TDNslope: 12 },
  heatSenescenceT: 29, heatSenescenceRate: 0.005, droughtSenescenceRate: 0.005,
  Bmin: 800, initialBiomass: 2600, initialCv: 0.15,
  paddocks: 10, areaHa: 0.404686,
  herd: { head: 10, initialBW: 300, initialBWSd: 25, dmiFracBW: 0.026, heatT: 28, heatSlopePerC: 0.03, heatMinFactor: 0.75,
    biteSaturationKgHa: 1200, trampleFrac: 0.15, grazingActivityFrac: 0.15, energyPerKgLossMcal: 6.0,
    gutFillSdFrac: 0.025, gutFillAr1: 0.5 },
  camera: { visitsPerDay: 2.5, heatVisitMult: 0.7, timidityEffect: 0.5, animalOffsetSdFrac: 0.03, visitSdFrac: 0.03 },
  map: { flightBiasSd: 0.03, calBiasSd: 0.03, cellSd: 0.14, rho: 0.4, nCells: 100, missingCellProb: 0.02 },
  // Producer methods (v1.1). PLACEHOLDERS set here; replace from the literature and the lab's own comparisons.
  plate: { calBiasSd: 0.12, passSd: 0.08, postExtraSd: 0.05 },
  visual: { observerBiasSd: 0.15, dailySd: 0.20, shrink: 0.7, center: 2000 },
  clip: { quadrats: 12, spatialCv: 0.30, labSd: 0.02 },
  scale: { sdKg: 2.0 }, scaleEveryDays: 40, cycleDays: 40,
  est: { regrowthPriorKgHaD: 45, regrowthPairs: 3, regrowthSd: 15, removalSdFrac: 0.10 }
};
var NOISE_MULT = { low: 0.25, medium: 1.0, high: 2.0 };
var BIO_SENSORS = { map: "UAV or rover map", plate: "Plate meter", visual: "Visual estimate" };

function mapRelSe(m) { var M = BASE.map; return m * Math.sqrt(M.calBiasSd * M.calBiasSd + M.flightBiasSd * M.flightBiasSd + M.rho * M.cellSd * M.cellSd + (1 - M.rho) * M.cellSd * M.cellSd / M.nCells); }
function plateRelSe(m) { var P = BASE.plate; return m * Math.sqrt(P.calBiasSd * P.calBiasSd + P.passSd * P.passSd); }
function visualRelSe(m) { var V = BASE.visual; return m * Math.sqrt(V.observerBiasSd * V.observerBiasSd + V.dailySd * V.dailySd); }
var DEFAULT_REL_SE = { map: +mapRelSe(1).toFixed(3), uav: +mapRelSe(1).toFixed(3), rover: +mapRelSe(1).toFixed(3), plate: +plateRelSe(1).toFixed(3), visual: +visualRelSe(1).toFixed(3), clip: +(BASE.clip.spatialCv / Math.sqrt(BASE.clip.quadrats)).toFixed(3) };

var DEFAULT_SETTINGS = {
  source: "sim", mode: "dual", weather: "average", recordYear: null, seed: 42, bioSensor: "map",
  floor: 1500, delta: 30, dmin: 2, dmax: 7, window: 5, calendarDays: 4,
  noiseMap: "medium", noiseCamera: "medium", noiseFill: "medium",
  calibrate: false, useClips: false,
  measured: { map: null, plate: null, visual: null },
  field: { head: 10, areaAc: 1.0, paddocks: 10, initialBW: 300, regrowthPrior: 45,
    relSe: { uav: DEFAULT_REL_SE.uav, rover: DEFAULT_REL_SE.rover, map: DEFAULT_REL_SE.map, plate: DEFAULT_REL_SE.plate, visual: DEFAULT_REL_SE.visual, clip: DEFAULT_REL_SE.clip } }
};
var LIMITS = { floor: [1000, 2000], delta: [10, 40], dmin: [1, 3], dmax: [3, 10], window: [3, 5], calendarDays: [1, 10] };
var FIELD_LIMITS = { head: [1, 500], areaAc: [0.05, 100], paddocks: [2, 40], initialBW: [50, 900], regrowthPrior: [0, 150] };

function sanitize(s) {
  var o = {}, k, notes = [];
  for (k in DEFAULT_SETTINGS) o[k] = (s && s[k] !== undefined) ? s[k] : DEFAULT_SETTINGS[k];
  for (k in LIMITS) {
    var v = Number(o[k]); if (!isFinite(v)) v = DEFAULT_SETTINGS[k];
    var c = clamp(v, LIMITS[k][0], LIMITS[k][1]);
    if (k !== "floor") c = Math.round(c);
    if (c !== v) notes.push(k + " clamped to " + c);
    o[k] = c;
  }
  if (o.dmin > o.dmax) { notes.push("d_min raised above d_max; d_max set to " + o.dmin); o.dmax = o.dmin; }
  o.seed = Math.max(1, Math.round(Number(o.seed)) || 42);
  if (["dual", "calendar", "grass"].indexOf(o.mode) < 0) o.mode = "dual"; // "grass": floor trigger only (Explore level)
  if (["sim", "field"].indexOf(o.source) < 0) o.source = "sim";
  if (!BASE.scenarios[o.weather] && o.weather !== "record") o.weather = "average";
  o.recordYear = Math.round(Number(o.recordYear)) || null;
  if (!BIO_SENSORS[o.bioSensor]) o.bioSensor = "map";
  ["noiseMap", "noiseCamera", "noiseFill"].forEach(function (q) { if (!NOISE_MULT[o[q]]) o[q] = "medium"; });
  o.calibrate = !!o.calibrate; o.useClips = !!o.useClips;
  var mi = (s && s.measured) || {}; o.measured = {};
  for (k in BIO_SENSORS) {
    var me = mi[k], b = me ? Number(me.bias) : NaN, sd = me ? Number(me.sd) : NaN;
    o.measured[k] = (me && isFinite(b) && isFinite(sd)) ? { bias: clamp(b, -0.8, 0.8), sd: clamp(sd, 0.005, 1), n: Math.max(0, Math.round(Number(me.n) || 0)), from: String(me.from || "field records").slice(0, 80) } : null;
  }
  var f = {}, fi = (s && s.field) || {};
  for (k in FIELD_LIMITS) { var fv = Number(fi[k]); if (!isFinite(fv)) fv = DEFAULT_SETTINGS.field[k]; f[k] = clamp(fv, FIELD_LIMITS[k][0], FIELD_LIMITS[k][1]); }
  f.head = Math.round(f.head); f.paddocks = Math.round(f.paddocks);
  f.relSe = {};
  for (k in DEFAULT_SETTINGS.field.relSe) { var rv = Number(fi.relSe && fi.relSe[k]); f.relSe[k] = (fi.relSe && fi.relSe[k] !== undefined && isFinite(rv)) ? clamp(rv, 0.005, 1) : DEFAULT_SETTINGS.field.relSe[k]; }
  o.field = f; o.notes = notes;
  return o;
}

// ---------- True-state model (simulation only) ----------
function normalTemp(doy) { return 16.5 + 10.5 * Math.sin(2 * Math.PI * (doy - 110) / 365); }
function makeWeather(P, scen, rng) {
  var sc = P.scenarios[scen], days = [], sw = P.weather.soil.fieldCapacityMm * 0.8, S = P.weather.soil;
  for (var d = 0; d < P.seasonDays; d++) {
    var doy = ((P.seasonStartDoy + d - 1) % 365) + 1;
    var temp = normalTemp(doy) + sc.tempOffsetC + rng.normal(0, P.weather.tempDailySdC);
    var rain = rng.bernoulli(P.weather.rainProbability) ? rng.exponential(P.weather.rainMeanMm) * sc.rainMult : 0;
    sw = clamp(sw + rain - S.etPerDegC * Math.max(temp, 0), 0, S.fieldCapacityMm);
    days.push({ day: d, doy: doy, temp: temp, rain: rain, fW: clamp((sw - S.wiltingMm) / (S.fieldCapacityMm - S.wiltingMm), 0, 1) });
  }
  return days;
}
function fTemp(T, sp) { if (T <= sp.Tmin || T >= sp.Tmax) return 0; return T < sp.Topt ? (T - sp.Tmin) / (sp.Topt - sp.Tmin) : (sp.Tmax - T) / (sp.Tmax - sp.Topt); }
function tdnOf(B, sp) { return sp.TDNmax - sp.TDNslope * clamp(B / sp.Bmax, 0, 1); }
function growth(B, wx, P) {
  var sp = P.grass;
  var fM = clamp(B / sp.Bref, 0.15, 1) * clamp(1 - B / sp.Bmax, 0, 1);
  var G = sp.Rmax * fTemp(wx.temp, sp) * Math.max(P.weather.soil.fWmin, wx.fW) * fM;
  var heat = wx.temp > P.heatSenescenceT ? 1 : 0;
  var S = (sp.senescence + P.heatSenescenceRate * heat + P.droughtSenescenceRate * (1 - wx.fW)) * Math.max(0, B - P.Bmin);
  return { G: G, S: S };
}
function heatFactor(T, H) { return T <= H.heatT ? 1 : Math.max(H.heatMinFactor, 1 - H.heatSlopePerC * (T - H.heatT)); }
function meFromTdn(tdn) { return 0.82 * 0.04409 * tdn; }
function neMa(ME) { return 1.37 * ME - 0.138 * ME * ME + 0.0105 * ME * ME * ME - 1.12; }
function neGa(ME) { return 1.42 * ME - 0.174 * ME * ME + 0.0122 * ME * ME * ME - 1.65; }
function gainFromIntake(intake, tdn, BW, H) {
  var ME = meFromTdn(tdn), NEm = neMa(ME), NEg = neGa(ME);
  var req = 0.077 * Math.pow(BW, 0.75) * (1 + H.grazingActivityFrac), dmiM = req / NEm;
  if (intake >= dmiM) { var RE = (intake - dmiM) * NEg; var EBG = Math.pow(RE / (0.0635 * Math.pow(0.891 * BW, 0.75)), 1 / 1.097); return EBG / 0.956; }
  return -((dmiM - intake) * NEm) / H.energyPerKgLossMcal;
}
function swardFactor(B) { return clamp((B - BASE.Bmin) / BASE.herd.biteSaturationKgHa, 0, 1); }

// ---------- Observer: estimator and controller. Reads records only. ----------
function createObserver(cfg) {
  var H = BASE.herd, E = BASE.est, N = cfg.N;
  var ob = {
    N: N, Bhat: [], Pvar: [], lastRead: [], lastExit: {}, regrowthPairs: [], rHat: cfg.regrowthPrior,
    animalLast: {}, camSeries: [], camToday: NaN, gHat: NaN, gSe: NaN, gMax: NaN,
    calPairs: {}, calFactor: {}, clipLog: [], readLog: [], scaleLog: [], lastObs: {}, tempToday: null, day: 0, lastCalDay: null
  };
  for (var p = 0; p < N; p++) { ob.Bhat.push(NaN); ob.Pvar.push(NaN); ob.lastRead.push(null); }
  function S() { return cfg.settings; }
  function relSe(type) { return cfg.relSe[type] !== undefined ? cfg.relSe[type] : cfg.relSe.map; }

  ob.newDay = function (day, stay) {
    ob.day = day; ob.lastObs = { map: null }; ob.tempToday = null; ob.camToday = NaN;
    if (stay === 0) ob.gMax = NaN;
    // outer loop: once per nominal cycle, update calibration factors from sensor-to-clip pairs so far
    if (day > 0 && day % BASE.cycleDays === 0) {
      for (var t in ob.calPairs) if (ob.calPairs[t].length) ob.calFactor[t] = mean(ob.calPairs[t]);
      ob.lastCalDay = day;
    }
  };
  ob.ingestWeights = function (day, cams, scales, temp) {
    if (temp !== null && temp !== undefined && isFinite(temp)) ob.tempToday = temp;
    var byA = {}, herdVals = [], a;
    cams.forEach(function (c) { if (c.animal === null || c.animal === undefined || c.animal === "") herdVals.push(c.value); else (byA[c.animal] = byA[c.animal] || []).push(c.value); });
    for (a in byA) ob.animalLast[a] = median(byA[a]);
    var vals = []; for (a in ob.animalLast) vals.push(ob.animalLast[a]);
    var y = herdVals.length ? mean(herdVals) : (vals.length ? mean(vals) : NaN);
    ob.camToday = y;
    if (isFinite(y)) ob.camSeries.push({ day: day, w: y });
    if (scales.length) ob.scaleLog.push({ day: day, value: mean(scales.map(function (s) { return s.value; })), camera: y });
  };
  function kf(p, y, R, type, role, day) {
    if (!isFinite(ob.Bhat[p])) { ob.Bhat[p] = y; ob.Pvar[p] = R; }
    else { var K = ob.Pvar[p] / (ob.Pvar[p] + R); ob.Bhat[p] += K * (y - ob.Bhat[p]); ob.Pvar[p] *= (1 - K); }
    var key = type + "|" + p;
    if (role === "pre" && ob.lastExit[key]) {
      var dd = day - ob.lastExit[key].day;
      if (dd >= 3) { ob.regrowthPairs.push((y - ob.lastExit[key].y) / dd); if (ob.regrowthPairs.length > E.regrowthPairs) ob.regrowthPairs.shift(); ob.rHat = mean(ob.regrowthPairs); }
    }
    if (role === "post") ob.lastExit[key] = { day: day, y: y };
  }
  ob.ingestBiomass = function (day, recs) {
    var groups = {}, order = [];
    recs.forEach(function (r) {
      var k = r.type + "|" + r.paddock + "|" + (r.role || "");
      if (!groups[k]) { groups[k] = { type: r.type, p: r.paddock, role: r.role || "", vals: [], n: null, sd: null }; order.push(k); }
      groups[k].vals.push(r.value); if (r.n) groups[k].n = r.n; if (r.sd) groups[k].sd = r.sd;
    });
    var clipAt = {};
    order.forEach(function (k) {
      var g = groups[k]; if (g.type !== "clip") return;
      var m = mean(g.vals), n = g.vals.length > 1 ? g.vals.length : (g.n || 1), sd = g.vals.length > 1 ? sdOf(g.vals) : (g.sd || NaN);
      var se = (n > 1 && isFinite(sd)) ? sd / Math.sqrt(n) : relSe("clip") * m;
      clipAt[g.p + "|" + g.role] = m;
      ob.clipLog.push({ day: day, p: g.p, role: g.role, mean: m, se: se, n: n });
      if (S().useClips) kf(g.p, m, se * se, "clip", g.role, day);
    });
    order.forEach(function (k) {
      var g = groups[k]; if (g.type === "clip") return;
      var y = mean(g.vals), c = clipAt[g.p + "|" + g.role];
      if ((g.role === "pre" || g.role === "post") && isFinite(c) && c > 0) (ob.calPairs[g.type] = ob.calPairs[g.type] || []).push(y / c);
      var yAdj = (S().calibrate && ob.calFactor[g.type]) ? y / ob.calFactor[g.type] : y;
      kf(g.p, yAdj, Math.pow(relSe(g.type) * yAdj, 2), g.type, g.role, day);
      ob.lastRead[g.p] = { day: day, y: yAdj, raw: y, role: g.role, type: g.type };
      ob.lastObs.map = { day: day, p: g.p, y: yAdj, raw: y, role: g.role, type: g.type };
      ob.readLog.push({ day: day, p: g.p, y: yAdj, raw: y, role: g.role, type: g.type });
    });
  };
  ob.decide = function (cur, stay, calTarget) {
    var s = S();
    var pts = ob.camSeries.slice(-s.window);
    var f = lsSlope(pts.map(function (q) { return q.day; }), pts.map(function (q) { return q.w; }));
    ob.gHat = f.n >= s.window ? f.slope : NaN; ob.gSe = f.se;
    if (isFinite(ob.gHat)) ob.gMax = isFinite(ob.gMax) ? Math.max(ob.gMax, ob.gHat) : ob.gHat;
    var BhatNow = ob.Bhat[cur];
    var thr = (isFinite(ob.gMax) && ob.gMax > 0) ? (1 - s.delta / 100) * ob.gMax : NaN;
    var grassFire = BhatNow <= s.floor;
    var gainFire = s.mode !== "grass" && isFinite(thr) && isFinite(ob.gHat) && stay >= 1 && ob.gHat <= thr;
    var move = false, fired = null;
    if (s.mode === "calendar") {
      var target = calTarget !== undefined ? calTarget : s.calendarDays;
      if (stay >= target) { move = true; fired = "calendar"; }
    } else {
      if (stay >= s.dmax) { move = true; fired = "max stay"; }
      else if (stay >= s.dmin && (grassFire || gainFire)) { move = true; fired = grassFire ? (gainFire ? "grass and gain" : "grass") : "gain"; }
    }
    return { move: move, fired: fired, grassFire: grassFire, gainFire: gainFire, thr: thr, Bhat: BhatNow, band: 1.96 * Math.sqrt(ob.Pvar[cur]), stay: stay };
  };
  ob.onMove = function () { ob.gMax = NaN; };
  ob.predict = function (cur, head, area) {
    var hf = ob.tempToday === null ? 1 : heatFactor(ob.tempToday, H);
    var Wh = ob.camSeries.length ? ob.camSeries[ob.camSeries.length - 1].w : cfg.initialBW;
    for (var p = 0; p < N; p++) {
      if (!isFinite(ob.Bhat[p])) continue;
      var remHat = p === cur ? head * H.dmiFracBW * Wh * hf * swardFactor(ob.Bhat[p]) * (1 + H.trampleFrac) / area : 0;
      ob.Bhat[p] = Math.max(0, ob.Bhat[p] + ob.rHat - remHat);
      var q = p === cur ? E.removalSdFrac * remHat : 0;
      ob.Pvar[p] += q * q + E.regrowthSd * E.regrowthSd;
    }
  };
  return ob;
}

function newLog() { return { day: [], Btrue: [], Bhat: [], Bband: [], camMean: [], camTrueMean: [], scale: [], gHat: [], gSe: [], gTrue: [], thr: [], paddock: [], temp: [], rec: [] }; }
function logMorning(L, d, ob, dec, cur, extra) {
  L.day.push(d); L.Btrue.push(extra.Btrue); L.Bhat.push(dec.Bhat); L.Bband.push(dec.band);
  L.camMean.push(ob.camToday); L.camTrueMean.push(extra.Wtrue); L.scale.push(extra.scale);
  L.gHat.push(ob.gHat); L.gSe.push(ob.gSe); L.gTrue.push(extra.gTrue); L.thr.push(dec.thr); L.paddock.push(cur); L.temp.push(ob.tempToday);
  L.rec.push(dec.move ? dec.fired : null);
}

// ---------- Simulation: true state plus record generator ----------
function createSim(settings) {
  var S = sanitize(settings), P = BASE, H = P.herd;
  var rng = makeRng(S.seed);
  var rWx = rng.fork("weather"), rPast = rng.fork("pasture"), rHerd = rng.fork("herd"), rSens = rng.fork("sensors"),
      rMap = rng.fork("maps"), rScale = rng.fork("scale"), rPlate = rng.fork("plate"), rVis = rng.fork("visual"), rClip = rng.fork("clips"), rMeas = rng.fork("measured");
  var mMap = NOISE_MULT[S.noiseMap], mCam = NOISE_MULT[S.noiseCamera], mFill = NOISE_MULT[S.noiseFill];
  var weather = null, wxNote = null;
  if (S.weather === "record") {
    var ry = WX.record && S.recordYear ? seasonFromRecord(WX.record, S.recordYear) : null;
    if (ry && ry.usable) { weather = ry.days; wxNote = "record " + S.recordYear; }
    else { wxNote = "no usable record year; average placeholder weather used"; }
  }
  if (!weather) weather = makeWeather(P, S.weather === "record" ? "average" : S.weather, rWx);
  var A = P.areaHa, N = P.paddocks;
  var B = []; for (var p = 0; p < N; p++) B.push(Math.max(300, P.initialBiomass * (1 + rPast.normal(0, P.initialCv))));
  var herd = []; for (var i = 0; i < H.head; i++) herd.push({ id: i, BW: Math.max(150, rHerd.normal(H.initialBW, H.initialBWSd)), gut: 0,
      timidity: rHerd.normal(0, 1), offset: rSens.normal(0, P.camera.animalOffsetSdFrac * mCam) });
  var calBias = rMap.normal(0, P.map.calBiasSd * mMap);
  var plateCal = rPlate.normal(0, P.plate.calBiasSd * mMap), visBias = rVis.normal(0, P.visual.observerBiasSd * mMap);
  var rel = { map: mapRelSe(mMap), plate: plateRelSe(mMap), visual: visualRelSe(mMap), clip: DEFAULT_REL_SE.clip };
  // measured errors (from field records) replace the placeholder model of that sensor; the noise level no longer scales it
  for (var mk in S.measured) if (S.measured[mk]) rel[mk] = Math.sqrt(S.measured[mk].bias * S.measured[mk].bias + S.measured[mk].sd * S.measured[mk].sd);

  var st = {
    source: "sim", settings: S, version: VERSION, day: 0, cur: 0, stay: 0, done: false, N: N, A: A, days: P.seasonDays,
    startDate: (weather[0] && weather[0].date) || P.seasonStartDate, wxNote: wxNote, trueB: B, herd: herd, weather: weather, log: newLog(), moves: [], events: [], lastDecision: null,
    records: [], head: H.head, trueSeries: [], gMaxTrue: NaN,
    hidden: { mapCalBias: calBias, plateCalBias: plateCal, visualBias: visBias }
  };
  var ob = createObserver({ N: N, A: A, head: H.head, initialBW: H.initialBW, regrowthPrior: P.est.regrowthPriorKgHaD, relSe: rel, settings: S });
  st.obs = ob;
  st.setSettings = function (s) { for (var k in s) if (k !== "notes" && k !== "field") S[k] = s[k]; };

  function rec(d, p, type, value, extra) { var r = { day: d, paddock: p, type: type, value: value, animal: null, n: null, sd: null, role: null }; if (extra) for (var k in extra) r[k] = extra[k]; st.records.push(r); return r; }
  function readBio(type, p, role, d) {
    var Bt = st.trueB[p], y, me = S.measured[type];
    if (me) {
      y = Math.max(0, Bt * (1 + me.bias + rMeas.normal(0, me.sd)));
    } else if (type === "map") {
      var M = P.map, fb = rMap.normal(0, M.flightBiasSd * mMap), shared = rMap.normal(0, M.cellSd * Math.sqrt(M.rho) * mMap), n = 0, acc = 0;
      for (var c = 0; c < M.nCells; c++) { if (rMap.bernoulli(M.missingCellProb)) continue; acc += rMap.normal(0, M.cellSd * Math.sqrt(1 - M.rho) * mMap); n++; }
      y = Math.max(0, Bt * (1 + fb + calBias + shared + (n ? acc / n : 0)));
    } else if (type === "plate") {
      var e = rPlate.normal(0, P.plate.passSd * mMap) + (role === "post" ? rPlate.normal(0, P.plate.postExtraSd * mMap) : 0);
      y = Math.max(0, Bt * (1 + plateCal + e));
    } else {
      var V = P.visual, seen = V.center + V.shrink * (Bt - V.center);
      y = Math.max(0, seen * (1 + visBias + rVis.normal(0, V.dailySd * mMap)));
    }
    return rec(d, p, type, y, { role: role });
  }
  function clips(p, role, d) {
    var out = [], C = P.clip;
    for (var q = 0; q < C.quadrats; q++) out.push(rec(d, p, "clip", Math.max(0, st.trueB[p] * (1 + rClip.normal(0, C.spatialCv)) * (1 + rClip.normal(0, C.labSd))), { role: role }));
    return out;
  }
  function openEvent(d) { st.eventOpen = { paddock: st.cur, dayStart: d, preTrue: st.trueB[st.cur] }; }
  function closeEvent(d, reason) {
    var e = st.eventOpen; if (!e) return;
    e.dayEnd = d; e.days = d - e.dayStart; e.postTrue = st.trueB[e.paddock]; e.util = (e.preTrue - e.postTrue) / e.preTrue; e.reason = reason;
    st.events.push(e); st.eventOpen = null;
  }

  st.step = function () {
    if (st.done) return null;
    var d = st.day, wx = weather[d], s = S, sensor = s.bioSensor;
    ob.newDay(d, st.stay);
    if (d === 0) rec(0, st.cur, "move", null);
    var tRec = rec(d, null, "temp", wx.temp), cams = [], scales = [];
    herd.forEach(function (a) {
      var C = P.camera, rate = C.visitsPerDay * (wx.temp > H.heatT ? C.heatVisitMult : 1) * Math.exp(-C.timidityEffect * a.timidity);
      var n = rSens.poisson(rate);
      for (var k = 0; k < n; k++) cams.push(rec(d, null, "camera", a.BW * (1 + a.offset) + a.gut + rSens.normal(0, C.visitSdFrac * mCam * a.BW), { animal: a.id }));
    });
    if (d % P.scaleEveryDays === 0 || d === P.seasonDays - 1) herd.forEach(function (a) { scales.push(rec(d, null, "scale", a.BW + a.gut + rScale.normal(0, P.scale.sdKg), { animal: a.id })); });
    ob.ingestWeights(d, cams, scales, tRec.value);
    var batch = [];
    if (d === 0) {
      batch.push(readBio(sensor, st.cur, "pre", d)); batch = batch.concat(clips(st.cur, "pre", d));
      for (var q = 0; q < N; q++) if (q !== st.cur) batch.push(readBio(sensor, q, "rest", d));
      openEvent(d);
    } else if (sensor === "visual") batch.push(readBio("visual", st.cur, "mid", d));
    else if (st.stay === 2) batch.push(readBio(sensor, st.cur, "mid", d));
    ob.ingestBiomass(d, batch);

    var calTarget = st.calTarget ? st.calTarget(st.moves.length) : undefined;
    var dec = ob.decide(st.cur, st.stay, calTarget);

    var Wt = mean(herd.map(function (a) { return a.BW; }));
    st.trueSeries.push({ day: d, w: Wt });
    var tp = st.trueSeries.slice(-s.window), tf = lsSlope(tp.map(function (x) { return x.day; }), tp.map(function (x) { return x.w; }));
    var gTrue = tf.n >= s.window ? tf.slope : NaN;
    if (st.stay === 0) st.gMaxTrue = NaN;
    if (isFinite(gTrue)) st.gMaxTrue = isFinite(st.gMaxTrue) ? Math.max(st.gMaxTrue, gTrue) : gTrue;
    var trueThr = (isFinite(st.gMaxTrue) && st.gMaxTrue > 0) ? (1 - s.delta / 100) * st.gMaxTrue : NaN;
    var trueNeed = st.trueB[st.cur] <= s.floor || (s.mode !== "grass" && isFinite(trueThr) && isFinite(gTrue) && st.stay >= 1 && gTrue <= trueThr);
    var wrong = null;
    if (dec.move && dec.fired !== "max stay" && dec.fired !== "calendar" && !trueNeed) wrong = "false";
    if (!dec.move && trueNeed && st.stay >= s.dmin) wrong = "missed";
    dec.day = d; dec.wrong = wrong; st.lastDecision = dec;
    logMorning(st.log, d, ob, dec, st.cur, { Btrue: st.trueB[st.cur], Wtrue: Wt, gTrue: gTrue, scale: scales.length ? mean(scales.map(function (x) { return x.value; })) : null });

    if (dec.move) {
      ob.ingestBiomass(d, [readBio(sensor, st.cur, "post", d)].concat(clips(st.cur, "post", d)));
      closeEvent(d, dec.fired);
      if (wrong === "false") st.events[st.events.length - 1].falseMove = true;
      st.moves.push({ day: d, from: st.cur, to: (st.cur + 1) % N, fired: dec.fired, stay: st.stay, wrong: wrong });
      st.cur = (st.cur + 1) % N; st.stay = 0; ob.onMove(); st.gMaxTrue = NaN;
      rec(d, st.cur, "move", null);
      ob.ingestBiomass(d, [readBio(sensor, st.cur, "pre", d)].concat(clips(st.cur, "pre", d)));
      openEvent(d);
    } else if (wrong === "missed") { st.eventOpen.missed = (st.eventOpen.missed || 0) + 1; }

    var tdn = tdnOf(st.trueB[st.cur], P.grass), hf = heatFactor(wx.temp, H), sf = swardFactor(st.trueB[st.cur]);
    var want = 0; herd.forEach(function (a) { a.want = H.dmiFracBW * a.BW * hf * sf; want += a.want; });
    var availKg = Math.max(0, st.trueB[st.cur] - P.Bmin) * A;
    var scaleI = want * (1 + H.trampleFrac) > availKg ? availKg / (want * (1 + H.trampleFrac)) : 1, intakeKg = 0;
    herd.forEach(function (a) {
      var I = a.want * scaleI; intakeKg += I;
      a.BW = Math.max(100, a.BW + gainFromIntake(I, tdn, a.BW, H));
      a.gut = H.gutFillAr1 * a.gut + rHerd.normal(0, H.gutFillSdFrac * mFill * a.BW * Math.sqrt(1 - H.gutFillAr1 * H.gutFillAr1));
    });
    for (var p2 = 0; p2 < N; p2++) {
      var gr = growth(st.trueB[p2], wx, P), rem = p2 === st.cur ? intakeKg * (1 + H.trampleFrac) / A : 0;
      st.trueB[p2] = Math.max(0, st.trueB[p2] + gr.G - gr.S - rem);
    }
    st.lastDay = { intakePerHead: intakeKg / H.head, tdn: tdn, temp: wx.temp, fW: wx.fW };
    ob.predict(st.cur, H.head, A);
    st.day++; st.stay++;
    if (st.day >= P.seasonDays) { closeEvent(st.day, "season end"); st.done = true; }
    return dec;
  };
  st.run = function () { while (!st.done) st.step(); return st; };
  st.score = function () { return scoreSim(st); };
  return st;
}

function scoreSim(st) {
  var P = BASE, ev = st.events.filter(function (e) { return e.days > 0; });
  var gain = mean(st.herd.map(function (a) { return a.BW; })) * P.herd.head - (st.trueSeries[0].w * P.herd.head);
  var nFalse = st.moves.filter(function (m) { return m.wrong === "false"; }).length;
  var nMissedEv = ev.filter(function (e) { return e.missed; }).length;
  return {
    events: ev.length, meanStay: mean(ev.map(function (e) { return e.days; })),
    residual: mean(ev.map(function (e) { return e.postTrue; })),
    minResidual: Math.min.apply(null, ev.map(function (e) { return e.postTrue; })),
    util: mean(ev.map(function (e) { return e.util; })),
    gainPerHa: gain / (P.paddocks * P.areaHa), adg: gain / P.herd.head / P.seasonDays,
    falseMoves: nFalse, missedEvents: nMissedEv, wrongMoves: nFalse + nMissedEv,
    triggers: st.moves.reduce(function (o, m) { o[m.fired] = (o[m.fired] || 0) + 1; return o; }, {})
  };
}
function compare(settings) {
  var s1 = sanitize(settings); s1.mode = "dual";
  var sa = scoreSim(createSim(s1).run());
  var s2 = sanitize(settings); s2.mode = "calendar";
  var b = createSim(s2), mstay = sa.meanStay;
  b.calTarget = function (j) { return Math.max(1, Math.round((j + 1) * mstay) - Math.round(j * mstay)); };
  return { dual: sa, calendar: scoreSim(b.run()), meanStay: mstay };
}
function compareSensors(settings) {
  var out = {};
  Object.keys(BIO_SENSORS).forEach(function (k) { var s = sanitize(settings); s.mode = "dual"; s.bioSensor = k; out[k] = scoreSim(createSim(s).run()); });
  return out;
}

// ---------- Field data: CSV parse, export, and replay ----------
var TYPES = { clip: "bio", uav: "bio", rover: "bio", map: "bio", plate: "bio", visual: "bio", camera: "wt", scale: "wt", move: "move", temp: "temp" };
var ROLES = { pre: 1, mid: 1, post: 1, rest: 1 };
var CSV_COLUMNS = ["date", "paddock", "type", "value", "unit", "animal", "n", "sd", "role", "note"];
function splitCsvLine(line) {
  var out = [], cur = "", q = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (q) { if (ch === "\"") { if (line[i + 1] === "\"") { cur += "\""; i++; } else q = false; } else cur += ch; }
    else if (ch === "\"") q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out.map(function (x) { return x.trim(); });
}
function dayDiff(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
function addDays(iso, n) { var t = new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000); return t.toISOString().slice(0, 10); }
function parseCSV(text) {
  var lines = String(text || "").replace(/\r/g, "").split("\n"), errors = [], warnings = [], rows = [];
  var hi = -1; for (var i = 0; i < lines.length; i++) if (lines[i].trim() && lines[i].trim()[0] !== "#") { hi = i; break; }
  if (hi < 0) return { records: [], errors: ["No data. Paste CSV text with a header row."], warnings: [], startDate: null, counts: {} };
  var head = splitCsvLine(lines[hi]).map(function (h) { return h.toLowerCase(); }), col = {};
  CSV_COLUMNS.forEach(function (c) { col[c] = head.indexOf(c); });
  ["date", "type"].forEach(function (c) { if (col[c] < 0) errors.push("Missing column: " + c + "."); });
  if (errors.length) return { records: [], errors: errors, warnings: warnings, startDate: null, counts: {} };
  var isoRe = /^\d{4}-\d{2}-\d{2}$/, anyIso = false, anyNum = false;
  for (i = hi + 1; i < lines.length; i++) {
    var L = lines[i]; if (!L.trim() || L.trim()[0] === "#") continue;
    var c = splitCsvLine(L), ln = i + 1;
    var get = (function (cc) { return function (k) { return col[k] >= 0 && col[k] < cc.length ? cc[col[k]] : ""; }; })(c);
    var type = get("type").toLowerCase(), dateS = get("date");
    if (!TYPES[type]) { errors.push("Line " + ln + ": unknown type \"" + type + "\". Use one of: " + Object.keys(TYPES).join(", ") + "."); continue; }
    if (isoRe.test(dateS)) anyIso = true; else if (/^-?\d+$/.test(dateS)) anyNum = true; else { errors.push("Line " + ln + ": date must be YYYY-MM-DD or a day number."); continue; }
    var pS = get("paddock").replace(/^p/i, ""), pad = pS === "" ? null : Number(pS);
    if (pad !== null && (!isFinite(pad) || pad < 1 || Math.round(pad) !== pad)) { errors.push("Line " + ln + ": paddock must be a whole number from 1 (P1 also works)."); continue; }
    var kind = TYPES[type], unit = get("unit").toLowerCase(), vS = get("value"), val = vS === "" ? null : Number(vS);
    if ((kind === "bio" || kind === "move") && pad === null) { errors.push("Line " + ln + ": " + type + " needs a paddock."); continue; }
    if (kind !== "move" && (val === null || !isFinite(val))) { errors.push("Line " + ln + ": value is missing or not a number."); continue; }
    if (kind === "bio") { if (unit === "lb/ac") val *= 1.12085; else if (unit && unit !== "kg/ha") { errors.push("Line " + ln + ": biomass unit must be kg/ha or lb/ac."); continue; } if (val < 0) { errors.push("Line " + ln + ": negative biomass."); continue; } }
    if (kind === "wt") { if (unit === "lb") val *= 0.453592; else if (unit && unit !== "kg") { errors.push("Line " + ln + ": weight unit must be kg or lb."); continue; } }
    if (kind === "temp") { if (unit === "f") val = (val - 32) / 1.8; else if (unit && unit !== "c") { errors.push("Line " + ln + ": temperature unit must be C or F."); continue; } }
    var role = get("role").toLowerCase(); if (role && !ROLES[role]) { errors.push("Line " + ln + ": role must be pre, mid, post, rest, or blank."); continue; }
    var nS = get("n"), sdS = get("sd");
    rows.push({ dateS: dateS, paddock: pad === null ? null : pad - 1, type: type, value: val, animal: get("animal") || null,
      n: nS ? Number(nS) : null, sd: sdS ? Number(sdS) : null, role: role || null, line: ln });
  }
  if (anyIso && anyNum) { errors.push("Dates mix YYYY-MM-DD and day numbers. Use one style."); return { records: [], errors: errors, warnings: warnings, startDate: null, counts: {} }; }
  var startDate = null;
  if (anyIso) { startDate = rows.map(function (r) { return r.dateS; }).sort()[0]; rows.forEach(function (r) { r.day = dayDiff(startDate, r.dateS); }); }
  else if (rows.length) { var d0 = Math.min.apply(null, rows.map(function (r) { return Number(r.dateS); })); rows.forEach(function (r) { r.day = Number(r.dateS) - d0; }); }
  rows.forEach(function (r) { delete r.dateS; });
  rows.sort(function (a, b) { return a.day - b.day || a.line - b.line; });
  if (rows.length && !rows.some(function (r) { return r.type === "move" && r.day === 0; })) errors.push("Add a move row on the first day that says which paddock the herd starts in.");
  var byType = {}; rows.forEach(function (r) { byType[r.type] = (byType[r.type] || 0) + 1; });
  if (rows.length && !byType.camera && !byType.scale) warnings.push("No camera or scale weights: the gain trigger cannot run.");
  if (rows.length && !(byType.uav || byType.rover || byType.map || byType.plate || byType.visual)) warnings.push("No biomass sensor readings: only clips, if used in the estimator, can inform it.");
  return { records: rows, errors: errors, warnings: warnings, startDate: startDate, counts: byType };
}
// ---------- Historical daily weather ----------
// Accepts (a) NOAA GHCN-Daily CSV as downloaded from NCEI (quoted columns, DATE plus TMAX, TMIN, PRCP,
// optional TAVG and NAME), or (b) a plain file with columns date, tmax, tmin, rain (optional tavg).
// Units: "auto" detects from midsummer TMAX: about 20 to 40 is metric (C, mm), 60 to 110 is standard (F, in),
// 150 to 450 is GHCN raw tenths (0.1 C, 0.1 mm). The season is Apr 1 to Oct 31 of each year.
var WX = { record: null };
function parseWeatherCSV(text, units) {
  var lines = String(text || "").replace(/\r/g, "").split("\n"), out = { rows: [], errors: [], station: null, units: null, detected: null };
  var hi = -1; for (var i = 0; i < lines.length; i++) if (lines[i].trim() && lines[i].trim()[0] !== "#") { hi = i; break; }
  if (hi < 0) { out.errors.push("No data found."); return out; }
  var head = splitCsvLine(lines[hi]).map(function (h) { return h.toLowerCase().trim(); });
  var ix = function (names) { for (var k = 0; k < names.length; k++) { var j = head.indexOf(names[k]); if (j >= 0) return j; } return -1; };
  var cD = ix(["date"]), cX = ix(["tmax"]), cN = ix(["tmin"]), cA = ix(["tavg"]), cP = ix(["prcp", "rain", "precip"]), cS = ix(["station"]), cNm = ix(["name"]);
  if (cD < 0) out.errors.push("Missing column: DATE.");
  if (cP < 0) out.errors.push("Missing column: PRCP (or rain).");
  if (cX < 0 && cA < 0) out.errors.push("Missing temperature: TMAX and TMIN, or TAVG.");
  if (out.errors.length) return out;
  var num = function (v) { if (v === undefined) return null; v = String(v).trim(); if (v === "" || v === "-9999" || /^[MT]$/i.test(v)) return v.toUpperCase() === "T" ? 0 : null; var n = Number(v); return isFinite(n) ? n : null; };
  for (i = hi + 1; i < lines.length; i++) {
    var L = lines[i]; if (!L.trim() || L.trim()[0] === "#") continue;
    var c = splitCsvLine(L), dS = (c[cD] || "").trim();
    if (/^\d{8}$/.test(dS)) dS = dS.slice(0, 4) + "-" + dS.slice(4, 6) + "-" + dS.slice(6, 8);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dS)) continue;
    if (!out.station && cS >= 0) out.station = (c[cS] || "").trim() + (cNm >= 0 && c[cNm] ? ", " + c[cNm].trim() : "");
    out.rows.push({ date: dS, tmax: cX >= 0 ? num(c[cX]) : null, tmin: cN >= 0 ? num(c[cN]) : null, tavg: cA >= 0 ? num(c[cA]) : null, prcp: num(c[cP]) });
  }
  if (!out.rows.length) { out.errors.push("No rows with a YYYY-MM-DD date."); return out; }
  out.rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var summer = out.rows.filter(function (r) { var m = Number(r.date.slice(5, 7)); return m >= 6 && m <= 8 && r.tmax !== null; }).map(function (r) { return r.tmax; });
  if (!summer.length) summer = out.rows.filter(function (r) { return r.tavg !== null; }).map(function (r) { return r.tavg + 8; });
  var med = median(summer), det = med >= 150 ? "tenths" : med >= 55 ? "standard" : "metric";
  out.detected = det; out.medianSummerTmax = med; out.units = (units && units !== "auto") ? units : det;
  var toC = out.units === "standard" ? function (v) { return (v - 32) / 1.8; } : out.units === "tenths" ? function (v) { return v / 10; } : function (v) { return v; };
  var toMm = out.units === "standard" ? function (v) { return v * 25.4; } : out.units === "tenths" ? function (v) { return v / 10; } : function (v) { return v; };
  out.rows.forEach(function (r) {
    ["tmax", "tmin", "tavg"].forEach(function (k) { if (r[k] !== null) r[k] = toC(r[k]); });
    if (r.prcp !== null) r.prcp = toMm(r.prcp);
    r.temp = (r.tmax !== null && r.tmin !== null) ? (r.tmax + r.tmin) / 2 : r.tavg;
    if (r.temp !== null && (r.temp < -40 || r.temp > 50)) r.temp = null;
    if (r.prcp !== null && (r.prcp < 0 || r.prcp > 500)) r.prcp = null;
  });
  var byDate = {}; out.rows.forEach(function (r) { byDate[r.date] = r; });
  out.byDate = byDate;
  var y0 = Number(out.rows[0].date.slice(0, 4)), y1 = Number(out.rows[out.rows.length - 1].date.slice(0, 4));
  out.years = [];
  for (var y = y0; y <= y1; y++) { var sy = seasonFromRecord(out, y); if (sy.nPresent > 0) out.years.push(sy.summary); }
  return out;
}
function seasonFromRecord(rec, year) {
  var P = BASE, S = P.weather.soil, start = year + "-04-01", days = [], sw = S.fieldCapacityMm * 0.8;
  var missT = 0, missP = 0, present = 0, temps = [];
  for (var d = 0; d < P.seasonDays; d++) { var r = rec.byDate[addDays(start, d)]; temps.push(r && r.temp !== null ? r.temp : null); if (r) present++; }
  // fill temperature gaps by linear interpolation (ends: nearest value)
  for (d = 0; d < temps.length; d++) if (temps[d] === null) {
    missT++; var a = d - 1, b = d + 1; while (b < temps.length && temps[b] === null) b++;
    var va = a >= 0 ? temps[a] : null, vb = b < temps.length ? temps[b] : null;
    temps[d] = va === null ? vb : vb === null ? va : va + (vb - va) * (d - a) / (b - a);
  }
  var rainTot = 0, heat = 0, run = 0, maxDry = 0;
  for (d = 0; d < P.seasonDays; d++) {
    var date = addDays(start, d), r2 = rec.byDate[date], rain = r2 && r2.prcp !== null ? r2.prcp : null;
    if (rain === null) { missP++; rain = 0; }
    var temp = temps[d] === null ? normalTemp(P.seasonStartDoy + d) : temps[d];
    sw = clamp(sw + rain - S.etPerDegC * Math.max(temp, 0), 0, S.fieldCapacityMm);
    days.push({ day: d, doy: P.seasonStartDoy + d, date: date, temp: temp, rain: rain, fW: clamp((sw - S.wiltingMm) / (S.fieldCapacityMm - S.wiltingMm), 0, 1) });
    rainTot += rain; if (temp > P.herd.heatT) heat++;
    run = rain < 1 ? run + 1 : 0; if (run > maxDry) maxDry = run;
  }
  var usable = present > 0 && missT <= 0.1 * P.seasonDays && missP <= 0.1 * P.seasonDays;
  return { days: days, usable: usable, nPresent: present, summary: { year: year, usable: usable, missingTemp: missT, missingRain: missP,
    rainMm: rainTot, meanTempC: mean(days.map(function (x) { return x.temp; })), hotDays: heat, longestDrySpell: maxDry,
    meanSoilWater: mean(days.map(function (x) { return x.fW; })) } };
}
function setWeatherRecord(rec) { WX.record = rec && !rec.errors.length ? rec : null; return WX.record; }
// Run every usable record year: dual trigger and a calendar with the same mean stay.
function runYears(settings) {
  if (!WX.record) return [];
  return WX.record.years.filter(function (y) { return y.usable; }).map(function (y) {
    var s = sanitize(settings); s.weather = "record"; s.recordYear = y.year;
    var c = compare(s);
    return { year: y.year, wx: y, dual: c.dual, calendar: c.calendar, meanStay: c.meanStay };
  });
}
// Monthly mean temperature and rain over usable years, against the placeholder curve.
function recordNormals() {
  if (!WX.record) return null;
  var ys = WX.record.years.filter(function (y) { return y.usable; }).map(function (y) { return y.year; });
  var out = [];
  for (var m = 4; m <= 10; m++) {
    var t = [], rain = [];
    ys.forEach(function (y) { var sd = seasonFromRecord(WX.record, y).days.filter(function (x) { return Number(x.date.slice(5, 7)) === m; });
      t.push(mean(sd.map(function (x) { return x.temp; }))); rain.push(sd.reduce(function (a, x) { return a + x.rain; }, 0)); });
    var doyMid = [0, 15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][m];
    out.push({ month: m, recordTempC: mean(t), placeholderTempC: normalTemp(doyMid), recordRainMm: mean(rain), placeholderRainMm: BASE.weather.rainProbability * BASE.weather.rainMeanMm * [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m] });
  }
  return { years: ys.length, months: out };
}
// Sensor error against clips, from parsed field records. A sensor reading is paired with the clip
// quadrats of the same paddock and day. Relative error e = (y - c) / c, c = clip mean.
// sdNet removes the clip mean's own sampling variance, so it estimates the sensor's error alone.
var SIM_SENSOR_OF = { uav: "map", rover: "map", map: "map", plate: "plate", visual: "visual" };
function sensorErrors(records) {
  var clips = {}, key = function (r) { return r.paddock + "|" + r.day; };
  records.forEach(function (r) {
    if (r.type !== "clip") return;
    var k = key(r), g = clips[k] = clips[k] || { vals: [], means: [] };
    if (r.n && r.n > 1) g.means.push({ m: r.value, n: r.n, sd: r.sd }); else g.vals.push(r.value);
  });
  var ref = {};
  for (var k in clips) {
    var g = clips[k], m, se;
    if (g.vals.length >= 2) { m = mean(g.vals); se = sdOf(g.vals) / Math.sqrt(g.vals.length); }
    else if (g.means.length) { var gm = g.means[0]; m = gm.m; se = isFinite(gm.sd) && gm.sd !== null ? gm.sd / Math.sqrt(gm.n) : NaN; }
    else continue;
    if (m > 0) ref[k] = { m: m, seRel: se / m, n: g.vals.length || (g.means[0] && g.means[0].n) };
  }
  var out = {};
  records.forEach(function (r) {
    if (TYPES[r.type] !== "bio" || r.type === "clip") return;
    var c = ref[key(r)]; if (!c) return;
    var o = out[r.type] = out[r.type] || { type: r.type, e: [], seRel2: [], pairs: [] };
    o.e.push((r.value - c.m) / c.m); o.seRel2.push(isFinite(c.seRel) ? c.seRel * c.seRel : 0);
    o.pairs.push({ day: r.day, paddock: r.paddock, y: r.value, clip: c.m, nClip: c.n });
  });
  var res = [];
  for (var t in out) {
    var o2 = out[t], n = o2.e.length, bias = mean(o2.e), sdRaw = n > 1 ? sdOf(o2.e) : NaN;
    var clipVar = mean(o2.seRel2), sdNet = isFinite(sdRaw) ? Math.sqrt(Math.max(0, sdRaw * sdRaw - clipVar)) : NaN;
    var rmse = Math.sqrt(mean(o2.e.map(function (x) { return x * x; })));
    res.push({ type: t, simSensor: SIM_SENSOR_OF[t], n: n, bias: bias, sdRaw: sdRaw, sdNet: sdNet, clipSeRel: Math.sqrt(clipVar), rmse: rmse, pairs: o2.pairs });
  }
  res.sort(function (a, b) { return ["uav", "rover", "map", "plate", "visual"].indexOf(a.type) - ["uav", "rover", "map", "plate", "visual"].indexOf(b.type); });
  return res;
}
function csvCell(v) { if (v === null || v === undefined) return ""; var s = String(v); return /[",]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s; }
function exportCSV(records, startDate, exact) {
  var lines = ["# grazing-control-sim record file. Biomass in kg DM/ha, weights in kg, temperature in C. Paddocks start at 1.", CSV_COLUMNS.join(",")];
  records.forEach(function (r) {
    var kind = TYPES[r.type], unit = kind === "bio" ? "kg/ha" : kind === "wt" ? "kg" : kind === "temp" ? "C" : "";
    var val = r.value === null ? "" : exact ? String(r.value) : (kind === "wt" || kind === "temp" ? r.value.toFixed(2) : r.value.toFixed(1));
    lines.push([startDate ? addDays(startDate, r.day) : r.day, r.paddock === null ? "" : r.paddock + 1, r.type, val, unit,
      r.animal === null ? "" : r.animal, r.n || "", r.sd || "", r.role || "", ""].map(csvCell).join(","));
  });
  return lines.join("\n") + "\n";
}

// Replay field records through the same observer. The herd's paddock follows the move rows.
// Each morning the rule gives a recommendation; the log compares it with what was done.
function createFieldRun(parsed, settings) {
  var S = sanitize(settings), F = S.field, recs = parsed.records;
  var maxP = recs.reduce(function (m, r) { return r.paddock !== null ? Math.max(m, r.paddock + 1) : m; }, 0);
  var N = Math.max(F.paddocks, maxP), A = F.areaAc * 0.404686;
  var lastDay = recs.length ? recs[recs.length - 1].day : 0;
  var byDay = {}; recs.forEach(function (r) { (byDay[r.day] = byDay[r.day] || []).push(r); });
  var ob = createObserver({ N: N, A: A, head: F.head, initialBW: F.initialBW, regrowthPrior: F.regrowthPrior, relSe: F.relSe, settings: S });
  var first = (byDay[0] || []).filter(function (r) { return r.type === "move"; })[0];
  var st = { source: "field", settings: S, version: VERSION, day: 0, cur: first ? first.paddock : 0, stay: 0, done: recs.length === 0, N: N, A: A,
    obs: ob, log: newLog(), moves: [], events: [], recs: [], lastDecision: null, days: lastDay + 1, startDate: parsed.startDate, head: F.head, trueB: null };
  st.setSettings = function (s) { for (var k in s) if (k !== "notes" && k !== "field") S[k] = s[k]; };
  st.eventOpen = { paddock: st.cur, dayStart: 0 };
  st.step = function () {
    if (st.done) return null;
    var d = st.day, today = byDay[d] || [];
    ob.newDay(d, st.stay);
    var mv = today.filter(function (r) { return r.type === "move"; }), moveTo = (d > 0 && mv.length) ? mv[mv.length - 1].paddock : null;
    if (moveTo === st.cur) moveTo = null;
    var tRow = today.filter(function (r) { return r.type === "temp"; })[0];
    ob.ingestWeights(d, today.filter(function (r) { return r.type === "camera"; }), today.filter(function (r) { return r.type === "scale"; }), tRow ? tRow.value : null);
    var bio = today.filter(function (r) { return TYPES[r.type] === "bio"; }).map(function (r) {
      var role = r.role;
      if (!role) role = (moveTo !== null && r.paddock === st.cur) ? "post" : (moveTo !== null && r.paddock === moveTo) ? "pre" : (d === 0 && r.paddock === st.cur) ? "pre" : r.paddock === st.cur ? "mid" : "rest";
      return { paddock: r.paddock, type: r.type, value: r.value, n: r.n, sd: r.sd, role: role };
    });
    ob.ingestBiomass(d, bio.filter(function (r) { return r.role !== "post" && !(r.role === "pre" && d > 0); }));
    var dec = ob.decide(st.cur, st.stay);
    dec.day = d; dec.wrong = null; st.lastDecision = dec;
    var sc = today.filter(function (r) { return r.type === "scale"; });
    logMorning(st.log, d, ob, dec, st.cur, { Btrue: NaN, Wtrue: NaN, gTrue: NaN, scale: sc.length ? mean(sc.map(function (x) { return x.value; })) : null });
    ob.ingestBiomass(d, bio.filter(function (r) { return r.role === "post"; }));
    if (moveTo !== null) {
      st.moves.push({ day: d, from: st.cur, to: moveTo, fired: dec.move ? dec.fired : "manual", stay: st.stay, agreed: dec.move, wrong: null });
      st.events.push({ paddock: st.cur, dayStart: st.eventOpen.dayStart, dayEnd: d, days: d - st.eventOpen.dayStart });
      st.cur = moveTo; st.stay = 0; ob.onMove(); st.eventOpen = { paddock: st.cur, dayStart: d };
      ob.ingestBiomass(d, bio.filter(function (r) { return r.role === "pre" && d > 0; }));
    } else if (dec.move) st.recs.push({ day: d, paddock: st.cur, fired: dec.fired, stay: st.stay });
    ob.predict(st.cur, F.head, A);
    st.day++; st.stay++;
    if (st.day > lastDay) st.done = true;
    return dec;
  };
  st.run = function () { while (!st.done) st.step(); return st; };
  return st;
}

var api = { VERSION: VERSION, BASE: BASE, DEFAULT_SETTINGS: DEFAULT_SETTINGS, LIMITS: LIMITS, FIELD_LIMITS: FIELD_LIMITS, NOISE_MULT: NOISE_MULT,
  BIO_SENSORS: BIO_SENSORS, DEFAULT_REL_SE: DEFAULT_REL_SE, TYPES: TYPES, CSV_COLUMNS: CSV_COLUMNS,
  sanitize: sanitize, createSim: createSim, createFieldRun: createFieldRun, compare: compare, compareSensors: compareSensors, scoreSim: scoreSim,
  parseCSV: parseCSV, exportCSV: exportCSV, sensorErrors: sensorErrors, parseWeatherCSV: parseWeatherCSV, seasonFromRecord: seasonFromRecord,
  setWeatherRecord: setWeatherRecord, runYears: runYears, recordNormals: recordNormals, WX: WX, SIM_SENSOR_OF: SIM_SENSOR_OF, addDays: addDays, normalTemp: normalTemp };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GCS = api;
})(this);
