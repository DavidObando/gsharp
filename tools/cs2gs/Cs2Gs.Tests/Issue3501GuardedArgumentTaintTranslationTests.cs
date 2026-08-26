// <copyright file="Issue3501GuardedArgumentTaintTranslationTests.cs" company="GSharp">
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
/// Issue #3501 (Oahu-gate regression guard): a local/parameter read that a
/// syntactic null-check guard proves non-null at a CONSTRUCTOR argument must
/// not propagate its declaration's taint into the parameter. The canonical
/// shape is Oahu's `if (prod is null) { continue; } pairs.Add(new(prod,
/// comp))` — `prod`'s producer can return null, but the creation-site read is
/// guarded, and tainting the record's positional parameter widened the data
/// shape (`Product` → `Product?` on the positional property) for every
/// consumer, including deconstruction locals whose dereferences are not
/// receiver-bridged. Ordinary METHOD arguments deliberately keep the
/// promotion-consolidation behavior (see PromotionConsolidationTests).
/// </summary>
public class Issue3501GuardedArgumentTaintTranslationTests
{
    [Fact]
    public void Oblivious_EarlyExitGuardedCreationArgument_DoesNotTaintPositionalParameter()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return ""x"";
        }

        public void Run(IEnumerable<bool> flags)
        {
            var pairs = new List<Pair>();
            foreach (var flag in flags)
            {
                var value = Find(flag);
                if (value is null)
                {
                    continue;
                }

                pairs.Add(new(value, 1));
            }
        }
    }

    public record Pair(string Name, int Rank);
}");

        // `value` itself is tainted (Find can return null)...
        Assert.Contains("Find(b bool) string?", printed);

        // ...but the guarded creation-site read must not widen the record's
        // positional data shape.
        Assert.Contains("Pair(Name string,", printed);
    }

    [Fact]
    public void Oblivious_UnguardedCreationArgument_StillTaintsPositionalParameter()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return ""x"";
        }

        public void Run()
        {
            var pairs = new List<Pair> { new(Find(true), 1) };
        }
    }

    public record Pair(string Name, int Rank);
}");

        Assert.Contains("Pair(Name string?,", printed);
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
