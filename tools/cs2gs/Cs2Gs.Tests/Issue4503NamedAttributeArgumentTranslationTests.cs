// <copyright file="Issue4503NamedAttributeArgumentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #4503: cs2gs preserves constructor-versus-member attribute argument syntax.</summary>
public sealed class Issue4503NamedAttributeArgumentTranslationTests
{
    [Fact]
    public void AttributeArgumentSeparators_PreserveCSharpMeaning()
    {
        const string source = """
            using System;

            [AttributeUsage(AttributeTargets.All)]
            public sealed class SampleAttribute : Attribute
            {
                public SampleAttribute(string first, int second = 2) { }
                public string Name { get; set; }
            }

            [Sample("x", second: 3, Name = "member")]
            public sealed class Tagged { }
            """;
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Input.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var translated = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.True(
            translated.Contains(
                """@Sample("x", second: int32(3), Name = "member")""",
                StringComparison.Ordinal),
            translated);
        Assert.DoesNotContain(
            "Name: \"member\"",
            translated,
            StringComparison.Ordinal);
    }
}
