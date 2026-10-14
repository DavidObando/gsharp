// <copyright file="Issue4116ImplicitArrayLiteralNullableElementTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #4116 (split from #4045's #2388 residual runtime failure,
/// `Issue2388NullableCustomEqualityEmitTests`, "runtime NRE"): an
/// implicit array literal (`new[] { a, b }`) passed straight into a BCL
/// sink whose parameter array itself accepts nullable elements (e.g.
/// `MethodBase.Invoke(object? obj, object?[]? parameters)`) forced a
/// legitimately-null element (e.g. a boxed default `Nullable<T>`,
/// which really is `null`) into a G# `!!` runtime
/// assertion and threw.
///
/// Root cause: `TranslateImplicitArrayCreation` computed its
/// per-element nullability contract from
/// `GetTypeInfo(creation).Type`/`.ConvertedType` — but in a
/// nullable-OBLIVIOUS file (no `#nullable enable` — exactly the
/// migrated corpus's own state, per the codebase's own
/// `IsObliviousCompilation` concept), Roslyn does not compute
/// per-EXPRESSION nullable annotations at all: both properties report
/// `NullableAnnotation.None` for the array literal's element, even
/// though the parameter it flows into (`MethodBase.Invoke`'s
/// `object?[]?`) is genuinely nullable-annotated in the BCL's own
/// metadata. The fix instead resolves the array element type from the
/// call's BOUND PARAMETER SYMBOL (via the enclosing argument's
/// `IArgumentOperation`) when the literal is a direct call argument —
/// a parameter's own annotation comes from the CALLEE's metadata and is
/// visible regardless of the caller's own nullable context, unlike
/// expression-level `GetTypeInfo`.
open class Issue4116ImplicitArrayLiteralNullableElementTranslationTests {
    @Fact
    func ImplicitArrayLiteral_PassedToBclNullableElementParameter_DoesNotAssertItsElements() {
        // The exact shape from Issue2388NullableCustomEqualityEmitTests:
        // a nullable-oblivious file, `var n = Activator.CreateInstance(...)`
        // (a genuinely `object?`-typed local, from the BCL's own annotated
        // return), forwarded whole into `MethodInfo.Invoke`'s `object?[]?`
        // parameters array via an implicit array literal.
        let rendered = Render(`
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
`)
        Assert.DoesNotContain("n!!", rendered, StringComparison.Ordinal)
        Assert.Contains("eqMethod.Invoke(nil, []object{m1, n})", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParenthesizedImplicitArrayLiteral_PassedToBclNullableElementParameter_DoesNotAssertItsElements() {
        // Copilot review on #4209: a semantics-preserving pair of
        // parentheses around the array literal (`eqMethod.Invoke(null,
        // (new[] { m1, n }))`) is still a direct call argument — its
        // IMMEDIATE syntactic parent is a ParenthesizedExpressionSyntax,
        // not the ArgumentSyntax, so the fix must walk up through it (as
        // every other "is this a direct argument" check in this translator
        // already does) rather than giving up and falling back to the
        // oblivious annotation.
        let rendered = Render(`
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
`)
        Assert.DoesNotContain("n!!", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitArrayLiteral_PassedToSourceDeclaredObliviousElementParameter_StillAssertsItsElements() {
        // Control: a SOURCE-DECLARED (same-compilation) sink whose array
        // parameter carries no `?` at all — genuinely oblivious, not merely
        // unannotated BCL metadata — must keep asserting a nullable value
        // that flows into it, so a mutant that stops asserting
        // unconditionally is caught here.
        let rendered = Render(`
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
`)
        Assert.Contains("n!!", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
