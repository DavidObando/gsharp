// <copyright file="MigrationStageKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

/// <summary>
/// The four ordered migration stages (ADR-0115 §C). Stages 1–2 are implemented;
/// stages 3–4 are reserved so the <c>stage</c> field of the triage schema
/// (§D.1) is stable before <see cref="IlVerify"/> / <see cref="TestParity"/>
/// land in a later step.
/// </summary>
public enum MigrationStageKind
{
    /// <summary>Stage 1 — C#→G# translation plus round-trip parse (<c>translate</c>).</summary>
    Translate,

    /// <summary>Stage 2 — compile the emitted G# with the real <c>gsc</c> (<c>compile</c>).</summary>
    Compile,

    /// <summary>Stage 3 — IL verification of the emitted assembly (<c>ilverify</c>). Reserved.</summary>
    IlVerify,

    /// <summary>Stage 4 — test parity against the C# baseline oracle (<c>test-parity</c>). Reserved.</summary>
    TestParity,
}

/// <summary>
/// The triage category recorded on a failure artifact (ADR-0115 §D.1). One
/// value per stage; all four are defined now even though only the first two are
/// produced, so the schema does not shift when stages 3–4 land.
/// </summary>
public enum TriageCategory
{
    /// <summary>A C# construct with no canonical G# form (stage 1).</summary>
    TranslationUnsupported,

    /// <summary>A <c>gsc</c> error compiling the emitted G# (stage 2).</summary>
    CompileError,

    /// <summary>An <c>ilverify</c> failure on the emitted assembly (stage 3). Reserved.</summary>
    IlVerifyFailure,

    /// <summary>A ported-test parity mismatch against the C# baseline (stage 4). Reserved.</summary>
    TestParityFailure,
}

/// <summary>
/// The outcome of a single stage for a single corpus app.
/// </summary>
public enum StageStatus
{
    /// <summary>The stage did not run (a prior stage failed and short-circuited it).</summary>
    Skipped,

    /// <summary>The stage ran and its pass gate held.</summary>
    Passed,

    /// <summary>The stage ran and its pass gate failed; remaining stages are skipped.</summary>
    Failed,
}
