import { describe, expect, it } from 'vitest';
import { applyVars, parseHttpFile, requestAt } from './httpfile';

const SAMPLE = `@host = https://api.example.com
@token = abc

### Login
POST {{host}}/login HTTP/1.1
Content-Type: application/json
# a comment

{"user": "a",
 "pass": "b"}

###
GET {{host}}/items
  ?page=2
  &sort=name
Authorization: Bearer {{token}}

### third
https://example.com/plain
`;

describe('parseHttpFile', () => {
  const { requests, vars } = parseHttpFile(SAMPLE);
  it('reads variables and splits requests', () => {
    expect(vars).toEqual({ host: 'https://api.example.com', token: 'abc' });
    expect(requests.map((r) => [r.method, r.line])).toEqual([['POST', 5], ['GET', 13], ['GET', 19]]);
    expect(requests[0]!.title).toBe('Login');
  });
  it('takes headers, skips comments and keeps the body', () => {
    expect(requests[0]!.headers).toEqual([['Content-Type', 'application/json']]);
    expect(requests[0]!.body).toBe('{"user": "a",\n "pass": "b"}');
  });
  it('joins continued query lines', () => {
    expect(requests[1]!.url).toBe('{{host}}/items?page=2&sort=name');
    expect(requests[1]!.headers[0]).toEqual(['Authorization', 'Bearer {{token}}']);
  });
  it('treats a bare URL as GET', () => {
    expect(requests[2]).toMatchObject({ method: 'GET', url: 'https://example.com/plain' });
  });
  it('finds the request under the cursor', () => {
    expect(requestAt(requests, 8)?.line).toBe(5);
    expect(requestAt(requests, 3)).toBeUndefined();
  });
});

describe('stray lines', () => {
  it('do not turn into requests', () => {
    expect(parseHttpFile('}\nGET\nfoo bar baz\n').requests).toEqual([]);
    expect(parseHttpFile('/health\n').requests).toHaveLength(1);
  });
});

describe('applyVars', () => {
  it('substitutes known names and leaves unknown ones', () => {
    expect(applyVars('{{a}}/{{ b }}/{{c}}', { a: '1', b: '2' })).toBe('1/2/{{c}}');
    expect(applyVars('{{$guid}}', {})).toMatch(/^[0-9a-f-]{36}$/);
    expect(applyVars('{{$timestamp}}', {})).toMatch(/^\d{10}$/);
  });
});
