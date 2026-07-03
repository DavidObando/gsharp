// <copyright file="MigrationStageKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

/// <summary>
/// The four ordered migration stages (ADR-0115 §C). All four are implemented:
/// stage 1 translates, stage 2 compiles, stage 3 IL-verifies, and stage 4
/// (<see cref="TestParity"/>) proves runtime/test parity with the original C#.
/// </summary>
public enum MigrationStageKind
{
    /// <summary>Stage 1 — C#→G# translation plus round-trip parse (<c>translate</c>).</summary>
    Translate,

    /// <summary>Stage 2 — compile the emitted G# with the real <c>gsc</c> (<c>compile</c>).</summary>
    Compile,

    /// <summary>Stage 3 — IL verification of the emitted assembly (<c>ilverify</c>).</summary>
    IlVerify,

    /// <summary>Stage 4 — test parity against the C# baseline oracle (<c>test-parity</c>).</summary>
    TestParity,
}

/// <summary>
/// The triage category recorded on a failure artifact (ADR-0115 §D.1). One
/// value per stage.
/// </summary>
public enum TriageCategory
{
    /// <summary>A C# construct with no canonical G# form (stage 1).</summary>
    TranslationUnsupported,

    /// <summary>A <c>gsc</c> error compiling the emitted G# (stage 2).</summary>
    CompileError,

    /// <summary>An <c>ilverify</c> failure on the emitted assembly (stage 3).</summary>
    IlVerifyFailure,

    /// <summary>A ported-test parity mismatch against the C# baseline (stage 4).</summary>
    TestParityFailure,
}

/// <summary>
/// The outcome of a single stage for a single corpus app.
/// </summary>
public enum StageStatus
{
    /// <summary>
    /// The stage was not verified: either it did not run (a prior stage failed
    /// and short-circuited it), or it ran but a dependency it needs to verify
    /// (e.g. a locally-built SDK, or a not-yet-implemented translation step) is
    /// genuinely unavailable. Distinct from <see cref="Passed"/> — "not
    /// verified" must never render as "verified green" (issue #1749).
    /// </summary>
    Skipped,

    /// <summary>The stage ran and its pass gate held.</summary>
    Passed,

    /// <summary>The stage ran and its pass gate failed; remaining stages are skipped.</summary>
    Failed,
}
