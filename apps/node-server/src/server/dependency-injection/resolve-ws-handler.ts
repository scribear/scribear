import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';

import type { AppDependencies } from './app-dependencies.js';

/**
 * Creates a wrapper that resolves a controller from the request DI scope and
 * delegates to the named WebSocket-handling method. Mirrors {@link resolveHandler}
 * for non-WS routes so feature routers stay free of direct class imports and
 * DI calls, and so each feature's HTTP and WS routes share one wiring style.
 *
 * @param controller Name of a controller registered in the Awilix container.
 * @param method Name of a method on that controller.
 * @returns A wrapped handler suitable for `wsHandler:` on a `fastify.route()` call.
 */
function resolveWsHandler<
  C extends keyof AppDependencies,
  M extends keyof AppDependencies[C],
>(controller: C, method: M): AppDependencies[C][M] {
  const wrapper = async (socket: WebSocket, req: FastifyRequest) => {
    const routeController = req.diScope.resolve(
      controller,
    ) as AppDependencies[C];

    if (
      !(method in routeController) ||
      typeof routeController[method] !== 'function'
    ) {
      throw new Error(
        `Failed to resolve handler: Property '${String(method)}' on controller '${controller}' is not a function.`,
      );
    }

    const handler = routeController[method].bind(routeController) as (
      socket: WebSocket,
      req: FastifyRequest,
    ) => unknown;

    return await handler(socket, req);
  };

  return wrapper as AppDependencies[C][M];
}

export default resolveWsHandler;
