// <copyright file="Issue2202ExternalObliviousReturnForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2202: a call to an EXTERNAL (metadata)
/// method whose return type is oblivious (<c>NullableAnnotation.None</c>, i.e.
/// the declaring assembly was compiled without a nullable context) produces a
/// value that gsc considers nullable (<c>T?</c>) per <c>ClrNullability.cs</c>'s
/// "unannotated → nullable" fallback. When such a call result appears as the
/// return/expression-body value in an oblivious compilation, cs2gs must assert
/// <c>!!</c> to bridge the gap between C#'s implicit acceptance and gsc's strict
/// nullability. This mirrors the RECEIVER-position handling (issue #2113) but
/// for VALUE positions (return statements, expression bodies).
/// </summary>
public class Issue2202ExternalObliviousReturnForgivenessTranslationTests
{
    /// <summary>
    /// Positive test: an oblivious external method's return value used directly
    /// as the expression body of a method (non-null declared return type) gets
    /// <c>!!</c> forgiveness.
    /// </summary>
    [Fact]
    public void ExpressionBody_ObliviousExternalReturn_AssertsNonNull()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            return ext.Combine(""hello"");
        }
    }
}");

        // The return value from ext.Combine(...) must be asserted with !!
        Assert.Contains("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Positive test: the oblivious external method return used as a direct
    /// expression-bodied member (arrow syntax) also gets <c>!!</c>.
    /// </summary>
    [Fact]
    public void ArrowBody_ObliviousExternalReturn_AssertsNonNull()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext) => ext.Combine(""world"");
    }
}");

        Assert.Contains("ext.Combine(\"world\")!!", printed);
    }

    /// <summary>
    /// Positive test: an oblivious external extension method's return value
    /// used as a return statement gets <c>!!</c> — mirrors the real
    /// <c>Oahu.Data</c> <c>Combine</c> extension pattern.
    /// </summary>
    [Fact]
    public void ReturnStatement_ObliviousExternalExtensionReturn_AssertsNonNull()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Format(IEnumerable<string> items)
        {
            return items.Merge("" - "");
        }
    }
}");

        // The extension method Merge returns string (oblivious) → needs !!
        Assert.Contains("items.Merge(\" - \")!!", printed);
    }

    /// <summary>
    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely <c>string?</c>-returning method
    /// represents a REAL, deliberate nullability that cs2gs should NOT paper
    /// over with blind <c>!!</c>. Only the truly oblivious/unannotated case
    /// (where gsc's fallback default is nullable purely due to lack of
    /// information) is safe to bridge.
    /// </summary>
    [Fact]
    public void AnnotatedExternalNullableReturn_IsNotForgiven()
    {
        string printed = TranslateObliviousWithAnnotatedLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(AnnotatedLib lib)
        {
            return lib.MaybeNull();
        }
    }
}");

        // The annotated nullable return must NOT get !! — it's a real nullable
        // that the ObliviousNullabilityAnalyzer should propagate/promote (the
        // method's return type should become string? or the value remains T?
        // without blind forgiveness).
        Assert.DoesNotContain("lib.MaybeNull()!!", printed);
    }

    /// <summary>
    /// Negative test: a nullable-ENABLED compilation calling an oblivious
    /// external method — the fix is gated to oblivious compilations only, so
    /// a nullable-enabled project must NOT get the <c>!!</c> forgiveness
    /// (its own nullable flow analysis handles correctness).
    /// </summary>
    [Fact]
    public void NullableEnabledCompilation_ObliviousExternalReturn_IsNotForgiven()
    {
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext) => ext.Combine(""test"")!;
    }
}");

        // In a nullable-enabled compilation, the C# author explicitly handles
        // the nullability (using ! here). cs2gs should NOT add its own !!
        // on top of the author's suppression — the gate `IsObliviousCompilation()`
        // must exclude this path. The ! already maps to !! in translation.
        // No DOUBLE assertion (!!!! or similar anomaly).
        Assert.DoesNotContain("!!!!",  printed);
    }

    /// <summary>
    /// Compiles a tiny "external" library WITHOUT a nullable context (oblivious),
    /// then translates the <paramref name="source"/> snippet referencing it in an
    /// oblivious compilation.
    /// </summary>
    private static string TranslateObliviousWithObliviousLibrary(string source)
    {
        const string LibSource = @"
using System.Collections.Generic;

public class ExtLib
{
    public string Combine(string separator) { return separator; }
}

public static class ExtLibExtensions
{
    public static string Merge(this IEnumerable<string> items, string separator)
    {
        return string.Join(separator, items);
    }
}
";
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "ObliviousExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2202.ExternalObliviousReturnInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    /// <summary>
    /// Compiles a tiny "external" library WITH nullable annotations enabled (a
    /// genuinely <c>string?</c>-returning method), then translates the
    /// <paramref name="source"/> snippet referencing it in an oblivious
    /// compilation.
    /// </summary>
    private static string TranslateObliviousWithAnnotatedLibrary(string source)
    {
        const string LibSource = @"
#nullable enable
public class AnnotatedLib
{
    public string? MaybeNull() { return null; }
}
";
        MetadataReference libRef = CompileAnnotatedLibrary(LibSource, "AnnotatedExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2202.AnnotatedExternalReturnInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    /// <summary>
    /// Translates the <paramref name="source"/> in a nullable-ENABLED compilation
    /// referencing the same oblivious external library — verifies the fix is gated.
    /// </summary>
    private static string TranslateEnabledWithObliviousLibrary(string source)
    {
        const string LibSource = @"
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
";
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "ObliviousExtLibForEnabled");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2202.EnabledCallingObliviousInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static MetadataReference CompileObliviousLibrary(string libSource, string assemblyName)
    {
        var libTree = CSharpSyntaxTree.ParseText(
            libSource,
            new CSharpParseOptions(LanguageVersion.Latest));
        var libCompilation = CSharpCompilation.Create(
            assemblyName,
            new[] { libTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));
        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return MetadataReference.CreateFromStream(peStream);
    }

    private static MetadataReference CompileAnnotatedLibrary(string libSource, string assemblyName)
    {
        var libTree = CSharpSyntaxTree.ParseText(
            libSource,
            new CSharpParseOptions(LanguageVersion.Latest));
        var libCompilation = CSharpCompilation.Create(
            assemblyName,
            new[] { libTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return MetadataReference.CreateFromStream(peStream);
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
