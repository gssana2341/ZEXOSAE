import { describe, expect, it } from 'vitest';
import { windowGeometry } from '../src/render/window-lights';
import type { Box } from '../src/sim/map';

describe('city window lights', () => {
  it('puts one orderly grid on each wall and leaves the roof clear', () => {
    const building: Box = { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 24, z: 10 }, kind: 'building', style: 'glass' };
    const landmark: Box = { ...building, landmark: 'observation' };
    const geometry = windowGeometry([building, landmark], []);
    const position = geometry.getAttribute('position');
    expect(position.count).toBe(16);
    expect(geometry.getIndex()!.count).toBe(24);
    for (let i = 0; i < position.count; i += 1) {
      expect(position.getY(i)).toBeGreaterThanOrEqual(3.2 - 0.001);
      expect(position.getY(i)).toBeLessThan(24);
      expect(Math.max(Math.abs(position.getX(i)), Math.abs(position.getZ(i)))).toBeCloseTo(10.25, 3);
    }
    geometry.dispose();
  });
});
