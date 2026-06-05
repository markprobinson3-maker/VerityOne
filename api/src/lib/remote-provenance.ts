type HeaderReader = {
  header(name: string): string | null | undefined;
};

export interface RemoteProvenance {
  remoteOrigin: string | null;
  remoteClientClass: string | null;
  remoteRequestId: string | null;
  isRemoteWrite: boolean;
}

export function readRemoteProvenanceHeaders(req: HeaderReader): RemoteProvenance {
  const remoteOrigin =
    req.header("X-VO-Remote-Origin") ||
    req.header("X-VO-Gateway-Origin") ||
    null;
  const remoteClientClass =
    req.header("X-VO-Client-Class") ||
    req.header("X-VO-Gateway-Client-Class") ||
    null;
  const remoteRequestId = req.header("X-VO-Request-Id") || null;

  return {
    remoteOrigin,
    remoteClientClass,
    remoteRequestId,
    isRemoteWrite: Boolean(remoteOrigin),
  };
}

export function hasRemoteOriginSql(fieldExpr: string): string {
  return `COALESCE(${fieldExpr}, '') != ''`;
}
