// <copyright file="Issue3096CollectionSpreadInitializerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translation coverage for initializer-safe native collection spreads.
class Issue3096CollectionSpreadInitializerTranslationTests {
    @Fact
    func FieldAndPropertyInitializers_UseNativeSpreadSyntaxWithoutSpills() {
        let rendered = Render(`using System;
using System.Linq;

namespace Issue3096;

public sealed class Holder
{
    private static readonly string[] All = ["a", "b", "skip"];
    public static readonly string[] Filtered = [.. All.Where(x => x != "skip")];
    public static readonly string[] Mixed = ["before", .. Filtered, "after"];
    public static readonly string[] Empty = [.. Array.Empty<string>()];

    public string[] Property { get; } =
        ["property-head", .. All.Where(x => x != "skip"), "property-tail"];

    public Holder()
    {
    }
}`)
        Assert.Contains("All.Where(", rendered, StringComparison.Ordinal)
        Assert.Contains("...", rendered, StringComparison.Ordinal)
        Assert.Contains("\"before\", ...", rendered, StringComparison.Ordinal)
        Assert.Contains("Filtered, \"after\"}", rendered, StringComparison.Ordinal)
        Assert.Contains("Array.Empty[string]()", rendered, StringComparison.Ordinal)
        Assert.Contains("Property = []string{\"property-head\", ...", rendered, StringComparison.Ordinal)
        Assert.Contains("\"property-tail\"}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__spread", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".AddRange(", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("CS2GS-GAP", rendered, StringComparison.Ordinal)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
        Assert.True(
            result!!.Success,
            string.Join(Environment.NewLine, result!!.Errors) + Environment.NewLine + rendered
        )
    }

    shared {
        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Empty(context.Diagnostics)
            return rendered
        }
    }
}
