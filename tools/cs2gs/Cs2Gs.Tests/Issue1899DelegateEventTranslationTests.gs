// <copyright file="Issue1899DelegateEventTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1899: `delegate` and `event` DECLARATIONS reported
/// CS2GS-GAP even though G# has canonical forms for both — a named delegate
/// type alias (ADR-0059, `delegate Name(params) R`) and an;
/// event declaration (ADR-0052), field-like or with explicit add/remove
/// accessors. Covers: a delegate with parameters and a return type, a void
/// delegate, a field-like event, an explicit add/remove event, and a generic
/// delegate declaration (issue #1960 item 1: generic delegate aliases are now
/// supported end to end).
open class Issue1899DelegateEventTranslationTests {
    @Fact
    func DelegateDeclaration_WithParametersAndReturnType_MapsToNamedDelegateAlias() {
        let rendered = Render(`
namespace Corpus.Issue1899
{
    public delegate int Combine(int a, int b);
}
`)
        Assert.Contains("delegate Combine(a int32, b int32) int32;", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DelegateDeclaration_VoidReturn_OmitsReturnClause() {
        let rendered = Render(`
namespace Corpus.Issue1899
{
    public delegate void Note(string message);
}
`)
        Assert.Contains("delegate Note(message string);", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("func(message string) ", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func EventFieldDeclaration_FieldLikeEvent_MapsToEventDeclaration() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1899
{
    public class TickSource
    {
        public event EventHandler? Ticked;

        public void Tick()
        {
            EventHandler? snapshot = Ticked;
            if (snapshot != null)
            {
                snapshot(this, EventArgs.Empty);
            }
        }
    }
}
`)
        Assert.Contains("event Ticked EventHandler", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(
            rendered,
            "G# cannot convert nominal System.EventHandler values to structural delegate locals."
        )
    }

    @Fact
    func EventDeclaration_ExplicitAddRemove_MapsToEventDeclarationWithAccessorBodies() {
        let rendered = Render(`
using System;
using System.Collections.Generic;

namespace Corpus.Issue1899
{
    public delegate void MessageHandler(string message);

    public class Broadcaster
    {
        private readonly List<MessageHandler> _handlers = new List<MessageHandler>();

        public event MessageHandler Message
        {
            add { _handlers.Add(value); }
            remove { _handlers.Remove(value); }
        }
    }
}
`)
        Assert.Contains("event Message MessageHandler", rendered, StringComparison.Ordinal)
        Assert.Contains("add {", rendered, StringComparison.Ordinal)
        Assert.Contains("remove {", rendered, StringComparison.Ordinal)
        Assert.Contains("_handlers.Add(value)", rendered, StringComparison.Ordinal)
        Assert.Contains("_handlers.Remove(value)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DelegateDeclaration_Generic_MapsToGenericNamedDelegateAlias() {
        // Issue #1960 item 1: generic delegate declarations now carry their
        // type parameters into the G# named delegate alias's bracket section
        // (ADR-0059 "Follow-up work", issue #1503; GS0234 retired) instead of
        // gapping loudly.
        let rendered = Render(`
namespace Corpus.Issue1899
{
    public delegate T Selector<T>(T value);
}
`)
        Assert.Contains("delegate Selector[T](value T) T;", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string, roundTripOnlyReason string? = nil) {
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(rendered)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason)
            }
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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
