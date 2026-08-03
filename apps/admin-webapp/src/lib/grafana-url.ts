/**
 * Root-relative URL to the ScribeAR Fleet Overview dashboard in Grafana, proxied
 * through nginx at /grafana/ (subpath mode — see infra/scribear-nginx/nginx.conf
 * and the grafana service's GF_SERVER_ROOT_URL / GF_SERVER_SERVE_FROM_SUB_PATH
 * env vars in deployment/compose.yml).
 *
 * Root-relative, not relative to `import.meta.env.BASE_URL`: Grafana is a
 * separate service proxied at /grafana/, not a file inside this webapp's bundle
 * the way audio-meter.html is. A relative href from a nested route like
 * /admin/sessions/:uid would resolve to /admin/sessions/grafana/..., which is
 * wrong; root-relative is the only spelling that works from every route.
 *
 * The dashboard UID (`scribear-fleet-overview`) is stable — it is set in the
 * provisioned JSON at deployment/monitoring/grafana/dashboards/ and does not
 * change between deployments.
 */
const FLEET_OVERVIEW_DASHBOARD_UID = 'scribear-fleet-overview';

export function grafanaFleetOverviewHref(): string {
  return `/grafana/d/${FLEET_OVERVIEW_DASHBOARD_UID}/`;
}
