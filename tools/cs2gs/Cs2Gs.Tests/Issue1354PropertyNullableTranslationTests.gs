// <copyright file="Issue1354PropertyNullableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translator-fidelity tests for issue #1354 (the cs2gs part): G# follows
/// Kotlin-style nullability, so a `nil` comparison is only legal on a nullable
/// type. The issue-#1072 null-spillover promotion (`T` rendered `T?` when
/// null-checked) is extended to PROPERTIES, and the flow-proven non-null
/// assertion (`!!`) is extended from receiver positions to VALUE positions
/// (a `return` expression and the arms of a conditional), because G# does not
/// smart-cast a property/field chain. The negative tests pin the precision
/// guards so a property that is never null-checked keeps its non-nullable type
/// and a non-null value is never spuriously asserted.
open class Issue1354PropertyNullableTranslationTests {
    @Fact
    func NullCheckedSettableProperty_RendersNullableType() {
        // A settable auto-property compared against `null` (here via the
        // `is null` pattern) is genuinely nullable and must render `T?`.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Flags { public int Size => 1; }
    public class C
    {
        public Flags Bits { get; set; } = new Flags();
        public int Size() => Bits is null ? 0 : Bits.Size;
    }
}`)
        Assert.Contains("prop Bits Flags?", printed)
    }

    @Fact
    func NullCheckedProperty_ReceiverUse_EmitsNonNullAssertion() {
        // Once the property is promoted to `T?`, a flow-proven non-null member
        // access on it (after the `is null` guard) needs the `!!` assertion,
        // exactly like the existing field/local receiver pass.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Flags { public int Size => 1; }
    public class C
    {
        public Flags Bits { get; set; } = new Flags();
        public int Size()
        {
            if (Bits is null) return 0;
            return Bits.Size;
        }
    }
}`)
        // Issue #4262 follow-up (item 2): `Bits` is a SETTABLE property, so
        // it is not a stable access path (any call could reassign it via its
        // public setter) — the local-capture rewrite deliberately excludes
        // it, leaving the original per-use `!!` in place at this receiver
        // use.
        Assert.Contains("prop Bits Flags?", printed)
        Assert.Contains("Bits!!.Size", printed)
    }

    @Fact
    func NullCheckedComputedProperty_ConditionalArm_EmitsNonNullAssertion() {
        // A computed get-only property that is `null`-checked promotes to `T?`;
        // the non-null conditional ARM that reads it (a VALUE position, not a
        // receiver) gets the `!!` assertion so the conditional unifies to the
        // non-null result type.
        let printed = TranslateUnit(`
#nullable enable
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        private Task? backing;
        protected virtual Task Work => backing ?? Task.CompletedTask;
        public Task Run() => Work is null ? Task.CompletedTask : Work;
    }
}`)
        Assert.Contains("prop Work Task?", printed)
        Assert.Contains("else { Work!! }", printed)
    }

    @Fact
    func NullCheckedComputedProperty_ReturnValue_EmitsNonNullAssertion() {
        // A bare `return Work` of a promoted `T?` property, where the method
        // returns the non-null `T`, gets the `!!` assertion in value position.
        let printed = TranslateUnit(`
#nullable enable
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        private Task? backing;
        protected virtual Task Work => backing ?? Task.CompletedTask;
        public Task Pick(bool b)
        {
            if (Work is null) return Task.CompletedTask;
            return Work;
        }
    }
}`)
        // Issue #4262 follow-up (item 2): `Work` is a COMPUTED (expression-
        // bodied) property, not an auto-property — its getter is not a pure
        // storage read, so the local-capture rewrite deliberately excludes it
        // (capturing would collapse two getter evaluations into one, an
        // observable behavior change for a getter that could have side
        // effects or return a fresh value per call). The original per-use
        // `!!` assertion is therefore still the correct, unchanged output
        // here.
        Assert.Contains("prop Work Task?", printed)
        Assert.Contains("return Work!!", printed)
        Assert.DoesNotContain("__guard", printed)
    }

    @Fact
    func NullCheckedComputedProperty_ExpressionBodiedMember_EmitsNonNullAssertion() {
        // An EXPRESSION-BODIED member (`=> Work`) that returns a promoted `T?`
        // property where the member is declared non-null `T` must route its
        // returned value through the null-forgiveness pass, exactly like the
        // statement-form `return Work;` does. This mirrors Oahu's
        // `Mp4Operation.OperationTask => Continuation` (issue #1354): before the
        // fix, WrapExpressionBody used a plain TranslateExpression and dropped
        // the `!!`, yielding a `T? -> T` mismatch (GS0155).
        let printed = TranslateUnit(`
#nullable enable
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        private Task? backing;
        protected virtual Task Work => backing ?? Task.CompletedTask;
        public void Guard() { if (Work is null) { } }
        public Task OperationTask => Work;
    }
}`)
        Assert.Contains("prop Work Task?", printed)
        Assert.Contains("prop OperationTask Task -> Work!!", printed)
    }

    @Fact
    func PropertyNeverNullChecked_StaysNonNullable() {
        // Precision guard: a property that is never null-checked nor
        // null-assigned keeps its declared non-nullable type, and a plain read
        // of it is never spuriously asserted.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Flags { public int Size => 1; }
    public class C
    {
        public Flags Bits { get; set; } = new Flags();
        public int Size() => Bits.Size;
    }
}`)
        Assert.Contains("prop Bits Flags", printed)
        Assert.DoesNotContain("prop Bits Flags?", printed)
        Assert.DoesNotContain("Bits!!", printed)
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
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
