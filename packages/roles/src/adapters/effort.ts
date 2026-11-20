const EFFORT = /^[A-Za-z0-9_-]{1,32}$/u;
export const plain = (value: string | undefined) =>
  value !== undefined && EFFORT.test(value) ? value : undefined;
