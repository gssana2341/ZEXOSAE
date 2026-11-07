// Builds public/models/hero/hero.glb from the Quaternius packs: the Superhero body
// and the animation clips the game uses, cut down for the web. The downloaded packs
// are not kept in this repository.
//
//   node tools/build-hero.mjs <folder holding the extracted packs>

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = process.argv[2];
if (!root) throw new Error('Pass the folder holding the extracted packs.');

const BODY = path.join(root, 'base/Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf');
const UAL1 = path.join(root, 'ual1/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb');
const UAL2 = path.join(root, 'ual2/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb');
const LICENSE = path.join(root, 'ual1/Universal Animation Library[Standard]/License.txt');
const OUT_DIR = 'public/models/hero';

const CLIPS = [
  [UAL1, 'Idle_Loop'],
  [UAL1, 'Jog_Fwd_Loop'],
  [UAL1, 'Sprint_Loop'],
  [UAL1, 'Jump_Loop'],
  [UAL1, 'Roll'],
  [UAL2, 'NinjaJump_Idle_Loop'],
  [UAL2, 'Slide_Loop'],
];

const TEXTURE_SIZE = 512;
const KEEP_TRIANGLES = 0.42;
/** Fingers don't read at game distance, and they are most of the animation data. */
const SKIP_BONES = /^(index|middle|ring|pinky|thumb)_/;

/**
 * Turns the bare skin into a one-colour suit: greyscale keeps the muscle shading, and
 * the game tints it per player. The head becomes a mask with a bright visor.
 * Positions are shares of the texture, from where the source sheet lays out the face.
 */
async function suitTexture(source) {
  const size = TEXTURE_SIZE;
  const px = (share) => Math.round(share * size);
  const mask = Buffer.from(`<svg width="${size}" height="${size}">
    <rect x="0" y="0" width="${px(0.36)}" height="${px(0.375)}" fill="#8d8d8d"/>
    <rect x="${px(0.24)}" y="${px(0.32)}" width="${px(0.27)}" height="${px(0.18)}" fill="#8d8d8d"/>
    <rect x="${px(0.08)}" y="${px(0.155)}" width="${px(0.21)}" height="${px(0.05)}" rx="${px(0.02)}" fill="#ffffff"/>
  </svg>`);

  return sharp(source)
    .resize(size, size)
    .greyscale()
    .normalise({ lower: 2, upper: 98 })
    // Lifted, because the game multiplies this by the suit colour.
    .linear(1.15, 62)
    .composite([{ input: mask }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

function copyAccessor(doc, accessor, buffer) {
  return doc
    .createAccessor()
    .setType(accessor.getType())
    .setArray(accessor.getArray().slice())
    .setBuffer(buffer);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready;

// Some texture names in the pack have a stray _png suffix, so those files aren't found.
const bodyFolder = path.dirname(BODY);
for (const { uri } of JSON.parse(readFileSync(BODY, 'utf8')).images) {
  const wanted = path.join(bodyFolder, uri);
  const actual = path.join(bodyFolder, uri.replace('_png.png', '.png'));
  if (!existsSync(wanted) && existsSync(actual)) copyFileSync(actual, wanted);
}

const hero = await io.read(BODY);
const heroRoot = hero.getRoot();

// Keep the body only: hair and eyes would poke through the mask.
for (const node of heroRoot.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const isBody = mesh.listPrimitives().some((p) => p.getMaterial()?.getName().startsWith('MI_Superhero'));
  if (!isBody) {
    node.setMesh(null);
    node.setSkin(null);
  }
}

const material = heroRoot.listMaterials().find((m) => m.getName().startsWith('MI_Superhero'));
const baseColor = material.getBaseColorTexture();
baseColor.setImage(await suitTexture(baseColor.getImage())).setMimeType('image/jpeg').setURI('suit.jpg');
material
  .setName('Suit')
  .setNormalTexture(null)
  .setMetallicRoughnessTexture(null)
  .setMetallicFactor(0)
  .setRoughnessFactor(0.55);

const buffer = heroRoot.listBuffers()[0];
const nodeByName = new Map(heroRoot.listNodes().map((n) => [n.getName(), n]));
const packs = new Map();

for (const [file, name] of CLIPS) {
  if (!packs.has(file)) packs.set(file, await io.read(file));
  const clip = packs.get(file).getRoot().listAnimations().find((a) => a.getName() === name);
  if (!clip) throw new Error(`Missing clip ${name}`);

  const copy = hero.createAnimation(name);
  for (const channel of clip.listChannels()) {
    const bone = channel.getTargetNode()?.getName();
    const target = nodeByName.get(bone);
    if (!target || SKIP_BONES.test(bone)) continue;

    const sampler = channel.getSampler();
    const newSampler = hero
      .createAnimationSampler()
      .setInterpolation(sampler.getInterpolation())
      .setInput(copyAccessor(hero, sampler.getInput(), buffer))
      .setOutput(copyAccessor(hero, sampler.getOutput(), buffer));
    copy.addSampler(newSampler);
    copy.addChannel(
      hero
        .createAnimationChannel()
        .setTargetNode(target)
        .setTargetPath(channel.getTargetPath())
        .setSampler(newSampler),
    );
  }
}

await hero.transform(
  prune({ keepAttributes: false }),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: KEEP_TRIANGLES, error: 0.004 }),
  resample({ tolerance: 0.002 }),
  dedup(),
  prune(),
);

mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'hero.glb');
await io.write(out, hero);
copyFileSync(LICENSE, path.join(OUT_DIR, 'License.txt'));

const triangles = heroRoot
  .listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
console.log(`hero.glb ${Math.round(statSync(out).size / 1024)} KB, ${Math.round(triangles)} triangles, ${heroRoot.listAnimations().length} clips`);
writeFileSync(path.join(OUT_DIR, 'clips.json'), JSON.stringify(CLIPS.map(([, name]) => name), null, 2) + '\n');
