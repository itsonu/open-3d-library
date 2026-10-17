# Procedural World Craft: Claude Code skill

A reusable skill for improving the realism and performance of a procedural Three.js/WebGL nature scene, and for building reusable procedural generators, without bloating the system with new features.

## Install

- **Per project:** keep this folder at `.claude/skills/procedural-world-craft/` (as in this repository).
- **For all your projects:** copy it to `~/.claude/skills/procedural-world-craft/`.

Claude Code uses the skill when a task matches its description, or you can ask for it explicitly:

> Use the `procedural-world-craft` skill to audit the current meadow. Fix the most visible realism issue only, then compare against the same camera/seed and report verified results.

## Contents

- `SKILL.md`: the FIELD method (Frame, Influence fields, Evolve forms, Link life, Demonstrate), implementation rules, debugging heuristics, change protocol and definition of done.
- `references/verified-lessons.md`: root causes and fixes verified on a real scene (coordinate spaces, fog/sky, fur-shell LOD, plant morphology, three.js r186 pitfalls, inspection traps).
- `references/benchmarking.md`: a repeatable measurement protocol.
- `references/generators-and-assets.md`: the generator contract and the licensing rules for example assets.
- `SYNTHESIS.md`: the short plain-language version.

It needs no runtime package. It tells the agent to inspect and reuse the project's existing systems.
