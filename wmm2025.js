// World Magnetic Model 2025 (NOAA/BGS, public domain), valid 2025-2030.
// Each row: n, m, g, h, g-dot, h-dot.
export const WMM_EPOCH = 2025.0;
export const WMM = [[1,0,-29351.8,0.0,12.0,0.0],[1,1,-1410.8,4545.4,9.7,-21.5],[2,0,-2556.6,0.0,-11.6,0.0],[2,1,2951.1,-3133.6,-5.2,-27.7],[2,2,1649.3,-815.1,-8.0,-12.1],[3,0,1361.0,0.0,-1.3,0.0],[3,1,-2404.1,-56.6,-4.2,4.0],[3,2,1243.8,237.5,0.4,-0.3],[3,3,453.6,-549.5,-15.6,-4.1],[4,0,895.0,0.0,-1.6,0.0],[4,1,799.5,278.6,-2.4,-1.1],[4,2,55.7,-133.9,-6.0,4.1],[4,3,-281.1,212.0,5.6,1.6],[4,4,12.1,-375.6,-7.0,-4.4],[5,0,-233.2,0.0,0.6,0.0],[5,1,368.9,45.4,1.4,-0.5],[5,2,187.2,220.2,0.0,2.2],[5,3,-138.7,-122.9,0.6,0.4],[5,4,-142.0,43.0,2.2,1.7],[5,5,20.9,106.1,0.9,1.9],[6,0,64.4,0.0,-0.2,0.0],[6,1,63.8,-18.4,-0.4,0.3],[6,2,76.9,16.8,0.9,-1.6],[6,3,-115.7,48.8,1.2,-0.4],[6,4,-40.9,-59.8,-0.9,0.9],[6,5,14.9,10.9,0.3,0.7],[6,6,-60.7,72.7,0.9,0.9],[7,0,79.5,0.0,-0.0,0.0],[7,1,-77.0,-48.9,-0.1,0.6],[7,2,-8.8,-14.4,-0.1,0.5],[7,3,59.3,-1.0,0.5,-0.8],[7,4,15.8,23.4,-0.1,0.0],[7,5,2.5,-7.4,-0.8,-1.0],[7,6,-11.1,-25.1,-0.8,0.6],[7,7,14.2,-2.3,0.8,-0.2],[8,0,23.2,0.0,-0.1,0.0],[8,1,10.8,7.1,0.2,-0.2],[8,2,-17.5,-12.6,0.0,0.5],[8,3,2.0,11.4,0.5,-0.4],[8,4,-21.7,-9.7,-0.1,0.4],[8,5,16.9,12.7,0.3,-0.5],[8,6,15.0,0.7,0.2,-0.6],[8,7,-16.8,-5.2,-0.0,0.3],[8,8,0.9,3.9,0.2,0.2],[9,0,4.6,0.0,-0.0,0.0],[9,1,7.8,-24.8,-0.1,-0.3],[9,2,3.0,12.2,0.1,0.3],[9,3,-0.2,8.3,0.3,-0.3],[9,4,-2.5,-3.3,-0.3,0.3],[9,5,-13.1,-5.2,0.0,0.2],[9,6,2.4,7.2,0.3,-0.1],[9,7,8.6,-0.6,-0.1,-0.2],[9,8,-8.7,0.8,0.1,0.4],[9,9,-12.9,10.0,-0.1,0.1],[10,0,-1.3,0.0,0.1,0.0],[10,1,-6.4,3.3,0.0,0.0],[10,2,0.2,0.0,0.1,-0.0],[10,3,2.0,2.4,0.1,-0.2],[10,4,-1.0,5.3,-0.0,0.1],[10,5,-0.6,-9.1,-0.3,-0.1],[10,6,-0.9,0.4,0.0,0.1],[10,7,1.5,-4.2,-0.1,0.0],[10,8,0.9,-3.8,-0.1,-0.1],[10,9,-2.7,0.9,-0.0,0.2],[10,10,-3.9,-9.1,-0.0,-0.0],[11,0,2.9,0.0,0.0,0.0],[11,1,-1.5,0.0,-0.0,-0.0],[11,2,-2.5,2.9,0.0,0.1],[11,3,2.4,-0.6,0.0,-0.0],[11,4,-0.6,0.2,0.0,0.1],[11,5,-0.1,0.5,-0.1,-0.0],[11,6,-0.6,-0.3,0.0,-0.0],[11,7,-0.1,-1.2,-0.0,0.1],[11,8,1.1,-1.7,-0.1,-0.0],[11,9,-1.0,-2.9,-0.1,0.0],[11,10,-0.2,-1.8,-0.1,0.0],[11,11,2.6,-2.3,-0.1,0.0],[12,0,-2.0,0.0,0.0,0.0],[12,1,-0.2,-1.3,0.0,-0.0],[12,2,0.3,0.7,-0.0,0.0],[12,3,1.2,1.0,-0.0,-0.1],[12,4,-1.3,-1.4,-0.0,0.1],[12,5,0.6,-0.0,-0.0,-0.0],[12,6,0.6,0.6,0.1,-0.0],[12,7,0.5,-0.1,-0.0,-0.0],[12,8,-0.1,0.8,0.0,0.0],[12,9,-0.4,0.1,0.0,-0.0],[12,10,-0.2,-1.0,-0.1,-0.0],[12,11,-1.3,0.1,-0.0,0.0],[12,12,-0.7,0.2,-0.1,-0.1]];

// Magnetic declination (degrees, east +) from the model: how far magnetic north is from true north.
// Standard WMM spherical-harmonic synthesis (as in NOAA's reference code), evaluated once per location.
let prepared = null;
function prepare() {
  const N = 13;
  const z = () => Array.from({ length: N }, () => new Array(N).fill(0));
  const c = z(), cd = z(), k = z(), snorm = z();
  for (const [n, m, g, h, gd, hd] of WMM) {
    c[m][n] = g; cd[m][n] = gd;
    if (m !== 0) { c[n][m - 1] = h; cd[n][m - 1] = hd; }
  }
  snorm[0][0] = 1;
  for (let n = 1; n < N; n++) {
    snorm[0][n] = (snorm[0][n - 1] * (2 * n - 1)) / n;
    let j = 2;
    for (let m = 0; m <= n; m++) {
      k[m][n] = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
      if (m > 0) {
        const flnmj = ((n - m + 1) * j) / (n + m);
        snorm[m][n] = snorm[m - 1][n] * Math.sqrt(flnmj);
        j = 1;
        c[n][m - 1] *= snorm[m][n];
        cd[n][m - 1] *= snorm[m][n];
      }
      c[m][n] *= snorm[m][n];
      cd[m][n] *= snorm[m][n];
    }
  }
  prepared = { c, cd, k };
  return prepared;
}

export function declination(latDeg, lonDeg, year, altKm = 0) {
  const { c, cd, k } = prepared || prepare();
  const N = 13;
  const dt = year - WMM_EPOCH;
  const a = 6378.137, b = 6356.7523142, re = 6371.2;
  const a2 = a * a, b2 = b * b, c2 = a2 - b2, a4 = a2 * a2, b4 = b2 * b2, c4 = a4 - b4;
  const lat = Math.max(-89.999, Math.min(89.999, latDeg)) * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const srlat = Math.sin(lat), crlat = Math.cos(lat), srlat2 = srlat * srlat, crlat2 = crlat * crlat;
  const q = Math.sqrt(a2 - c2 * srlat2);
  const q1 = altKm * q;
  const q2 = ((q1 + a2) / (q1 + b2)) ** 2;
  const ct = srlat / Math.sqrt(q2 * crlat2 + srlat2);
  const st = Math.sqrt(1 - ct * ct);
  const r2 = altKm * altKm + 2 * q1 + (a4 - c4 * srlat2) / (q * q);
  const r = Math.sqrt(r2);
  const d = Math.sqrt(a2 * crlat2 + b2 * srlat2);
  const ca = (altKm + d) / r;
  const sa = (c2 * crlat * srlat) / (r * d);
  const sp = [0], cp = [1];
  for (let m = 1; m < N; m++) { sp[m] = Math.sin(m * lon); cp[m] = Math.cos(m * lon); }
  const p = Array.from({ length: N }, () => new Array(N).fill(0));
  const dp = Array.from({ length: N }, () => new Array(N).fill(0));
  p[0][0] = 1;
  const aor = re / r;
  let ar = aor * aor;
  let br = 0, bt = 0, bp = 0;
  for (let n = 1; n < N; n++) {
    ar *= aor;
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        p[m][n] = st * p[m - 1][n - 1];
        dp[m][n] = st * dp[m - 1][n - 1] + ct * p[m - 1][n - 1];
      } else if (n === 1 && m === 0) {
        p[m][n] = ct * p[m][n - 1];
        dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1];
      } else {
        const pm2 = m > n - 2 ? 0 : p[m][n - 2];
        const dpm2 = m > n - 2 ? 0 : dp[m][n - 2];
        p[m][n] = ct * p[m][n - 1] - k[m][n] * pm2;
        dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1] - k[m][n] * dpm2;
      }
      const g = c[m][n] + dt * cd[m][n];
      const h = m !== 0 ? c[n][m - 1] + dt * cd[n][m - 1] : 0;
      const par = ar * p[m][n];
      const temp1 = g * cp[m] + h * sp[m];
      const temp2 = g * sp[m] - h * cp[m];
      bt -= ar * temp1 * dp[m][n];
      bp += m * temp2 * par;
      br += (n + 1) * temp1 * par;
    }
  }
  bp /= st;
  const bx = -bt * ca - br * sa;
  const by = bp;
  return Math.atan2(by, bx) * 180 / Math.PI;
}
