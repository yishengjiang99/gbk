export function resolveCompactStudioMode({ composer = false, narrow = false, inApp = false }: { composer?: boolean; narrow?: boolean; inApp?: boolean } = {}) {
  return composer || narrow || inApp;
}
