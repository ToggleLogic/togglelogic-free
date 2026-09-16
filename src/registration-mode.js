export function shouldSkipRuntimeRegistration(registrationMode) {
  return registrationMode === "cli-metadata";
}
