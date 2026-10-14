// <copyright file="Issue1960DelegateEventFollowUpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1960: narrower follow-ups from PR #1959 (issue #1899) review.
/// Covers item 1 (generic delegate declarations, any arity, with
/// constraints), item 2 (delegate multicast `+=`/`-=` combine on a
/// non-event delegate-typed target has no G# form and must gap loudly rather
/// than emit code that fails to bind in gsc), and item 3 (a field-like event
/// prefers a source-declared named delegate type over the anonymous
/// `func(...)` arrow form). Item 4 (a gsc nullable-local event-snapshot
/// invoke crash) is a separate gsc runtime bug, split off to its own issue.
open class Issue1960DelegateEventFollowUpTests {
    @Fact
    func DelegateDeclaration_Generic_SingleTypeParameter_MapsToGenericAlias() {
        let rendered = Render(`
namespace Corpus.Issue1960
{
    public delegate T Selector<T>(T value);
}
`)
        Assert.Contains("delegate Selector[T](value T) T;", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DelegateDeclaration_Generic_MultipleTypeParameters_MapsToGenericAlias() {
        let rendered = Render(`
namespace Corpus.Issue1960
{
    public delegate TResult Mapper<TIn, TResult>(TIn input);
}
`)
        Assert.Contains("delegate Mapper[TIn, TResult](input TIn) TResult;", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DelegateDeclaration_Generic_VoidReturn_OmitsReturnClause() {
        let rendered = Render(`
namespace Corpus.Issue1960
{
    public delegate void Handler<T>(T value);
}
`)
        Assert.Contains("delegate Handler[T](value T);", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("func(value T) ", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DelegateDeclaration_Generic_WithClassConstraint_CarriesConstraint() {
        let rendered = Render(`
namespace Corpus.Issue1960
{
    public delegate void Handler<T>(T value) where T : class;
}
`)
        Assert.Contains("delegate Handler[T class](value T);", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DelegateMulticastCombine_OnNonEventDelegateLocal_ReportsUnsupportedGap() {
        // Issue #1960 item 2: `note += Second; note -= Second;` on a plain
        // delegate-typed LOCAL (not a declared `event`) has no G# equivalent —
        // G#'s `+=`/`-=` syntax binds only to an actual CLR event, and
        // `Delegate.Combine`/`Delegate.Remove` are reachable only from the
        // compiler's own synthesized event accessors. This must gap loudly
        // rather than silently emit `+=`/`-=` that fails to bind in gsc.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("delegate multicast", StringComparison.Ordinal)
        )
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("'+='", StringComparison.Ordinal)
        )
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("'-='", StringComparison.Ordinal)
        )
    }

    @Fact
    func DelegateMulticastCombine_OnActualEvent_StillTranslatesNormally() {
        // The event-subscription `+=`/`-=` form (already supported, ADR-0052/
        // ADR-0036) must keep working unaffected by the item-2 gap check —
        // only a NON-event delegate-typed target gaps.
        let rendered = Render(`
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
            broadcaster.Say("hi");
            broadcaster.Said -= listener;
        }
    }
}
`)
        Assert.Contains("broadcaster.Said += listener", rendered, StringComparison.Ordinal)
        Assert.Contains("broadcaster.Said -= listener", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func EventFieldDeclaration_WithSourceDeclaredDelegate_PrefersNamedDelegateType() {
        // Issue #1960 item 3: a field-like event whose type is a
        // SOURCE-DECLARED named delegate keeps that name (`event Ticked
        // TickHandler`) instead of collapsing to the anonymous `func(...)`
        // arrow shape cs2gs previously always emitted for every delegate type.
        let rendered = Render(`
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
`)
        Assert.Contains("event Ticked TickHandler", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("event Ticked (int32) -> void", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func EventFieldDeclaration_WithBclDelegate_PreservesNominalType() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1960
{
    public class TickSource
    {
        public event EventHandler? Ticked;
        public event EventHandler<EventArgs>? Detailed;
        public event Action<object, EventArgs>? ExplicitAction;
    }
}
`)
        Assert.Contains("event Ticked EventHandler", rendered, StringComparison.Ordinal)
        Assert.Contains("event Detailed EventHandler[EventArgs]", rendered, StringComparison.Ordinal)
        Assert.Contains("event ExplicitAction Action[object, EventArgs]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("event Ticked (object?, EventArgs) -> void", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
