// <copyright file="Issue1733EnumAndFloatDefaultTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1733: <c>MapConstantDefault</c> and <c>MapAttributeArgumentValue</c>
/// previously rendered an enum-typed default/attribute-argument as its boxed
/// underlying integer (e.g. <c>3</c>) rather than the enum member it names.
/// <see cref="CSharpToGSharpTranslator.VisitEnumDeclaration"/> drops the C#
/// explicit case values, so a translated enum is renumbered by declaration
/// order — the raw integer could silently name the WRONG member (or none) under
/// the new numbering. Enum-typed constants now resolve to the qualified member
/// reference (<c>EnumType.Member</c>), a <c>[Flags]</c> OR-combination when no
/// single member matches, or a visible <c>Unsupported</c> diagnostic when
/// neither applies. Separately, <c>double.NaN</c>/<c>PositiveInfinity</c>/
/// <c>NegativeInfinity</c> (and the <c>float</c> equivalents) previously
/// rendered as the bare, unresolved identifiers <c>NaN</c>/<c>Infinity</c>;
/// they now render as the qualified BCL member (<c>System.Double.NaN</c>, …).
/// </summary>
public class Issue1733EnumAndFloatDefaultTranslationTests
{
    private const string Source = @"
using System;

namespace Corpus.Issue1733
{
    public enum Color { Red, Green, Blue }

    [Flags]
    public enum Toppings { None = 0, Cheese = 1, Olives = 2, Pepperoni = 4 }

    // N2: a ulong-backed [Flags] enum with a high-bit member above
    // long.MaxValue. Convert.ToInt64 throws OverflowException on such a value;
    // MapEnumConstant must resolve/decompose it without crashing.
    [Flags]
    public enum BigFlags : ulong
    {
        None = 0,
        Small = 1UL,
        Big = 0x8000_0000_0000_0000UL,
    }

    public class KindAttribute : Attribute
    {
        public KindAttribute(Color color) { }
    }

    public class Widgets
    {
        public void Paint(Color c = Color.Blue) { }

        public void Sprinkle(Toppings t = Toppings.Cheese | Toppings.Olives) { }

        public void BigFlagCombo(BigFlags b = BigFlags.Big | BigFlags.Small) { }

        public void Undefined(Color c = (Color)99) { }

        [Kind(Color.Green)]
        public void Tagged() { }

        public void FiniteFloat(double d = 1.5, float f = 2.5f) { }

        public void SpecialDouble(
            double nan = double.NaN,
            double posInf = double.PositiveInfinity,
            double negInf = double.NegativeInfinity) { }

        public void SpecialFloat(
            float nan = float.NaN,
            float posInf = float.PositiveInfinity,
            float negInf = float.NegativeInfinity) { }
    }
}
";

    [Fact]
    public void EnumParameterDefault_RendersAsMemberReference_NotRawInt()
    {
        string rendered = Render();

        Assert.Contains("c Color = Color.Blue", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("c Color = 2", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void FlagsEnumParameterDefault_RendersAsOrOfMembers()
    {
        string rendered = Render();

        // Decomposed in descending-value order (Olives=2 before Cheese=1).
        Assert.Contains("t Toppings = Toppings.Olives | Toppings.Cheese", rendered, StringComparison.Ordinal);
    }

    // N2: a ulong [Flags] enum member above long.MaxValue must not crash
    // Convert.ToInt64 (OverflowException) and must resolve/decompose correctly.
    [Fact]
    public void UInt64FlagsEnumWithHighBitMember_DoesNotCrash_AndRendersAsOrOfMembers()
    {
        string rendered = Render();

        Assert.Contains("b BigFlags = BigFlags.Big | BigFlags.Small", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void UndefinedEnumValue_ReportsUnsupported()
    {
        (_, TranslationContext context) = Translate();

        Assert.Contains(
            context.Diagnostics,
            d => d.IsUnsupported && d.Message.Contains("'99'", StringComparison.Ordinal));
    }

    [Fact]
    public void EnumAttributeArgument_RendersAsMemberReference_NotRawInt()
    {
        string rendered = Render();

        Assert.Contains("@Kind(Color.Green)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("@Kind(1)", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void FiniteFloatDefaults_StillRenderAsLiterals()
    {
        string rendered = Render();

        Assert.Contains("d float64 = 1.5", rendered, StringComparison.Ordinal);
        Assert.Contains("f float32 = 2.5", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void DoubleSpecialDefaults_RenderAsQualifiedBclMembers_NotBareIdentifiers()
    {
        string rendered = Render();

        Assert.Contains("nan float64 = System.Double.NaN", rendered, StringComparison.Ordinal);
        Assert.Contains("posInf float64 = System.Double.PositiveInfinity", rendered, StringComparison.Ordinal);
        Assert.Contains("negInf float64 = System.Double.NegativeInfinity", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void FloatSpecialDefaults_RenderAsQualifiedBclMembers_NotBareIdentifiers()
    {
        string rendered = Render();

        Assert.Contains("nan float32 = System.Single.NaN", rendered, StringComparison.Ordinal);
        Assert.Contains("posInf float32 = System.Single.PositiveInfinity", rendered, StringComparison.Ordinal);
        Assert.Contains("negInf float32 = System.Single.NegativeInfinity", rendered, StringComparison.Ordinal);
    }

    // N3: a parameter symbol declared in a REFERENCED (metadata) assembly has no
    // `DeclaringSyntaxReferences`, so the old code (using that alone as the
    // diagnostic anchor) silently dropped the default with NO diagnostic. Here,
    // `ExternalLib.Service.Configure`'s `level` parameter is compiled into a
    // separate metadata assembly with a default that matches no `Level` member;
    // a named-argument call that skips it must still resolve `MapConstantDefault`
    // to a non-null fallback node (the call-site argument list) so the
    // Unsupported diagnostic fires instead of being swallowed.
    [Fact]
    public void MetadataEnumParameterDefault_WithNoMatchingMember_StillReportsUnsupported()
    {
        MetadataReference libraryReference = CompileExternalLibraryReference();

        const string CallerSource = @"
namespace Corpus.Issue1733.Caller
{
    public class Caller
    {
        public void Invoke()
        {
            ExternalLib.Service.Configure(extra: 5);
        }
    }
}
";

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Caller.cs", CallerSource) },
            CSharpProjectLoader.RuntimeReferences().Append(libraryReference).ToImmutableArray());

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.IsUnsupported && d.Message.Contains("'99'", StringComparison.Ordinal));
    }

    private static MetadataReference CompileExternalLibraryReference()
    {
        const string LibrarySource = @"
namespace ExternalLib
{
    public enum Level { Low = 1, High = 2 }

    public static class Service
    {
        public static void Configure(string name = ""a"", Level level = (Level)99, int extra = 0) { }
    }
}
";
        var tree = CSharpSyntaxTree.ParseText(LibrarySource, new CSharpParseOptions(LanguageVersion.Latest));
        CSharpCompilation compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue1733.ExternalLib",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emitResult = compilation.Emit(stream);
        Assert.True(
            emitResult.Success,
            "external library fixture should compile: " +
                string.Join(Environment.NewLine, emitResult.Diagnostics));

        stream.Position = 0;
        return MetadataReference.CreateFromStream(stream);
    }

    private static string Render()
    {
        (CompilationUnit unit, _) = Translate();
        return GSharpPrinter.Print(unit);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Widgets.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
