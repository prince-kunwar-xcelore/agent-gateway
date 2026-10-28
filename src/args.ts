export function getArg(args: string[], flag: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultValue;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** All values of a repeatable flag; each value may also be comma-separated. */
export function getArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, idx) => {
    if (arg === flag && args[idx + 1]) values.push(...args[idx + 1].split(','));
  });
  return values.map((v) => v.trim()).filter(Boolean);
}
