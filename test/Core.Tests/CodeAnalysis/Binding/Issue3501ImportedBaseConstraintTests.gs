// <copyright file="Issue3501ImportedBaseConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

/// Issue #3501 (the GSharpAnalyzerVerifier wall): two composed gaps around a
/// class constraint whose base lives in a REFERENCED assembly.
/// (1) `SatisfiesClassConstraint` never walked a SOURCE class's base chain to
/// its `ImportedBaseType`, so `class Derived : ImportedBase` failed
/// `[T ImportedBase]` (GS0152). (2) A `T`-typed argument erased to bare
/// `object` in overload gating, so `ImmutableArray.Create[ImportedBase](T())`
/// found no applicable overload (GS0159); it now erases to the constraint's
/// CLR class.
open class Issue3501ImportedBaseConstraintTests {
    @Fact
    func SourceClassDerivingImportedBase_SatisfiesConstraint_AndTTypedArgumentBinds() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue3501ImportedBase")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue3501.Base.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package IC.Analyzers

open class Base {
    prop Id string -> "b"
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libraryResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue3501.Base")
            Assert.True(libraryResult.Success, string.Join(Environment.NewLine, libraryResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue3501.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package IC.Consumer

import IC.Analyzers
import System.Collections.Immutable

class Derived : Base {
}

class Runner[T Base init()] {
    func Go() int32 {
        let items = ImmutableArray.Create[Base](T())
        return items.Length
    }
}

class Entry {
    func Use() int32 {
        return Runner[Derived]().Go()
    }
}`))){IsLibrary = true}
        using let consumerStream = MemoryStream()
        let result = consumer.Emit(consumerStream, pdbStream: nil, refStream: nil, assemblyName: "Issue3501.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }
}
