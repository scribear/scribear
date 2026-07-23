import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppDependencies } from './app-dependencies.js';

/**
 * Creates a wrapper that resolves a controller from the request DI scope and
 * delegates to the named method. Keeps routers free of direct class imports.
 */
function resolveHandler<
  C extends keyof AppDependencies,
  M extends keyof AppDependencies[C],
>(controller: C, method: M): AppDependencies[C][M] {
  const wrapper = async (req: FastifyRequest, res: FastifyReply) => {
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
      req: FastifyRequest,
      res: FastifyReply,
    ) => unknown;

    return await handler(req, res);
  };

  return wrapper as AppDependencies[C][M];
}

export default resolveHandler;
