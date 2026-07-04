// <copyright file="Issue1907FieldKeywordTranslationTests.cs" company="GSharp">
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
/// Issue #1907: a property accessor using the C#14 <c>field</c> contextual
/// keyword (Roslyn's <c>FieldExpressionSyntax</c>, NOT an
/// <c>IdentifierNameSyntax</c>) refers to the compiler-synthesized backing
/// field of the enclosing property. G# has no synthesized-field surface —
/// ADR-0051 computed properties always name their own backing field
/// explicitly — so the property gets ONE real <c>var</c> field synthesized
/// and every <c>field</c> reference (across ALL its accessors, including a
/// bodyless/auto sibling accessor that implicitly shares the same
/// compiler-synthesized field) is rewritten to read/write it.
/// </summary>
public class Issue1907FieldKeywordTranslationTests
{
    [Fact]
    public void CustomSetWithField_AutoGet_ShareOneSynthesizedBackingField()
    {
        string rendered = Render(@"
namespace Corpus.Issue1907
{
    public class ClampedGauge
    {
        public int Level
        {
            get;
            set => field = value < 0 ? 0 : value;
        }
    }
}
");

        Assert.Contains("private var _level int32", rendered, StringComparison.Ordinal);
        Assert.Contains("return _level", rendered, StringComparison.Ordinal);
        Assert.Contains("_level = if value < 0 { 0 } else { value }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GetWithFieldCoalesceAssign_AutoSet_LazilyInitializesSharedField()
    {
        string rendered = Render(@"
namespace Corpus.Issue1907
{
    public class LazyLabel
    {
        public string Name { get => field ??= ""default""; set; }
    }
}
");

        Assert.Contains("private var _name string?", rendered, StringComparison.Ordinal);
        Assert.Contains("_name ??= \"default\"", rendered, StringComparison.Ordinal);
        Assert.Contains("_name = value", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void BothAccessorsCustom_ShareOneSynthesizedBackingField()
    {
        string rendered = Render(@"
namespace Corpus.Issue1907
{
    public class LoggedCounter
    {
        private int changeCount;

        public int Count
        {
            get => field;
            set
            {
                field = value;
                changeCount = changeCount + 1;
            }
        }
    }
}
");

        Assert.Contains("private var _count int32", rendered, StringComparison.Ordinal);
        Assert.Contains("get -> _count", rendered, StringComparison.Ordinal);
        Assert.Contains("_count = value", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SynthesizedBackingFieldName_AvoidsCollisionWithExistingMember()
    {
        // The type already declares a field named `_level` unrelated to the
        // property; the synthesized backing field must not collide with it.
        string rendered = Render(@"
namespace Corpus.Issue1907
{
    public class ClampedGauge
    {
        private int _level;

        public int Level
        {
            get => field;
            set => field = value < 0 ? 0 : value;
        }

        public int RawLevel() => _level;
    }
}
");

        Assert.Contains("private var _level int32", rendered, StringComparison.Ordinal);
        Assert.Contains("private var _level2 int32", rendered, StringComparison.Ordinal);
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
