// <copyright file="Issue1900RefLocalsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
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
/// One shape remains unsupported HERE and must gap loudly rather than emit
/// non-compiling or semantically-wrong G#: a ref-returning LOCAL function —
/// it lowers to a G# `func` literal. Issue #4219 later gave gsc a genuine
/// non-generic ref-returning function-literal form (`let f = func (...) ref
/// T { ... }`), but this translator has not been updated to emit it, so the
/// gap below stands.
///
/// Re-aliasing a ref-returning CALL's result (<c>ref int q = ref F(x)</c>)
/// used to gap the same way — gsc's ref-alias/ref-return lvalue check
/// (<c>IsLvalue</c>/<c>IsLvalueForRefReturn</c>) accepted only a variable,
/// field, or array-element access, never a call result. Issue #4224 taught
/// both classifiers to also accept a call to a native ref-returning
/// function/method or a read of a native ref-returning property/indexer, so
/// <c>TranslateRefExpression</c> now translates an <c>InvocationExpressionSyntax</c>
/// operand like any other lvalue shape and lets gsc's own binder validate it
/// (and reject, with its own precise diagnostic, a callee that does not
/// actually return by ref) — see <see cref="RefAliasingCallResult_NoLongerGaps"/>
/// and <see cref="ReturnRefOverCallResult_NoLongerGaps"/>.
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
    public void RefLocal_ConfinedBeforeAwaitInAsyncMethod_LowersToNativeRefAliasingLocal()
    {
        // Issue #4222: this translation was always straightforward (no
        // async-specific special-casing exists in TranslateRefLocalDeclaration
        // above — a `ref` local translates to G#'s native alias unconditionally,
        // regardless of the enclosing method's async-ness), but gsc's binder
        // used to reject EVERY ref-aliasing local in an async function with a
        // blanket GS0258, so translating this exact C# shape produced G# that
        // failed to compile — a latent self-hosting risk for any hot-core C#
        // source using a confined `ref` local inside an `async` method.
        // #4222's liveness-based fix (this alias never crosses the `await`)
        // means AssertRoundTripParses below now actually BINDS clean; no
        // change to the translator itself was needed.
        string rendered = Render(@"
using System.Threading.Tasks;
namespace Corpus.Issue4222
{
    public class Holder
    {
        public async Task<int> Bump(int[] xs)
        {
            ref int r = ref xs[1];
            r = 20;
            await Task.Delay(1);
            return xs[1];
        }
    }
}
");

        Assert.Contains("var ref r int32 = xs[1]", rendered, StringComparison.Ordinal);
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
    public void ReturnRefOverCallResult_NoLongerGaps()
    {
        // Issue #1987 filed this shape; issue #4224 is what actually closes
        // it — `return ref F(x)` where the ref-return operand is itself a
        // call result now translates (and gsc now binds it, since `Middle`
        // genuinely returns by ref and does not escape function-local
        // storage) instead of hitting the TranslateRefExpression fallback.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1987
{
    public class Holder
    {
        public ref int Outer(int[] data)
        {
            return ref Middle(data);
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
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("return ref Middle(data)", GSharpPrinter.Print(unit), StringComparison.Ordinal);
    }

    [Fact]
    public void ElementAccess_OnRefReturningIndexer_NoLongerGaps()
    {
        // Issue #1987 gapped `list[i]` against a user-defined ref-returning
        // indexer (`ref T this[int i]`) because G# had no ref-returning indexer
        // at all, so a plain index expression would have dropped the aliasing.
        // Issue #3879 (the ADR-0060 amendment) added the declaration form
        // `prop this[i T] ref U`, and gsc's emitter loads through the returned
        // managed pointer at the read — so a plain index expression is now the
        // correct lowering, with the same read semantics C# gives it. The
        // DECLARATION is what carries the aliasing; the read is a value read
        // either way (G# cannot bind a call result as an alias — see the
        // RefAliasingCallResult gap below, which is the #1900 limit itself).
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1987
{
    public class RefIndexable
    {
        private int[] data = new int[4];

        public ref int this[int i] => ref this.data[i];
    }

    public class Holder
    {
        public int Read(RefIndexable list, int i)
        {
            return list[i];
        }
    }
}
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void ElementAccess_OnRefReadonlyReturningIndexer_Translates()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1987
{
    public class RefReadonlyIndexable
    {
        private int[] data = new int[4];

        public ref readonly int this[int i] => ref this.data[i];
    }

    public class Holder
    {
        public int Read(RefReadonlyIndexable list, int i)
        {
            return list[i];
        }
    }
}
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("ref readonly int32", GSharpPrinter.Print(unit), StringComparison.Ordinal);
    }

    [Fact]
    public void RefAliasingCallResult_NoLongerGaps()
    {
        // Issue #4224: aliasing a ref-returning CALL's result now has a
        // native G# construct to bind to (`var ref middle = Middle(data)`),
        // so the translator no longer needs to gap it, and gsc genuinely
        // aliases the original array element through the call.
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
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("var ref middle int32 = Middle(data)", GSharpPrinter.Print(unit), StringComparison.Ordinal);
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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
