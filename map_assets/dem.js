/* Regular XYZ terrain grids. No datum inference, interpolation across voids or extrapolation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'));
  else root.FSSDem = factory(root.FSS);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const MAX_CELLS = 1000000;
  class XyzGrid {
    constructor(name, text, options = {}) {
      if (options.crs !== 'EPSG:4326') throw Error('Confirm XYZ X/Y are WGS84 longitude/latitude (EPSG:4326). Reproject other grids first.');
      if (!['metres', 'feet'].includes(options.units)) throw Error('Select the actual source Z units.');
      if (typeof text !== 'string' || text.length > 40 * 1024 * 1024) throw Error('XYZ file limit is 40 MB.');
      const nodata = options.nodata === '' || options.nodata == null ? null : Number(options.nodata);
      if (nodata !== null && !Number.isFinite(nodata)) throw Error('No-data value must be a finite number or blank.');
      const rows = [], xs = new Set(), ys = new Set();
      const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
      let lineNumber = 0;
      for (const line of text.split(/\r?\n/)) {
        lineNumber++;
        const raw = line.trim();
        if (!raw || raw.startsWith('#')) continue;
        const fields = raw.split(/[\s,;]+/);
        if (rows.length === 0 && fields.length === 3 && /^(x|lon|longitude)$/i.test(fields[0]) && /^(y|lat|latitude)$/i.test(fields[1]) && /^(z|height|elevation)$/i.test(fields[2])) continue;
        if (fields.length !== 3 || fields.some(v => !number.test(v))) throw Error(`XYZ line ${lineNumber}: expected three numeric X Y Z values.`);
        const [x, y, z] = fields.map(Number);
        if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 180 || Math.abs(y) > 85.05112878) throw Error(`XYZ line ${lineNumber}: invalid coordinate or height for this map.`);
        if (rows.length >= MAX_CELLS) throw Error('XYZ limit is 1,000,000 cells.');
        rows.push([x, y, z]); xs.add(x); ys.add(y);
      }
      this.xs = [...xs].sort((a, b) => a - b);
      this.ys = [...ys].sort((a, b) => a - b);
      this.width = xs.size; this.heightCount = ys.size;
      if (this.width < 2 || this.heightCount < 2 || this.width * this.heightCount !== rows.length) throw Error('XYZ must be a complete rectangular grid; scattered points need gridding first.');
      const spacing = a => {
        const d = (a.at(-1) - a[0]) / (a.length - 1);
        if (!(d > 0) || a.some((v, i) => Math.abs(v - (a[0] + i * d)) > Math.max(1e-10, d * 1e-5))) throw Error('XYZ grid spacing must be regular. Regrid irregular data first.');
        return d;
      };
      this.dx = spacing(this.xs); this.dy = spacing(this.ys);
      this.west = this.xs[0]; this.east = this.xs.at(-1);
      this.south = this.ys[0]; this.north = this.ys.at(-1);
      if (this.east - this.west > 180) throw Error('Split grids crossing the antimeridian before importing.');
      this.values = new Float64Array(rows.length).fill(NaN);
      const seen = new Uint8Array(rows.length);
      const xi = new Map(this.xs.map((v, i) => [v, i])), yi = new Map(this.ys.map((v, i) => [v, i]));
      let valid = 0;
      for (const [x, y, z] of rows) {
        const index = yi.get(y) * this.width + xi.get(x);
        if (seen[index]) throw Error('XYZ has duplicate grid coordinates.');
        seen[index] = 1;
        if (z !== nodata) {
          const metres = z * (options.units === 'feet' ? 0.3048 : 1);
          if (metres < -10000 || metres > 1667721.5) throw Error('XYZ height is outside the terrain renderer range. Check units and no-data value.');
          this.values[index] = metres; valid++;
        }
      }
      if (!valid) throw Error('XYZ grid contains no valid heights.');
      this.name = String(name).slice(0, 160);
      this.reference = String(options.reference || 'Unspecified source vertical datum').slice(0, 160);
      this.valid = valid;
    }
    height(p) {
      const x = (p[0] - this.west) / this.dx, y = (p[1] - this.south) / this.dy;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1e-8 || y < -1e-8 || x > this.width - 1 + 1e-8 || y > this.heightCount - 1 + 1e-8) return null;
      const px = Math.max(0, Math.min(this.width - 1, x)), py = Math.max(0, Math.min(this.heightCount - 1, y));
      const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(x0 + 1, this.width - 1), y1 = Math.min(y0 + 1, this.heightCount - 1);
      const fx = px - x0, fy = py - y0;
      let h = 0;
      for (const [a, b, w] of [[x0,y0,(1-fx)*(1-fy)],[x1,y0,fx*(1-fy)],[x0,y1,(1-fx)*fy],[x1,y1,fx*fy]]) {
        if (w < 1e-12) continue;
        const z = this.values[b * this.width + a];
        if (!Number.isFinite(z)) return null;
        h += z * w;
      }
      return h;
    }
  }
  function terrainProfile(feature, grids, spacing) {
    if (!grids.length) throw Error('Import local HGT or XYZ terrain first.');
    if (feature?.geometry?.type !== 'LineString') throw Error('Select a saved single route/line for the terrain profile.');
    if (!Number.isFinite(spacing) || spacing < 1 || spacing > 1000) throw Error('Profile spacing must be 1–1,000 metres.');
    const input = feature.geometry.coordinates, points = [];
    const append = p => {
      let h = null;
      for (const grid of grids) { h = grid.height(p); if (h !== null) break; }
      if (h === null) throw Error('The route crosses missing terrain. Choose a route inside the loaded grid; gaps are not filled.');
      points.push([p[0], p[1], h]);
    };
    append(input[0]);
    for (let i = 1; i < input.length; i++) {
      const leg = C.inverse(input[i - 1], input[i]), steps = Math.max(1, Math.ceil(leg.distance / spacing));
      if (points.length + steps > 5000) throw Error('Profile exceeds 5,000 samples. Increase spacing or shorten the route.');
      for (let j = 1; j <= steps; j++) append(j === steps ? input[i] : C.direct(input[i - 1], leg.bearing, leg.distance * j / steps));
    }
    const reference = [...new Set(grids.map(g => g.reference || 'HGT source vertical datum'))].join('; ');
    return C.feature('LineString', points, `${feature.properties.name} · terrain profile`, {
      folder: 'Terrain profiles', heightReference: reference,
      description: `Sampled local DEM at ≤${spacing} m intervals; ${reference}. Source route retained. Heights are interpolated terrain, not survey observations.`,
    });
  }
  return { XyzGrid, terrainProfile };
});
