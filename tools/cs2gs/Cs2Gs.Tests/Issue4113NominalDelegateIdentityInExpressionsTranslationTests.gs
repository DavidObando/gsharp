// <copyright file="Issue4113NominalDelegateIdentityInExpressionsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Translator-fidelity tests for issue #4113: a nominal CLR delegate
/// (`EventHandler`, `EventHandler<T>`) referenced from a
/// `typeof(...)` operand or an explicit generic type argument must keep
/// its nominal identity, exactly like `MapExplicitType` already
/// preserves it for a variable's declared type (issue #2835/#3841).
///
/// Before this fix, `MapTypeOf` (the `typeof(...)` operand mapper)
/// and `MapTypeArguments` (the explicit-type-argument mapper) both
/// routed through the general, structurally-canonicalizing `Map`
/// pipeline, which silently rewrote `typeof(EventHandler)` into
/// `typeof(Action<object, EventArgs>)` — a DIFFERENT runtime
/// (cref:Type). That is invisible at the printed-G#-source level only
/// if you don't check it, but it defeats any test (or, once this exact
/// translator source is itself self-hosted, any compiler logic — see
/// `MemberLookup.CanonicalizeWellKnownEventHandler`) that relies on
/// `typeof(EventHandler)` actually meaning `System.EventHandler`.
open class Issue4113NominalDelegateIdentityInExpressionsTranslationTests {
    @Fact
    func TypeOfSourceEventHandlerPlaceholder_PreservesNominalRuntimeIdentity() {
        // #4116's Issue1473FunctionTypeEventEmitTests uses a source-defined
        // EventArgs subclass. CanonicalizeWellKnownEventHandler has no CLR type
        // for it yet, so it uses this closed placeholder with EventHandler<>'s
        // generic definition. #4205 must preserve their matching identities.
        let printed = TranslateUnit(`
using System;

public class Probe
{
    public Type Placeholder() => typeof(EventHandler<EventArgs>);
    public Type Definition() => typeof(EventHandler<>);
}`)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe().Placeholder().GetGenericTypeDefinition() == Probe().Definition()"
        )
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(true, result.Value)
        Assert.Contains("typeof(EventHandler[EventArgs])", printed)
    }

    @Fact
    func TypeOfNominalEventHandler_PreservesNominalIdentity() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(EventHandler);
    }
}`)
        Assert.Contains("typeof(EventHandler)", printed)
        Assert.DoesNotContain("EventArgs) -> void", printed)
    }

    @Fact
    func TypeOfClosedGenericNominalEventHandler_PreservesNominalIdentity() {
        let printed = TranslateUnit(`
using System;
using System.ComponentModel;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(EventHandler<PropertyChangedEventArgs>);
    }
}`)
        Assert.Contains("typeof(EventHandler[PropertyChangedEventArgs])", printed)
        Assert.DoesNotContain("EventArgs) -> void", printed)
    }

    @Fact
    func ExplicitGenericTypeArgumentOfNominalEventHandler_PreservesNominalIdentity() {
        // The exact shape behind EventEmitTests' `Assert.IsType<EventHandler>(del)`
        // (#4113): an explicit type argument on a generic method call.
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public bool F(object del) => Describe<EventHandler>(del);

        public bool Describe<T>(object value) => value is T;
    }
}`)
        Assert.Contains("Describe[EventHandler](del)", printed)
        Assert.DoesNotContain("Describe[(object", printed)
    }

    @Fact
    func TypeOfOrdinaryActionDelegate_StillCanonicalizesToStructuralForm() {
        // Precision guard: Func/Action are the canonical structural
        // spelling's own identity (issue #2835's own exclusion) — typeof over
        // one of those must keep collapsing to the arrow form, unlike
        // EventHandler above.
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(Action<object, EventArgs>);
    }
}`)
        Assert.Contains("typeof((object, EventArgs) -> void)", printed)
    }

    @Fact
    func TypeOfArrayOfNominalEventHandler_PreservesNominalIdentity() {
        // Copilot review of PR #4205: the top-level delegate check alone
        // does not catch a nominal delegate one level down. MapExplicitType
        // recurses into an array's element type instead of falling through
        // to the general Map() pipeline for it.
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(EventHandler[]);
    }
}`)
        Assert.Contains("typeof([]EventHandler)", printed)
        Assert.DoesNotContain("EventArgs) -> void", printed)
    }

    @Fact
    func TypeOfGenericListOfNominalEventHandler_PreservesNominalIdentity() {
        // Copilot review of PR #4205: same nesting gap, one generic type
        // argument deep (`typeof(List<EventHandler>)`).
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(List<EventHandler>);
    }
}`)
        Assert.Contains("typeof(List[EventHandler])", printed)
        Assert.DoesNotContain("EventArgs) -> void", printed)
    }

    @Fact
    func ExplicitGenericTypeArgumentOfGenericListOfNominalEventHandler_PreservesNominalIdentity() {
        // Copilot review of PR #4205: the same nesting gap reachable through
        // MapTypeArguments (an explicit generic type argument on a call),
        // not just MapTypeOf.
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public bool F(object del) => Describe<List<EventHandler>>(del);

        public bool Describe<T>(object value) => value is T;
    }
}`)
        Assert.Contains("Describe[List[EventHandler]](del)", printed)
        Assert.DoesNotContain("Describe[List[(object", printed)
    }

    @Fact
    func NullableValueTypeWrappingAnOrdinaryGenericType_IsNotDoublyWrapped() {
        // Regression guard found during PR #4205's own regression sweep, not
        // by Copilot: Memory<int>? is Nullable<Memory<int>> — a generic named
        // type (Nullable<T>) whose OWN single type argument is the WRAPPED
        // type, not a sibling of the same shape as an ordinary List<T>/T[]
        // nesting. Map() unwraps it specially (to Memory<int>'s own mapped
        // shape, marked nullable) before ever reaching the generic tail the
        // array/generic-argument recursion above mirrors, so blindly zipping
        // Nullable<T>'s own type argument onto that already-unwrapped
        // reference's type-argument list corrupted Memory<int>? into
        // Memory[Memory[int32]]? — silently doubling the generic nesting on
        // a declaration with no delegate anywhere in it.
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public void F()
        {
            Memory<int>? memory = new Memory<int>(new[] { 5, 6, 7, 8 });
        }
    }
}`)
        Assert.Contains("Memory[int32]?", printed)
        Assert.DoesNotContain("Memory[Memory", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip and bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
