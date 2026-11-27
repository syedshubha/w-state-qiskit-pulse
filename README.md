# W-State Preparation with Qiskit Pulse

Prepares the three-qubit W state

<p align="center"><b>|W⟩ = (|001⟩ + |010⟩ + |100⟩) / √3</b></p>

first as a gate-level circuit, then as a pulse schedule built from `ibm_sherbrooke` calibration data (physical qubits 1–3). Unlike a GHZ state, a W state keeps bipartite entanglement when one qubit is lost, which makes it useful for secret sharing and teleportation over noisy links.

## Edit the circuit in your browser

Open the [three-transmon pulse lab](https://syedshubha.com/transmon/) and load **W state**. The preset uses the decomposed circuit from the circuit notebook and measures all three wires. Try editing the first R<sub>y</sub> angle or removing a CX, then inspect the resulting pulse schedule and ideal basis probabilities. The lab writes basis labels in wire order q₀q₁q₂. Qiskit statevectors print q₂q₁q₀ from left to right.

The [browser source](browser/) can also be served from this checkout.

```bash
python3 -m http.server 8000 --directory browser
```

Open [localhost:8000](http://localhost:8000/) to use the editor. To verify the preset's preparation independently of the browser and Qiskit, run `python3 w_state_reference.py`. This script applies the seven unitary gates to |000⟩ and checks that exactly the three single-excitation amplitudes equal 1/√3 up to numerical precision.

The lab uses a teaching compiler with illustrative timings, virtual frame updates, and an echoed effective ZX model for CX. The legacy notebook uses the Sherbrooke snapshot and hand-chosen cross-resonance parameters for its original pulse sequence. The browser's ideal output probabilities come from the circuit gates.

## Original Qiskit notebooks

| Notebook | What it does | Environment |
| --- | --- | --- |
| [`notebooks/w_state_circuit.ipynb`](notebooks/w_state_circuit.ipynb) | Two gate-level W-state circuits, checked against the exact statevector; then reads T₁, T₂, readout error, and drive frequencies from the backend and saves them to [`data/wstate_backend_params.json`](data/wstate_backend_params.json). | [`requirements-circuit.txt`](requirements-circuit.txt) (Qiskit 2.x) |
| [`notebooks/w_state_pulse.ipynb`](notebooks/w_state_pulse.ipynb) | Estimates π-pulse amplitudes per qubit, defines pulse-level RY, X, cross-resonance CNOT, and measurement blocks, and assembles the full W-state schedule. | [`requirements-pulse.txt`](requirements-pulse.txt) (Qiskit 0.46) |

The pulse notebook is pinned to Qiskit 0.46 to reproduce the original API. IBM deprecated Qiskit Pulse in 1.3 and removed it in 2.0. See the [Qiskit 2.0 release notes](https://quantum.cloud.ibm.com/docs/en/api/qiskit/release-notes/2.0).

## Run it

```bash
git clone https://github.com/syedshubha/w-state-qiskit-pulse
cd w-state-qiskit-pulse

python -m venv .venv-pulse && source .venv-pulse/bin/activate
pip install -r requirements-pulse.txt jupyter
jupyter notebook notebooks/w_state_pulse.ipynb
```

Use `requirements-circuit.txt` in a separate environment for the circuit notebook. Each notebook also has an **Open in Colab** badge; in Colab the first cells install the same pinned versions and fetch the calibration snapshot from this repository.

The calibration snapshot in `data/` lets the pulse notebook run without an IBM Quantum account. Only the final cells of the circuit notebook, which fetch live calibration data, need `qiskit-ibm-runtime` and an account.

## Results

**Gate-level circuit.** Both constructions start with `RY(2 arccos(1/√3))` on q0, then use a controlled rotation on q1, two CNOTs, and an X on q0. The decomposed version uses RY(π/4), CX(0, 1), and RY(−π/4) for the controlled rotation on this input. The second CX in the full controlled-RY decomposition can be dropped here because q1 is already in the +1 eigenstate of X on the q0 = 1 branch. Each circuit returns amplitude 1/√3 on |001⟩, |010⟩, and |100⟩ and zero elsewhere.

![W-state circuit](figures/w_state_circuit.png)

**π-pulse estimates.** Each qubit is swept over `RX(πA)` for 50 amplitudes A, with that qubit's T₁/T₂ relaxation and readout error from the snapshot, at 1,024 shots per point. The ideal π amplitude is therefore A = 1; the noisy argmax lands at 0.96–1.00 and shifts slightly from run to run because of shot noise. This is a circuit-level stand-in for a pulse Rabi experiment.

![Rabi sweeps](figures/rabi_calibration.png)

**Pulse schedule.** Single-qubit rotations are 128-sample Gaussian pulses (σ = 64) scaled from the π amplitudes, with RY implemented as phase-shifted X drives. Each CNOT is a cross-resonance sequence: a Gaussian CR pulse on the control at the target's drive frequency, a π pulse on the target, then a CR pulse with negated amplitude. The full schedule runs 2,944 samples (dt = 0.222 ns).

![W-state pulse schedule](figures/w_state_pulse_schedule.png)

## Scope and limitations

- The schedule is assembled and drawn but not simulated or run on hardware. CR amplitude and duration are set by hand rather than calibrated, so the schedule shows the structure of a pulse-level W-state preparation, not a tuned implementation.
- `ibm_sherbrooke` reported no calibrated `cx` gates when the snapshot was taken, so CNOT timing could not be read from the backend.

## Write-up

The full report, with derivations and discussion, is in [`docs/w-state-report.pdf`](docs/w-state-report.pdf). The project was completed for PHYS 4750 (Quantum Technology) at Louisiana State University in 2025.

## Author

[Syed Emad Uddin Shubha](https://syedshubha.com), Louisiana State University

## License

[MIT](LICENSE)
