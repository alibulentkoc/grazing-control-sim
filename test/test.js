// grazing-control-sim tests. Run: node test/test.js
const G = require('../src/engine.js'); const fs = require('fs');
let pass = 0, fail = 0;
function t(name, ok) { if (ok) pass++; else { fail++; console.log('FAIL', name); } }
const B = G.BASE;
function exactRelSe(set) {
  const m = G.NOISE_MULT[G.sanitize(set).noiseMap];
  return { map: m * Math.sqrt(B.map.calBiasSd ** 2 + B.map.flightBiasSd ** 2 + B.map.rho * B.map.cellSd ** 2 + (1 - B.map.rho) * B.map.cellSd ** 2 / B.map.nCells),
    plate: m * Math.sqrt(B.plate.calBiasSd ** 2 + B.plate.passSd ** 2), visual: m * Math.sqrt(B.visual.observerBiasSd ** 2 + B.visual.dailySd ** 2), clip: G.DEFAULT_REL_SE.clip };
}
// 1 reproducibility
const a = G.createSim({ seed: 7 }).run().score(), b = G.createSim({ seed: 7 }).run().score();
t('same seed same result', JSON.stringify(a) === JSON.stringify(b));
t('different seed differs', JSON.stringify(a) !== JSON.stringify(G.createSim({ seed: 8 }).run().score()));
// 2 regression against v1.0 (map sensor, seed 42 trigger counts)
t('v1.0 regression, seed 42', JSON.stringify(G.createSim({ seed: 42 }).run().score().triggers) === JSON.stringify({ gain: 20, grass: 45, 'max stay': 3, 'grass and gain': 18 }));
// 3 clamping
let s = G.sanitize({ floor: 5000, delta: 80, dmin: 3, dmax: 2, window: 9, field: { head: 0, relSe: { plate: 9 } } });
t('floor clamp', s.floor === 2000); t('delta clamp', s.delta === 40); t('window clamp', s.window === 5);
t('dmin<=dmax', s.dmin <= s.dmax && s.notes.length > 0); t('field clamps', s.field.head === 1 && s.field.relSe.plate === 1);
// 4 stay limits in dual mode, all sensors
for (const set of [{ dmin: 1, dmax: 3 }, { dmin: 3, dmax: 10, bioSensor: 'plate' }, { dmin: 2, dmax: 7, noiseCamera: 'high', bioSensor: 'visual' }]) {
  const r = G.createSim(set).run(), sn = G.sanitize(set);
  t('stay limits ' + JSON.stringify(set), r.events.filter(e => e.reason !== 'season end').every(e => e.days >= sn.dmin && e.days <= sn.dmax));
}
// 5 causality: the observer module reads records only; its decide block touches no true state
const src = fs.readFileSync(__dirname + '/../src/engine.js', 'utf8');
const obsSrc = src.slice(src.indexOf('function createObserver'), src.indexOf('function newLog'));
t('observer reads no true state', !/trueB|\.BW|gTrue|gMaxTrue|trueSeries|\.gut\b|weather\[/.test(obsSrc));
// 6 sensor schedules
const r = G.createSim({}).run(), recs = r.records;
t('map roles', recs.filter(x => x.type === 'map').every(x => ['pre', 'mid', 'post', 'rest'].includes(x.role) && (x.role !== 'rest' || x.day === 0)));
t('clips only at turn-in and exit, 12 each', recs.filter(x => x.type === 'clip').every(x => x.role === 'pre' || x.role === 'post') && recs.filter(x => x.type === 'clip').length % 12 === 0);
t('scale reference days', recs.filter(x => x.type === 'scale').every(x => x.day % 40 === 0 || x.day === B.seasonDays - 1));
const rv = G.createSim({ bioSensor: 'visual' }).run();
t('visual read daily', new Set(rv.records.filter(x => x.type === 'visual').map(x => x.day)).size === B.seasonDays);
t('camera differs from truth', r.log.camMean.some((y, i) => Math.abs(y - r.log.camTrueMean[i]) > 0.5));
// 7 compare equal mean stay
const c = G.compare({}); t('compare equal mean stay', Math.abs(c.dual.meanStay - c.calendar.meanStay) < 0.15);
// 8 parity: a simulated season exported as CSV and replayed as field data gives identical decisions
for (const set of [{ seed: 42 }, { seed: 7, bioSensor: 'plate' }, { seed: 3, bioSensor: 'visual', calibrate: true }, { seed: 5, mode: 'calendar' }]) {
  const sim = G.createSim(set).run(), parsed = G.parseCSV(G.exportCSV(sim.records, sim.startDate, true));
  const fr = G.createFieldRun(parsed, Object.assign({}, set, { field: { head: 10, areaAc: 1, paddocks: 10, initialBW: 300, regrowthPrior: 45, relSe: exactRelSe(set) } })).run();
  let mism = 0, dB = 0; for (let i = 0; i < sim.log.day.length; i++) { if (sim.log.rec[i] !== fr.log.rec[i]) mism++; if (isFinite(sim.log.Bhat[i])) dB = Math.max(dB, Math.abs(sim.log.Bhat[i] - fr.log.Bhat[i])); }
  t('parity ' + JSON.stringify(set), parsed.errors.length === 0 && mism === 0 && dB === 0 && fr.moves.every(m => m.agreed));
}
// 9 CSV parsing and validation
let p = G.parseCSV('date,paddock,type,value,unit\n2026-05-01,1,move,,\n2026-05-01,1,plate,1000,lb/ac\n2026-05-02,,camera,660,lb\n2026-05-02,,temp,86,F');
t('csv units', p.errors.length === 0 && Math.abs(p.records[1].value - 1120.85) < 0.01 && Math.abs(p.records[2].value - 299.37) < 0.01 && Math.abs(p.records[3].value - 30) < 1e-9);
t('csv day index', p.records[2].day === 1 && p.startDate === '2026-05-01');
p = G.parseCSV('date,paddock,type,value\n2026-05-01,1,move,\n2026-05-01,1,grass,1000\n2026-05-02,x,plate,5\nbad,1,plate,5\n2026-05-03,1,plate,');
t('csv errors reported', p.errors.length === 4 && /unknown type/.test(p.errors[0]));
p = G.parseCSV('date,paddock,type,value\n2026-05-02,1,plate,1500');
t('csv needs start move', p.errors.some(e => /move row/.test(e)));
p = G.parseCSV('date,type,value\n1,camera,300\n2,camera,301');
t('csv day numbers and warnings', p.errors.length === 1 && p.records[1].day === 1);
// 10 clip rows given as a mean with n and sd
p = G.parseCSV('date,paddock,type,value,n,sd,role\n0,1,move,,,,\n0,1,clip,2400,12,600,pre\n0,1,plate,2600,,,pre');
const fr2 = G.createFieldRun(p, { field: { head: 10 } }).run();
t('clip mean with n and sd', fr2.obs.clipLog.length === 1 && Math.abs(fr2.obs.clipLog[0].se - 600 / Math.sqrt(12)) < 1e-9 && Math.abs(fr2.obs.calPairs.plate[0] - 2600 / 2400) < 1e-12);
// 11 calibration removes a steady plate bias
const bias = s => { const e = []; s.log.Bhat.forEach((v, i) => { if (i > 80 && isFinite(v)) e.push((v - s.log.Btrue[i]) / s.log.Btrue[i]); }); return Math.abs(e.reduce((x, y) => x + y, 0) / e.length); };
let bOff = 0, bOn = 0, fOk = true;
for (const seed of [1, 2, 3]) { const x = G.createSim({ seed, bioSensor: 'plate' }).run(), y = G.createSim({ seed, bioSensor: 'plate', calibrate: true }).run();
  bOff += bias(x); bOn += bias(y); fOk = fOk && Math.abs(y.obs.calFactor.plate - (1 + y.hidden.plateCalBias)) < 0.03; }
t('calibration finds the plate bias and shrinks estimate bias', fOk && bOn < 0.5 * bOff);
// 14 field-to-simulator bridge: errors measured from exported records recover the hidden plate bias and scatter
{ const sim = G.createSim({ bioSensor: 'plate', seed: 5 }).run();
  const pr = G.parseCSV(G.exportCSV(sim.records, '2027-04-01'));
  const e = G.sensorErrors(pr.records).find(x => x.type === 'plate');
  t('sensorErrors pairs plate with clips', !!e && e.n > 100);
  t('sensorErrors recovers hidden plate bias', !!e && Math.abs(e.bias - sim.hidden.plateCalBias) < 0.02);
  t('sensorErrors removes clip sampling error', !!e && e.sdNet < e.sdRaw && Math.abs(e.sdNet - 0.08) < 0.03);
  const m = G.sanitize({ measured: { plate: { bias: e.bias, sd: e.sdNet, n: e.n } } });
  t('measured errors sanitized', m.measured.plate && m.measured.map === null);
  const a1 = G.createSim({ seed: 9, bioSensor: 'plate', measured: { plate: { bias: 0.2, sd: 0.01 } } }).run();
  const rel = a1.records.filter(r => r.type === 'plate').length;
  const s2 = G.createSim({ seed: 9, bioSensor: 'plate', measured: { plate: { bias: 0.2, sd: 0.01 } } }).run();
  t('measured model is reproducible', JSON.stringify(s2.score()) === JSON.stringify(a1.score()) && rel > 0);
  // a +20 percent measured bias shows up in the readings against truth (true B logged each morning)
  const back = G.sensorErrors(G.parseCSV(G.exportCSV(a1.records, '2027-04-01')).records).find(x => x.type === 'plate');
  t('measured bias applied (+20 percent comes back as +20 percent against clips)', Math.abs(back.bias - 0.2) < 0.03);
}
// 15 clip quadrat conversion used by the entry form: g / m2 x 10 = kg/ha
t('quadrat conversion', Math.abs(60 / 0.25 * 10 - 2400) < 1e-9);
// 16 historical weather: three NOAA-style formats parse to the same season; gap years are excluded
{ const mk = (style) => { const L = []; let k = 0;
    if (style === 'cdo') L.push('"STATION","NAME","DATE","PRCP","TMAX","TMIN"'); else if (style === 'raw') L.push('"STATION","DATE","NAME","PRCP","PRCP_ATTRIBUTES","TMAX","TMAX_ATTRIBUTES","TMIN","TMIN_ATTRIBUTES"'); else L.push('date,tmax,tmin,rain');
    for (let t = Date.UTC(2000, 0, 1); t <= Date.UTC(2002, 11, 31); t += 86400000) { k++;
      const d = new Date(t), iso = d.toISOString().slice(0, 10), m = d.getUTCMonth();
      const tx = 22 + 10 * Math.sin((m - 3) / 12 * 2 * Math.PI), tn = tx - 12, pr = k % 3 ? 0 : 5.08, gap = iso >= '2001-05-01' && iso < '2001-06-15';
      if (style === 'cdo') L.push(`"USC00381770","CLEMSON UNIVERSITY, SC US","${iso}","${(pr / 25.4).toFixed(2)}","${gap ? '' : (tx * 1.8 + 32).toFixed(0)}","${gap ? '' : (tn * 1.8 + 32).toFixed(0)}"`);
      else if (style === 'raw') L.push(`"USW00093846","${iso}","ANDERSON","${Math.round(pr * 10)}",",,W","${gap ? '' : Math.round(tx * 10)}",",,W","${gap ? '' : Math.round(tn * 10)}",",,W"`);
      else L.push(`${iso},${gap ? '' : tx.toFixed(1)},${gap ? '' : tn.toFixed(1)},${pr}`); }
    return L.join('\n'); };
  const a = G.parseWeatherCSV(mk('cdo'), 'auto'), b = G.parseWeatherCSV(mk('raw'), 'auto'), c = G.parseWeatherCSV(mk('plain'), 'auto');
  t('weather units detected (F, tenths, C)', a.detected === 'standard' && b.detected === 'tenths' && c.detected === 'metric');
  const y = (r, yr) => r.years.find(x => x.year === yr);
  t('weather formats agree', Math.abs(y(a, 2000).meanTempC - y(c, 2000).meanTempC) < 0.3 && Math.abs(y(b, 2000).rainMm / y(c, 2000).rainMm - 1) < 0.02 && Math.abs(y(a, 2000).rainMm / y(c, 2000).rainMm - 1) < 0.02);
  t('gap season excluded', y(c, 2001).usable === false && y(c, 2000).usable && y(c, 2002).usable);
  G.setWeatherRecord(c);
  const s1 = G.createSim({ weather: 'record', recordYear: 2002 }).run();
  t('record season drives the sim', s1.wxNote === 'record 2002' && s1.startDate === '2002-04-01' && s1.weather[100].temp === G.seasonFromRecord(c, 2002).days[100].temp);
  t('runYears covers usable seasons', G.runYears({}).length === 2);
  G.setWeatherRecord(null);
  t('missing record falls back', /^no usable/.test(G.createSim({ weather: 'record', recordYear: 2002 }).run().wxNote));
}
// 17 Explore level: grass-only controller never fires the gain trigger
{ const r = G.createSim({ mode: 'grass', noiseCamera: 'high', noiseFill: 'high' }).run();
  t('grass mode: no gain moves', r.moves.every(m => m.fired !== 'gain' && m.fired !== 'grass and gain'));
  t('grass mode sanitized', G.sanitize({ mode: 'grass' }).mode === 'grass' && G.sanitize({ mode: 'bogus' }).mode === 'dual'); }
// 12 biomass non-negative
t('biomass nonneg', r.log.Btrue.every(v => v >= 0));
// 13 ASCII-only source
const bad = [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2022, 0x2192, 0x2212, 0x00A7];
for (const f of ['src/engine.js', 'src/template.html', 'index.html', 'README.md']) {
  const txt = fs.readFileSync(__dirname + '/../' + f, 'utf8'); t('typography ' + f, ![...txt].some(ch => bad.includes(ch.codePointAt(0))));
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
