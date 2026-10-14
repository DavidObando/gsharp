// <copyright file="Issue3394NegatedPatternGuardTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3394: a negated pattern binder behind an earlier short-circuit guard
/// must keep evaluation order and remain in scope after an exiting guard.
///
/// ADR-0166 / issue #3409: G# now scopes pattern variables the way C# definite
/// assignment does, so the translator keeps a qualifying negated guard verbatim
/// (`if !(x is T t) { return }` followed by plain `t`) instead of
/// hoisting `let t T? = x as T` above the `if`. The hoist lowering
/// remains the fallback for a binder that is later reassigned (G# pattern
/// variables are `let`-immutable) and is witnessed by
/// (cref:LogicalNotAroundDeclarationPattern_ReassignedBinder_HoistsSurvivingBinder)
/// and (cref:ReassignedNegatedPatternBinder_IsMutable).
open class Issue3394NegatedPatternGuardTranslationTests {
    @Fact
    func PriorOrGuard_RunsBeforePatternReceiver_AndBinderSurvives() {
        const source = `
namespace Demo
{
    public sealed class Candidate
    {
        public bool IsGeneric;
        public int Value;
    }

    public static class C
    {
        public static bool TryRead(Candidate[] candidates, out int value)
        {
            value = 0;
            if (candidates.Length != 1
                || candidates[0] is not { IsGeneric: false } candidate)
            {
                return false;
            }

            value = candidate.Value;
            return true;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        // ADR-0166 / issue #3409: the pattern stays in the condition, so the
        // `||` prefix guard still runs before `candidates[0]` is ever read and
        // `candidate` survives the exiting guard as a native pattern variable.
        let prefixGuard = rendered.IndexOf("if candidates.Length != 1 ||", StringComparison.Ordinal)
        let patternTest = rendered.IndexOf(
            "candidates[0] is not { IsGeneric: false } candidate",
            StringComparison.Ordinal
        )
        Assert.True(prefixGuard >= 0 && patternTest > prefixGuard, rendered)
        Assert.Contains(
            "if candidates.Length != 1 || candidates[0] is not { IsGeneric: false } candidate {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("value = candidate.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let __spill", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func LogicalNotAroundDeclarationPattern_KeepsBinderAsNativePatternVariable() {
        const source = `
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base
    {
        public int Value;
    }

    public static class C
    {
        public static int Read(Base value)
        {
            if (!(value is Candidate candidate))
            {
                return 0;
            }

            return candidate.Value;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        // ADR-0166 / issue #3409: `!(x is T t)` is native G#; no hoisted `let t T?`.
        Assert.Contains("if !(value is Candidate candidate) {", rendered, StringComparison.Ordinal)
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(" as Candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    /// Witness for the negated-guard HOIST lowering: ADR-0166 / issue #3409
    /// keeps a `!(x is T t)` guard native only while `t` is never
    /// reassigned; this input reassigns `candidate` after the guard, so the
    /// translator must still take the legacy hoist and declare a mutable
    /// nullable local above the exiting `if`.
    @Fact
    func LogicalNotAroundDeclarationPattern_ReassignedBinder_HoistsSurvivingBinder() {
        const source = `
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base
    {
        public int Value;
    }

    public static class C
    {
        private static Candidate Normalize(Candidate value) => value;

        public static int Read(Base value)
        {
            if (!(value is Candidate candidate))
            {
                return 0;
            }

            candidate = Normalize(candidate);
            return candidate.Value;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("var candidate Candidate? = value as Candidate", rendered, StringComparison.Ordinal)
        Assert.Contains("if candidate == nil {", rendered, StringComparison.Ordinal)
        Assert.Contains("candidate = Normalize(candidate)", rendered, StringComparison.Ordinal)
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("is Candidate candidate", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func MultipleNegatedPatterns_KeepEveryBinderAsNativePatternVariable() {
        const source = `
namespace Demo
{
    public class Base { }
    public sealed class Left : Base { public int Value; }
    public sealed class Right : Base { public int Value; }

    public static class C
    {
        public static int Read(Base left, Base right)
        {
            if (left is not Left typedLeft || right is not Right typedRight)
            {
                return 0;
            }

            return typedLeft.Value + typedRight.Value;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: both `is not` binders stay in the condition
        // as native `is not` tests; nothing is hoisted.
        Assert.Contains(
            "if left is not Left typedLeft || right is not Right typedRight {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("typedLeft.Value + typedRight.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let typedLeft", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let typedRight", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(" as ", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ReassignedNegatedPatternBinder_IsMutable() {
        const source = `
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base { public int Value; }

    public static class C
    {
        private static Candidate Normalize(Candidate value) => value;

        public static int Read(Base value)
        {
            if (value is not Candidate candidate)
            {
                return 0;
            }

            candidate = Normalize(candidate);
            return candidate.Value;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("var candidate Candidate?", rendered, StringComparison.Ordinal)
        Assert.Contains("candidate = Normalize(candidate)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NullableValueNegatedPattern_KeepsBinderAsNativePatternVariable() {
        const source = `
namespace Demo
{
    public static class C
    {
        public static int Read(int? value)
        {
            if (value is not int present)
            {
                return 0;
            }

            return present;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: the nullable value type unwraps through the
        // native `value is not int32 present` guard; no `let present int32? = value`.
        Assert.Contains("if value is not int32 present {", rendered, StringComparison.Ordinal)
        Assert.Contains("return present", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let present", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func BoxedValueNegatedPattern_KeepsBinderAsNativePatternVariable() {
        const source = `
namespace Demo
{
    public static class C
    {
        public static bool Read(object value)
        {
            if (value is not bool present)
            {
                return false;
            }

            return present;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: the boxed value unboxes through the native
        // `value is not bool present` guard; no `let present bool? = value as bool?`.
        Assert.Contains("if value is not bool present {", rendered, StringComparison.Ordinal)
        Assert.Contains("return present", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let present", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(" as bool", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NestedPropertyPatternBinder_KeepsBinderAsNativePatternVariable() {
        const source = `
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base { public int Value; }
    public sealed class Holder
    {
        public Base Child;
    }

    public static class C
    {
        public static int Read(Holder value)
        {
            if (value is not Holder { Child: Candidate candidate })
            {
                return 0;
            }

            return candidate.Value;
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: the nested designation stays inside the
        // property pattern and is read as plain `candidate` (no `__spillN`
        // receiver temp, no `var candidate Candidate?`, no `!!`).
        Assert.Contains("if !(value is Holder { Child: Candidate candidate }) {", rendered, StringComparison.Ordinal)
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("candidate!!", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("var candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func PriorOrGuard_WithElse_KeepsPatternBinderInElseScope() {
        const source = `
namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base { public int Value; }

    public static class C
    {
        private static Base Get(Base value) => value;

        public static int Read(bool skip, Base value)
        {
            if (skip || !(Get(value) is Candidate candidate))
            {
                return 0;
            }
            else
            {
                return candidate.Value;
            }
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: `skip` is still tested before `Get(value)` is
        // called, and the else-branch sees the when-false pattern variable.
        let prefixGuard = rendered.IndexOf("if skip ||", StringComparison.Ordinal)
        let patternTest = rendered.IndexOf("!(Get(value) is Candidate candidate)", StringComparison.Ordinal)
        Assert.True(prefixGuard >= 0 && patternTest > prefixGuard, rendered)
        Assert.Contains("if skip || !(Get(value) is Candidate candidate) {", rendered, StringComparison.Ordinal)
        Assert.Contains("} else {", rendered, StringComparison.Ordinal)
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }
}
