// <copyright file="GeneratedDocTranslatorSourceCensusTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Cs2Gs.Translator.Loading
import GSharp.GeneratorHost
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// Source-bearing references remain part of the generated-document name census.
open class GeneratedDocTranslatorSourceCensusTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceReferenceHomonym_RespectsTheGlobalAlias(includeGlobal bool) {
        let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
        let source = CSharpCompilation.Create(
            "Rival",
            []SyntaxTree{CSharpSyntaxTree.ParseText("namespace Rival { public class Uri {} }")},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        references.Add(
            source.ToMetadataReference(
                aliases: if includeGlobal {
                    ImmutableArray.Create("Hidden", "global")
                } else {
                    ImmutableArray.Create("Hidden")
                }
            )
        )
        let generated = Assert.Single(
            GeneratedDocTranslator.Translate(
                "namespace App { partial class Foo {} }",
                []GeneratedCsDocument{
                    GeneratedCsDocument(
                        "Foo.g.cs",
                        SourceText.From(
                            "#nullable enable\nnamespace App { partial class Foo { public System.Uri? Address => null; } }"
                        )
                    )
                },
                references
            )
        )
        Assert.Empty(generated.RoundTripErrors)
        Assert.Empty(generated.HostDiagnostics)
        Assert.Contains("partial class Foo", generated.GSharpSource)
        Assert.Contains("? -> nil", generated.GSharpSource)
        if includeGlobal {
            Assert.Contains("System.Uri", generated.GSharpSource)
            Assert.DoesNotContain("prop Address Uri?", generated.GSharpSource)
        } else {
            Assert.Contains("prop Address Uri?", generated.GSharpSource)
        }
    }
}
