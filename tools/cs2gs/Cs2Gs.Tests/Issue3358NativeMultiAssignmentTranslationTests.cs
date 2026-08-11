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
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3358: a C# deconstruction assignment into existing variables renders
/// as G#'s native multi-target assignment (<c>a, b = b, a</c>, ADR-0015) rather
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
    /// A storage target is GS0005 in the native form (`arr[i], o.F = …`), so it
    /// keeps the existing lowering — including the receiver/index spill that
    /// preserves C#'s targets-then-value order (#2234).
    /// </summary>
    [Fact]
    public void StorageTargets_KeepTheDeconLowering()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M(int[] arr, int i)
    {
        (arr[i], arr[i + 1]) = (1, 2);
    }
}");

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A bare-identifier target that is a FIELD or property is still a storage
    /// location, not a local, and must not be mistaken for one.
    /// </summary>
    [Fact]
    public void PropertyTarget_KeepsTheDeconLowering()
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

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("P, _ = 5, 6", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// `gsc` will not spread a single tuple-valued right-hand side across N
    /// targets (GS0167), so a tuple-returning call keeps the decon lowering.
    /// </summary>
    [Fact]
    public void TupleReturningCall_KeepsTheDeconLowering()
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

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A mixed declaration (`a, let y = …`) is GS0005 in the native form.
    /// </summary>
    [Fact]
    public void MixedDeclaration_KeepsTheDeconLowering()
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

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
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

    private static string Translate(string source)
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

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors)
                + "\n\nPrinted:\n" + printed);

        return printed;
    }
}
