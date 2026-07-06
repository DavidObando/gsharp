// <copyright file="LockKeywordSanitizationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// <c>lock</c> is a hard G# keyword (it introduces the <c>lock</c> statement),
/// so a C# member literally named <c>lock</c> — most commonly the verbatim
/// identifier <c>@lock</c> guarding a <c>lock (@lock) { ... }</c> block, an
/// idiomatic C# monitor pattern — must be sanitized to <c>lock_</c> at both its
/// declaration and every reference site (including the lock-statement operand).
/// It was missing from the translator's reserved-word set, so the field emitted
/// as the bare keyword <c>lock</c> and the statement as <c>lock lock { ... }</c>,
/// which failed to round-trip-parse (GS0005: unexpected <c>LockKeyword</c>).
/// </summary>
public class LockKeywordSanitizationTranslationTests
{
    private const string Source = @"
namespace Corpus.LockSanitize
{
    public class Guarded
    {
        private readonly object @lock = new object();
        private int count;

        public int Increment()
        {
            lock (@lock)
            {
                return ++this.count;
            }
        }
    }
}
";

    [Fact]
    public void VerbatimLockField_IsSanitizedToLockUnderscore()
    {
        string rendered = Render();

        Assert.Contains("lock_", rendered, StringComparison.Ordinal);

        // The bare `lock` keyword must never appear as an identifier: neither the
        // field declaration nor the lock-statement operand may leak it.
        Assert.DoesNotContain("@lock", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("lock lock ", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let lock ", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void SanitizedOutput_RoundTripParses()
    {
        string rendered = Render();

        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Guarded.cs", Source) });

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
