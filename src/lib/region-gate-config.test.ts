/**
 * @jest-environment node
 */
import { gateConfigProblems, gateConfigured } from './region-gate';

const saved = {
  PASSWORD: process.env.GATE_PASSWORD,
  SECRET: process.env.GATE_SECRET,
};

afterEach(() => {
  if (saved.PASSWORD === undefined) delete process.env.GATE_PASSWORD;
  else process.env.GATE_PASSWORD = saved.PASSWORD;
  if (saved.SECRET === undefined) delete process.env.GATE_SECRET;
  else process.env.GATE_SECRET = saved.SECRET;
});

describe('gate configuration', () => {
  it('reports nothing missing when both values are set', () => {
    process.env.GATE_PASSWORD = 'open-sesame';
    process.env.GATE_SECRET = 'x'.repeat(32);
    expect(gateConfigProblems()).toEqual([]);
    expect(gateConfigured()).toBe(true);
  });

  it('names the missing password', () => {
    delete process.env.GATE_PASSWORD;
    process.env.GATE_SECRET = 'x'.repeat(32);
    const problems = gateConfigProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GATE_PASSWORD');
    expect(gateConfigured()).toBe(false);
  });

  it('names a secret that is missing or shorter than 32 characters', () => {
    process.env.GATE_PASSWORD = 'open-sesame';
    process.env.GATE_SECRET = 'too-short';
    expect(gateConfigProblems().join('|')).toContain('GATE_SECRET');
    delete process.env.GATE_SECRET;
    expect(gateConfigProblems().join('|')).toContain('GATE_SECRET');
  });

  it('lists both problems when nothing is set', () => {
    delete process.env.GATE_PASSWORD;
    delete process.env.GATE_SECRET;
    const problems = gateConfigProblems();
    expect(problems).toHaveLength(2);
    expect(problems.join('|')).toContain('GATE_PASSWORD');
    expect(problems.join('|')).toContain('GATE_SECRET');
  });
});
