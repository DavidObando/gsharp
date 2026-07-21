// <copyright file="Issue2425ExplicitLocalObliviousExternalForgivenessTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #2425: an explicit-typed local declared
/// `T x = external.ObliviousReturn();` — where the declared type equals the
/// initializer's natural type (the common case that omits the type clause
/// entirely, ADR-0115 §B.3) — drops null forgiveness for an oblivious EXTERNAL
/// (metadata, no nullable context) member result. Issue #2202's value-read logic
/// already asserts `!!` on a DIRECT return of such a member
/// (`return external.ObliviousReturn();`), but issue #1737's explicit-local
/// type-retention decision only consults the whole-program SAME/SIBLING-source
/// taint fixpoint (issue #2412), which an EXTERNAL symbol can never seed an edge
/// in. So the explicit type is dropped, gsc infers the local as `T?` (per its own
/// unannotated-external-import rule, issue #1354), and a later `return
/// codeVerifier;` has no external symbol left at the read site to trigger
/// forgiveness (GS0156) — exactly the real-world `Oahu.Core`
/// `Login.CreateCodeVerifier` shape (`string codeVerifier =
/// tokenBytes.ToUrlBase64String(); return codeVerifier;`).
///
/// The fix asserts `!!` at the INITIALIZER (mirroring the direct-return fix)
/// instead of retaining an explicit `T?` type, so the local infers the intended
/// non-null type from the start and every later use (return/argument/
/// assignment) needs no further special-casing.
/// </summary>
public class Issue2425ExplicitLocalObliviousExternalForgivenessTranslationTests
{
    /// <summary>
    /// Positive test: the exact real-world <c>Oahu.Core</c>
    /// <c>Login.CreateCodeVerifier</c> shape — an explicit-typed local
    /// initialized from an oblivious external EXTENSION method, later returned.
    /// </summary>
    [Fact]
    public void LoginCreateCodeVerifierShape_ExtensionMethodResult_ForgivenAtInitialization()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string CreateCodeVerifier(byte[] tokenBytes)
        {
            string codeVerifier = tokenBytes.ToUrlBase64String();
            return codeVerifier;
        }
    }
}");

        Assert.Contains("let codeVerifier = tokenBytes.ToUrlBase64String()!!", printed);
        Assert.Contains("return codeVerifier", printed);

        // Parity: the local's declaration absorbs the SAME single forgiveness a
        // direct return would need — the later `return codeVerifier` must not
        // need (or get) a second one.
        Assert.DoesNotContain("return codeVerifier!!", printed);
    }

    [Fact]
    public void InstanceMethodResult_ForgivenAtInitialization()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Combine(""hello"");
            return result;
        }
    }
}");

        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed);
    }

    [Fact]
    public void StaticMethodResult_ForgivenAtInitialization()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format()
        {
            string result = ExtLib.StaticCombine(""hello"");
            return result;
        }
    }
}");

        Assert.Contains("let result = ExtLib.StaticCombine(\"hello\")!!", printed);
    }

    [Fact]
    public void FieldResult_ForgivenAtInitialization()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Field;
            return result;
        }
    }
}");

        Assert.Contains("let result = ext.Field!!", printed);
    }

    [Fact]
    public void PropertyResult_ForgivenAtInitialization()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Prop;
            return result;
        }
    }
}");

        Assert.Contains("let result = ext.Prop!!", printed);
    }

    /// <summary>
    /// Negative test: an external oblivious method whose declared return is an
    /// UNSUBSTITUTED type parameter (<c>T Generic&lt;T&gt;(T seed)</c>) is
    /// excluded by <c>IsObliviousExternalNullableMember</c> — a type parameter's
    /// own nullability is decided by its substituted argument, not the
    /// declaring assembly's nullable context — so the local must not be
    /// forgiven.
    /// </summary>
    [Fact]
    public void GenericMethod_UnsubstitutedTypeParameterReturn_IsNotForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Generic(""seed"");
            return result;
        }
    }
}");

        Assert.Contains("let result = ext.Generic(\"seed\")", printed);
        Assert.DoesNotContain("ext.Generic(\"seed\")!!", printed);
    }

    /// <summary>
    /// Positive test: a parenthesized initializer resolves the same underlying
    /// symbol (Roslyn's <c>GetSymbolInfo</c> sees through parentheses), so the
    /// forgiveness still applies — matching the direct-return path's behavior
    /// for the identical shape.
    /// </summary>
    [Fact]
    public void ParenthesizedInitializer_ForgivenAtInitialization()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = (ext.Combine(""hello""));
            return result;
        }
    }
}");

        Assert.Contains("let result = (ext.Combine(\"hello\"))!!", printed);
    }

    [Fact]
    public void MultipleDeclarators_EachForgivenIndependently()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string a = ext.Combine(""x""), b = ext.Combine(""y"");
            return a + b;
        }
    }
}");

        Assert.Contains("let a = ext.Combine(\"x\")!!", printed);
        Assert.Contains("let b = ext.Combine(\"y\")!!", printed);
    }

    [Fact]
    public void LocalUsedAsArgument_ForgivenAtInitializationOnly()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Sink(string s) { }

        public void Format(ExtLib ext)
        {
            string result = ext.Combine(""hello"");
            this.Sink(result);
        }
    }
}");

        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed);
        Assert.Contains("this.Sink(result)", printed);
        Assert.DoesNotContain("this.Sink(result!!)", printed);
    }

    [Fact]
    public void LocalUsedInAssignment_ForgivenAtInitializationOnly()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ext.Combine(""hello"");
            string other;
            other = result;
            System.Console.WriteLine(other);
        }
    }
}");

        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed);
        Assert.Contains("other = result", printed);
        Assert.DoesNotContain("other = result!!", printed);
    }

    /// <summary>
    /// A `var` local also needs forgiveness at its oblivious external initializer
    /// so G# infers the same non-null type that C# does.
    /// </summary>
    [Fact]
    public void VarLocal_IsForgivenAtInitializer()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            var result = ext.Combine(""hello"");
            return result;
        }
    }
}");

        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: an explicit-typed local initialized from a
    /// SAME-PROJECT (source) member must not be touched by this fix — only an
    /// EXTERNAL (metadata) oblivious member qualifies. A plain source method
    /// returning a definitely-non-null literal is not itself tainted by the
    /// whole-program fixpoint (issue #1737/#2412 territory), so the type
    /// clause and initializer are both left exactly as before.
    /// </summary>
    [Fact]
    public void SameProjectSourceMember_IsNotForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class Helper
    {
        public string Get() { return ""a""; }
    }

    public class C
    {
        public string Format(Helper h)
        {
            string result = h.Get();
            return result;
        }
    }
}");

        Assert.Contains("let result = h.Get()", printed);
        Assert.DoesNotContain("h.Get()!!", printed);
    }

    /// <summary>
    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely <c>string?</c>-returning method is a
    /// real, deliberate nullability that must be preserved (as `T?`), not
    /// papered over with a blind initializer `!!`.
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
            string result = lib.MaybeNull();
            return result;
        }
    }
}");

        Assert.Contains("result string? = lib.MaybeNull()", printed);
        Assert.DoesNotContain("lib.MaybeNull()!!", printed);
    }

    /// <summary>
    /// A nullable-enabled consumer still sees a nullable-oblivious producer's
    /// unannotated reference return as T? in G#, so it needs the same bridge.
    /// </summary>
    [Fact]
    public void NullableEnabledCompilation_IsForgiven()
    {
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Combine(""hello"");
            return result;
        }
    }
}");

        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Direct-return parity: an explicit local later returned and a direct
    /// return of the identical call both end up with exactly one <c>!!</c>
    /// bridging the same oblivious external member — the local-declaration fix
    /// reproduces the #2202 direct-return outcome rather than a different one.
    /// </summary>
    [Fact]
    public void ExplicitLocalThenReturn_MatchesDirectReturnForgivenessCount()
    {
        string viaLocal = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Combine(""hello"");
            return result;
        }
    }
}");

        string direct = TranslateObliviousWithObliviousLibrary(@"
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

        int CountForgiveness(string printed) => printed.Split("!!").Length - 1;

        Assert.Equal(1, CountForgiveness(viaLocal));
        Assert.Equal(1, CountForgiveness(direct));
    }

    /// <summary>
    /// Compiles a tiny "external" library WITHOUT a nullable context (oblivious),
    /// then translates the <paramref name="source"/> snippet referencing it in an
    /// oblivious compilation.
    /// </summary>
    private static string TranslateObliviousWithObliviousLibrary(string source)
    {
        const string LibSource = @"
public class ExtLib
{
    public string Combine(string separator) { return separator; }

    public string Field;

    public string Prop { get; set; }

    public static string StaticCombine(string separator) { return separator; }

    public T Generic<T>(T seed) { return seed; }
}

public static class ExtLibExtensions
{
    public static string ToUrlBase64String(this byte[] bytes)
    {
        return System.Convert.ToBase64String(bytes);
    }
}
";
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "Issue2425ObliviousExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2425.ExplicitLocalObliviousExternalInMemory",
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
        MetadataReference libRef = CompileAnnotatedLibrary(LibSource, "Issue2425AnnotatedExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2425.AnnotatedExternalReturnInMemory",
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
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "Issue2425ObliviousExtLibForEnabled");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2425.EnabledCallingObliviousInMemory",
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
