/**
 * @jest-environment node
 */
import { nodeResolve } from './dns-node';

describe('nodeResolve', () => {
  it('returns the addresses a name resolves to on the Node runtime', async () => {
    const addresses = await nodeResolve('localhost');
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((address) => /^[0-9a-f:.]+$/i.test(address))).toBe(
      true
    );
    expect(addresses).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(127\.0\.0\.1|::1)$/)])
    );
  });

  it('rejects when the name does not exist', async () => {
    await expect(nodeResolve('no-such-host.invalid')).rejects.toThrow();
  });
});
