import { type Mock, describe, expect, vi } from 'vitest';

import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';

interface ClientLike {
  probes: { liveness: Mock };
}

function makeClient(result: [unknown, unknown]): ClientLike {
  return { probes: { liveness: vi.fn().mockResolvedValue(result) } };
}

function makeReply(): { res: unknown; code: Mock; send: Mock } {
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  return { res: { code }, code, send };
}

describe('ReadinessController', (it) => {
  function build(
    sm: [unknown, unknown] = [{ status: 'ok' }, null],
    ts: [unknown, unknown] = [{ status: 'ok' }, null],
  ) {
    const sessionManagerClient = makeClient(sm);
    const transcriptionServiceClient = makeClient(ts);
    const controller = new ReadinessController(
      sessionManagerClient as never,
      transcriptionServiceClient as never,
    );
    return { controller, sessionManagerClient, transcriptionServiceClient };
  }

  it('returns 200 with status ok when both upstreams are healthy', async () => {
    const { controller } = build();
    const { res, code, send } = makeReply();

    await controller.readiness({} as never, res as never);

    expect(code).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('returns 503 marking sessionManager fail when Session Manager is unhealthy', async () => {
    const { controller } = build(
      [null, new Error('session manager down')],
      [{ status: 'ok' }, null],
    );
    const { res, code, send } = makeReply();

    await controller.readiness({} as never, res as never);

    expect(code).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({
      status: 'fail',
      checks: { sessionManager: 'fail', transcriptionService: 'ok' },
    });
  });

  it('returns 503 marking transcriptionService fail when Transcription Service is unhealthy', async () => {
    const { controller } = build(
      [{ status: 'ok' }, null],
      [null, new Error('transcription service down')],
    );
    const { res, code, send } = makeReply();

    await controller.readiness({} as never, res as never);

    expect(code).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({
      status: 'fail',
      checks: { sessionManager: 'ok', transcriptionService: 'fail' },
    });
  });

  it('returns 503 with both checks fail when both upstreams are unhealthy', async () => {
    const { controller } = build(
      [null, new Error('session manager down')],
      [null, new Error('transcription service down')],
    );
    const { res, code, send } = makeReply();

    await controller.readiness({} as never, res as never);

    expect(code).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({
      status: 'fail',
      checks: { sessionManager: 'fail', transcriptionService: 'fail' },
    });
  });

  it('treats [data, null] as ok and [null, error] as fail, checking error === null', async () => {
    // [null, null] -> ok (data is null but error === null)
    // [null, Error] -> fail (error !== null)
    const { controller } = build([null, null], [null, new Error('boom')]);
    const { res, code, send } = makeReply();

    await controller.readiness({} as never, res as never);

    expect(code).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({
      status: 'fail',
      checks: { sessionManager: 'ok', transcriptionService: 'fail' },
    });
  });
});
