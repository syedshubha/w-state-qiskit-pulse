"""Check the three-transmon pulse lab's ideal W preset using only Python."""

from math import acos, cos, isclose, pi, sin, sqrt


# Entries are (column, gate, target, angle in radians or control wire).
# Rotations on different wires in the same column commute.
W_PREPARATION = (
    (0, "RY", 0, 2 * acos(1 / sqrt(3))),
    (0, "RY", 1, pi / 4),
    (1, "CX", 1, 0),
    (2, "RY", 1, -pi / 4),
    (3, "CX", 2, 1),
    (4, "CX", 1, 0),
    (5, "X", 0, None),
)


def w_statevector() -> tuple[float, ...]:
    """Return amplitudes before measurement, in binary order |q0 q1 q2⟩."""
    state = [1.0] + [0.0] * 7
    for _, gate, target, parameter in W_PREPARATION:
        target_mask = 1 << (2 - target)
        if gate == "RY":
            cosine, sine = cos(parameter / 2), sin(parameter / 2)
            for low in range(8):
                if low & target_mask:
                    continue
                high = low | target_mask
                zero, one = state[low], state[high]
                state[low] = cosine * zero - sine * one
                state[high] = sine * zero + cosine * one
        elif gate == "CX":
            control_mask = 1 << (2 - parameter)
            state = [state[index ^ target_mask if index & control_mask else index] for index in range(8)]
        elif gate == "X":
            state = [state[index ^ target_mask] for index in range(8)]
        else:
            raise ValueError(f"Unsupported reference gate {gate}")
    return tuple(state)


if __name__ == "__main__":
    amplitudes = w_statevector()
    for index, amplitude in enumerate(amplitudes):
        expected = 1 / sqrt(3) if index in (0b001, 0b010, 0b100) else 0.0
        if not isclose(amplitude, expected, rel_tol=0.0, abs_tol=1e-12):
            raise SystemExit(f"Unexpected amplitude for |{index:03b}⟩: {amplitude}")
        print(f"|{index:03b}⟩  amplitude {amplitude:.10f}  probability {amplitude**2:.10f}")
