export function getArg(args: string[], flag: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultValue;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
