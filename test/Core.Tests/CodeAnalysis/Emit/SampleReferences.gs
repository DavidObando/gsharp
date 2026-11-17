// <copyright file="SampleReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System

/// Issue #4665: the explicit reference set the sample-hashing gates compile
/// against. `new Compilation(tree)` resolves through
/// `ReferenceResolver.Default()`, which is built from whatever
/// assemblies the test host happens to have loaded, so a G#-built Core or a
/// different host could change name resolution and the AssemblyRef/TypeRef
/// rows. The gates must hash what the compiler emits, not what the host
/// loaded, so they reference the targeting pack (the closure the .NET SDK
/// hands gsc) plus the bundled G# runtime assemblies, exactly as the driver does.
/// ADR-0223 D3 moved the construction into (cref:ReferenceResolver.ForReferencePack).
internal shared class SampleReferences {
    /// Builds the resolver for a sample compilation.
    /// @returns A resolver over the ref pack and the bundled G# runtime assemblies.
    internal func CreateResolver() ReferenceResolver -> ReferenceResolver.ForReferencePack(
        "net${Environment.Version.Major}.0"
    )
}
