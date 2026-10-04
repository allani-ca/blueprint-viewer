import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlueprint } from '../src/parser/blueprint';

describe('parseBlueprint', () => {
  it('parses the sample blueprint', () => {
    const text = readFileSync('public/samples/sheepshank-chickencoop.blueprint', 'utf8');
    const bp = parseBlueprint(text);
    expect(bp.metadata.name).toBe('ChickenCoop');
    expect(bp.metadata.creator).toBe('Sheepshank');
    expect(bp.metadata.category).toBe('Blueprints');
    expect(bp.metadata.description).toBe('');
    expect(bp.terrain).toHaveLength(3);
    expect(bp.terrain[0]).toMatchObject({ shape: 'square', radius: 3.5, rotation: 23, smooth: 0.3 });
    expect(bp.pieces).toHaveLength(1584 - 9);
    expect(bp.rejected).toHaveLength(0);
    expect(bp.pieces[0]).toMatchObject({
      prefab: 'stone_floor_2x2',
      table: 'BuildingStonecutter',
      data: '',
      scale: [1, 1, 1],
    });
    expect(bp.pieces[0].position[0]).toBeCloseTo(-0.6947937);
    expect(bp.pieces[0].rotation[3]).toBeCloseTo(0.5555702);
    const scaled = bp.pieces.find((p) => p.prefab === 'wood_wall_roof_upsidedown');
    expect(scaled?.scale).toEqual([1, 1, 1.05]);
    const sign = bp.pieces.find((p) => p.prefab === 'sign');
    expect(sign?.data).toBe('<color=white>Chicken Coop');
    const tiny = bp.pieces.find((p) => p.raw.includes('-4.371139E-08'));
    expect(tiny?.rotation[3]).toBeCloseTo(0, 6);
  });

  it('keeps unknown headers, sections and malformed lines', () => {
    const bp = parseBlueprint(
      '#Name:X\r\n#Foo:bar\r\n#Pieces\r\nwall;Building;1;2;3;0;0;0;1;"";1;1;1;extra1\r\nbroken;line\r\n#TerrainHeight\r\n1;2;3\r\n',
    );
    expect(bp.extraHeaders).toEqual([{ key: 'Foo', value: 'bar', line: 2 }]);
    expect(bp.pieces).toHaveLength(1);
    expect(bp.pieces[0].extra).toEqual(['extra1']);
    expect(bp.rejected).toHaveLength(1);
    expect(bp.unknownSections[0].lines).toEqual([{ line: 7, text: '1;2;3' }]);
  });

  it('defaults scale to 1 and strips (Clone) from names', () => {
    const bp = parseBlueprint('#Pieces\nwood_beam(Clone);Building;0,5;1;2;0;0;0;1;""\n');
    expect(bp.pieces[0].prefab).toBe('wood_beam');
    expect(bp.pieces[0].position).toEqual([0.5, 1, 2]);
    expect(bp.pieces[0].scale).toEqual([1, 1, 1]);
  });
});
