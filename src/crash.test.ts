import { describe, expect, it } from 'vitest';
import { crashAddresses, isCrashHeader, matchProjectFile, networkPorts } from './crash';

describe('crashAddresses', () => {
  it('takes the program counters of an Xtensa backtrace', () => {
    expect(crashAddresses('Backtrace: 0x400d1234:0x3ffb1f50 0x400d5678:0x3ffb1f70')).toEqual(['0x400d1234', '0x400d5678']);
  });
  it('reads RISC-V lists and registers', () => {
    expect(crashAddresses('Backtrace: 0x42001234 0x42005678')).toEqual(['0x42001234', '0x42005678']);
    expect(crashAddresses('MEPC    : 0x42001234  RA      : 0x42005678  SP      : 0x3fc90000')).toEqual(['0x42001234', '0x42005678']);
    expect(crashAddresses('PC      : 0x400d1234  PS      : 0x00060030')).toEqual(['0x400d1234']);
  });
  it('ignores ordinary lines and null addresses', () => {
    expect(crashAddresses('Temperature: 21.5')).toEqual([]);
    expect(crashAddresses('Backtrace: 0x00000000:0x3ffb0000')).toEqual([]);
  });
  it('recognises crash headers', () => {
    expect(isCrashHeader("Guru Meditation Error: Core  1 panic'ed (LoadProhibited).")).toBe(true);
    expect(isCrashHeader('hello')).toBe(false);
  });
});

describe('matchProjectFile', () => {
  const files = ['C:\\proj\\sketch\\sketch.ino', 'C:\\proj\\sketch\\lib\\wifi.cpp', 'C:\\proj\\other\\wifi.cpp'];
  it('maps a build-machine path onto the project by its tail', () => {
    expect(matchProjectFile('D:/build/tmp/sketch/sketch.ino', files)).toBe('C:\\proj\\sketch\\sketch.ino');
    expect(matchProjectFile('/x/lib/wifi.cpp', files)).toBe('C:\\proj\\sketch\\lib\\wifi.cpp');
  });
  it('does not guess between equal names', () => {
    expect(matchProjectFile('/x/wifi.cpp', files)).toBeNull();
  });
});

describe('networkPorts', () => {
  it('finds network boards in both output shapes', () => {
    const a = JSON.stringify({ detected_ports: [{ port: { address: '192.168.1.5', label: 'esp32 at 192.168.1.5', protocol: 'network' } }, { port: { address: 'COM3', protocol: 'serial' } }] });
    expect(networkPorts(a)).toEqual([{ address: '192.168.1.5', label: 'esp32 at 192.168.1.5' }]);
    expect(networkPorts(JSON.stringify([{ address: '10.0.0.2', protocol: 'network' }]))).toEqual([{ address: '10.0.0.2', label: '10.0.0.2' }]);
    expect(networkPorts('not json')).toEqual([]);
  });
});
