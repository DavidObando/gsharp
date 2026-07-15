// <copyright file="Issue2370ExplicitInterfaceStaticMemberTests.cs" company="GSharp">
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
/// ADR-0149 follow-up (issue #2362/PR #2370, "final completion pass"):
/// extends the explicit-interface <c>(IFoo)</c> qualifier clause to STATIC
/// members — C# 11 <c>static abstract</c>/<c>static virtual</c> interface
/// methods and properties (ADR-0089/#755/#1019) can be explicitly
/// implemented (<c>static int IFoo.M() { ... }</c>,
/// <c>static int IFoo.P { get; }</c>), exactly like their instance
/// counterparts. The existing method/property translation paths
/// (<c>TranslateMethod</c>/<c>TranslatePropertyOrIndexer</c>) already key
/// off Roslyn's <see cref="Microsoft.CodeAnalysis.IMethodSymbol.ExplicitInterfaceImplementations"/> /
/// <see cref="Microsoft.CodeAnalysis.IPropertySymbol.ExplicitInterfaceImplementations"/>
/// without special-casing <c>IsStatic</c> — the `static` classification and
/// routing into a G# <c>shared { }</c> block happens as an orthogonal, later
/// step, so no translator changes were required; these tests are pure
/// regression coverage proving the combination works end-to-end.
/// <para>
/// There is no static indexer or static event form in C#/the CLR at all
/// (indexers always require an instance receiver; interfaces cannot declare
/// <c>static abstract</c>/<c>static virtual</c> events) — this is a genuine
/// language/CLR limitation, not a translator gap, so only methods and
/// properties are covered here.
/// </para>
/// </summary>
public class Issue2370ExplicitInterfaceStaticMemberTests
{
    /// <summary>
    /// A lone static explicit interface METHOD implementation translates to
    /// a <c>shared</c> method carrying an ADR-0149 explicit-interface
    /// qualifier clause, with C#-faithful (non-public) visibility — mirrors
    /// <c>Issue1911ExplicitInterfaceImplementationTests.LoneExplicitImplementation_TranslatesToExplicitInterfaceClauseMethod</c>
    /// for the static case.
    /// </summary>
    [Fact]
    public void LoneStaticExplicitMethodImplementation_TranslatesToExplicitInterfaceClauseMethod()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2370Static
{
    public interface IFactory
    {
        static abstract int Create();
    }

    public class Widget : IFactory
    {
        static int IFactory.Create()
        {
            return 42;
        }
    }
}");
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("private func (IFactory) Create() int32 {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// A lone static explicit interface PROPERTY implementation translates
    /// to a <c>shared</c> property carrying the clause, C#-faithful
    /// visibility, mirroring the instance property equivalent.
    /// </summary>
    [Fact]
    public void LoneStaticExplicitPropertyImplementation_TranslatesToExplicitInterfaceClauseProperty()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2370Static
{
    public interface ISized
    {
        static abstract int SizeInBytes { get; }
    }

    public class Blob : ISized
    {
        static int ISized.SizeInBytes => 8;
    }
}");
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("(ISized)", printed, StringComparison.Ordinal);
        Assert.Contains("SizeInBytes", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// A static explicit method implementation coexisting with a same-named
    /// ordinary (non-explicit) public static method on the same class: both
    /// survive as distinct, clause-disambiguated G# members — the static
    /// counterpart of the instance collision regression covered by
    /// <c>Issue2010ExplicitInterfaceImplementationTests</c>.
    /// </summary>
    [Fact]
    public void StaticExplicitMethodCoexistingWithPublicStaticMethod_BothSurvive()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Corpus.Issue2370Static
{
    public interface ICounter
    {
        static abstract int Next();
    }

    public class Sequence : ICounter
    {
        public static int Next()
        {
            return 1;
        }

        static int ICounter.Next()
        {
            return 2;
        }
    }
}");
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("private func (ICounter) Next() int32 {", printed, StringComparison.Ordinal);
        Assert.Contains("Next() int32", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
        AssertRoundTripParses(printed);
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

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);
        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }
}
