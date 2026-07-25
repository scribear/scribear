import { type Mock, describe, expect, vi } from 'vitest';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import resolveWsHandler from '#src/server/dependency-injection/resolve-ws-handler.js';

interface ReqLike {
  diScope: { resolve: Mock };
}
type Handler = (req: ReqLike, res: unknown) => Promise<unknown>;
type WsHandler = (socket: unknown, req: ReqLike) => Promise<unknown>;

const resolve = resolveHandler as unknown as (
  controller: string,
  method: string,
) => Handler;
const resolveWs = resolveWsHandler as unknown as (
  controller: string,
  method: string,
) => WsHandler;

function makeReq(controller: unknown): ReqLike {
  return { diScope: { resolve: vi.fn().mockReturnValue(controller) } };
}

describe('resolveHandler', (it) => {
  it('resolves the controller and delegates to the named method with (req, res)', async () => {
    const method = vi.fn().mockResolvedValue('result');
    const req = makeReq({ myMethod: method });
    const res = {};

    const wrapper = resolve('myController', 'myMethod');
    const result = await wrapper(req, res);

    expect(req.diScope.resolve).toHaveBeenCalledWith('myController');
    expect(method).toHaveBeenCalledWith(req, res);
    expect(result).toBe('result');
  });

  it('throws when the controller has no such method', async () => {
    const req = makeReq({});
    const wrapper = resolve('myController', 'myMethod');

    await expect(wrapper(req, {})).rejects.toThrow('Failed to resolve handler');
  });

  it('throws when the property is not a function', async () => {
    const req = makeReq({ myMethod: 'not a function' });
    const wrapper = resolve('myController', 'myMethod');

    await expect(wrapper(req, {})).rejects.toThrow('Failed to resolve handler');
  });
});

describe('resolveWsHandler', (it) => {
  it('resolves the controller and delegates to the named method with (socket, req)', async () => {
    const method = vi.fn().mockResolvedValue('result');
    const req = makeReq({ myMethod: method });
    const socket = {};

    const wrapper = resolveWs('myController', 'myMethod');
    const result = await wrapper(socket, req);

    expect(req.diScope.resolve).toHaveBeenCalledWith('myController');
    expect(method).toHaveBeenCalledWith(socket, req);
    expect(result).toBe('result');
  });

  it('throws when the controller has no such method', async () => {
    const req = makeReq({});
    const wrapper = resolveWs('myController', 'myMethod');

    await expect(wrapper({}, req)).rejects.toThrow(
      'Failed to resolve handler',
    );
  });

  it('throws when the property is not a function', async () => {
    const req = makeReq({ myMethod: 'not a function' });
    const wrapper = resolveWs('myController', 'myMethod');

    await expect(wrapper({}, req)).rejects.toThrow(
      'Failed to resolve handler',
    );
  });
});
