export function assertNever(value: never, what = "variant"): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`);
}
