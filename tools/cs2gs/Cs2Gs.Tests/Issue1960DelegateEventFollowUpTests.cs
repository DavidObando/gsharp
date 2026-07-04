// <copyright file="Issue1960DelegateEventFollowUpTests.cs" company="GSharp">
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
/// Issue #1960: narrower follow-ups from PR #1959 (issue #1899) review.
/// Covers item 1 (generic delegate declarations, any arity, with
/// constraints), item 2 (delegate multicast <c>+=</c>/<c>-=</c> combine on a
/// non-event delegate-typed target has no G# form and must gap loudly rather
/// than emit code that fails to bind in gsc), and item 3 (a field-like event
/// prefers a source-declared named delegate type over the anonymous
/// <c>func(...)</c> arrow form). Item 4 (a gsc nullable-local event-snapshot
/// invoke crash) is a separate gsc runtime bug, split off to its own issue.
/// </summary>
public class Issue1960DelegateEventFollowUpTests
{
    [Fact]
    public void DelegateDeclaration_Generic_SingleTypeParameter_MapsToGenericAlias()
    {
        string rendered = Render(@"
namespace Corpus.Issue1960
{
    public delegate T Selector<T>(T value);
}
");

        Assert.Contains("type Selector[T] = delegate func(value T) T", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DelegateDeclaration_Generic_MultipleTypeParameters_MapsToGenericAlias()
    {
        string rendered = Render(@"
namespace Corpus.Issue1960
{
    public delegate TResult Mapper<TIn, TResult>(TIn input);
}
");

        Assert.Contains("type Mapper[TIn, TResult] = delegate func(input TIn) TResult", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DelegateDeclaration_Generic_VoidReturn_OmitsReturnClause()
    {
        string rendered = Render(@"
namespace Corpus.Issue1960
{
    public delegate void Handler<T>(T value);
}
");

        Assert.Contains("type Handler[T] = delegate func(value T)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("func(value T) ", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DelegateDeclaration_Generic_WithClassConstraint_CarriesConstraint()
    {
        string rendered = Render(@"
namespace Corpus.Issue1960
{
    public delegate void Handler<T>(T value) where T : class;
}
");

        Assert.Contains("type Handler[T class] = delegate func(value T)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DelegateMulticastCombine_OnNonEventDelegateLocal_ReportsUnsupportedGap()
    {
        // Issue #1960 item 2: `note += Second; note -= Second;` on a plain
        // delegate-typed LOCAL (not a declared `event`) has no G# equivalent —
        // G#'s `+=`/`-=` syntax binds only to an actual CLR event, and
        // `Delegate.Combine`/`Delegate.Remove` are reachable only from the
        // compiler's own synthesized event accessors. This must gap loudly
        // rather than silently emit `+=`/`-=` that fails to bind in gsc.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1960
{
    public delegate void Note(string message);

    public static class Fixture
    {
        public static void Run()
        {
            Note note = First;
            note += Second;
            note -= Second;
        }

        private static void First(string message) { }

        private static void Second(string message) { }
    }
}
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(context.Diagnostics, d => d.Message.Contains("delegate multicast", StringComparison.Ordinal));
        Assert.Contains(context.Diagnostics, d => d.Message.Contains("'+='", StringComparison.Ordinal));
        Assert.Contains(context.Diagnostics, d => d.Message.Contains("'-='", StringComparison.Ordinal));
    }

    [Fact]
    public void DelegateMulticastCombine_OnActualEvent_StillTranslatesNormally()
    {
        // The event-subscription `+=`/`-=` form (already supported, ADR-0052/
        // ADR-0036) must keep working unaffected by the item-2 gap check —
        // only a NON-event delegate-typed target gaps.
        string rendered = Render(@"
using System;

namespace Corpus.Issue1960
{
    public delegate void Note(string message);

    public class Broadcaster
    {
        public event Note Said;

        public void Say(string message)
        {
            if (Said != null)
            {
                Said(message);
            }
        }
    }

    public static class Fixture
    {
        public static void Run()
        {
            var broadcaster = new Broadcaster();
            Note listener = message => Console.WriteLine(message);
            broadcaster.Said += listener;
            broadcaster.Say(""hi"");
            broadcaster.Said -= listener;
        }
    }
}
");

        Assert.Contains("broadcaster.Said += listener", rendered, StringComparison.Ordinal);
        Assert.Contains("broadcaster.Said -= listener", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void EventFieldDeclaration_WithSourceDeclaredDelegate_PrefersNamedDelegateType()
    {
        // Issue #1960 item 3: a field-like event whose type is a
        // SOURCE-DECLARED named delegate keeps that name (`event Ticked
        // TickHandler`) instead of collapsing to the anonymous `func(...)`
        // arrow shape cs2gs previously always emitted for every delegate type.
        string rendered = Render(@"
namespace Corpus.Issue1960
{
    public delegate void TickHandler(int count);

    public class TickSource
    {
        public event TickHandler? Ticked;

        public void Tick(int count)
        {
            if (Ticked != null)
            {
                Ticked(count);
            }
        }
    }
}
");

        Assert.Contains("event Ticked TickHandler", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("event Ticked (int32) -> void", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void EventFieldDeclaration_WithBclDelegate_StillUsesArrowForm()
    {
        // A BCL delegate (EventHandler, Action, Func, ...) has no G# alias
        // declaration to preserve, so it must keep lowering to the
        // structural arrow form — the item-3 fix is scoped to
        // SOURCE-declared delegates only.
        string rendered = Render(@"
using System;

namespace Corpus.Issue1960
{
    public class TickSource
    {
        public event EventHandler? Ticked;
    }
}
");

        Assert.Contains("event Ticked (object?, EventArgs) -> void", rendered, StringComparison.Ordinal);
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
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
