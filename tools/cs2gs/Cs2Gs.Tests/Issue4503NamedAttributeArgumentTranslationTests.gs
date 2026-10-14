// <copyright file="Issue4503NamedAttributeArgumentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #4503: cs2gs preserves constructor-versus-member attribute argument syntax.
class Issue4503NamedAttributeArgumentTranslationTests {
    @Fact
    func AttributeArgumentSeparators_PreserveCSharpMeaning() {
        const source = `using System;

[AttributeUsage(AttributeTargets.All)]
public sealed class SampleAttribute : Attribute
{
    public SampleAttribute(string first, int second = 2) { }
    public string Name { get; set; }
}

[Sample("x", second: 3, Name = "member")]
public sealed class Tagged { }`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Input.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.True(
            translated.Contains("@Sample(\"x\", second: int32(3), Name = \"member\")", StringComparison.Ordinal),
            translated
        )
        Assert.DoesNotContain("Name: \"member\"", translated, StringComparison.Ordinal)
    }
}
