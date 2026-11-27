import { describe, expect, it } from 'vitest';

describe('transport async dispatch', () => {
  it('ack callback returns within 100ms when handler is dispatched via setImmediate', async () => {
    let handlerStarted = false;
    let handlerResolved = false;

    const slowHandler = async () => {
      handlerStarted = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      handlerResolved = true;
    };

    const start = Date.now();
    let callbackResolvedAt = 0;

    await new Promise<void>((ackResolve) => {
      setImmediate(() => {
        slowHandler().catch(() => {});
      });
      callbackResolvedAt = Date.now();
      ackResolve();
    });

    const elapsed = callbackResolvedAt - start;
    expect(elapsed).toBeLessThan(100);
    expect(handlerResolved).toBe(false);
    expect(handlerStarted).toBe(false);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handlerStarted).toBe(true);
    expect(handlerResolved).toBe(false);
  });

  it('handler error after async dispatch does not crash the ack path', async () => {
    const errors: unknown[] = [];
    const failingHandler = async () => {
      throw new Error('handler failure');
    };

    await new Promise<void>((ackResolve) => {
      setImmediate(() => {
        failingHandler().catch((err) => { errors.push(err); });
      });
      ackResolve();
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('handler failure');
  });
});
