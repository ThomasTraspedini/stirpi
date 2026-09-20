# O2-FS source and holdout protocol

## Purpose and scope

This is a design checkpoint for a prospective evaluation surface. It records a
small set of source and review principles; it does not distribute a benchmark,
a frozen study, or a run.

## Two roles for material

**Exposed historical material (E)** may inform pattern discovery and rubric
construction. Exposure must be supported by evidence for the material in
question; a source name alone does not establish it.

**Prospective holdout design (C)** prioritizes prospective-real cases:
requirements, defects, or features that are genuinely desired by real projects.
A case is registered before both its classification and analysis of expected
behavior. This checkpoint does not prescribe an order between those two later
activities, and historical material used as E cannot be retroactively treated
as C.

## Runtime and target in dogfooding

Dogfooding may use a frozen runtime to develop a target copy. The runtime and
target have separate identities and provenance. The resulting target output is
not used retrospectively to validate the runtime that produced it.

## Purpose-built cases

Purpose-built cases may be included when needed for coverage. They are
identified separately, complement the prospective-real cases, and do not
dominate the corpus. This checkpoint sets no numeric threshold or other
quantitative criterion for that role.

## Decisions still open

Concrete sources, cases, classifications or rubrics, case counts, thresholds,
proportions, allocation, seeds, and quantitative criteria for purpose-built
coverage remain open. The operational procedure for registration also remains
undefined.

The following items are not distributed by this checkpoint:

- manifest
- allocation
- inventory
- witness

This checkpoint does not claim an O2-FS task universe or operational holdout,
a new result, verified independence, assurance, feasibility, complete
preregistration, or a new runtime capability.

This checkpoint does not grant access to any source material.

## Relationship to existing public material

The documented [H/S/T pilot](../p1-hst/RESULTS.md) and its [recorded offline
replay](../p1-hst/REPLAY.md) are existing public history. The replay verifies
recorded transitions and is not a new experiment. This design checkpoint is
separate from both and does not authorize or supply a new run. Apply the design
through the [manual review checklist](REVIEW-CHECKLIST.md).
