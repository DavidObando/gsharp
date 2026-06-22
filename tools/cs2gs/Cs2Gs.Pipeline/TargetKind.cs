// <copyright file="TargetKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

/// <summary>
/// The G# output kind a corpus app compiles to, selecting the <c>gsc</c>
/// <c>/target:</c> switch (ADR-0115 §C; <c>src/Compiler/Program.cs</c>).
/// </summary>
public enum TargetKind
{
    /// <summary>An executable (<c>/target:exe</c>).</summary>
    Exe,

    /// <summary>A class library (<c>/target:library</c>).</summary>
    Library,
}
