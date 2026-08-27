// <copyright file="Issue3501PositionalRecordPropertyTaintTests.cs" company="GSharp">
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
/// Issue #3501: a positional record's synthesized property and its
/// primary-constructor parameter share ONE declaration (the ParameterSyntax)
/// but are TWO Roslyn symbols. The oblivious taint fixpoint keys argument
/// edges on the parameter (`new Entry(null, …)`), while a member read
/// (`entry.GsNamespace`) binds the property — so the value bridge never saw
/// the promotion and a guarded `yield return entry.GsNamespace` in a
/// `sequence[string]` iterator failed with GS0155 (`string?` → `string`).
/// The promotion query now normalizes the property back to its parameter.
/// </summary>
public class Issue3501PositionalRecordPropertyTaintTests
{
    [Fact]
    public void GuardedYieldOfPromotedPositionalProperty_GetsBridge()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    internal static class ApiMap
    {
        private static readonly Dictionary<string, Entry> TypeMap = new()
        {
            [""A""] = new Entry(""GS.Analysis"", ""Alpha""),
            [""B""] = new Entry(null, ""Beta""),
        };

        internal static IEnumerable<string> EnumerateTargetNamespaces()
        {
            foreach (Entry entry in TypeMap.Values)
            {
                if (!string.IsNullOrEmpty(entry.GsNamespace))
                {
                    yield return entry.GsNamespace;
                }
            }
        }
    }

    internal readonly record struct Entry(string GsNamespace, string GsName, string AdaptationNote = null);
}");

        // The parameter-side taint promotes the positional declaration…
        Assert.Contains("GsNamespace string?", printed);

        // …and the property read at the yield seam is now bridged.
        Assert.Contains("yield entry.GsNamespace!!", printed);
    }

    [Fact]
    public void UntaintedPositionalProperty_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    internal static class ApiMap
    {
        private static readonly Dictionary<string, Entry> TypeMap = new()
        {
            [""A""] = new Entry(""GS.Analysis"", ""Alpha""),
        };

        internal static IEnumerable<string> EnumerateTargetNamespaces()
        {
            foreach (Entry entry in TypeMap.Values)
            {
                yield return entry.GsNamespace;
            }
        }
    }

    internal readonly record struct Entry(string GsNamespace, string GsName);
}");

        Assert.Contains("GsNamespace string,", printed);
        Assert.DoesNotContain("GsNamespace!!", printed);
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
