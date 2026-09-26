// Small DSP toolkit for tempo and key detection: an in-place radix-2 FFT and
// a Hann window. Plain typed arrays, no dependencies.

/** In-place complex FFT; `re` and `im` must have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

export function nextPow2(n: number) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/**
 * Magnitude spectra of successive windowed frames. Calls `onFrame` with a
 * reused buffer of n/2 + 1 magnitudes, so nothing big is allocated per frame.
 */
export function stft(x: Float32Array, n: number, hop: number, onFrame: (mag: Float64Array, index: number) => void) {
  const win = hann(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const mag = new Float64Array(n / 2 + 1)
  for (let start = 0, f = 0; start + n <= x.length; start += hop, f++) {
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * win[i]
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b <= n / 2; b++) mag[b] = Math.hypot(re[b], im[b])
    onFrame(mag, f)
  }
}
