import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppDependencies } from './register-dependencies.js';

/**
 * Creates a wrapper function around provided controller websocket route handler
 *  Wrapper function resolves controller from request dependency container scope
 *  and passes socket and request to handler
 *
 * Need to cast to ((req: FastifyRequest, res: FastifyReply) => void) due to bug with @fastify/websocket
 * @see https://github.com/fastify/fastify-websocket/issues/314
 *
 * @param controller Name of controller to resolve
 * @param method Name of method on controller to call
 * @returns Wrapped controller method
 */
export function resolveWsHandler<
  C extends keyof AppDependencies,
  M extends keyof AppDependencies[C],
>(
  controller: C,
  method: M,
): AppDependencies[C][M] & ((req: FastifyRequest, res: FastifyReply) => void) {
  const wrapper = async (socket: WebSocket, req: FastifyRequest) => {
    const routeController = req.diScope.resolve(
      controller,
    ) as AppDependencies[C];

    // Throw exception if method is not a function
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

  // Cast the type of the wrapper to be the same as the wrapped handler
  return wrapper as unknown as AppDependencies[C][M] &
    ((req: FastifyRequest, res: FastifyReply) => void);
}
