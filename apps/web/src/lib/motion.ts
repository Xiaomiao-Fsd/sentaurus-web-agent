export const springTransition = "220ms cubic-bezier(0.2, 0.8, 0.2, 1)";

export const fadeInStyle = {
  animation: "surface-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)"
} as const;

export const staggerDelay = (index: number, stepMs = 24): string => `${Math.min(index, 16) * stepMs}ms`;
