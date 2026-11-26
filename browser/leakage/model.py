"""Isolated multilevel Duffing model using QuTiP and recorded IQM Pulse shapes.

Run with QuTiP 4.7 or 5.3, NumPy, and the accompanying waveform-basis.json.
Time is in ns, frequencies in rad/ns internally, and displayed inputs in MHz.
"""

import json
import math
from importlib.metadata import version
from pathlib import Path

import numpy as np
import qutip as qt


def make_waveform_basis(samples=512):
    """Generate the normalized Gaussian and derivative with IQM Pulse."""
    from iqm.pulse.playlist.waveforms import Gaussian, GaussianDerivative

    sigma = 1 / 6
    return {
        "n_samples": samples,
        "sigma_fraction": sigma,
        "iqm_pulse_version": version("iqm-pulse"),
        "gaussian": Gaussian(n_samples=samples, sigma=sigma).sample().tolist(),
        "gaussian_derivative_normalized": GaussianDerivative(n_samples=samples, sigma=sigma).sample().tolist(),
    }


def numeric(parameters, name, low, high):
    value = parameters[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    return value


def simulate(parameters, basis):
    """Return sampled level populations for one finite pulse from |0> or |1>."""
    levels = numeric(parameters, "levels", 3, 6)
    initial = numeric(parameters, "initial", 0, 1)
    if not isinstance(levels, int) or not isinstance(initial, int):
        raise ValueError("Levels and initial state must be integers.")
    duration = numeric(parameters, "duration_ns", 2, 200)
    angle = numeric(parameters, "angle_rad", -2 * math.pi, 2 * math.pi)
    phase = numeric(parameters, "phase_rad", -math.pi, math.pi)
    detuning = 2 * math.pi / 1000 * numeric(parameters, "detuning_mhz", -150, 150)
    alpha = 2 * math.pi / 1000 * numeric(parameters, "anharmonicity_mhz", -400, -40)
    beta = numeric(parameters, "drag_beta_ns", -5, 5)

    samples = int(basis["n_samples"])
    dt = duration / samples
    gaussian = np.asarray(basis["gaussian"], dtype=float)
    derivative = np.asarray(basis["gaussian_derivative_normalized"], dtype=float)
    # IQM's derivative uses the dimensionless scale sigma*sqrt(e).
    derivative /= basis["sigma_fraction"] * duration * math.sqrt(math.e)
    # The signed area fixes the nominal on-resonance two-level rotation.
    scale = angle / (dt * np.sum(gaussian))
    iq = scale * (gaussian + 1j * beta * derivative) * np.exp(1j * phase)

    def coefficient(values):
        def held(t, args=None):
            if t < 0 or t >= duration:
                return 0.0
            return float(values[min(int(t / dt), samples - 1)])
        return held

    a = qt.destroy(levels)
    n = a.dag() * a
    h0 = detuning * n + 0.5 * alpha * n * (n - qt.qeye(levels))
    h = [h0, [(a + a.dag()) / 2, coefficient(iq.real)], [(a - a.dag()) / (2j), coefficient(iq.imag)]]
    times = np.linspace(0, duration, samples + 1)
    options = dict(atol=1e-10, rtol=1e-8, nsteps=20000, max_step=dt/2,
                   store_states=True, normalize_output=False)
    if int(qt.__version__.split(".")[0]) < 5:
        options = qt.Options(**options)
    evolution = qt.sesolve(h, qt.basis(levels, initial), times, options=options)
    amplitudes = np.column_stack([ket.full().ravel() for ket in evolution.states])
    populations = np.abs(amplitudes)**2
    leakage = np.sum(populations[2:], axis=0)
    return {
        "qutip_version": qt.__version__,
        "iqm_pulse_version": basis["iqm_pulse_version"],
        "parameters": parameters,
        "time_ns": times.tolist(),
        "populations": populations.tolist(),
        "leakage": leakage.tolist(),
        "peak_leakage": float(np.max(leakage)),
        "final_leakage": float(leakage[-1]),
        "max_top_level_population": float(np.max(populations[-1])),
        "norm_error": float(np.max(np.abs(np.sum(populations, axis=0) - 1))),
    }


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iqm", action="store_true", help="Regenerate the waveform basis with installed IQM Pulse.")
    arguments = parser.parse_args()
    request = json.load(sys.stdin)
    fixture = make_waveform_basis() if arguments.iqm else json.loads(Path(__file__).with_name("waveform-basis.json").read_text())
    print(json.dumps(simulate(request, fixture), allow_nan=False))
