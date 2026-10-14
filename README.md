# grazing-control-sim

Rotational grazing as a control loop: a live simulation that also replays field records.

Version 1.4.0. Design-stage teaching tool. Simulated results are not field results.

Companion tool for the proposal "From Forage Biomass Maps to Feed Conversion and Move Timing on Rotationally Grazed Pastures" (USDA NIFA AFRI A1521). PI: Dr. A. B. Koc, Agricultural and Biosystems Engineering, Clemson University.

## Relation to the proposal

Proposal version 5 uses the residual floor as the move trigger and reads herd-mean gain once per rotation cycle to retune the floor (proposal Figure 5). This tool runs the daily loop: the dual trigger, the grass-only rule, and the calendar. The cycle-scale retune is not in this version. Proposal Figure 7 is a screenshot of the Explore level.

## What it does

The page runs a grazing season one day per tick. The block diagram is live. Every block shows its current value. Each morning the controller reads the estimates and decides: stay or move.

There are two data sources. Both use the same estimator and controller.

- Simulation. A season is generated from the grazing-sim v0.1.0 equations. The true state is known, so every decision can be scored.
- Field data. Your own records are replayed: clips, UAV or rover estimates, plate meter, visual estimates, camera and scale weights, temperatures, and the days the herd moved. Nothing is simulated. Each morning the rule gives its recommendation, and the log sets it next to what was done.

The control law used by the dual-trigger mode:

    move if B^(k) <= B* or g^(k) <= (1 - delta) g^max(k),  subject to d_min <= d <= d_max

B^ is estimated standing biomass. g^ is the rolling herd-mean gain over n days. g^max is the best rolling gain since turn-in. Calendar mode moves on a fixed day instead (open loop).

## Biomass sensors

| Sensor | When read | Error model (placeholders) | Relative SE |
|---|---|---|---|
| UAV or rover map | turn-in, day 2, exit | grazing-sim map errors | 0.099 |
| Plate meter | turn-in, day 2, exit | calibration bias 0.12 fixed per season; per-pass 0.08; extra 0.05 at exit | 0.144 |
| Visual estimate | every morning | observer bias 0.15 fixed per season; daily 0.20; pulls toward 2000 kg/ha with slope 0.7 | 0.25 |
| Clips (reference) | turn-in and exit | 12 quadrats; within-paddock CV 0.30; lab error 0.02 | 0.087 |

The plate meter and visual values are set in this tool. They must be replaced from the literature and from the lab's own comparisons against clips. Traditional methods are treated as sensors, not as a separate objective.

Clips are an independent reference by default. They can also be fed into the estimator.

## From field data back to the simulator

The simulator's sensor errors are placeholders. Field data replaces them.

1. Enter clips and sensor readings for the same paddock on the same day. The clip form takes the dry weight of each quadrat in grams and the frame area, and writes one row per quadrat (g / m2 x 10 = kg DM/ha). It reports the mean, its standard error, and the 95 percent interval.
2. Apply the records. The table "Sensor error against clips" pairs every sensor reading with the clip mean of that paddock and day. It reports bias, measured scatter, the clip mean's own sampling error, the sensor's scatter with that sampling error removed, and RMSE.
3. Press "Use for ..." on a row. The measured bias and scatter replace that sensor's placeholder model in the simulator: y = B (1 + bias + e), e ~ N(0, scatter). The simulation settings list which sensors run on measured errors. Clear restores the placeholder.

When the clip mean's sampling error is as large as the measured scatter, the sensor's share cannot be separated. The table says "not resolved" and offers the measured scatter as a conservative value.

The same path carries a pipeline feed. The lab's processing scripts write a CSV in the record format, for example `data/field-records.csv` in this repository. On GitHub Pages, "Load from a URL" with that path reads it. Loading from other sites works only if they allow cross-origin requests. It does not work from a local file or inside the claude.ai preview, where "Load a CSV file" does the same job.

## Three levels

One engine, three views. The level switch sits under the title and is remembered in the browser. A link can open a level directly, for example `index.html?level=explore`.

- **Explore** (high school, first-year students, the public): a four-box loop (grass and cattle, measure, decide, act), the paddock ring, a grass gauge, plain-language messages, a season report, and three challenges. Units are lb/acre and lb. The controller is the grass rule only (or a 4-day calendar), with a 2-day minimum and 7-day maximum stay.
- **Learn** (animal science and agricultural engineering students): the full control-loop diagram, plots, scenarios, comparison, and exercises. Field data, historical weather, calibration, and the parameter table are hidden.
- **Research** (researchers and professionals): everything.

The science is identical at every level. Only what is shown and controlled changes.

## Historical weather

The placeholder weather (a seasonal temperature curve and random rain) can be replaced by a real daily record. Each year from April 1 to October 31 becomes one season.

Suggested stations for Clemson, Pendleton, and Anderson (NOAA GHCN-Daily):

| Station | ID | Location | Daily record |
|---|---|---|---|
| Clemson University | USC00381770 | 34.660, -82.823; 244 m; about 4 km from Pendleton | from 1896 |
| Anderson Regional Airport | USW00093846 | 34.498, -82.709; 234 m | from 1948 |
| Clemson-Oconee County Airport | USW00053850 | 34.672, -82.881; 271 m | check coverage |

Download from NOAA NCEI Climate Data Online, Daily Summaries: search the station ID, pick the years (for example 1995 to 2025), choose CSV, and include TMAX, TMIN, and PRCP. Metric or standard units both work. The raw per-station GHCN files (tenths of a degree C and tenths of a mm) also work. Any lab or farm station works as a plain CSV with columns date, tmax, tmin, rain in C and mm.

In the tool, Historical weather, Load a weather CSV:

- Units are detected from midsummer maximum temperature and shown for confirmation. They can be set by hand.
- A season is used when no more than 10 percent of its days lack temperature or rain. Temperature gaps are interpolated. Missing rain counts as none.
- A monthly table compares the record with the placeholder weather it replaces.
- A season table lists rain, mean temperature, days above 28 C, the longest dry spell, and mean soil water.
- Season and sensors, Weather, Historical record, then pick a year, replays that season.
- Run all years runs the dual trigger and a matched calendar on every usable season. It reports each year and the 10th, 50th, and 90th percentiles. Animals and sensors use the same seed in every season, so the spread comes from the weather.

The record replaces temperature and rain only. The soil-water bucket, growth, and animal parameters are still placeholders. The record describes past seasons. It is not a forecast.

## Outer loop (sensor calibration)

The outer loop is off by default. When it is on, every 40 days each biomass sensor gets a calibration factor: its mean ratio to the clip means collected so far. Later readings are divided by that factor. This removes a steady bias, such as a plate meter's generic equation. It cannot remove day-to-day scatter. The scale is shown as the reference for the camera. Calibrating model constants and the n-alkane reference remain year-2 work.

## Field records

One row per reading. The same file can come from manual entry, a spreadsheet, or the lab's processing pipelines.

    date,paddock,type,value,unit,animal,n,sd,role,note
    2027-04-01,3,move,,,,,,,herd enters P3
    2027-04-01,3,clip,2480,kg/ha,,,,,quadrat 1
    2027-04-01,3,clip,2210,kg/ha,,,,,quadrat 2
    2027-04-01,3,uav,2550,kg/ha,,,,,
    2027-04-01,3,plate,2350,lb/ac,,,,,
    2027-04-02,,camera,305.2,kg,A17,,,,
    2027-04-02,,scale,302.0,kg,A17,,,,
    2027-04-02,,temp,24.5,C,,,,,

- date: YYYY-MM-DD or a day number, one style per file.
- paddock: 1, 2, 3 or P1, P2, P3. Needed for biomass and move rows.
- type: clip, uav, rover, map, plate, visual, camera, scale, move, temp.
- value: biomass as a paddock mean, or one clip quadrat per row. Weight per animal, or a herd mean when animal is blank. Empty for move rows.
- unit: kg/ha or lb/ac; kg or lb; C or F. Blank means kg/ha, kg, C.
- n, sd: optional, for a clip row that is already a mean.
- role: optional (pre, mid, post, rest). Blank is inferred from the move rows.
- The first day needs a move row that says where the herd starts. Lines starting with # are comments.

The page checks every row and lists problems by line number. Records stay in the browser. Copy CSV and Download CSV write them back out.

## Use

Open `index.html` in any current browser. No install, no network, no build step.

- Play, Pause, Step one day, Reset. Space plays or pauses. The right arrow steps.
- Setpoints apply from the next morning, so they can be changed during a run.
- Weather, noise, sensor choice, seed, and estimator options restart the run.
- Guided scenarios: normal season, dry spell, high sensor noise, producer methods.
- Compare runs the dual trigger and a calendar with the same mean stay on the same seed.
- Compare the sensors runs the dual trigger with each biomass sensor on the same seed.
- Export to field records writes the current simulated season in the field format and opens it under Field data.

## Deploy on GitHub Pages

1. Push this folder to a repository, for example `alibulentkoc/grazing-control-sim`.
2. Settings, Pages, Deploy from a branch, `main`, folder `/ (root)`.
3. The page is served at `https://alibulentkoc.github.io/grazing-control-sim/`.

`index.html` and `grazing-control-sim.html` are identical. `.nojekyll` stops Pages from processing the files.

## Files

    index.html                  the tool (GitHub Pages entry point)
    grazing-control-sim.html    the same file under its descriptive name
    src/engine.js               simulation, observer (estimator and controller), CSV parse, export, replay
    src/template.html           page, styles, and interface code
    tools/build.js              inlines the engine into the page; typography and syntax check
    test/test.js                34 tests
    LICENSE                     MIT, for the code

After editing `src/`, run `node tools/build.js`, then `node test/test.js`.

## How the tool is checked

- Parity. A simulated season is exported as CSV and replayed as field data. The replay must give the same decision on every day and the same estimate to the last bit. This holds for the map, plate, and visual sensors, with and without calibration, and in calendar mode.
- Regression. With the map sensor, v1.1 reproduces v1.0 decisions.
- Causality. The observer code reads no true-state variable.
- Also tested: stay limits, sensor schedules, CSV units and validation, clip means given as n and SD, calibration recovering a known plate bias, and a typography check on every source file.

## Model

Equations and parameter values are ported from grazing-sim v0.1.0. No new biological equations were added. Most values are placeholders and are marked so in the parameter table on the page.

- Weather: seasonal temperature curve, random rain, soil-water bucket.
- Growth: temperature response, soil-water factor, standing-mass feedback, senescence above the ungrazeable residual.
- Intake: 2.6 percent of body weight, cut by heat above 28 C, limited by allowance through the bite-size factor clamp((B - 800)/1200, 0, 1).
- Gain: NRC and NASEM beef energy partition from TDN.
- Gut fill: AR(1) deviation per animal. Camera: Poisson visits, persistent offset, per-visit error, gut fill included.

### Differences from grazing-sim v0.1.0

| Item | grazing-sim | This tool | Why |
|---|---|---|---|
| Space | cell grid | paddock mean | the controller uses paddock means |
| Species | grass and legume | tall fescue only | year 1 of the project |
| Paddocks and herd | 8 x 1 ha, 12 head | 10 x 1 acre, 10 head | handover scenario |
| Control law | Rule 4: floor AND gain drop | floor OR gain drop | control-loop notation and the calculators |
| Gain window | 7 d | 3 to 5 d | locked range |
| Stay limits | 3 to 14 d | 1 to 3 and 3 to 10 d | locked ranges |
| Missing camera days | mean of animals seen | last daily median carried forward | removes offset noise |
| Regrowth estimate | rest-paddock map pairs | exit reading to next turn-in reading | uses only scheduled readings |
| Biomass sensors | UAV and rover | adds plate meter, visual estimate, clips | producer methods as sensors |

## What the tool shows with placeholder parameters

Averages over 20 seeds, default settings (floor 1500 kg/ha, delta 30 percent, stays 2 to 7 d, window 5 d, medium noise). These come from placeholder parameters. They must not be quoted as results.

Dual trigger against a calendar with the same mean stay (map sensor):

| Score | Dual trigger | Calendar |
|---|---|---|
| Mean stay, d | 2.6 | 2.6 |
| Mean post-graze residual, kg DM/ha | 1417 | 1497 |
| Gain per hectare, kg | 116 | 118 |
| False moves per season | 16.8 | 0 |
| Stays with a missed move | 7.3 | 25.5 |

Biomass sensors under the dual trigger (outer loop off, then on):

| Sensor | False grass-trigger moves | All false moves | Stays with a missed move | Lowest residual, kg/ha |
|---|---|---|---|---|
| UAV or rover map | 2.3, 2.4 | 16.8, 16.0 | 7.3, 7.2 | 1145, 1146 |
| Plate meter | 3.9, 3.0 | 18.0, 17.2 | 8.6, 7.0 | 1125, 1144 |
| Visual estimate | 13.1, 12.1 | 24.5, 23.8 | 5.8, 4.4 | 1143, 1149 |

1. The grass trigger works with a map. It gives about 2 false moves per season and cuts missed moves by about two thirds against the calendar.
2. The plate meter is close to the map once calibrated against clips. Its error is mostly a steady calibration bias, which the outer loop removes.
3. The visual estimate gives about five times the false grass moves of a map. Its error is mostly daily scatter and observer bias; calibration helps little.
4. The gain trigger does not work at ten head. Its 5-day error SD is about 1.3 kg/d against a signal of about 0.26 kg/d. It causes most false moves with every biomass sensor. Lower noise alone does not fix it: the window (5 d) is longer than the typical stay (2 to 3 d).
5. The minimum stay matters under noise. With all errors doubled, raising d_min from 1 to 3 cuts wrong moves from about 43 to 18 per season.
6. A floor-only rule speeds the rotation up in summer. Stays shorten as pre-graze biomass falls, and so does rest.
7. The dry scenario does not make the gain trigger fire first. In grazing-sim, forage quality does not fall with drought.
8. Season outcomes (residual, gain per hectare) differ little between sensors, because the gain trigger's noise dominates the move count.

### Quadrat numbers set what the clips can resolve

With 12 quadrats and a within-paddock CV of 0.30 (placeholder), the clip mean has a relative SE of about 8.7 percent. That is as large as the placeholder plate meter scatter (8 percent). On the 60-day example, the plate's scatter could not be separated from clip sampling error. To resolve a sensor scatter of about 8 percent, the clip SE should be near half of it, which takes on the order of 50 quadrats per paddock and pass at CV 0.30, or more pairs across the season. The field CV sets the real number: the clip form reports it on every paddock. This belongs in the Objective 1 sampling design.

## Known limits

- One species. No species-resolved maps.
- Ear-tag data are not used.
- Calibration of model constants and the n-alkane reference are not simulated.
- No turn-in check or skip rule for paddocks that enter below the floor.
- The estimator treats each reading's error as independent, so repeated visual readings are weighted too heavily.
- Field mode assumes one herd, paddocks of equal area, and a fixed head count.

## Version history

- v1.4.0 (October 7, 2026): Explore, Learn, and Research levels on the same engine; grass-only controller mode for Explore.
- v1.3.0 (September 30, 2026): historical daily weather from NOAA GHCN-Daily or a plain CSV; replay any season; run all seasons with percentiles.
- v1.2.0 (September 30, 2026): clip quadrat form, sensor error against clips, measured errors sent to the simulator, load from a URL for a pipeline feed.
- v1.1.0 (September 30, 2026): record-based observer shared by simulation and field data; plate meter, visual estimate, and clip reference; sensor calibration loop; CSV import, manual entry, and export; sensor comparison.
- v1.0.0 (September 30, 2026): live control-loop simulation of the grazing system.
- Based on grazing-sim v0.1.0: Node engine, single-file HTML, LaTeX documentation with 34 equations.

## License

Code: MIT (see LICENSE).
