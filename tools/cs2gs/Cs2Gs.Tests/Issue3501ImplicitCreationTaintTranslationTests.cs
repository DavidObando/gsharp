// <copyright file="Issue3501ImplicitCreationTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (Translator burn-down, GS0155 nil→string family): the oblivious
/// taint walk matched <c>ObjectCreationExpressionSyntax</c> only, but a
/// target-typed creation (<c>new(null, "…")</c>, C# 9) is the sibling
/// <c>ImplicitObjectCreationExpressionSyntax</c> — so a null argument inside a
/// collection-initializer entry (`[key] = new(null, "…")`, the
/// RoslynAnalyzerApiMap shape) never flowed into the record's positional
/// parameter and the rendered `T` rejected the `nil` at every call site.
/// Matching the shared <c>BaseObjectCreationExpressionSyntax</c> closes it.
/// </summary>
public class Issue3501ImplicitCreationTaintTranslationTests
{
    [Fact]
    public void Oblivious_ImplicitCreationNullArgument_TaintsPositionalParameter()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    internal static class Map
    {
        private static readonly Dictionary<string, Entry> Table = new()
        {
            [""a""] = new(""ns"", ""x""),
            [""b""] = new(null, ""y""),
        };

        internal readonly record struct Entry(string Ns, string Name, string Note = null);
    }
}");

        // The null argument in the target-typed `new(null, ""y"")` taints the
        // positional `Ns`; `Name` never sees null and stays bare.
        Assert.Contains("Ns string?", printed);
        Assert.Contains("Name string,", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
