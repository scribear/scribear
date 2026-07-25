import fastifyPlugin from 'fastify-plugin';

import { readBuildInfo } from '../build-info.js';
import type { BaseFastifyInstance } from '../types/base-fastify-types.js';

/** Path every container in the stack answers build metadata on. */
export const BUILD_INFO_PATH = '/build-info';

/**
 * `GET /build-info` — which artifact this container was built from.
 *
 * Registered here rather than per service so that all four Node services answer
 * the same path with the same body, and so that adding a fifth needs no route
 * of its own. Mounted at the root, deliberately outside each service's
 * `/api/<service>/v1` prefix: the static webapps and transcription-service
 * cannot honour a Node service's prefix, and one path across the whole stack is
 * what lets the admin console probe every container with one loop.
 *
 * **Unauthenticated, and reachable only in-cluster.** nginx proxies only the
 * `/api/...` prefixes to these services, so nothing outside the compose network
 * can reach this route. That is the reason it can be unauthenticated at all,
 * and the reason it must stay at the root: moving it under `/api` would publish
 * every service's commit hash to the internet.
 *
 * The payload is computed once, at registration: the environment it reads is
 * baked into the image and cannot change while the process lives.
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  const buildInfo = readBuildInfo();

  fastify.route({
    method: 'GET',
    url: BUILD_INFO_PATH,
    handler: (_req, res) => {
      res.code(200).send(buildInfo);
    },
  });
});
