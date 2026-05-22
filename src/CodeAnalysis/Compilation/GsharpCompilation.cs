// <copyright file="GsharpCompilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Emit;
using Roslyn.Utilities;

namespace Gsharp.CodeAnalysis.Compilation;

/// <summary>
/// GSharp's Roslyn-derived <see cref="Microsoft.CodeAnalysis.Compilation"/> subclass.
/// Bridges the GSharp <see cref="BoundProgram"/> to Roslyn's symbol/emit machinery so
/// the produced assembly is a real .NET PE.
/// </summary>
/// <remarks>
/// Mirrors <c>Pchp.CodeAnalysis.PhpCompilation</c> from peachpie:
/// <c>/tmp/peachpie-study/src/Peachpie.CodeAnalysis/Compilation/PhpCompilation.cs</c>.
/// </remarks>
public sealed partial class GsharpCompilation : Microsoft.CodeAnalysis.Compilation
{
    private GsharpCompilation(
        string? assemblyName,
        ImmutableArray<MetadataReference> references,
        IReadOnlyDictionary<string, string> features,
        bool isSubmission,
        SemanticModelProvider? semanticModelProvider,
        AsyncQueue<CompilationEvent>? eventQueue)
        : base(assemblyName, references, features, isSubmission, semanticModelProvider, eventQueue)
    {
    }

    // TODO Phase 1: implement public Create(...) factory accepting BoundProgram + references.
    // TODO Phase 1: implement required Compilation abstract overrides incrementally,
    //   replacing the NotImplementedException stubs in GsharpCompilation.Abstracts.cs
    //   (SourceModule, Assembly, GetSpecialType, ObjectType, DynamicType,
    //    ScriptClass, CommonGetEntryPoint, CommonCreateAnonymousTypeSymbol, …).
    // TODO Phase 1: delegate Emit to the PEModuleBuilder under Emitter/.
}

#endif
