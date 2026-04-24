export const CLIENT_WEBAPP_URL =
  (import.meta.env['VITE_CLIENT_WEBAPP_URL'] as string | undefined) ??
  `${window.location.origin}/client`;

export function buildClientJoinUrl(joinCode: string): string {
  const config = { clientSessionConfig: { joinCode } };
  const encoded = btoa(JSON.stringify(config));
  return `${CLIENT_WEBAPP_URL}#config=${encoded}`;
}
