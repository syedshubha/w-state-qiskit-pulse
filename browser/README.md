# Transmon Pulse Lab

[Open the lab](https://syedshubha.com/transmon/). This directory is the public source copy of the browser app.

From the W-state repository root, run `python3 -m http.server 8000 --directory browser` and open `http://127.0.0.1:8000/`. The circuit editor runs without a build step. The first leakage run downloads the pinned QuTiP WebAssembly runtime and its numerical packages from the [QuTiP Virtual Lab](https://qutip.org/qutip-virtual-lab/). The browser verifies their hashes against `leakage/runtime-provenance.json` and performs the calculation in a Web Worker.

## What the models calculate

- `app.mjs` renders the editor, I/Q timeline, instruction details, and ideal probabilities. `engine.mjs` compiles the circuit with illustrative drive, echoed ZX, frame, and readout templates. The ideal probabilities use gates and projective Z measurements. The W-state preset follows the original notebook.
- `leakage/model.py` builds an isolated rotating-frame Duffing Hamiltonian and evolves a finite pulse using QuTiP. A chosen local drive contributes its signed nominal area, phase, and duration. Higher-level populations are summed to report peak and final leakage. The model uses a fresh initial state and omits earlier gates, interactions and readout dynamics.
- `leakage/waveform-basis.json` records 512 samples per waveform from IQM Pulse 16.0.0. The browser scales the Gaussian and its derivative, and the native reproduction can generate these samples directly. The circuit timeline uses the app's separate schematic pulse templates.

[EmulateQPU-4Q](https://github.com/syedshubha/EmulateQPU-4Q) provides the layout, electromagnetic extraction, circuit quantization and multilevel workflow needed to study how changes to a modeled chip affect its response.

## Reproduce an isolated pulse in Python

Use Python 3.12 and install `leakage/requirements.txt`. The following runs a nominal X pulse. Omit `--iqm` to use the same recorded fixture as the browser, which runs QuTiP 4.7.0. Native requirements pin QuTiP 5.3.1.

```sh
python -m pip install -r browser/leakage/requirements.txt
python browser/leakage/model.py --iqm <<'JSON'
{"levels":4,"initial":0,"duration_ns":32,"angle_rad":3.141592653589793,"phase_rad":0,"detuning_mhz":0,"anharmonicity_mhz":-220,"drag_beta_ns":0}
JSON
```

The JSON output includes all retained level populations, leakage, and normalization drift. A pulse can populate higher levels during the drive and end with much smaller leakage. To compare two durations, keep `angle_rad` fixed. To test truncation, repeat the calculation with an additional level.

Time is in ns and the Hamiltonian coefficients are in rad/ns. The rotating-frame Hamiltonian is `H/ℏ = Δn + αn(n−1)/2 + I(t)(a+a†)/2 + Q(t)(a−a†)/(2i)`, where `a` lowers the transmon level, `n = a†a`, `Δ = ω₀₁−ω_drive`, and `α = ω₁₂−ω₀₁`. The schedule’s nominal angle sets the integrated Gaussian drive before phase rotation and the optional derivative correction.
