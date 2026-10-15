// <copyright file="Issue1729StaticCtorFoldTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #1729 — `cs2gs` folds a "simple" static constructor into its
/// fields' initializers and drops the constructor. The foldability check and
/// the consumption chain had six silent divergence modes; each is covered here.
/// Modes that CAN be represented faithfully as a folded initializer are asserted
/// to fold to the CORRECT value/shape; modes that cannot fold safely
/// (cross-type writes, order-dependent RHS) now map the constructor body to a
/// G# `init { }` static-initializer block (ADR-0140, ADR-0115 §B.11)
/// instead of folding, while side-effecting/duplicate instance-lift hoists still
/// surface a visible (cref:TranslationSeverity.Unsupported) diagnostic or
/// keep the explicit constructor intact rather than silently emitting wrong
/// code.
open class Issue1729StaticCtorFoldTranslationTests {
    /// Regression: a static field with NO inline initializer, assigned once in
    /// the static constructor with an RHS independent of the type's own static
    /// state, still folds — the constructor is dropped and the field carries the
    /// assigned value as its initializer.
    @Fact
    func SimpleStaticCtor_NoInlineInitializer_StillFoldsAndDropsCtor() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static int X;
        static C() { X = 1; }
    }
}`)
        Assert.Contains("var X int32 = 1", printed)
        Assert.DoesNotContain("init()", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// Mode 1: an inline field initializer AND a static-ctor assignment to the
    /// same field must fold to the ctor's value — C# runs field initializers
    /// THEN the static constructor, so the ctor's assignment is the field's true
    /// final value, not the inline initializer.
    @Fact
    func InlineInitializerAndStaticCtorAssignment_FoldsToCtorFinalValue() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static int X = 1;
        static C() { X = 2; }
    }
}`)
        Assert.Contains("var X int32 = 2", printed)
        Assert.DoesNotContain("var X int32 = 1", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// N1: an inline field initializer whose RHS is SIDE-EFFECTING (a call) and a
    /// static-ctor assignment to the same field must NOT silently fold. C# runs
    /// the side-effecting inline initializer, THEN the static constructor
    /// overwrites the field — folding to just the ctor's value would silently
    /// drop the initializer's observable side effect. This must surface an
    /// Unsupported diagnostic instead.
    @Fact
    func InlineInitializerSideEffecting_AndStaticCtorAssignment_ReportsUnsupported_DoesNotFold() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static int Log(int n) => n;
        public static int X = Log(1);
        static C() { X = 2; }
    }
}`)
        Assert.Contains(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
        Assert.DoesNotContain("var X int32 = 2", printed)
    }

    /// N1 (pure path): an inline field initializer whose RHS is a pure
    /// constant/literal is safe to drop when a static-ctor assignment overwrites
    /// it — dropping it does not lose any observable behavior. This still folds
    /// to the ctor's final value with no diagnostic (locks the good path
    /// alongside the side-effecting case above).
    @Fact
    func InlineInitializerPure_AndStaticCtorAssignment_StillFoldsNoDiagnostic() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static int X = 1;
        static C() { X = 2; }
    }
}`)
        Assert.Contains("var X int32 = 2", printed)
        Assert.DoesNotContain("var X int32 = 1", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// Mode 2: a static constructor that assigns another TYPE's static field is
    /// not foldable (the entry would be keyed by the other type's field symbol
    /// and never consumed by this type's fields, silently vanishing). Instead of
    /// folding, its body maps to a G# `init { }` static-initializer block
    /// (ADR-0140) that assigns the other type's field directly, and the other
    /// type's own initializer is left untouched.
    @Fact
    func StaticCtorAssignsOtherTypesField_MapsToInitBlock_DoesNotFold() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class Other
    {
        public static int Field = 0;
    }

    public class C
    {
        static C() { Other.Field = 5; }
    }
}`)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
        Assert.Contains("init {", printed)
        Assert.Contains("Other.Field = 5", printed)
        Assert.Contains("var Field int32 = 0", printed)
        Assert.DoesNotContain("var Field int32 = 5", printed)
    }

    /// Mode 3: a static constructor whose assignment RHS reads the type's OWN
    /// static state cannot be hoisted to the assigned field's declaration
    /// position without risking a change to C#'s
    /// initializers-then-cctor evaluation order. Instead of folding, its body
    /// maps to a G# `init { }` static-initializer block (ADR-0140) that
    /// preserves the original evaluation order.
    @Fact
    func StaticCtorRhsReferencesOwnStaticField_MapsToInitBlock_DoesNotFold() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static int B = 21;
        public static int A;
        static C() { A = B * 2; }
    }
}`)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
        Assert.Contains("init {", printed)
        Assert.Contains("A = B * 2", printed)
        Assert.DoesNotContain("var A int32 = B * 2", printed)
    }

    /// Mode 4: a nested type declared BETWEEN an outer static field's own
    /// (already-folded) static-ctor assignment and the outer field's own
    /// declaration must not wipe the outer type's pending fold — the shared
    /// fold-collection state has to be scoped per type (save/restore around the
    /// nested-type visit), not a single dictionary cleared unconditionally at
    /// the end of every type visit.
    @Fact
    func NestedTypeBetweenOuterFields_DoesNotWipeOuterFoldedInitializer() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class Outer
    {
        public static int Before;
        public class Nested
        {
            public static int NestedField;
            static Nested() { NestedField = 9; }
        }
        public static int After;

        static Outer() { Before = 1; After = 2; }
    }
}`)
        Assert.Contains("var Before int32 = 1", printed)
        Assert.Contains("var After int32 = 2", printed)
        Assert.Contains("var NestedField int32 = 9", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// Mode 5a: an instance constructor's hoist-to-field-initializer lift must
    /// bail when the hoisted RHS is not side-effect-free (a call here) — hoisting
    /// it to the field's declaration position would run it BEFORE another field's
    /// inline initializer that runs first in the real C# constructor-body order.
    /// The explicit constructor is kept intact (never silently reordered).
    @Fact
    func InstanceCtorHoist_SideEffectingRhs_BailsKeepsExplicitCtorOrder() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static int Log(int n) => n;
        public int A = Log(1);
        public int B;
        public C() { B = Log(2); }
    }
}`)
        // The lift must not have hoisted `B = Log(2)` into a field initializer:
        // the explicit constructor body (with the real, un-reordered call order)
        // survives instead.
        Assert.Contains("Log(2)", printed)
        Assert.Contains("var B int32", printed)
        Assert.DoesNotContain("var B int32 = Log(2)", printed)
    }

    /// Mode 5b: an instance constructor that assigns the SAME target field more
    /// than once must bail the lift — hoisting only the last assignment to the
    /// field's initializer position would silently discard the first
    /// assignment's (potentially side-effecting) evaluation entirely.
    @Fact
    func InstanceCtorHoist_RepeatedAssignmentToSameField_Bails() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public int X;
        public C() { X = 1; X = 2; }
    }
}`)
        // Both assignments must survive, in the original order, inside the kept
        // explicit constructor — not collapsed to a single field initializer of
        // `2` that drops the first write.
        let firstIndex = printed.IndexOf("X = 1", StringComparison.Ordinal)
        let secondIndex = printed.IndexOf("X = 2", StringComparison.Ordinal)
        Assert.True(firstIndex >= 0 && secondIndex > firstIndex)
        Assert.DoesNotContain("var X int32 = 2", printed)
    }

    /// Issue #4918: the fold check asks Roslyn for the symbol of every simple
    /// name in the RHS, and the `nameof` in `nameof(Console)` binds to no
    /// symbol. That is "not a static member of the type", so the constructor
    /// still folds; the cut-over had turned it into a NullReferenceException
    /// that crashed the whole translate stage.
    @Fact
    func StaticCtorRhsWithNameof_FoldsWithoutCrashing() {
        let (printed, context) = Translate(`
namespace Demo
{
    public class C
    {
        public static string X;
        static C() { X = nameof(System.Console); }
    }
}`)
        Assert.Contains("var X string = ", printed)
        Assert.DoesNotContain("init()", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    shared {
        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            return (printed, context)
        }
    }
}
