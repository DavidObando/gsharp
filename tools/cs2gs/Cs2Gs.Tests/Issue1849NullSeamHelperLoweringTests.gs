// <copyright file="Issue3355NullSeamBlockExpressionLoweringTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #3355 replaces issue #1849's synthesized `__initN(__pN)`
/// helpers with native block expressions when statements remain necessary.
/// Issue #3347 removes those blocks too when a native boolean pattern can
/// evaluate the scrutinee once.
open class Issue3355NullSeamBlockExpressionLoweringTests {
    @Fact
    func FieldInitializer_PatternScrutinee_UsesNativeBlock() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public sealed class C
    {
        private static A GetA() => new A { X = 1, Y = 2 };

        private bool flag = GetA() is { X: 1, Y: 2 };
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetA()"))
        Assert.Contains("private var flag bool = GetA() is { X: 1, Y: 2 }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
    }

    @Fact
    func GetOnlyPropertyInitializer_PatternScrutinee_UsesNativeBlock() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
    }

    public sealed class C
    {
        private static int calls;

        private static A GetA()
        {
            calls++;
            return new A { X = 1 };
        }

        public bool P { get; } = GetA() is { X: > 0 };

        public int Run() => (P ? 100 : 0) + calls;
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetA()"))
        Assert.Contains("GetA() is { X: > 0 }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C().Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(101, result.Value)
    }

    @Fact
    func StaticFieldAndPropertyInitializers_KeepStaticContext() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
    }

    public sealed class C
    {
        private static int calls;

        private static A GetA()
        {
            calls++;
            return new A { X = 1 };
        }

        private static bool flag = GetA() is { X: 1 };
        public static bool P { get; } = GetA() is { X: > 0 };

        public static int Run() =>
            (flag ? 100 : 0) + (P ? 100 : 0) + calls;
    }
}`)
        Assert.Equal(3, CountOccurrences(printed, "GetA()"))
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(202, result.Value)
    }

    @Fact
    func BaseConstructorNamedArgument_UsesNativeBlock() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public class Base
    {
        public Base(bool flag) { }
    }

    public sealed class Derived : Base
    {
        private static A GetA() => new A { X = 1, Y = 2 };

        public Derived() : base(flag: GetA() is { X: 1, Y: 2 }) { }
    }
}`, "Named base-constructor arguments remain a known G# binding gap; this test isolates block lowering.")
        Assert.Equal(2, CountOccurrences(printed, "GetA()"))
        Assert.Contains("init() : base(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(": base(flag:", printed, StringComparison.Ordinal)
        Assert.Contains("GetA() is { X: 1, Y: 2 }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
    }

    @Fact
    func ThisConstructorArgument_UsesNativeBlockAndKeepsParametersInScope() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public sealed class C
    {
        public C(bool flag) { }

        private static A GetA() => new A { X = 1, Y = 2 };

        public C(int expected)
            : this(GetA() is { X: > 0, Y: var y } && y == expected)
        {
        }
    }
}`)
        Assert.Contains("is { X: > 0, Y: var y } && y == expected", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("expected", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
    }

    @Fact
    func RefConstructorArgument_KeepsAddressOutsideNativeBlock() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public class Base
    {
        public Base(ref bool value)
        {
            value = true;
        }
    }

    public sealed class Derived : Base
    {
        private static int calls;
        private static bool whenTrue;
        private static bool whenFalse;

        private static A GetA()
        {
            calls++;
            return new A { X = 1, Y = 2 };
        }

        public Derived()
            : base(ref (GetA() is { X: 1, Y: 2 } ? ref whenTrue : ref whenFalse))
        {
        }

        public int Run() =>
            calls * 100 + (whenTrue ? 10 : 0) + (whenFalse ? 1 : 0);
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetA()"))
        Assert.Contains(": base(&", printed, StringComparison.Ordinal)
        Assert.Contains("GetA() is { X: 1, Y: 2 }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Derived().Run()")
        Assert.False(
            result.Diagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(110, result.Value)
    }

    @Fact
    func NestedNullSeamOperand_UsesOnlyInScopeSpillLocals() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class C
    {
        private static int[] Y = new int[] { 1, 2, 3, 4, 5 };
        private static int Z() => 1;
        private const int a = 3;

        private bool flag = Y[Z()..a] is [1, 2];
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__p", printed, StringComparison.Ordinal)
        AssertNoHelperOrGap(printed, context)
    }

    @Fact
    func TranslatedFieldInitializer_BindsEmitsAndRunsOnce() {
        let (printed, context) = TranslateUnitWithContext(`namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public sealed class C
    {
        private static int calls;

        private static A GetA()
        {
            calls++;
            return new A { X = 1, Y = 2 };
        }

        private bool flag = GetA() is { X: 1, Y: 2 };

        public int Run() => (flag ? 100 : 0) + calls;
    }
}`)
        AssertNoHelperOrGap(printed, context)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C().Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(101, result.Value)
    }

    shared {
        private func AssertNoHelperOrGap(printed string, context TranslationContext) {
            Assert.DoesNotContain("__init", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("__p", printed, StringComparison.Ordinal)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
        }

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func TranslateUnitWithContext(source string, roundTripOnlyReason string? = nil)(
            Printed string,
            Context TranslationContext
        ) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
