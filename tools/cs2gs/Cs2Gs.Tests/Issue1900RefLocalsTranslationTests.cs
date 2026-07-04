// <copyright file="Issue1900RefLocalsTranslationTests.cs" company="GSharp">
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
/// Issue #1900: C# <c>ref</c> locals (<c>ref int r = ref xs[1]</c>) and
/// <c>ref</c>-returning functions (<c>ref int F(...) { return ref x; }</c>)
/// had no canonical G# form and reported the CS2GS-GAP "expression
/// 'RefExpression' has no canonical G# form yet" / "RefType" on the local's
/// declared type.
///
/// gsc has genuine native support for both features (not a workaround
/// primitive): a ref-aliasing local (<c>let/var ref name T = lvalue</c>,
/// bound by <c>StatementBinder.BindRefAliasLocalDeclaration</c>) and a
/// ref-returning function/method (<c>func F(...) ref T { return ref lvalue
/// }</c>, parsed via <c>FunctionDeclarationSyntax.ReturnRefModifier</c>).
/// Both alias the RHS lvalue directly — writes through the alias
/// observably hit the original storage, matching C#'s aliasing semantics
/// exactly (no value-copy divergence).
///
/// Two shapes remain unsupported and must gap loudly rather than emit
/// non-compiling or semantically-wrong G#:
/// <list type="bullet">
/// <item>a ref-returning LOCAL function — it lowers to a G# `func` literal,
/// and G#'s `ref` return modifier only exists on a genuine top-level/method
/// function declaration.</item>
/// <item>re-aliasing a ref-returning CALL's result (<c>ref int q = ref
/// F(x)</c>) — gsc's ref-alias/ref-return lvalue check
/// (<c>IsLvalue</c>/<c>IsLvalueForRefReturn</c>) only accepts a variable,
/// field, or array-element access, never a call result.</item>
/// </list>
/// </summary>
public class Issue1900RefLocalsTranslationTests
{
    [Fact]
    public void RefLocal_AliasingArrayElement_LowersToNativeRefAliasingLocal()
    {
        string rendered = Render(@"
namespace Corpus.Issue1900
{
    public class Holder
    {
        public int Bump(int[] xs)
        {
            ref int r = ref xs[1];
            r = 20;
            return xs[1];
        }
    }
}
");

        Assert.Contains("var ref r int32 = xs[1]", rendered, StringComparison.Ordinal);
        Assert.Contains("r = 20", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RefLocal_AliasingLetBoundVariable_ForcesVarBindingOnAliasee()
    {
        // `v` is never directly reassigned by plain C# syntax, but `ref v`
        // takes its address, so gsc's ref-alias binder requires the aliased
        // variable to be `var`-bound (it rejects aliasing a `let`).
        string rendered = Render(@"
namespace Corpus.Issue1900
{
    public class Holder
    {
        public int Bump()
        {
            int v = 5;
            ref int alias = ref v;
            alias = 6;
            return v;
        }
    }
}
");

        Assert.Contains("var v = 5", rendered, StringComparison.Ordinal);
        Assert.Contains("var ref alias int32 = v", rendered, StringComparison.Ordinal);
        Assert.Contains("alias = 6", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RefReturningMethod_ReturnRefStatement_LowersToNativeRefReturn()
    {
        string rendered = Render(@"
namespace Corpus.Issue1900
{
    public class Holder
    {
        public ref int Middle(int[] values)
        {
            return ref values[1];
        }
    }
}
");

        Assert.Contains("func Middle(", rendered, StringComparison.Ordinal);
        Assert.Contains("ref int32", rendered, StringComparison.Ordinal);
        Assert.Contains("return ref values[1]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RefReturningLocalFunction_StaysLoudGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1900
{
    public class Holder
    {
        public int Pick(int[] xs)
        {
            static ref int Pick(int[] a, int i)
            {
                return ref a[i];
            }

            ref int q = ref Pick(xs, 2);
            return q;
        }
    }
}
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("ref-returning local function", StringComparison.Ordinal));
    }

    [Fact]
    public void RefAliasingCallResult_StaysLoudGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1900
{
    public class Holder
    {
        public int Bump(int[] data)
        {
            ref int middle = ref Middle(data);
            middle += 5;
            return data[1];
        }

        private static ref int Middle(int[] values)
        {
            return ref values[1];
        }
    }
}
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("not a call result", StringComparison.Ordinal));
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
