// <copyright file="Issue2010ExplicitInterfaceImplementationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2010 (follow-up to #1911 / PR #1994 review): the #1911 fix forced
/// explicit interface implementations public and DROPPED any colliding
/// same-name/same-signature sibling (another explicit impl, or a coexisting
/// public method) via an <see cref="TranslationSeverity.Unsupported"/>
/// diagnostic — surfacing the loss instead of silently emitting wrong
/// behavior, but still losing a distinct body.
/// <para>
/// This fix instead preserves full fidelity, zero drops: every explicit
/// interface implementation is emitted as its own G# method under a reserved
/// mangled name (<c>__explicit_&lt;Interface&gt;__&lt;Member&gt;</c>) that
/// gsc's binder recognizes and links to the specific interface member it
/// implements (<c>FunctionSymbol.ExplicitInterfaceMember</c>); the emitter
/// binds a CLR <c>MethodImpl</c> row per implementation (reusing the
/// ADR-0089 static-virtual / issue #985 bridge machinery) so each
/// interface's dispatch slot routes to its own distinct method body. Since
/// the mangled name embeds the interface's own name, two explicit
/// implementations of the same member from different interfaces never
/// collide — no GS0264, no drop, no diagnostic.
/// </para>
/// </summary>
public class Issue2010ExplicitInterfaceImplementationTests
{
    /// <summary>
    /// Two explicit implementations of the SAME-NAME, SAME-SIGNATURE member
    /// from two DIFFERENT interfaces (a same-name diamond, no public sibling)
    /// both survive translation as two distinct mangled-name methods — the
    /// #1911 "de-duplicate to one survivor + Unsupported diagnostic" gap no
    /// longer applies.
    /// </summary>
    [Fact]
    public void TwoCollidingExplicitImplementations_BothSurviveAsDistinctMangledMethods()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2010
{
    public interface IGreeter
    {
        string Greet();
    }

    public interface IWelcomer
    {
        string Greet();
    }

    public class Multi : IGreeter, IWelcomer
    {
        string IGreeter.Greet()
        {
            return ""hi"";
        }

        string IWelcomer.Greet()
        {
            return ""welcome"";
        }
    }
}");
        string printed = GSharpPrinter.Print(unit);

        TypeDeclaration multi = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Multi");
        Assert.Contains(multi.Members.OfType<MethodDeclaration>(), m => m.Name == "__explicit_Corpus_Issue2010_IGreeter__Greet");
        Assert.Contains(multi.Members.OfType<MethodDeclaration>(), m => m.Name == "__explicit_Corpus_Issue2010_IWelcomer__Greet");
        Assert.Contains("hi", printed, StringComparison.Ordinal);
        Assert.Contains("welcome", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// An explicit implementation coexisting with a same-signature public
    /// method of the same name no longer collides at all: the public method
    /// keeps its plain name, and the explicit implementation gets its own
    /// mangled name and its own body — both survive.
    /// </summary>
    [Fact]
    public void ExplicitImplementationCoexistingWithPublicMethod_BothSurvive()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2010
{
    public interface IGreeter
    {
        string Greet();
    }

    public class LoudHost : IGreeter
    {
        public string Greet()
        {
            return ""hello-public"";
        }

        string IGreeter.Greet()
        {
            return ""hello-explicit"";
        }
    }
}");
        string printed = GSharpPrinter.Print(unit);

        TypeDeclaration loudHost = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "LoudHost");
        Assert.Contains(loudHost.Members.OfType<MethodDeclaration>(), m => m.Name == "Greet");
        Assert.Contains(loudHost.Members.OfType<MethodDeclaration>(), m => m.Name == "__explicit_Corpus_Issue2010_IGreeter__Greet");
        Assert.Contains("hello-public", printed, StringComparison.Ordinal);
        Assert.Contains("hello-explicit", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// Follow-up fix: two SAME-SIMPLE-NAME interfaces declared in DIFFERENT
    /// namespaces (<c>NsA.IBar</c> and <c>NsB.IBar</c>) previously mangled
    /// to the identical <c>__explicit_IBar__M</c> name (bare simple name),
    /// producing a hard GS0264 duplicate-signature collision instead of the
    /// intended per-interface distinctness. The mangle now embeds the
    /// interface's namespace-qualified name, so the two implementations
    /// mangle to distinct names and both survive.
    /// </summary>
    [Fact]
    public void TwoSameSimpleNameInterfacesFromDifferentNamespaces_MangleDistinctly()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("NsA.cs", @"
namespace NsA
{
    public interface IBar
    {
        string M();
    }
}"),
            ("NsB.cs", @"
namespace NsB
{
    public interface IBar
    {
        string M();
    }
}"),
            ("Multi.cs", @"
using NsA;
using NsB;

namespace Corpus.Issue2010
{
    public class Multi : NsA.IBar, NsB.IBar
    {
        string NsA.IBar.M()
        {
            return ""from-a"";
        }

        string NsB.IBar.M()
        {
            return ""from-b"";
        }
    }
}"),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath == "Multi.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        TypeDeclaration multi = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Multi");
        var mangledNames = multi.Members.OfType<MethodDeclaration>().Select(m => m.Name).ToList();

        // The two mangled names must be DISTINCT — this is the regression this
        // fix addresses (previously both would be "__explicit_IBar__M").
        Assert.Equal(2, mangledNames.Distinct(StringComparer.Ordinal).Count());
        Assert.Contains(mangledNames, n => n.StartsWith("__explicit_NsA_IBar__M", StringComparison.Ordinal));
        Assert.Contains(mangledNames, n => n.StartsWith("__explicit_NsB_IBar__M", StringComparison.Ordinal));
        Assert.Contains("from-a", printed, StringComparison.Ordinal);
        Assert.Contains("from-b", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
