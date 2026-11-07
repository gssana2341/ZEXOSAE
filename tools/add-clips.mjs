// Adds animation clips from a Quaternius Universal Animation Library pack to the
// finished public/models/hero/hero.glb. The pack shares the hero's skeleton, so the
// clips copy across bone by bone. The pack itself is not kept in this repository.
//
//   node tools/add-clips.mjs <pack .glb, without root motion> <clip name>...
//
// The climbing clips come from the Pro version of the first library (UAL1.glb):
//   node tools/add-clips.mjs tools/anims/Unreal-Godot/UAL1.glb Climb_Idle_Loop Climb_Up_Loop \
//     Climb_Down_Loop Climb_Left_Loop Climb_Right_Loop ClimbLedge

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample } from '@gltf-transform/functions';

const [packFile, ...names] = process.argv.slice(2);
if (!packFile || names.length === 0) throw new Error('Pass the pack and the clips to add.');

const OUT_DIR = 'public/models/hero';
const HERO = path.join(OUT_DIR, 'hero.glb');
/** Hands only show their fingers on a wall, where they grip. Elsewhere fingers stay still. */
const KEEP_FINGERS = /^Climb/;
const FINGER = /^(index|middle|ring|pinky|thumb)_/;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const hero = await io.read(HERO);
const root = hero.getRoot();
const pack = await io.read(packFile);
const buffer = root.listBuffers()[0];
const nodeByName = new Map(root.listNodes().map((n) => [n.getName(), n]));

function copyAccessor(accessor) {
  return hero.createAccessor().setType(accessor.getType()).setArray(accessor.getArray().slice()).setBuffer(buffer);
}

for (const name of names) {
  const clip = pack.getRoot().listAnimations().find((a) => a.getName() === name);
  if (!clip) throw new Error(`Missing clip ${name}`);
  root.listAnimations().find((a) => a.getName() === name)?.dispose();

  const copy = hero.createAnimation(name);
  for (const channel of clip.listChannels()) {
    const bone = channel.getTargetNode()?.getName();
    const target = nodeByName.get(bone);
    if (!target) continue;
    if (FINGER.test(bone) && !KEEP_FINGERS.test(name)) continue;
    // The pack's body has different proportions: moving bones would stretch the hero.
    if (channel.getTargetPath() !== 'rotation' && bone !== 'pelvis' && bone !== 'root') continue;

    const sampler = channel.getSampler();
    const newSampler = hero
      .createAnimationSampler()
      .setInterpolation(sampler.getInterpolation())
      .setInput(copyAccessor(sampler.getInput()))
      .setOutput(copyAccessor(sampler.getOutput()));
    copy.addSampler(newSampler);
    copy.addChannel(
      hero.createAnimationChannel().setTargetNode(target).setTargetPath(channel.getTargetPath()).setSampler(newSampler),
    );
  }
}

await hero.transform(resample({ tolerance: 0.002 }), dedup(), prune());
await io.write(HERO, hero);

const clips = JSON.parse(readFileSync(path.join(OUT_DIR, 'clips.json'), 'utf8'));
for (const name of names) if (!clips.includes(name)) clips.push(name);
writeFileSync(path.join(OUT_DIR, 'clips.json'), JSON.stringify(clips, null, 2) + '\n');
console.log(`hero.glb ${Math.round(statSync(HERO).size / 1024)} KB, ${root.listAnimations().length} clips`);
