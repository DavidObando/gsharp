// <copyright file="Issue3358NativeMultiAssignmentTranslationTests.cs" company="GSharp">
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

/// Issues #3353/#3358: a C# deconstruction assignment into existing variables
/// or storage locations renders as G#'s native multi-target assignment rather
/// than a temporary tuple binding plus per-target-write triple.
///
/// ADR-0015 evaluates every right-hand expression left-to-right into temporaries
/// BEFORE any write, then assigns left-to-right — exactly the order C# specifies,
/// so an aliasing swap stays correct without the tool synthesising its own temps.
///
/// This corrects a mis-classification in issue #3347, which recorded
/// `__deconN` as a G# language gap. It is not: the native form covers 378 of
/// the 389 deconstruction assignments measured in dotnet/roslyn (97%).
open class Issue3358NativeMultiAssignmentTranslationTests {
    @Fact
    func Swap_UsesNativeMultiAssignment() {
        let printed = Translate(`
public sealed class C
{
    public void M()
    {
        int a = 1, b = 2;
        (a, b) = (b, a);
        System.Console.WriteLine(a + b);
    }
}`)
        Assert.Contains("a, b = b, a", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    @Fact
    func Discard_UsesNativeMultiAssignment() {
        let printed = Translate(`
public sealed class C
{
    public void M()
    {
        int a = 0;
        (a, _) = (1, 2);
        System.Console.WriteLine(a);
    }
}`)
        Assert.Contains("a, _ = 1, 2", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    @Fact
    func ThreeTargets_UsesNativeMultiAssignment() {
        let printed = Translate(`
public sealed class C
{
    public void M()
    {
        int a = 0, b = 0, c = 0;
        (a, b, c) = (1, 2, 3);
        System.Console.WriteLine(a + b + c);
    }
}`)
        Assert.Contains("a, b, c = 1, 2, 3", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    /// G# now captures storage-target components before the RHS itself, so D2
    /// receiver/index spills and deconstruction temps are redundant.
    @Fact
    func StorageTargets_UseNativeMultiAssignment() {
        let printed = Translate(`
public sealed class C
{
    public void M(int[] arr, int i)
    {
        (arr[i], arr[i + 1]) = (1, 2);
    }
}`)
        Assert.Contains("arr[i], arr[i + 1] = 1, 2", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    /// Bare property target uses same native storage-target path.
    @Fact
    func PropertyTarget_UsesNativeMultiAssignment() {
        let printed = Translate(`
public sealed class C
{
    public int P { get; set; }

    public void M()
    {
        (P, _) = (5, 6);
    }
}`)
        Assert.Contains("P, _ = 5, 6", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    /// Tuple-valued call remains one RHS expression and is evaluated once.
    @Fact
    func TupleReturningCall_UsesNativeMultiAssignment() {
        let printed = Translate(`
public sealed class C
{
    private static (int, int) Pair() { return (1, 2); }

    public void M()
    {
        int a = 0, b = 0;
        (a, b) = Pair();
        System.Console.WriteLine(a + b);
    }
}`)
        Assert.Contains("a, b = Pair()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    @Fact
    func TupleReturningCall_TranslatedGSharp_BindsAndRuns() {
        let printed = Translate(`
public sealed class C
{
    private static int calls;

    private static (int, int) Pair()
    {
        calls++;
        return (4, 2);
    }

    public int M()
    {
        int a = 0, b = 0;
        (a, b) = Pair();
        return (calls * 100) + (a * 10) + b;
    }
}`)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C().M()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(142, result.Value)
    }

    @Fact
    func NonTupleDeconstructSource_KeepsRecursiveLowering() {
        let printed = Translate(`
public sealed class Pair
{
    public void Deconstruct(out int first, out int second)
    {
        first = 1;
        second = 2;
    }
}

public sealed class C
{
    public void M()
    {
        int a = 0, b = 0;
        (a, b) = new Pair();
    }
}`, "G# deconstruction currently supports tuples and data structs, not C# Deconstruct methods.")
        Assert.Contains("let (aValue, bValue) = Pair()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    @Fact
    func MixedDeclaration_UsesInlineFreshTarget() {
        let printed = Translate(`
public sealed class C
{
    public void M()
    {
        int a = 0;
        (a, var y) = (1, 2);
        System.Console.WriteLine(a + y);
    }
}`)
        Assert.Contains("a, let y = 1, 2", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    /// A nested target tuple has no flat multi-target form.
    @Fact
    func NestedTargets_KeepRecursiveLoweringWithReadableCarriers() {
        let printed = Translate(`
public sealed class C
{
    public void M()
    {
        int a = 0, b = 0, c = 0;
        ((a, b), c) = ((1, 2), 3);
        System.Console.WriteLine(a + b + c);
    }
}`)
        Assert.Contains("let (aTuple, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal)
        Assert.Contains("let (aValue, bValue) = aTuple", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `using System;

namespace Demo
{
` + source + `
}
`)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
