// <copyright file="Issue1897CollectionExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1897: four distinct C# collection-expression gaps in the G05
/// grid corpus, each fixed independently:
/// <list type="bullet">
/// <item>a collection-expression spread element (<c>[0, ..rest, 9]</c>) —
/// was CS2GS-GAP "SpreadElement ... has no canonical G# composite-literal
/// form yet"; lowers to a build-and-append <c>List[T]</c> temporary
/// (<c>Add</c>/<c>AddRange</c> calls hoisted into the enclosing statement's
/// prologue), converted back via <c>.ToArray()</c> for an array/span
/// target.</item>
/// <item>a <c>List&lt;T&gt;</c>-targeted collection expression
/// (<c>List&lt;int&gt; l = [10, 20];</c>) — previously mistranslated to a
/// G# array literal (<c>[]int32{10, 20}</c>) that does not convert to
/// <c>List[int32]</c> (gsc GS0155); now lowers to the canonical G#
/// collection-initializer form (<c>List[int32]{10, 20}</c>, ADR-0117).</item>
/// <item>the <c>["key"] = value</c> dictionary-initializer form — already
/// had a canonical G# form via the existing indexed
/// <c>CollectionInitializerElement</c> path (<c>TryTranslateCollectionInitializer</c>);
/// this test just locks in that it stays gap-free and round-trips.</item>
/// <item>the implicit-typed <c>stackalloc[] { 5, 6, 7 }</c> form — was
/// CS2GS-GAP "ImplicitStackAllocArrayCreationExpression has no canonical G#
/// form yet"; now maps to the same G# count-inferred stackalloc initializer
/// (<c>stackalloc []T{...}</c>) as the explicit omitted-size form.</item>
/// </list>
/// </summary>
public class Issue1897CollectionExpressionTranslationTests
{
    [Fact]
    public void SpreadElement_LowersToBuildAndAppendTemporary()
    {
        string rendered = Render(@"
namespace Corpus.Issue1897
{
    public class Holder
    {
        public int[] Combine(int[] rest)
        {
            int[] s = [0, .. rest, 9];
            return s;
        }
    }
}
");

        Assert.Contains("List[int32]()", rendered, StringComparison.Ordinal);
        Assert.Contains(".Add(0)", rendered, StringComparison.Ordinal);
        Assert.Contains(".AddRange(rest)", rendered, StringComparison.Ordinal);
        Assert.Contains(".Add(9)", rendered, StringComparison.Ordinal);
        Assert.Contains(".ToArray()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ListTarget_LowersToCollectionInitializerNotArrayLiteral()
    {
        string rendered = Render(@"
using System.Collections.Generic;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public List<int> Make()
        {
            List<int> l = [10, 20];
            return l;
        }
    }
}
");

        Assert.Contains("List[int32]{ 10, 20 }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("[]int32{10, 20}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DictionaryIndexedInitializer_TranslatesGapFreeAndRoundTrips()
    {
        string rendered = Render(@"
using System.Collections.Generic;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public Dictionary<string, int> Make()
        {
            return new Dictionary<string, int> { [""blue""] = 2 };
        }
    }
}
");

        Assert.Contains("[\"blue\"] = 2", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitStackAlloc_LowersToCountInferredStackAllocInitializer()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public int First()
        {
            Span<int> t = stackalloc[] { 5, 6, 7 };
            return t[0];
        }
    }
}
");

        Assert.Contains("stackalloc [3]int32{5, 6, 7}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
