import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppDependencies } from './register-dependencies.js';

/**
 * Creates a wrapper function around provided controller route handler
 *  Wrapper function resolves controller from request dependency container scope
 *  and passes request/reply to handler
 * @param controller Name of controller to resolve
 * @param method Name of method on controller to call
 * @returns Wrapped controller method
 */
function resolveHandler<
  C extends keyof AppDependencies,
  M extends keyof AppDependencies[C],
>(controller: C, method: M): AppDependencies[C][M] {
  const wrapper = async (req: FastifyRequest, res: FastifyReply) => {
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
      req: FastifyRequest,
      res: FastifyReply,
    ) => unknown;

    return await handler(req, res);
  };

  // Cast the type of the wrapper to be the same as the wrapped handler
  return wrapper as AppDependencies[C][M];
}

export default resolveHandler;
