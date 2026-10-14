// <copyright file="Issue1727NamedArgumentReorderTranslationTests.cs" company="GSharp">
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

/// Issue #1727/#3090: cs2gs preserves C# named arguments in canonical G#
/// `name: value` form. Native gsc binding maps names to parameter slots
/// while evaluating argument expressions in lexical source order.
open class Issue1727NamedArgumentReorderTranslationTests {
    @Fact
    func NamedArguments_OutOfDeclarationOrder_PreserveNamesAndSourceOrder() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b) { }

        public void Caller()
        {
            Foo(b: 2, a: 1);
        }
    }
}`)
        Assert.Contains("Foo(b: 2, a: 1)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedArgument_SkipsLeadingOptionalParameters_PreservesName() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a = 1, int b = 2, int c = 3) { }

        public void Caller()
        {
            Foo(c: 5);
        }
    }
}`)
        Assert.Contains("Foo(c: 5)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NamedArguments_AlreadyInDeclarationOrder_TranslateUnchanged() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b) { }

        public void Caller()
        {
            Foo(a: 1, b: 2);
        }
    }
}`)
        Assert.Contains("Foo(a: 1, b: 2)", printed, StringComparison.Ordinal)
    }

    @Fact
    func MixedPositionalAndNamedArguments_PreserveSourceForm() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b, int c) { }

        public void Caller()
        {
            Foo(1, c: 3, b: 2);
        }
    }
}`)
        Assert.Contains("Foo(1, c: 3, b: 2)", printed, StringComparison.Ordinal)
    }

    /// Side-effecting named arguments stay in source order; native gsc lowering
    /// preserves that evaluation order while binding by name.
    @Fact
    func NamedArguments_ReorderingSideEffectingCalls_PreserveSourceOrder() {
        let (unit, context) = Translate(`
namespace Demo
{
    public class C
    {
        public void Foo(int a, int b) { }

        public int NextA() => 1;

        public int NextB() => 2;

        public void Caller()
        {
            Foo(b: NextB(), a: NextA());
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("Foo(b: NextB(), a: NextA())", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    /// A named argument at a leading parameter's own position combined with a
    /// `params` parameter used in EXPANDED form (C# 7.2+) makes several
    /// arguments share the SAME `Parameter.Ordinal` (the params
    /// parameter's). This must not crash the translator (previously an
    /// unguarded `ToDictionary` threw on the duplicate key); since source
    /// order already agrees with declaration order here, it is emitted
    /// unchanged.
    @Fact
    func NamedArgument_WithExpandedParams_DoesNotCrash_EmitsSourceOrder() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int x, params int[] rest) { }

        public void Caller()
        {
            Foo(x: 0, 1, 2, 3);
        }
    }
}`)
        Assert.Contains("Foo(x: 0, 1, 2, 3)", printed, StringComparison.Ordinal)
    }

    /// Skipping a MIDDLE optional parameter (not just a leading one) must
    /// still dense-fill the gap from the parameter's own default.
    @Fact
    func NamedArgument_SkipsMiddleOptionalParameter_PreservesNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int a = 1, int b = 2, int c = 3) { }

        public void Caller()
        {
            Foo(a: 1, c: 5);
        }
    }
}`)
        Assert.Contains("Foo(a: 1, c: 5)", printed, StringComparison.Ordinal)
    }

    /// Sanity baseline: an all-positional call into a `params` parameter
    /// (no named arguments at all) is untouched by the named-argument reorder
    /// path and keeps its correct, unchanged output.
    @Fact
    func AllPositionalArguments_WithParams_TranslateUnchanged() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void Foo(int x, params int[] rest) { }

        public void Caller()
        {
            Foo(1, 2, 3);
        }
    }
}`)
        Assert.Contains("Foo(1, 2, 3)", printed, StringComparison.Ordinal)
    }

    /// A named argument for a leading optional parameter followed by EXPANDED
    /// `params` positional elements (`Merge(additionalCapacity: 8, a, b)`).
    /// Roslyn folds the expanded elements into a single array-creation argument, so
    /// `GetOperation` on each element syntax returns null — the reorder path
    /// previously gapped ("could not be resolved to a parameter", issue #1727) even
    /// though source order already matches declaration order. It must now emit the
    /// call in source order (the named value first, then the params elements).
    @Fact
    func NamedArgument_FollowedByExpandedParams_EmitsSourceOrder() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public byte[] Merge(int additionalCapacity = 0, params byte[][] arrays) => arrays[0];

        public byte[] Caller(byte[] a, byte[] b)
        {
            return Merge(additionalCapacity: 8, a, b);
        }
    }
}`)
        Assert.Contains("Merge(additionalCapacity: 8, a, b)", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConstructorInitializerNames_InParameterOrder_LowerToPositionalArguments() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Base
    {
        public Base(int value, bool enabled) { }
    }

    public class Derived : Base
    {
        public Derived()
            : base(value: 1, enabled: true)
        {
        }
    }
}`)
        Assert.Contains("base(1, true)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("value:", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("enabled:", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConstructorInitializer_TrailingOptionalArgument_IsMaterialized() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Base
    {
        public Base(int value, string label = null) { }
    }

    public class Derived : Base
    {
        public Derived()
            : base(1)
        {
        }
    }
}`)
        Assert.Contains("base(1, nil)", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConstructorInitializerNames_SkippingOptionalParameters_MaterializeDefaults() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Base
    {
        public Base(
            int first,
            int skipped = 2,
            bool enabled = false,
            string label = "default")
        {
        }
    }

    public class Derived : Base
    {
        public Derived()
            : base(1, enabled: true, label: "chosen")
        {
        }
    }
}`)
        Assert.Contains("base(1, 2, true, \"chosen\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("enabled:", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("label:", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConstructorInitializer_NullableOptionalAndParamsContracts_ArePreserved() {
        let printed = TranslateUnit(`#nullable enable

namespace Demo
{
    public class Base
    {
        public Base(int value, string? label = null, params string?[] tags) { }
    }

    public class Derived : Base
    {
        public Derived()
            : base(value: 1, tags: new string?[] { null, "tag" })
        {
        }
    }
}`)
        Assert.Contains("base(1, nil, []string?{nil, \"tag\"})", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConstructorInitializerNames_ReorderedTrivialValues_LowerPositionally() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Base
    {
        public Base(int first = 0, int second = 0, int third = 0) { }
    }

    public class Derived : Base
    {
        public Derived()
            : base(third: 3, first: 1)
        {
        }
    }
}`)
        Assert.Contains("base(1, 0, 3)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("first:", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("third:", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateUnit(source string) string {
            let (unit, _) = Translate(source)
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

        private func AssertRoundTrip(printed string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
        }

        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }
    }
}
