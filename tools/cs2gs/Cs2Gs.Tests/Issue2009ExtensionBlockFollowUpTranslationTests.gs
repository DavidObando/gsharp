// <copyright file="Issue2009ExtensionBlockFollowUpTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// Issue #2009: PR #2007 (#1879) Opus-review follow-ups, hardening the C# 14
/// `extension(T x) { ... }` block translation:
/// - a static extension member's call-site qualifier used the extension block's containing class's BARE
/// simple name (`IdentifierExpression(SanitizeIdentifier(extOwner.Name))`), which does not resolve when
/// that class is nested inside another type and its simple name collides with another source type
/// elsewhere in the compilation. The fix routes the qualifier through `StaticQualifierReceiver` — the
/// same nested-type-qualification machinery (`CSharpTypeMapper.QualifiedTypeName`) already used for a
/// bare sibling static field/call reference (ADR-0115 §B.18).
/// - a `ref`/`in`/`scoped` modifier on the block's receiver parameter (`extension(ref T x)`) was
/// silently ignored. gsc's receiver clause grammar (ADR-0019) accepts the same modifier tokens
/// syntactically, but its declaration binder never threads by-ref/scoped semantics onto the bound
/// receiver parameter — printing the modifier would therefore parse but silently drop its semantics (a
/// genuine silent miscompile). There is no safe mapping, so this now reports an explicit, loud
/// CS2GS-GAP diagnostic instead.
open class Issue2009ExtensionBlockFollowUpTranslationTests {
    @Fact
    func StaticExtensionMember_CrossNamespaceCaller_QualifiesOwnerAndResolves() {
        // The extension block's declaring class (`Corpus.Ext.Helpers`) must be
        // top-level and non-generic (Roslyn CS9283), so it can never itself be
        // nested/generic — but the CALLER can legitimately live in a different
        // namespace, exactly as a classic extension method requires a `using`
        // for the declaring namespace. This proves the rewritten qualifier
        // still resolves correctly through the shared
        // `StaticQualifierReceiver`/`QualifiedTypeName` machinery once the
        // owner is threaded through it instead of a raw bare identifier.
        let rendered = Render(`
namespace Corpus.Ext
{
    public static class Helpers
    {
        extension(string s)
        {
            public static string Shout(string value)
            {
                return value.ToUpperInvariant() + "!";
            }
        }
    }
}

namespace Corpus.Caller
{
    using Corpus.Ext;

    public static class Program
    {
        public static string Run()
        {
            return string.Shout("hi");
        }
    }
}
`)
        Assert.Contains("Helpers.Shout(\"hi\")", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("string.Shout", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        let diagnostics = BindDiagnostics(rendered)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func SiblingStaticCall_NestedHomonymOwner_QualifiesThroughContainingTypeChain() {
        // `StaticQualifierReceiver` is the SAME shared qualifier the extension-
        // block owner rewrite now reuses (issue #2009); this proves its
        // non-generic branch — previously a raw `owner.Name` bypassing
        // `CSharpTypeMapper.QualifiedTypeName` entirely — now correctly
        // qualifies a NESTED owner through its containing-type chain when its
        // simple name collides with another source type, exactly like the
        // nested-type reference fix in issue #1174 — but issue #3471's
        // same-type policy now supersedes it at sites lexically inside the
        // declaring type, where the reference stays bare. `Holder` is declared twice:
        // once as an unrelated top-level class, and once nested inside
        // `Outer`, where the actual sibling static method being called lives.
        let rendered = Render(`
namespace Corpus.Sibling
{
    public class Holder
    {
        public int Unrelated;
    }

    public static class Outer
    {
        public static class Holder
        {
            private static int Tab = 5;

            public static int Read()
            {
                return Tab;
            }

            public static int ReadTwice()
            {
                return Read() + Read();
            }
        }
    }
}
`)
        // The sibling call site is lexically inside the declaring nested type
        // itself, so the same-type policy (issue #3471) keeps it BARE — the
        // homonym collision is on the OWNER's simple name, not the member's,
        // and never forces qualification at a same-type site.
        Assert.Contains("return Read() + Read()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Outer.Holder.Read()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        // Binding the printed G# end to end proves the bare reference resolves
        // against the enclosing NESTED type — the top-level homonym does not
        // declare `Read` at all and would fail member lookup (GS0158) if the
        // bare simple name had bound to it instead.
        let diagnostics = BindDiagnostics(rendered)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func StaticExtensionMember_NoHomonymOwner_KeepsSimpleNameQualifier() {
        // Without a homonym collision, the owner keeps its bare simple name
        // (no gratuitous qualification), mirroring issue #1174's
        // no-collision case for nested-type references.
        let rendered = Render(`
namespace Corpus.NoCollision
{
    public static class Extensions
    {
        extension(string)
        {
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
        Assert.Contains("Extensions.Meaning", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        let diagnostics = BindDiagnostics(rendered)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ExtensionBlock_RefReceiver_ReportsLoudGap() {
        AssertReceiverModifierReportsLoudGap(`
namespace Corpus.Issue2009
{
    public struct Point
    {
        public int X;
    }

    public static class E
    {
        extension(ref Point p)
        {
            public void DoubleX()
            {
                p.X *= 2;
            }
        }
    }
}
`)
    }

    @Fact
    func ExtensionBlock_InReceiver_ReportsLoudGap() {
        AssertReceiverModifierReportsLoudGap(`
namespace Corpus.Issue2009
{
    public struct Point
    {
        public int X;
    }

    public static class E
    {
        extension(in Point p)
        {
            public int GetX()
            {
                return p.X;
            }
        }
    }
}
`)
    }

    @Fact
    func ExtensionBlock_ScopedReceiver_ReportsLoudGap() {
        AssertReceiverModifierReportsLoudGap(`
using System;

namespace Corpus.Issue2009
{
    public static class E
    {
        extension(scoped Span<int> s)
        {
            public int FirstOrZero()
            {
                return s.Length == 0 ? 0 : s[0];
            }
        }
    }
}
`)
    }

    shared {
        private func AssertReceiverModifierReportsLoudGap(source string) {
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
            CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Contains(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                    "receiver parameter modifier",
                    StringComparison.Ordinal
                )
            )
        }

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

        private func BindDiagnostics(gsharpSource string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(gsharpSource))
            let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return scope_.Diagnostics
        }
    }
}
