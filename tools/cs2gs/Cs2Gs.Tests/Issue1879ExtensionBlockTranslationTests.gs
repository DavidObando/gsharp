// <copyright file="Issue1879ExtensionBlockTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #1879: a C# 14 `extension(T x) { ... }` / `extension(T) { ...
/// }` block had no canonical G# declaration mapping and every form reported
/// "CS2GS-GAP: 'ExtensionBlockDeclaration' has no canonical G# declaration
/// mapping". The natural G# target is the SAME receiver-clause `func` a
/// classic `this T x` extension method already lowers to (ADR-0115
/// §B.19). Covers:
/// - an instance extension method (`extension(string s) { public int M() {...} }`) — a receiver-clause
/// `func`, lifted to a top-level sibling exactly like a classic extension method.
/// - an instance extension property (get-only, expression- and block-bodied) — lowered to a get-only
/// receiver-clause `func` (G#'s `prop` grammar has no receiver clause), with every read call site
/// rewritten to a zero-argument call.
/// - a static extension member (method or property) declared in a named or receiverless block — a plain
/// `shared` member of the declaring class, with call sites (qualified through the extended type's name)
/// rewritten to the real owner.
/// - the receiverless form (`extension(string) { ... }`) — static members only.
open class Issue1879ExtensionBlockTranslationTests {
    @Fact
    func InstanceExtensionMethod_LowersToReceiverClauseFunc() {
        let rendered = Render(`
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public int Doubled()
            {
                return s.Length * 2;
            }
        }
    }

    public static class Caller
    {
        public static int Run(string word)
        {
            return word.Doubled();
        }
    }
}
`)
        Assert.Contains("func (s string) Doubled() int32", rendered, StringComparison.Ordinal)
        Assert.Contains("word.Doubled()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InstanceExtensionProperty_ExpressionBodied_LowersToGetOnlyFuncAndCallRewritesToInvocation() {
        let rendered = Render(`
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public int DoubledLength => s.Length * 2;
        }
    }

    public static class Caller
    {
        public static int Run(string word)
        {
            return word.DoubledLength;
        }
    }
}
`)
        Assert.Contains("func (s string) DoubledLength() int32 -> s.Length * 2", rendered, StringComparison.Ordinal)
        Assert.Contains("word.DoubledLength()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InstanceExtensionProperty_BlockBodied_LowersToFuncWithBlockBody() {
        let rendered = Render(`
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public string FirstAndLast
            {
                get
                {
                    if (s.Length == 0)
                    {
                        return "<empty>";
                    }

                    return s[0] + s[s.Length - 1].ToString();
                }
            }
        }
    }

    public static class Caller
    {
        public static string Run(string word)
        {
            return word.FirstAndLast;
        }
    }
}
`)
        Assert.Contains("func (s string) FirstAndLast() string {", rendered, StringComparison.Ordinal)
        Assert.Contains("word.FirstAndLast()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func StaticExtensionMembers_ReceiverlessBlock_LowerToSharedMembersWithRewrittenCallSites() {
        let rendered = Render(`
using System.Text;

namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string)
        {
            public static string Meaning => "forty-two";

            public static string Repeat(string value, int count)
            {
                var builder = new StringBuilder();
                for (int i = 0; i < count; i++)
                {
                    builder.Append(value);
                }

                return builder.ToString();
            }
        }
    }

    public static class Caller
    {
        public static string RunProp()
        {
            return string.Meaning;
        }

        public static string RunMethod()
        {
            return string.Repeat("ab", 3);
        }
    }
}
`)
        Assert.Contains("prop Meaning string -> \"forty-two\"", rendered, StringComparison.Ordinal)
        Assert.Contains("func Repeat(value string, count int32) string", rendered, StringComparison.Ordinal)
        Assert.Contains("E.Meaning", rendered, StringComparison.Ordinal)
        Assert.Contains("E.Repeat(\"ab\", 3)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("string.Meaning", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("string.Repeat", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func StaticExtensionMember_InNamedReceiverBlock_IgnoresReceiverAndLowersToSharedMember() {
        // A static member may be declared inside a NAMED receiver block
        // (`extension(string s) { public static ... }`) — it simply ignores the
        // receiver `s` and is emitted exactly like the receiverless-block form.
        let rendered = Render(`
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public int Doubled()
            {
                return s.Length * 2;
            }

            public static string Meaning => "forty-two";
        }
    }

    public static class Caller
    {
        public static string Run()
        {
            return string.Meaning;
        }
    }
}
`)
        Assert.Contains("prop Meaning string -> \"forty-two\"", rendered, StringComparison.Ordinal)
        Assert.Contains("E.Meaning", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InstanceExtensionPropertyWithSetter_ReportsLoudGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public int Backing
            {
                get { return s.Length; }
                set { }
            }
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("has a setter", StringComparison.Ordinal)
        )
    }

    @Fact
    func ExtensionBlock_GenericTypeParameter_ReportsLoudGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System.Collections.Generic;
using System.Linq;

namespace Corpus.Issue1879
{
    public static class E
    {
        extension<T>(IEnumerable<T> src) where T : notnull
        {
            public T First()
            {
                return src.First();
            }
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("generic extension block", StringComparison.Ordinal)
        )
    }

    @Fact
    func InstanceExtensionProperty_ConditionalAccess_RewritesToInvocation() {
        let rendered = Render(`
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public int DoubledLength => s.Length * 2;
        }
    }

    public static class Caller
    {
        public static int? Run(string? word)
        {
            return word?.DoubledLength;
        }
    }
}
`)
        Assert.Contains("word?.DoubledLength()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InstanceExtensionProperty_NameOf_RejectedByCSharpItself_TranslatorNeverSeesIt() {
        // Roslyn (CS9316 "Extension members are not allowed as an argument to
        // 'nameof'") rejects `nameof(word.DoubledLength)` on an instance
        // extension member at the C# source level — for classic `this T x`
        // extension methods/properties too, not just extension blocks — so
        // this construct can never reach TranslateMemberAccess. The nameof
        // guard added there (skip the zero-arg-call rewrite for a member used
        // as a bare nameof argument) is kept as a defensive no-op belt only;
        // this test documents WHY there is no reachable rendered-output
        // assertion to make here.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1879
{
    public static class E
    {
        extension(string s)
        {
            public int DoubledLength => s.Length * 2;
        }
    }

    public static class Caller
    {
        public static string Run(string word)
        {
            return nameof(word.DoubledLength);
        }
    }
}
`)})
        Assert.False(project.BoundWithoutErrors)
        Assert.Contains(project.ErrorDiagnostics, (d Diagnostic) -> d.Id == "CS9316")
    }

    @Fact
    func ExtensionBlock_EnumReceiver_UsesExplicitReceiverClause() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1879
{
    public enum Color { Red, Green, Blue }

    public static class E
    {
        extension(Color c)
        {
            public string Describe()
            {
                return c.ToString();
            }
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("func (c Color) Describe()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("enum receiver", StringComparison.Ordinal)
        )
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
            // A `static class` always carries the (expected, unrelated) info-level
            // "no direct G# form; mapped to ... 'shared { }'" diagnostic
            // (ADR-0115 §B.11/§B.53); every extension-block fixture here needs a
            // static class, so only assert no GAP-level diagnostic fired.
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
