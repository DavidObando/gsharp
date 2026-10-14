// <copyright file="Issue4116VarDelegateLocalIdentityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #4116 (split from #4045's #2519 residual runtime failure,
/// `Issue2519SourceClassConstraintOrderingEmitTests`): a `var`-typed C#
/// local initialized by a delegate-creation expression
/// (`var handler = new Action(() => counter++);`) loses its nominal
/// delegate identity entirely.
///
/// `TranslateObjectCreation` unwraps `new SomeDelegate(lambda)`
/// straight to the bare lambda argument (G# has no delegate-wrapper
/// constructor to keep). An EXPLICITLY typed local (`Action handler =
/// ...`) survives this because the declared-type-preservation branch
/// (issue #4045) still emits an explicit type clause. A `var` local has no
/// such anchor, so G# was left to infer the bare arrow lambda's type from
/// its own body — and since G# models `++`/`--` as a VALUE-
/// PRODUCING expression (ADR-0115 §B / gsc issue #1027), `() ->
/// counter++` naturally infers `Func<int32>` instead of the
/// source's `Action`. A reflection-based `MethodInfo.Invoke` against
/// the real `Action`-typed parameter then rejects it outright — "Func`1
/// passed where Action is required" — exactly
/// `Issue2519SourceClassConstraintOrderingEmitTests`' migrated-pipeline
/// failure mode.
///
/// The emitted annotation is the structural arrow spelling (`() ->
/// void`), not the nominal name `Action`: `MapExplicitType`
/// (issue #2835/#3841/#4113/#4205) treats `Func`/`Action`
/// as the structural spelling's own canonical identity and
/// still canonicalizes them, unlike a genuinely distinct nominal delegate
/// such as `EventHandler`. What matters for correctness here is only
/// that an explicit type clause exists at all, so gsc target-types the
/// lambda against it — exactly as it already does for an explicitly-typed
/// C# local (issue #4045's `EventHandler handler = (_, _) => hits++;`,
/// covered by `Issue4045CompilerTestsParityRegressionTests`) — instead
/// of inferring the lambda's type from its own body with no target at all.
open class Issue4116VarDelegateLocalIdentityTranslationTests {
    @Fact
    func VarActionLocal_FromDelegateCreationWithIncrementBody_GetsAnExplicitVoidType() {
        let rendered = Render(`
using System;

namespace Corpus.Issue4116
{
    public class Holder
    {
        public Action MakeCounter(int[] box)
        {
            var handler = new Action(() => box[0]++);
            return handler;
        }
    }
}
`)
        Assert.Contains("let handler () -> void = () -> box[0]++", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func VarFuncLocal_FromDelegateCreationWithIncrementBody_GetsAnExplicitReturnType() {
        // A non-void delegate target needs the annotation too: without it,
        // nothing is broken here (the natural inference already matches), but
        // the fix must still apply uniformly to every var-typed delegate
        // local per the shared nominal-identity rule (issue #4113/#4205),
        // not conditionally based on ReturnsVoid.
        let rendered = Render(`
using System;

namespace Corpus.Issue4116
{
    public class Holder
    {
        public Func<int> MakeCounter(int[] box)
        {
            var handler = new Func<int>(() => box[0]++);
            return handler;
        }
    }
}
`)
        Assert.Contains("let handler () -> int32 = () -> box[0]++", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func VarEventHandlerLocal_FromDelegateCreationWithIncrementBody_KeepsNominalDelegateType() {
        // A genuinely nominal (non-Func/Action) delegate must keep
        // its own name, not collapse to the structural spelling — the same
        // distinction issue #4113/#4205 draws for typeof(...) operands and
        // explicit generic type arguments.
        let rendered = Render(`
using System;

namespace Corpus.Issue4116
{
    public class Holder
    {
        public void Subscribe(int[] box)
        {
            var handler = new EventHandler((sender, args) => box[0]++);
            handler(null, EventArgs.Empty);
        }
    }
}
`)
        Assert.Contains("let handler EventHandler = (", rendered, StringComparison.Ordinal)
        Assert.Contains("-> box[0]++", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func VarIntLocal_StaysUnannotated() {
        // Control: an ordinary non-delegate `var` local must not gain a
        // spurious type clause, so a mutant that annotates every `var` local
        // is caught here.
        let rendered = Render(`
namespace Corpus.Issue4116
{
    public class Holder
    {
        public int Compute()
        {
            var value = 1 + 2;
            return value;
        }
    }
}
`)
        Assert.Contains("let value = 1 + 2", rendered, StringComparison.Ordinal)
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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
