/**
 * The auth seam (plan §1, pillar 1). Operations never see raw credentials or
 * refresh logic — they ask a `CredentialProvider` for a currently-valid credential.
 *
 * The *interface* is universal; the credential *payload* (`TCredential`) is
 * provider-shaped — e.g. S3 access keys vs an OAuth token bundle.
 */
export interface CredentialProvider<TCredential> {
  /** Return a currently-valid credential, refreshing internally if needed. */
  getCredential(): Promise<TCredential>;
}

/** The trivial provider for long-lived, static credentials (e.g. S3 access keys). */
export class StaticCredentialProvider<
  TCredential,
> implements CredentialProvider<TCredential> {
  constructor(private readonly credential: TCredential) {}

  getCredential(): Promise<TCredential> {
    return Promise.resolve(this.credential);
  }
}

/** Convenience factory for `StaticCredentialProvider`. */
export function staticCredentials<TCredential>(
  credential: TCredential,
): CredentialProvider<TCredential> {
  return new StaticCredentialProvider(credential);
}
