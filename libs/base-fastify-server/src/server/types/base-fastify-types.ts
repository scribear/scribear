import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  ContextConfigDefault,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { RouteGenericInterface } from 'fastify/types/route.js';
import type { FastifySchema } from 'fastify/types/schema.js';

import type { BaseLogger } from '../create-logger.js';

/**
 * Custom types for Fastify to provide type checking for requests and replies according to route schema
 * @see https://github.com/fastify/fastify-type-provider-typebox?tab=readme-ov-file#type-definition-of-fastifyrequest-fastifyreply--typeprovider
 */
type BaseFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  BaseLogger,
  TypeBoxTypeProvider
>;

type BaseFastifyReply<TSchema extends FastifySchema> = FastifyReply<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  ContextConfigDefault,
  TSchema,
  TypeBoxTypeProvider
>;

type BaseFastifyRequest<TSchema extends FastifySchema> = FastifyRequest<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression,
  TSchema,
  TypeBoxTypeProvider
>;

export type { BaseFastifyInstance, BaseFastifyRequest, BaseFastifyReply };
