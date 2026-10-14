// <copyright file="Issue3595SelfPackageImportedTypeTests.cs" company="GSharp">
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

/// Issue #3595 (#3501): CLR namespaces merge across assemblies, and a G#
/// package is the same construct — a file in `package X` must see a
/// REFERENCED assembly's exported types in namespace X without spelling
/// `import X`. The C#→G# self-migration splits one namespace across
/// project boundaries (Cs2Gs.ProjectLoading declares types in the referenced
/// Translator assembly's `Cs2Gs.Translator.Loading` namespace), and the
/// missing merge made every such cross-assembly reference GS0113.
open class Issue3595SelfPackageImportedTypeTests {
    @Fact
    func SamePackage_TypeFromReferencedAssembly_ResolvesWithoutImport() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue3595")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue3595.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Shared.Loading

open class Doc {
    prop Path string -> "p"
}

open class Doc2[T] {
    prop Value T? -> nil
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libraryResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue3595.Library"
            )
            Assert.True(libraryResult.Success, string.Join(Environment.NewLine, libraryResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue3595.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Shared.Loading

class Holder {
    func Describe(d Doc) string {
        return d.Path
    }

    func First(d Doc2[string]) string? {
        return d.Value
    }
}`))){IsLibrary = true}
        using let consumerStream = MemoryStream()
        let result = consumer.Emit(consumerStream, pdbStream: nil, refStream: nil, assemblyName: "Issue3595.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }
}
