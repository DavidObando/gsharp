// <copyright file="Issue4116XunitAssertEqualNullArgumentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
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

    [Fact]
    public void CustomAssertEqual_InANamespaceOnlyEndingInXunit_StaysForcedNonNull()
    {
        // Control (Copilot review on #4209): the namespace check must pin
        // the EXACT top-level `Xunit` namespace (`global::Xunit`), not
        // merely a namespace whose LAST segment happens to be named
        // "Xunit". `Company.Xunit.Assert.Equal` is an unrelated,
        // non-exempted method that just happens to share the name/shape.
        //
        // IMPORTED (a genuinely separately-compiled, referenced assembly —
        // not a same-compilation declaration): gsc's oblivious-PROMOTION
        // mechanism only ever rewrites a SAME-compilation declaration's own
        // parameter type, so a same-file "Company.Xunit.Assert.Equal" would
        // itself get silently promoted to `object?` by usage evidence,
        // masking the exact bug this control exists to catch. An imported
        // method's declared (non-nullable, explicitly `#nullable enable`)
        // parameter can never be rewritten that way, so its own contract is
        // what decides — and a mutant that matches on the namespace's leaf
        // name alone is caught here.
        MetadataReference customAssertLibrary = CompileLibraryReference(@"
#nullable enable
namespace Company.Xunit
{
    public static class Assert
    {
        public static void Equal(object expected, object actual)
        {
        }
    }
}
");

        string rendered = Render(
            @"
using Company.Xunit;

public static class Probe
{
    private static void CheckDefault(object expected, object actual)
    {
        Assert.Equal(expected, actual);
    }

    public static void Run()
    {
        CheckDefault(null, null);
    }
}
",
            additionalReferences: new[] { customAssertLibrary });

        // Round-trip binding is skipped here: it would require also
        // resolving the compiled "Company.Xunit.Assert" library on gsc's
        // OWN (separate) ReferenceResolver, which this control's narrow
        // purpose — proving the printed text still forces `!!` — does not
        // warrant.
        Assert.Contains("expected!!", rendered, StringComparison.Ordinal);
    }

    private static MetadataReference CompileLibraryReference(string source)
    {
        var syntaxTree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var compilation = CSharpCompilation.Create(
            "Issue4116CustomXunitLibrary",
            new[] { syntaxTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        stream.Position = 0;
        return MetadataReference.CreateFromStream(stream);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source, MetadataReference[] additionalReferences = null)
    {
        IReadOnlyList<MetadataReference> references = additionalReferences == null
            ? null
            : CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences).ToList();

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) },
            references);

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
