// <copyright file="Issue3358NativeMultiAssignmentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issues #3353/#3358: a C# deconstruction assignment into existing variables
/// or storage locations renders as G#'s native multi-target assignment rather
/// than the <c>let (__decon0, __decon1) = …</c> plus per-target-write triple.
/// <para>
/// ADR-0015 evaluates every right-hand expression left-to-right into temporaries
/// BEFORE any write, then assigns left-to-right — exactly the order C# specifies,
/// so an aliasing swap stays correct without the tool synthesising its own temps.
/// </para>
/// <para>
/// This corrects a mis-classification in issue #3347, which recorded
/// <c>__deconN</c> as a G# language gap. It is not: the native form covers 378 of
/// the 389 deconstruction assignments measured in dotnet/roslyn (97%).
/// </para>
/// </summary>
public class Issue3358NativeMultiAssignmentTranslationTests
{
    [Fact]
    public void Swap_UsesNativeMultiAssignment()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M()
    {
        int a = 1, b = 2;
        (a, b) = (b, a);
        System.Console.WriteLine(a + b);
    }
}");

        Assert.Contains("a, b = b, a", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Discard_UsesNativeMultiAssignment()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M()
    {
        int a = 0;
        (a, _) = (1, 2);
        System.Console.WriteLine(a);
    }
}");

        Assert.Contains("a, _ = 1, 2", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ThreeTargets_UsesNativeMultiAssignment()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M()
    {
        int a = 0, b = 0, c = 0;
        (a, b, c) = (1, 2, 3);
        System.Console.WriteLine(a + b + c);
    }
}");

        Assert.Contains("a, b, c = 1, 2, 3", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// G# now captures storage-target components before the RHS itself, so D2
    /// receiver/index spills and deconstruction temps are redundant.
    /// </summary>
    [Fact]
    public void StorageTargets_UseNativeMultiAssignment()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M(int[] arr, int i)
    {
        (arr[i], arr[i + 1]) = (1, 2);
    }
}");

        Assert.Contains("arr[i], arr[i + 1] = 1, 2", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Bare property target uses same native storage-target path.
    /// </summary>
    [Fact]
    public void PropertyTarget_UsesNativeMultiAssignment()
    {
        string printed = Translate(@"
public sealed class C
{
    public int P { get; set; }

    public void M()
    {
        (P, _) = (5, 6);
    }
}");

        Assert.Contains("P, _ = 5, 6", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Tuple-valued call remains one RHS expression and is evaluated once.
    /// </summary>
    [Fact]
    public void TupleReturningCall_UsesNativeMultiAssignment()
    {
        string printed = Translate(@"
public sealed class C
{
    private static (int, int) Pair() { return (1, 2); }

    public void M()
    {
        int a = 0, b = 0;
        (a, b) = Pair();
        System.Console.WriteLine(a + b);
    }
}");

        Assert.Contains("a, b = C.Pair()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TupleReturningCall_TranslatedGSharp_BindsAndRuns()
    {
        string printed = Translate(@"
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
}");

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C().M()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(142, result.Value);
    }

    [Fact]
    public void NonTupleDeconstructSource_KeepsRecursiveLowering()
    {
        string printed = Translate(@"
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
}",
            "G# deconstruction currently supports tuples and data structs, not C# Deconstruct methods.");

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MixedDeclaration_UsesInlineFreshTarget()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M()
    {
        int a = 0;
        (a, var y) = (1, 2);
        System.Console.WriteLine(a + y);
    }
}");

        Assert.Contains("a, let y = 1, 2", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A nested target tuple has no flat multi-target form.
    /// </summary>
    [Fact]
    public void NestedTargets_KeepTheDeconLowering()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M()
    {
        int a = 0, b = 0, c = 0;
        ((a, b), c) = ((1, 2), 3);
        System.Console.WriteLine(a + b + c);
    }
}");

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source, string roundTripOnlyReason = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", "using System;\n\nnamespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        RoundTripResult roundTrip = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors)
                + "\n\nPrinted:\n" + printed);

        return printed;
    }
}
