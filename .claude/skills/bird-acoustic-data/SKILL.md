---
name: bird-acoustic-data
description: Curation rules for Chirping's species catalogue (BIRD_DB in index.html and docs/bird-db-provenance.json). Use whenever adding, correcting or reviewing a species entry, its frequencies (fmin/fmax/fdom), vocal descriptors (t, nr), confidence codes (c, cf), regions (r), synonyms (sy) or fun facts — and before trusting catalogue values in any analysis. Defines each field as a measurable quantity, the provenance and anti-templating rules, and the lint/degeneracy checks (tests/db-lint.mjs) every change must pass.
---

# Bird acoustic data — curating BIRD_DB

You are acting as the panel's ornithologist-bioacoustician. The classifier can be no better than the
catalogue: v3.2 had only 122 distinct (fmin,fmax,fdom) triples for 219 species (18 shared 1500/7000/3500),
which capped *any* frequency-only classifier at 55.7 % top-1, and contained hummingbirds listed at
1.0–1.2 kHz (their chips are 2–10 kHz) and a Bohemian Waxwing filed as "Cedar Waxwing".

## Field definitions (each is something analyzePCM measures — keep them comparable)

| Field | Definition | Measured counterpart |
|---|---|---|
| `fdom` | Frequency of maximum energy of the time-averaged spectrum of the **primary advertising vocalization** (song for songbirds; the characteristic, most-recorded call otherwise — owl hoot/screech, dove coo, raptor scream, woodpecker drum) | aggregate-spectrum `peak` |
| `fmin`/`fmax` | Lower/upper limits of that vocalization's visible energy (≈ −20 dB from peak; Raven Freq 5 %/95 % widened slightly). Not the whole repertoire | `f5`/`f95` (must fall inside) |
| `t` | Dominant texture: `w` tonal whistle (incl. near-pure hoots), `h` harmonic stack, `n` noisy/harsh/buzzy, `t` trill (≥ ~8 similar notes/s), `c` complex warble / mimicry, `p` percussive (drum, bill-clatter) | `conc1`, `conc3`, `pitchIQR` |
| `nr` | `[lo,hi]` notes or syllables per second **within a bout**; `null` for a single sustained note | `noteRate` |
| `c` / `cf` | Confidence `h`/`m`/`l` in (`t`,`nr`) / in the frequencies. `h` = established and documented, `m` = plausible from the species or genus, `l` = uncertain or unchanged template | model trusts `c` at 0.9/0.75/0.5 and widens σ by 1/1.25/1.6 for `cf` |
| `r` | Realms where the species **regularly** occurs — breeding, wintering, or an established introduced population; never vagrants | soft region prior |
| `sy` | Other binomials/trinomials under which iNaturalist/GBIF list the same population (recent splits, genus moves) | occurrence-prior name matching |

Invariant: `fmin < fdom < fmax`, 50 Hz ≤ fmin, fmax ≤ 16 kHz, fmax/fmin ≥ 1.2.

## Realms (`r`) — must match `getRegions` boxes in index.html

`na` North & Central America + Caribbean · `sa` South America · `eu` Europe (+ Maghreb, Levant,
Turkey via overlapping boxes) · `as` Asia incl. Middle East, Siberia, South & SE Asia to Wallacea ·
`af` Africa incl. Madagascar and the Mascarenes · `au` Australia, New Zealand, New Guinea.
Hawaii and remote Pacific islands map to **no** realm: do not add `au` for a Hawaii-only introduction
(it would put the species in front of mainland-Australian users).

## Provenance and honesty rules

1. Every changed entry gets a record in `docs/bird-db-provenance.json`: `{n, s, changed:[fields], c, cf,
   why}` — `why` names the reference vocalization and the basis (published measurement, sonogram,
   genus knowledge). Unchanged-but-reviewed entries are recorded too.
2. **No templating.** Do not copy another species' triple. Give species-specific values at the precision
   actually known (nearest 50 Hz is fine); if you cannot improve a value, leave it and set `cf:"l"`.
   212 of 220 `fdom` values are still on a 100 Hz grid — treat that as a to-do list, not a style.
3. **Never invent precision.** A value from memory is `m` at best. `h` needs a documented measurement.
4. Prefer IOC/Clements current taxonomy for `s`; put the previous name in `sy`. When a split leaves a
   region uncovered (Common Moorhen → Common Gallinule in the Americas), add the daughter species rather
   than deleting the region.
5. Sanity-check pitch against body size: dominant frequency falls with mass roughly as M^−0.3 to M^−0.4
   among passerines (large corvids ~1 kHz, small warblers/crests 6–8 kHz). A 3 g hummingbird at 1 kHz or
   a 4 kg goose at 6 kHz is a red flag.
6. Fun facts are claims: correct the false ones (v4 fixed e.g. the disproved pigeon beak-magnetite story).

## Checks to run

`node tests/db-lint.mjs` — fails on any invariant violation and prints the degeneracy report: the top-1
ceiling under perfect measurement for frequency-only matching and with `t`+`nr`, globally and per realm
(two species are frequency-twins when fdom differs <5 % and both band edges <10 %; descriptor-twins when
also `t` matches and `nr` ranges overlap). Current: 54.5 % → 77.3 % global, 85.7–94.4 % per realm. A
change that lowers the descriptor ceiling needs a reason in the provenance file.

## Merging curated batches

Large reviews are done by parallel expert agents writing JSON `{key: <current s>, set:{changed fields},
t, nr, c, cf, sy, why}` (one record per species, none skipped), merged by a script that rewrites each
3-line entry in place (`{n,s,fmin,fmax,fdom,r,t,nr,c,cf[,sy],` / `h` / `f,w}`) so section comments
survive. Check the last array element too — it is followed by `\n];`, not `},\n`.
