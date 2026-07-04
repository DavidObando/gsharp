// <copyright file="Issue2003FieldKeywordSynthesizedSiblingCollisionTests.cs" company="GSharp">
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
/// Issue #2003 (follow-up from PR #2000 / #1907 Opus review): the C#14
/// <c>field</c>-keyword synthesized backing-field name (<c>_&lt;prop&gt;</c>,
/// see <see cref="Issue1907FieldKeywordTranslationTests"/>) is collision-
/// checked against <c>ContainingType.GetMembers()</c> — Roslyn SOURCE symbols
/// only. A cs2gs-synthesized sibling with no Roslyn source-symbol counterpart
/// is invisible to that check. The primary case: a primary-constructor
/// parameter that is captured (read inside the type) but never assigned to an
/// explicit field/property becomes a same-named G# field (ADR-0065 §5) with
/// NO corresponding Roslyn field/property symbol — so it was previously
/// missed, and a same-named `field`-keyword backing field would silently
/// double-declare it (a gsc-loud duplicate-member error, not a silent
/// miscompile). These tests verify the SAME mangled-suffix resolution used
/// for source-symbol collisions (see
/// <see cref="Issue1907FieldKeywordTranslationTests.SynthesizedBackingFieldName_AvoidsCollisionWithExistingMember"/>)
/// now also applies here.
/// </summary>
public class Issue2003FieldKeywordSynthesizedSiblingCollisionTests
{
    [Fact]
    public void FieldKeywordBackingField_AvoidsCollisionWithPrimaryCtorParameterCapture()
    {
        // `_x` is a native C#12 primary-constructor parameter that is merely
        // captured (read in `UseX`), never assigned to any field/property, so
        // Roslyn synthesizes no source field/property symbol for it — it only
        // becomes a real field once cs2gs maps the primary ctor (ADR-0065 §5).
        // Property `X`'s `field`-keyword backing field would independently
        // synthesize the SAME name `_x` from camelCasing "X"; the second one
        // synthesized must be suffixed to avoid a duplicate member.
        string rendered = Render(@"
namespace Corpus.Issue2003
{
    public class Foo(int _x)
    {
        public int X
        {
            get => field;
            set => field = value;
        }

        public int UseX() => _x;
    }
}
");

        Assert.Contains("class Foo(_x int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("private var _x2 int32", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("private var _x int32", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void FieldKeywordBackingField_AvoidsCollisionWithLiftedPrimaryCtorParameterField()
    {
        // T2 (ADR-0115 §B.3): an explicit constructor whose only statement is
        // `_level = level` is canonicalized into a primary-constructor
        // parameter field named after the ORIGINAL source field `_level`.
        // That source field IS visible via `GetMembers()` before the lift, so
        // this case is already handled by the pre-existing check — kept here
        // as a regression guard alongside the true synthesized-sibling case
        // above.
        string rendered = Render(@"
namespace Corpus.Issue2003
{
    public class Gauge
    {
        private int _level;

        public Gauge(int level)
        {
            _level = level;
        }

        public int Level
        {
            get => field;
            set => field = value < 0 ? 0 : value;
        }
    }
}
");

        Assert.Contains("class Gauge(_level int32)", rendered, StringComparison.Ordinal);
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
        return GSharpPrinter.Print(unit);
    }
}
