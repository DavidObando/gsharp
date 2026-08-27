// <copyright file="Issue3501RawStringControlCharTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501: a multiline C# string normally renders as a Go-style backtick
/// raw literal, but raw literals carry characters verbatim — an embedded NUL
/// (Core.Tests' LexerTests fixture for issue #1608) lexes as end-of-file and
/// the emitted file fails the round-trip parse (GS0003 unterminated string).
/// Values holding control characters other than newline/tab keep the escaped
/// one-line form, where NUL renders as <c>\\u0000</c>.
/// </summary>
public class Issue3501RawStringControlCharTests
{
    [Fact]
    public void MultilineStringWithEmbeddedNul_KeepsEscapedForm()
    {
        string g = Render("""
namespace N
{
    public class C
    {
        public string Source() => "let a = 1\n\0let b = 2\nlet c = 3\n";
    }
}
""");

        Assert.DoesNotContain("`", g, StringComparison.Ordinal);
        Assert.Contains("\\u0000", g, StringComparison.Ordinal);
    }

    [Fact]
    public void MultilineStringWithoutControlChars_KeepsRawForm()
    {
        string g = Render("""
namespace N
{
    public class C
    {
        public string Source() => "let a = 1\nlet b = 2\nlet c = 3\n";
    }
}
""");

        Assert.Contains("`let a = 1", g, StringComparison.Ordinal);
    }

    private static string Render(string csharp)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", csharp) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
