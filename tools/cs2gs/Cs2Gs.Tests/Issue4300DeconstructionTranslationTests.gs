// <copyright file="Issue4300DeconstructionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Focused translation coverage for issue #4300 carrier allocation.
class Issue4300DeconstructionTranslationTests {
    @Fact
    func NestedDeclarations_BindSimpleLeavesDirectly_PerBody() {
        let printed = Translate(`public sealed class Runner
{
    public int First()
    {
        var (a, (b, c)) = (1, (2, 3));
        return a + b + c;
    }

    public int Second()
    {
        var (a, (b, c)) = (1, (2, 3));
        return a + b + c;
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "let (a, bTuple) = (1, (2, 3))"))
        Assert.Equal(2, CountOccurrences(printed, "let (b, c) = bTuple"))
        Assert.DoesNotContain("aValue", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("bTuple2", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func LambdaAndLocalFunction_CollidingOuterName_UseIndependentBodyNames() {
        let printed = Translate(`using System;

public sealed class Runner
{
    public int Run()
    {
        int aTuple = 100;
        Func<int> lambda = () =>
        {
            int a = 0;
            int b = 0;
            int c = 0;
            ((a, b), c) = ((1, 2), 3);
            return a + b + c + aTuple;
        };

        int Local()
        {
            int a = 0;
            int b = 0;
            int c = 0;
            ((a, b), c) = ((4, 5), 6);
            return a + b + c + aTuple;
        }

        return lambda() + Local();
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "let (aTuple2, cValue) ="))
        Assert.DoesNotContain("aTuple3", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Runner().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(221, result.Value)
    }

    @Fact
    func LaterSourceLocal_IsReservedBeforeCarrierAllocation() {
        let printed = Translate(`public sealed class Runner
{
    public int Run()
    {
        int a = 0;
        int b = 0;
        int c = 0;
        ((a, b), c) = ((1, 2), 3);
        int aTuple = 4;
        return a + b + c + aTuple;
    }
}`)
        Assert.Contains("let (aTuple2, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func NestedDeclaration_RhsDeconstructionAssignment_PreservesWritesAndValue() {
        let printed = Translate(`public sealed class Runner
{
    public int Run()
    {
        int x = 0;
        int y = 0;
        int z = 0;
        var (a, (b, c)) = ((x, (y, z)) = (1, (2, 3)));
        return (x * 100000) + (y * 10000) + (z * 1000) + (a * 100) + (b * 10) + c;
    }
}`)
        Assert.Contains("let (xValue, yTuple) = (1, (2, 3))", printed, StringComparison.Ordinal)
        Assert.Contains("x = xValue", printed, StringComparison.Ordinal)
        Assert.Contains("let (yValue, zValue) = yTuple", printed, StringComparison.Ordinal)
        Assert.Contains("y = yValue", printed, StringComparison.Ordinal)
        Assert.Contains("z = zValue", printed, StringComparison.Ordinal)
        Assert.Contains("let (a, bTuple) = ((xValue, (yValue, zValue)))", printed, StringComparison.Ordinal)
        Assert.Contains("let (b, c) = bTuple", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Runner().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(123123, result.Value)
    }

    @Fact
    func TupleExpressionNestedDeclaration_UsesRecursiveLowering() {
        let printed = Translate(`public sealed class Runner
{
    public int Run()
    {
        (var first, var (second, third)) = (1, (2, 3));
        return (first * 100) + (second * 10) + third;
    }
}`)
        Assert.Contains("let (first, secondTuple) = (1, (2, 3))", printed, StringComparison.Ordinal)
        Assert.Contains("let (second, third) = secondTuple", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let (first, _)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Runner().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(123, result.Value)
    }

    @Fact
    func NestedBodyLocals_DoNotReserveOuterCarrierNames() {
        let printed = Translate(`using System;

public sealed class Runner
{
    public int Run()
    {
        int a = 0;
        int b = 0;
        int c = 0;
        ((a, b), c) = ((1, 2), 3);

        Func<int> lambda = () =>
        {
            int aTuple = 4;
            return aTuple;
        };

        int Local()
        {
            int aTuple = 5;
            return aTuple;
        }

        return a + b + c + lambda() + Local();
    }

    public int Other()
    {
        int a = 0;
        int b = 0;
        int c = 0;
        ((a, b), c) = ((1, 2), 3);

        int aTuple() => 4;
        return a + b + c;
    }
}`)
        Assert.Contains("let (aTuple, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        Assert.Contains("let (aTuple2, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "(Runner().Run() * 100) + Runner().Other()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(1506, result.Value)
    }

    @Fact
    func NestedBodyOuterMemberReference_ReservesOuterCarrierName() {
        let printed = Translate(`using System;

public sealed class Runner
{
    private int aTuple = 100;

    public int Run()
    {
        int a = 0;
        int b = 0;
        int c = 0;
        ((a, b), c) = ((1, 2), 3);

        Func<int> read = () => aTuple;
        return a + b + c + read();
    }
}`)
        Assert.Contains("let (aTuple2, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let (aTuple, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Runner().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(106, result.Value)
    }

    @Fact
    func NestedBodyOuterGenericMethodReference_ReservesOuterCarrierName() {
        let printed = Translate(`using System;

public sealed class Runner
{
    private int aTuple<T>() => 100;

    public int Run()
    {
        int a = 0;
        int b = 0;
        int c = 0;
        ((a, b), c) = ((1, 2), 3);

        Func<int> read = () => aTuple<int>();
        return a + b + c + read();
    }
}`)
        Assert.Contains("let (aTuple2, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let (aTuple, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Runner().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(106, result.Value)
    }

    @Fact
    func NestedBodyCapturedLocal_DoesNotReserveOuterCarrierName() {
        let printed = Translate(`using System;

public sealed class Runner
{
    public int Run()
    {
        int a = 0;
        int b = 0;
        int c = 0;
        ((a, b), c) = ((1, 2), 3);

        int Local()
        {
            int aTuple = 4;
            Func<int> read = () => aTuple;
            return read();
        }

        return a + b + c + Local();
    }
}`)
        Assert.Contains("let (aTuple, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let (aTuple2, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Runner().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(10, result.Value)
    }

    shared {
        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var start = 0
            while (start = text.IndexOf(value, start, StringComparison.Ordinal)) >= 0 {
                count++
                start += value.Length
            }
            return count
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
            )
            return printed
        }
    }
}
