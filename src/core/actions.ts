/** Device-independent input for one tick. Plain data only. */
export interface InputActions {
  /** Strafe (x, +right) and forward (y, +forward). Each in [-1, 1], magnitude <= 1. */
  move: [number, number];
  /** Yaw delta (x, +right) and pitch delta (y, +up) in radians for this poll. */
  look: [number, number];
  fire: boolean;
  jump: boolean;
  dive: boolean;
  sub: boolean;
  special: boolean;
  pause: boolean;
}

export function emptyActions(): InputActions {
  return {
    move: [0, 0],
    look: [0, 0],
    fire: false,
    jump: false,
    dive: false,
    sub: false,
    special: false,
    pause: false,
  };
}

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';
