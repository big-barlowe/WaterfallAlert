// Heartbeat status codes. DOWN/UP/PENDING match Uptime Kuma's numbering;
// BLOCKED is ours: the monitor was not checked because something upstream
// is down, so its real state is unknown.
export const DOWN = 0;
export const UP = 1;
export const PENDING = 2;
export const BLOCKED = 4;

export const STATUS_NAMES = { [DOWN]: 'down', [UP]: 'up', [PENDING]: 'pending', [BLOCKED]: 'blocked' };
