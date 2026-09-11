// <copyright file="Issue4116ImplicitArrayLiteralNullableElementTranslationTests.cs" company="GSharp">
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
/// Issue #4116 (split from #4045's #2388 residual runtime failure,
/// <c>Issue2388NullableCustomEqualityEmitTests</c>, "runtime NRE"): an
/// implicit array literal (<c>new[] { a, b }</c>) passed straight into a BCL
/// sink whose parameter array itself accepts nullable elements (e.g.
/// <c>MethodBase.Invoke(object? obj, object?[]? parameters)</c>) forced a
/// legitimately-null element (e.g. a boxed default <c>Nullable&lt;T&gt;</c>,
/// which really is <see langword="null"/>) into a G# <c>!!</c> runtime
/// assertion and threw.
/// <para>
/// Root cause: <c>TranslateImplicitArrayCreation</c> computed its
/// per-element nullability contract from
/// <c>GetTypeInfo(creation).Type</c>/<c>.ConvertedType</c> — but in a
/// nullable-OBLIVIOUS file (no <c>#nullable enable</c> — exactly the
/// migrated corpus's own state, per the codebase's own
/// <c>IsObliviousCompilation</c> concept), Roslyn does not compute
/// per-EXPRESSION nullable annotations at all: both properties report
/// <c>NullableAnnotation.None</c> for the array literal's element, even
/// though the parameter it flows into (<c>MethodBase.Invoke</c>'s
/// <c>object?[]?</c>) is genuinely nullable-annotated in the BCL's own
/// metadata. The fix instead resolves the array element type from the
/// call's BOUND PARAMETER SYMBOL (via the enclosing argument's
/// <c>IArgumentOperation</c>) when the literal is a direct call argument —
/// a parameter's own annotation comes from the CALLEE's metadata and is
/// visible regardless of the caller's own nullable context, unlike
/// expression-level <c>GetTypeInfo</c>.
/// </para>
/// </summary>
public class Issue4116ImplicitArrayLiteralNullableElementTranslationTests
{
    [Fact]
    public void ImplicitArrayLiteral_PassedToBclNullableElementParameter_DoesNotAssertItsElements()
    {
        // The exact shape from Issue2388NullableCustomEqualityEmitTests:
        // a nullable-oblivious file, `var n = Activator.CreateInstance(...)`
        // (a genuinely `object?`-typed local, from the BCL's own annotated
        // return), forwarded whole into `MethodInfo.Invoke`'s `object?[]?`
        // parameters array via an implicit array literal.
        string rendered = Render(@"
using System;
using System.Reflection;

public static class Probe
{
    public static void Run(MethodInfo eqMethod, object m1, Type nullableType)
    {
        var n = Activator.CreateInstance(nullableType);
        eqMethod.Invoke(null, new[] { m1, n });
    }
}
");

        Assert.DoesNotContain("n!!", rendered, StringComparison.Ordinal);
        Assert.Contains("eqMethod.Invoke(nil, []object{m1, n})", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParenthesizedImplicitArrayLiteral_PassedToBclNullableElementParameter_DoesNotAssertItsElements()
    {
        // Copilot review on #4209: a semantics-preserving pair of
        // parentheses around the array literal (`eqMethod.Invoke(null,
        // (new[] { m1, n }))`) is still a direct call argument — its
        // IMMEDIATE syntactic parent is a ParenthesizedExpressionSyntax,
        // not the ArgumentSyntax, so the fix must walk up through it (as
        // every other "is this a direct argument" check in this translator
        // already does) rather than giving up and falling back to the
        // oblivious annotation.
        string rendered = Render(@"
using System;
using System.Reflection;

public static class Probe
{
    public static void Run(MethodInfo eqMethod, object m1, Type nullableType)
    {
        var n = Activator.CreateInstance(nullableType);
        eqMethod.Invoke(null, (new[] { m1, n }));
    }
}
");

        Assert.DoesNotContain("n!!", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitArrayLiteral_PassedToSourceDeclaredObliviousElementParameter_StillAssertsItsElements()
    {
        // Control: a SOURCE-DECLARED (same-compilation) sink whose array
        // parameter carries no `?` at all — genuinely oblivious, not merely
        // unannotated BCL metadata — must keep asserting a nullable value
        // that flows into it, so a mutant that stops asserting
        // unconditionally is caught here.
        string rendered = Render(@"
using System;

public static class Probe
{
    private static void Consume(object[] values)
    {
    }

    public static void Run(Type nullableType)
    {
        var n = Activator.CreateInstance(nullableType);
        Consume(new[] { n, n });
    }
}
");

        Assert.Contains("n!!", rendered, StringComparison.Ordinal);
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
