# gpsview

Visualize my GPS tracks.

A single-page web app with no build step. Drag GPX files onto the map, or use the
"choose files" link, and they are drawn as a LineString layer on a
[MapLibre GL JS](https://maplibre.org/) map. Files are read in the browser and
never uploaded anywhere.

## Filters

All filters apply to every loaded track and update the map immediately.

- **Date range:** local calendar dates (the browser's time zone). Defaults to the
  full range of the loaded data.
- **Time of day:** local time regardless of date. The end time includes its whole
  minute. A start later than the end wraps past midnight, so 22:00 to 04:00
  shows overnight travel.
- **Speed (mph):** computed for each pair of consecutive points from the
  great-circle distance and the timestamps. Leave the maximum empty for no
  limit.
- **Longest jump (miles):** breaks the line between consecutive points that are
  farther apart than this, so gaps in recording don't draw straight lines across
  the map. Leave it empty for no limit.
- **Simplification (feet):** Douglas-Peucker tolerance applied to each line after
  filtering. 0 draws every point.

A line is broken wherever a point falls outside the date or time window, or a
pair of points falls outside the speed range or is farther apart than the
longest jump. Click a line to see its name, time
span and distance.

**Line width** sets the track thickness in pixels; thinner lines help in dense
areas. It is remembered in the browser and is not affected by "Reset filters".

## Base maps

The default is [OpenFreeMap](https://openfreemap.org/), which serves free
vector tiles built from OpenStreetMap data with no API key, no registration and
no usage limits. Vector tiles stay sharp at every zoom and on high-DPI screens,
and its muted Positron style makes tracks easier to see. The base map menu also
offers:

- OpenFreeMap Liberty and Bright, more colorful vector styles.
- OpenStreetMap's standard raster tiles. These work, but the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  asks apps not to rely on them for heavy use, and they look blurry on high-DPI
  screens.
- Esri World Imagery satellite tiles. Check
  [Esri's terms](https://www.esri.com/en-us/legal/terms/full-master-agreement)
  before relying on these.

The choice is remembered in the browser.

## Hosting on GitHub Pages

The app is static files at the repository root (`index.html`, `app.js`,
`style.css`). To publish it:

1. In the repository on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**,
   then choose the `main` branch and the `/ (root)` folder, and save.
3. After a minute or so the app will be at `https://<username>.github.io/gpsview/`.

To run it locally, serve the directory with any static server, for example
`python3 -m http.server`, and open http://localhost:8000/.
