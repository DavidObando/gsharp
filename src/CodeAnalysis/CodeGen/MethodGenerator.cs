// <copyright file="MethodGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

using GSharp.Core.CodeAnalysis.Binding;
using Microsoft.CodeAnalysis.CodeGen;

namespace Gsharp.CodeAnalysis.CodeGen;

/// <summary>
/// Walks a <see cref="BoundBlockStatement"/> (already lowered by
/// <c>GSharp.Core.CodeAnalysis.Lowering</c>) and emits IL via Roslyn's
/// <see cref="ILBuilder"/>.
/// </summary>
/// <remarks>
/// Phase 1 only needs to handle a single Console.WriteLine call to produce a
/// runnable Hello World. Phase 2 expands to every <c>BoundNodeKind</c>.
/// </remarks>
internal sealed class MethodGenerator
{
    // TODO Phase 1: implement EmitMain(BoundBlockStatement, ILBuilder) producing
    //   ldstr / call System.Console::WriteLine(string) / ret for the prototype.
    // TODO Phase 2: full BoundNodeKind coverage.
}

#endif
