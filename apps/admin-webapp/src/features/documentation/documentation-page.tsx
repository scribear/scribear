import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import InsightsIcon from '@mui/icons-material/Insights';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { OpensInNewTab } from '#src/components/opens-in-new-tab';

/**
 * The wiki lives outside the deployment, so these are absolute github.com URLs
 * rather than anything routed through the BFF. Slugs, not titles: GitHub
 * resolves `Audio-Telemetry`, and a page renamed on the wiki leaves the old
 * slug redirecting, so a stale entry here degrades to a redirect rather than
 * a 404.
 */
const WIKI_BASE = 'https://github.com/scribear/scribear/wiki';

interface DocLink {
  /** Wiki page title as it renders on GitHub, used as the card heading. */
  title: string;
  /** Wiki slug appended to WIKI_BASE. */
  slug: string;
  description: string;
  icon: React.ReactNode;
}

const DOC_LINKS: DocLink[] = [
  {
    title: 'Deployment',
    slug: 'Deployment',
    description:
      'Bringing the production Docker Compose stack up from the prebuilt GHCR images, and what to configure before you do.',
    icon: <RocketLaunchIcon color="primary" />,
  },
  {
    title: 'Audio Monitoring',
    slug: 'Audio-Monitoring',
    description:
      "The audio engineer's guide to the level meters and VAD readouts: what the numbers mean, and how to fix caption quality at the source.",
    icon: <GraphicEqIcon color="primary" />,
  },
  {
    title: 'Audio Telemetry',
    slug: 'Audio-Telemetry',
    description:
      'Developer reference for the telemetry pipeline: the measurement points, the flow through Redis to this console, and the schema contracts.',
    icon: <InsightsIcon color="primary" />,
  },
  {
    title: 'Admin Website',
    slug: 'Admin-Website',
    description:
      'Operator guide to this console — signing in, and managing rooms, devices, and kiosks.',
    icon: <AdminPanelSettingsIcon color="primary" />,
  },
  {
    title: 'Documentation',
    slug: 'Documentation',
    description:
      'Architecture overview and API reference: Session Manager, the admin BFF, and the node-server websocket protocol.',
    icon: <MenuBookIcon color="primary" />,
  },
];

/**
 * Link hub for the project wiki.
 *
 * Every card opens in a new tab: the wiki is a different site, and an operator
 * reading a runbook is usually mid-task in the console — navigating away would
 * cost them the page they are working on. That makes each card an `<a>` (via
 * `CardActionArea component="a"`) rather than a click handler, so middle-click
 * and "copy link address" behave the way they do anywhere else, and it carries
 * the same `OpenInNewIcon` + `OpensInNewTab` affordance pair as the audio meter
 * link in the side nav.
 */
export const DocumentationPage = () => {
  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>
        Documentation
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
        Project documentation lives in the{' '}
        <strong>scribear/scribear GitHub wiki</strong>. Each card below opens
        there in a new tab.
      </Typography>

      <Grid container spacing={2}>
        {DOC_LINKS.map((link) => (
          <Grid key={link.slug} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card sx={{ height: '100%' }}>
              <CardActionArea
                component="a"
                href={`${WIKI_BASE}/${link.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ height: '100%', alignItems: 'stretch' }}
              >
                <CardContent>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', mb: 1 }}
                  >
                    {link.icon}
                    {/* `component="h2"`: MUI would map the `subtitle1`
                        variant to an `<h6>`, which under this page's `h1`
                        skips four levels. Each card is a real subsection
                        directly under the page title - and headings are how
                        a screen-reader user moves between the cards - so h2
                        is both valid and the correct semantics. */}
                    <Typography
                      variant="subtitle1"
                      component="h2"
                      sx={{ flexGrow: 1 }}
                    >
                      {link.title}
                    </Typography>
                    <OpenInNewIcon fontSize="small" color="action" />
                    <OpensInNewTab />
                  </Stack>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {link.description}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};
