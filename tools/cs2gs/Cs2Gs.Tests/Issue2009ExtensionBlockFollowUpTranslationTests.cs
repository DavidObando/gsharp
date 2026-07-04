// <copyright file="Issue2009ExtensionBlockFollowUpTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2009: PR #2007 (#1879) Opus-review follow-ups, hardening the C# 14
/// <c>extension(T x) { ... }</c> block translation:
/// <list type="bullet">
/// <item>a static extension member's call-site qualifier used the extension
/// block's containing class's BARE simple name
/// (<c>IdentifierExpression(SanitizeIdentifier(extOwner.Name))</c>), which does
/// not resolve when that class is nested inside another type and its simple
/// name collides with another source type elsewhere in the compilation. The
/// fix routes the qualifier through <c>StaticQualifierReceiver</c> — the same
/// nested-type-qualification machinery (<c>CSharpTypeMapper.QualifiedTypeName</c>)
/// already used for a bare sibling static field/call reference
/// (ADR-0115 §B.18).</item>
/// <item>a <c>ref</c>/<c>in</c>/<c>scoped</c> modifier on the block's receiver
/// parameter (<c>extension(ref T x)</c>) was silently ignored. gsc's receiver
/// clause grammar (ADR-0019) accepts the same modifier tokens syntactically,
/// but its declaration binder never threads by-ref/scoped semantics onto the
/// bound receiver parameter — printing the modifier would therefore parse but
/// silently drop its semantics (a genuine silent miscompile). There is no safe
/// mapping, so this now reports an explicit, loud CS2GS-GAP diagnostic instead.</item>
/// </list>
/// </summary>
public class Issue2009ExtensionBlockFollowUpTranslationTests
{
    [Fact]
    public void StaticExtensionMember_CrossNamespaceCaller_QualifiesOwnerAndResolves()
    {
        // The extension block's declaring class (`Corpus.Ext.Helpers`) must be
        // top-level and non-generic (Roslyn CS9283), so it can never itself be
        // nested/generic — but the CALLER can legitimately live in a different
        // namespace, exactly as a classic extension method requires a `using`
        // for the declaring namespace. This proves the rewritten qualifier
        // still resolves correctly through the shared
        // `StaticQualifierReceiver`/`QualifiedTypeName` machinery once the
        // owner is threaded through it instead of a raw bare identifier.
        string rendered = Render(@"
namespace Corpus.Ext
{
    public static class Helpers
    {
        extension(string s)
        {
            public static string Shout(string value)
            {
                return value.ToUpperInvariant() + ""!"";
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
            return string.Shout(""hi"");
        }
    }
}
");

        Assert.Contains("Helpers.Shout(\"hi\")", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Shout", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);

        var diagnostics = BindDiagnostics(rendered);
        Assert.DoesNotContain(diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void SiblingStaticCall_NestedHomonymOwner_QualifiesThroughContainingTypeChain()
    {
        // `StaticQualifierReceiver` is the SAME shared qualifier the extension-
        // block owner rewrite now reuses (issue #2009); this proves its
        // non-generic branch — previously a raw `owner.Name` bypassing
        // `CSharpTypeMapper.QualifiedTypeName` entirely — now correctly
        // qualifies a NESTED owner through its containing-type chain when its
        // simple name collides with another source type, exactly like the
        // nested-type reference fix in issue #1174. `Holder` is declared twice:
        // once as an unrelated top-level class, and once nested inside
        // `Outer`, where the actual sibling static method being called lives.
        string rendered = Render(@"
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
");

        // The bare sibling call is rewritten to the FULLY qualified nested
        // owner...
        Assert.Contains("Outer.Holder.Read()", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);

        // Binding the printed G# end to end proves the qualified reference
        // resolves against the NESTED type — the top-level homonym does not
        // declare `Read` at all and would fail member lookup (GS0158) if the
        // bare simple name had bound to it instead.
        var diagnostics = BindDiagnostics(rendered);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void StaticExtensionMember_NoHomonymOwner_KeepsSimpleNameQualifier()
    {
        // Without a homonym collision, the owner keeps its bare simple name
        // (no gratuitous qualification), mirroring issue #1174's
        // no-collision case for nested-type references.
        string rendered = Render(@"
namespace Corpus.NoCollision
{
    public static class Extensions
    {
        extension(string)
        {
            public static string Meaning => ""forty-two"";
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
");

        Assert.Contains("Extensions.Meaning", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);

        var diagnostics = BindDiagnostics(rendered);
        Assert.DoesNotContain(diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void ExtensionBlock_RefReceiver_ReportsLoudGap()
    {
        AssertReceiverModifierReportsLoudGap(@"
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
");
    }

    [Fact]
    public void ExtensionBlock_InReceiver_ReportsLoudGap()
    {
        AssertReceiverModifierReportsLoudGap(@"
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
");
    }

    [Fact]
    public void ExtensionBlock_ScopedReceiver_ReportsLoudGap()
    {
        AssertReceiverModifierReportsLoudGap(@"
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
");
    }

    private static void AssertReceiverModifierReportsLoudGap(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("receiver parameter modifier", StringComparison.Ordinal));
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
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        // A `static class` always carries the (expected, unrelated) info-level
        // "no direct G# form; mapped to ... 'shared { }'" diagnostic
        // (ADR-0115 §B.11/§B.53); every extension-block fixture here needs a
        // static class, so only assert no GAP-level diagnostic fired.
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> BindDiagnostics(string gsharpSource)
    {
        var tree = SyntaxTree.Parse(SourceText.From(gsharpSource));
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return scope.Diagnostics;
    }
}
