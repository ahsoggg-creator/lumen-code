import { describe, expect, it } from 'vitest';
import { compareCells, detectDelimiter, parseCsv } from './csv';

describe('parseCsv', () => {
  it('handles quotes, embedded delimiters and line breaks', () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi"""\n"line\nbreak",2\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['line\nbreak', '2']]);
  });
  it('reads CRLF files, a BOM and a last line without a newline', () => {
    expect(parseCsv('﻿a;b\r\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('stops at the row limit', () => {
    expect(parseCsv('1\n2\n3\n4\n', ',', 2)).toHaveLength(2);
  });
});

describe('detectDelimiter', () => {
  it('finds semicolons, tabs and commas', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('a,b\n1,2')).toBe(',');
    expect(detectDelimiter('single column')).toBe(',');
  });
});

describe('compareCells', () => {
  it('sorts numbers numerically and blanks last', () => {
    expect(['10', '9', '', 'b', 'a'].sort(compareCells)).toEqual(['9', '10', 'a', 'b', '']);
  });
});
