// <copyright file="Issue1900RefLocalsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1900: C# `ref` locals (`ref int r = ref xs[1]`) and
/// `ref`-returning functions (`ref int F(...) { return ref x; }`)
/// had no canonical G# form and reported the CS2GS-GAP "expression
/// 'RefExpression' has no canonical G# form yet" / "RefType" on the local's
/// declared type.
///
/// gsc has genuine native support for both features (not a workaround
/// primitive): a ref-aliasing local (`let/var ref name T = lvalue`,
/// bound by `StatementBinder.BindRefAliasLocalDeclaration`) and a
/// ref-returning function/method (`func F(...) ref T { return ref lvalue
/// }`, parsed via `FunctionDeclarationSyntax.ReturnRefModifier`).
/// Both alias the RHS lvalue directly — writes through the alias
/// observably hit the original storage, matching C#'s aliasing semantics
/// exactly (no value-copy divergence).
///
/// Issue #4302 now emits gsc's native non-generic ref-returning function
/// literal form for static local functions. Generic, ref-readonly, capturing,
/// and delegate-value shapes remain loud gaps.
///
/// Re-aliasing a ref-returning CALL's result (`ref int q = ref F(x)`)
/// used to gap the same way — gsc's ref-alias/ref-return lvalue check
/// (`IsLvalue`/`IsLvalueForRefReturn`) accepted only a variable,
/// field, or array-element access, never a call result. Issue #4224 taught
/// both classifiers to also accept a call to a native ref-returning
/// function/method or a read of a native ref-returning property/indexer, so
/// `TranslateRefExpression` now translates an `InvocationExpressionSyntax`
/// operand like any other lvalue shape and lets gsc's own binder validate it
/// (and reject, with its own precise diagnostic, a callee that does not
/// actually return by ref) — see (cref:RefAliasingCallResult_NoLongerGaps)
/// and (cref:ReturnRefOverCallResult_NoLongerGaps).
open class Issue1900RefLocalsTranslationTests {
    @Fact
    func RefLocal_AliasingArrayElement_LowersToNativeRefAliasingLocal() {
        let rendered = Render(`
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
`)
        Assert.Contains("var ref r int32 = xs[1]", rendered, StringComparison.Ordinal)
        Assert.Contains("r = 20", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RefLocal_AliasingLetBoundVariable_ForcesVarBindingOnAliasee() {
        // `v` is never directly reassigned by plain C# syntax, but `ref v`
        // takes its address, so gsc's ref-alias binder requires the aliased
        // variable to be `var`-bound (it rejects aliasing a `let`).
        let rendered = Render(`
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
`)
        Assert.Contains("var v = 5", rendered, StringComparison.Ordinal)
        Assert.Contains("var ref alias int32 = v", rendered, StringComparison.Ordinal)
        Assert.Contains("alias = 6", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RefLocal_ConfinedBeforeAwaitInAsyncMethod_LowersToNativeRefAliasingLocal() {
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
        let rendered = Render(`
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
`)
        Assert.Contains("var ref r int32 = xs[1]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RefReturningMethod_ReturnRefStatement_LowersToNativeRefReturn() {
        let rendered = Render(`
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
`)
        Assert.Contains("func Middle(", rendered, StringComparison.Ordinal)
        Assert.Contains("ref int32", rendered, StringComparison.Ordinal)
        Assert.Contains("return ref values[1]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func StaticRefReturningLocalFunction_UsesNativeLiteral() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("let Pick = func (a []int32, i int32) ref int32", rendered, StringComparison.Ordinal)
        Assert.Contains("return ref a[i]", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ReturnRefOverCallResult_NoLongerGaps() {
        // Issue #1987 filed this shape; issue #4224 is what actually closes
        // it — `return ref F(x)` where the ref-return operand is itself a
        // call result now translates (and gsc now binds it, since `Middle`
        // genuinely returns by ref and does not escape function-local
        // storage) instead of hitting the TranslateRefExpression fallback.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("return ref Middle(data)", GSharpPrinter.Print(unit), StringComparison.Ordinal)
    }

    @Fact
    func ElementAccess_OnRefReturningIndexer_NoLongerGaps() {
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
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    @Fact
    func ElementAccess_OnRefReadonlyReturningIndexer_Translates() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("ref readonly int32", GSharpPrinter.Print(unit), StringComparison.Ordinal)
    }

    @Fact
    func RefAliasingCallResult_NoLongerGaps() {
        // Issue #4224: aliasing a ref-returning CALL's result now has a
        // native G# construct to bind to (`var ref middle = Middle(data)`),
        // so the translator no longer needs to gap it, and gsc genuinely
        // aliases the original array element through the call.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("var ref middle int32 = Middle(data)", GSharpPrinter.Print(unit), StringComparison.Ordinal)
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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
