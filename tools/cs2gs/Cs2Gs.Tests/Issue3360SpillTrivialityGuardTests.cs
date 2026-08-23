// <copyright file="Issue3360SpillTrivialityGuardTests.cs" company="GSharp">
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
/// Issue #3360: two sites emitted a <c>__spillN</c> temp directly instead of
/// going through <c>SpillOperand</c>, so they bypassed its
/// <c>IsTrivialOperand</c> check and spilled even a bare
/// local/parameter/<c>this</c>/literal — which is safe to duplicate and needs no
/// temp at all.
/// <para>
/// <c>CaptureMethodGroupReceiver</c> uses the same triviality gate only after
/// proving the receiver symbol stable; reassigned locals still spill to
/// preserve C# method-group capture timing (issue #3357 follow-up).
/// </para>
/// Issue #3347 later removes the remaining value-type guard spill by emitting
/// native typed <c>if let</c>, and ADR-0166 (issue #3409) turns an unmodified
/// binder into a native pattern variable (<c>if x is T t { }</c>), so the hoist
/// under test is now only reached for a binder the body reassigns.
/// </summary>
public class Issue3360SpillTrivialityGuardTests
{
    /// <summary>
    /// <c>BuildPositiveValueGuardHoist</c>: the scrutinee is read twice — by the
    /// <c>is</c> guard and by the narrowing conversion — but a bare parameter is
    /// safe to duplicate.
    /// </summary>
    [Fact]
    public void ValueTypeGuard_TrivialScrutinee_EmitsNoSpill()
    {
        // ADR-0166 / issue #3409: the binder is reassigned in the body, so the
        // (let-immutable) native pattern variable path declines and the
        // positive value-guard hoist under test is still the lowering taken.
        string printed = Translate(@"
public sealed class C
{
    public void M(object o)
    {
        if (o is int i) { i = i + 1; System.Console.WriteLine(i); }
    }
}");

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);

        Assert.Contains("var i int32", printed, StringComparison.Ordinal);
        Assert.Contains("if o is int32", printed, StringComparison.Ordinal);
        Assert.Contains("i = int32(o)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A non-trivial scrutinee must be evaluated exactly once. ADR-0166 / issue
    /// #3409: an unmodified binder is a native pattern variable, which reads the
    /// scrutinee once by construction — no spill, no <c>if let</c>.
    /// </summary>
    [Fact]
    public void ValueTypeGuard_NonTrivialScrutinee_UsesNativePatternVariable()
    {
        string printed = Translate(@"
public sealed class C
{
    private static object Get() { return 1; }

    public void M()
    {
        if (Get() is int i) { System.Console.WriteLine(i + 1); }
    }
}");

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("if Get() is int32 i {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("as int32?", printed, StringComparison.Ordinal);

        // Evaluated exactly once: one declaration site, one call.
        Assert.Equal(2, CountOccurrences(printed, "Get()"));
    }

    [Fact]
    public void ValueTypeGuard_ThisScrutinee_EmitsNoSpill()
    {
        string printed = Translate(@"
public sealed class C
{
    public void M()
    {
        if (this is object o) { System.Console.WriteLine(o); }
    }
}");

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        for (int index = haystack.IndexOf(needle, StringComparison.Ordinal);
            index >= 0;
            index = haystack.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
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

        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors)
                + "\n\nPrinted:\n" + printed);

        return printed;
    }
}
