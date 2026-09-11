// <copyright file="Issue4116XunitAssertEqualNullArgumentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4116 (split from #4045's #2745 residual runtime failure,
/// <c>Issue2745OptionalParameterMetadataEmitTests</c>, "NRE while checking
/// reflected defaults"): <c>Assert.Equal&lt;T&gt;(T expected, T actual)</c> /
/// <c>Assert.NotEqual&lt;T&gt;(T, T)</c> carry no non-null constraint on
/// <c>T</c> in xunit's own signature — comparing a value against a
/// legitimately-null expected/actual result is exactly the point of these
/// overloads (e.g. asserting a reflected <c>ParameterInfo.DefaultValue</c>
/// equals <see langword="null"/> for a <c>string? = nil</c>-defaulted
/// parameter).
/// <para>
/// <c>IsXunitNullAssertionArgument</c> already exempted
/// <c>Assert.Null</c>/<c>Assert.NotNull</c> arguments from gsc's oblivious-
/// forwarding bridge (which otherwise forces a G# <c>!!</c> runtime
/// assertion whenever a nullable-oblivious value flows into an apparently
/// non-null sink), but did not exempt <c>Assert.Equal</c>/
/// <c>Assert.NotEqual</c> — so a helper like
/// <c>AssertDefault(ParameterInfo parameter, object expected) =&gt;
/// Assert.Equal(expected, parameter.DefaultValue);</c>, called once with a
/// literal <c>null</c> expected value, translated to
/// <c>Assert.Equal(expected!!, parameter.DefaultValue!!)</c> — throwing an
/// NRE on the exact call the test exists to prove doesn't throw.
/// </para>
/// </summary>
public class Issue4116XunitAssertEqualNullArgumentTranslationTests
{
    [Fact]
    public void AssertEqual_WithLiteralNullArgument_IsNotForcedNonNull()
    {
        string rendered = Render(@"
using System;
using Xunit;

public static class Probe
{
    public static void CheckDefault(object expected, object actual)
    {
        Assert.Equal(expected, actual);
    }

    public static void Run()
    {
        CheckDefault(null, null);
    }
}
");

        Assert.DoesNotContain("Assert.Equal(expected!!", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("actual!!)", rendered, StringComparison.Ordinal);
        Assert.Contains("Assert.Equal(expected, actual)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void AssertNotEqual_WithLiteralNullArgument_IsNotForcedNonNull()
    {
        string rendered = Render(@"
using System;
using Xunit;

public static class Probe
{
    public static void CheckDifferent(object expected, object actual)
    {
        Assert.NotEqual(expected, actual);
    }

    public static void Run()
    {
        CheckDifferent(null, ""x"");
    }
}
");

        Assert.DoesNotContain("Assert.NotEqual(expected!!", rendered, StringComparison.Ordinal);
        Assert.Contains("Assert.NotEqual(expected, actual)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void AssertContains_WithObliviouslyPromotedArgument_StaysForcedNonNull()
    {
        // Control: Assert.Contains<T>(T expected, IEnumerable<T> collection)
        // shares Assert.Equal's generic two-argument shape (an unconstrained
        // T the general oblivious-forwarding bridge treats as non-null) but
        // is NOT in the Null/NotNull/Equal/NotEqual exemption, so it must
        // keep the existing forced-non-null behavior for an oblivious value
        // promoted nullable by usage evidence (called once with a literal
        // `null`) — proving the exemption is scoped to exactly those four
        // method names, not to every generic-comparison-shaped Xunit method.
        string rendered = Render(@"
using System;
using Xunit;

public static class Probe
{
    private static void CheckContains(object expected, object[] collection)
    {
        Assert.Contains(expected, collection);
    }

    public static void Run()
    {
        CheckContains(null, new object[0]);
    }
}
");

        Assert.Contains("expected!!", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
