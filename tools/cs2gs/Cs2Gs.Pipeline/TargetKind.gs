// <copyright file="TargetKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

/// The G# output kind a corpus app compiles to, selecting the `gsc`
/// `/target:` switch (ADR-0115 §C; `src/Compiler/Program.cs`).
enum TargetKind {
    Exe,
    Library
}
