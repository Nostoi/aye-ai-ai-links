/**
 * The colors a space (a pinned tag) can have, in the order a new pin takes them. Amber is never
 * one: it means "needs you".
 */
export const SPACE_COLORS = ["teal", "clay", "violet", "blue", "green", "rose"] as const;
export type SpaceColor = (typeof SPACE_COLORS)[number];

export const isSpaceColor = (value: unknown): value is SpaceColor =>
  (SPACE_COLORS as readonly unknown[]).includes(value);
