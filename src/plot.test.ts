import { describe, expect, it } from 'vitest';
import { parsePlot } from './plot';

describe('parsePlot', () => {
  it('reads labelled and unlabelled values', () => {
    expect(parsePlot('T:21.5 H=40')).toEqual([['T', 21.5], ['H', 40]]);
    expect(parsePlot('1,2,-3.5')).toEqual([['v0', 1], ['v1', 2], ['v2', -3.5]]);
    expect(parsePlot('temp: 1e3')).toEqual([['temp', 1000]]);
  });
  it('ignores lines without numbers', () => {
    expect(parsePlot('Booting…')).toEqual([]);
  });
});
