export class AddonPassConfigurationError extends Error {
  constructor() {
    super("AddonPass verifier configuration is invalid");
    this.name = "AddonPassConfigurationError";
  }
}

export class AddonPassUnavailableError extends Error {
  constructor() {
    super("AddonPass entitlement verification is unavailable");
    this.name = "AddonPassUnavailableError";
  }
}

export class EntitlementCredentialRejectedError extends Error {
  constructor() {
    super("AddonPass integration credential was rejected");
    this.name = "EntitlementCredentialRejectedError";
  }
}

export class EntitlementScopeMismatchError extends Error {
  constructor() {
    super("Entitlement does not match the configured add-on scope");
    this.name = "EntitlementScopeMismatchError";
  }
}

export class EntitlementVerificationError extends Error {
  constructor() {
    super("AddonPass entitlement verification failed");
    this.name = "EntitlementVerificationError";
  }
}

export class InvalidEntitlementTokenError extends Error {
  constructor() {
    super("Entitlement token is invalid");
    this.name = "InvalidEntitlementTokenError";
  }
}

export class UnsupportedStremioRouteError extends Error {
  constructor() {
    super("Stremio route is not protected by this handler");
    this.name = "UnsupportedStremioRouteError";
  }
}
