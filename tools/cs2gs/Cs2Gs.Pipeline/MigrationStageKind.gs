// <copyright file="MigrationStageKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

/// The four ordered migration stages (ADR-0115 §C). All four are implemented:
/// stage 1 translates, stage 2 compiles, stage 3 IL-verifies, and stage 4
/// ((cref:TestParity)) proves runtime/test parity with the original C#.
enum MigrationStageKind {
    Translate,
    Compile,
    IlVerify,
    TestParity
}

/// The triage category recorded on a failure artifact (ADR-0115 §D.1). One
/// value per stage, plus (cref:PipelineCrash) for "the stage itself
/// fell over", which belongs to no stage in particular.
enum TriageCategory {
    TranslationUnsupported,
    CompileError,
    IlVerifyFailure,
    TestParityFailure,
    PipelineCrash
}

/// The outcome of a single stage for a single corpus app.
enum StageStatus {
    Skipped,
    Passed,
    Failed
}
