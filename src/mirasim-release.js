export const MIRASIM_CLIENT_VERSION = "0.0.516";
export const MIRASIM_SEAL_PUBLIC_KEY = "HlyNMMeGXryasYLJuYQ/9ksCD4AYVVy1zXKAtJdpJn4=";

export function bundledCliEnvironment(env = process.env) {
  return {
    ...env,
    MIRASIM_ANALYTICS: env.MIRASIM_ANALYTICS ?? "0",
    MIRASIM_DIAG: env.MIRASIM_DIAG ?? "0",
    MIRASIM_RECORD: env.MIRASIM_RECORD ?? "0"
  };
}
