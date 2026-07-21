// <copyright file="Issue2427ObliviousExternalAssignmentForgivenessTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #2427: a plain REASSIGNMENT (`path =
/// external.ObliviousReturn();`) to an already-declared non-null local/
/// parameter/field/property/indexer drops null forgiveness for an oblivious
/// EXTERNAL (metadata, no nullable context) member result. Issue #2202's
/// value-read logic already asserts `!!` on a DIRECT return of such a member
/// (`return external.ObliviousReturn();`), and issue #2425's fix asserts `!!`
/// at an explicit-typed LOCAL DECLARATION's initializer (`T x =
/// external.ObliviousReturn();`) — but neither reaches a subsequent bare
/// assignment STATEMENT: `TranslateExpressionStatement`'s
/// <c>AssignmentExpressionSyntax</c> case computes its RHS via
/// <c>CoerceConstantToUnsigned</c> / <c>CoerceCompoundAssignmentRhs</c> /
/// <c>CoercePointerConversion</c> / <c>ForgiveEventSubscriptionRhs</c> /
/// <c>ForgiveElementAccessAssignmentRhs</c>, none of which apply
/// <c>IsObliviousExternalNullableMember</c> forgiveness. This is exactly the
/// real-world `Oahu.Core` `BookLibrary.gs:469` shape surfaced by #2426:
/// `path = (pathStub + ext).AsUncIfLong();`, where <c>AsUncIfLong</c> is an
/// oblivious external extension method and <c>path</c> is an already
/// non-null-typed local.
/// </summary>
public class Issue2427ObliviousExternalAssignmentForgivenessTranslationTests
{
    /// <summary>
    /// Positive test: the exact real-world <c>Oahu.Core</c>
    /// <c>BookLibrary.gs:469</c> shape — a non-null local declared earlier in
    /// the method, reassigned from a string-concatenation receiver's
    /// oblivious external EXTENSION method call.
    /// </summary>
    [Fact]
    public void BookLibraryShape_ExtensionMethodReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Resolve(string pathStub, string ext)
        {
            string path = ""seed"";
            path = (pathStub + ext).AsUncIfLong();
            return path;
        }
    }
}");

        Assert.Contains("path = (pathStub + ext)!!.AsUncIfLong()!!", printed);

        // Parity: the assignment absorbs the SAME single forgiveness a
        // direct return would need — the later `return path` must not need
        // (or get) a second one.
        Assert.DoesNotContain("return path!!", printed);
    }

    [Fact]
    public void ParameterReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext, string result)
        {
            result = ext.Combine(""hello"");
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = ext.Combine(\"hello\")!!", printed);
    }

    [Fact]
    public void InstanceFieldReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Cached = ""seed"";

        public void Format(ExtLib ext)
        {
            this.Cached = ext.Combine(""hello"");
        }
    }
}");

        Assert.Contains("this.Cached = ext.Combine(\"hello\")!!", printed);
    }

    [Fact]
    public void InstancePropertyReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Cached { get; set; } = ""seed"";

        public void Format(ExtLib ext)
        {
            this.Cached = ext.Combine(""hello"");
        }
    }
}");

        Assert.Contains("this.Cached = ext.Combine(\"hello\")!!", printed);
    }

    [Fact]
    public void StaticFieldReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public static string Cached = ""seed"";

        public static void Format(ExtLib ext)
        {
            C.Cached = ext.Combine(""hello"");
        }
    }
}");

        Assert.Contains("C.Cached = ext.Combine(\"hello\")!!", printed);
    }

    [Fact]
    public void IndexerReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext, string[] arr)
        {
            arr[0] = ext.Combine(""hello"");
        }
    }
}");

        Assert.Contains("arr[0] = ext.Combine(\"hello\")!!", printed);
    }

    [Fact]
    public void StaticMethodResultReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format()
        {
            string result = ""seed"";
            result = ExtLib.StaticCombine(""hello"");
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = ExtLib.StaticCombine(\"hello\")!!", printed);
    }

    [Fact]
    public void FieldReadReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ""seed"";
            result = ext.Field;
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = ext.Field!!", printed);
    }

    [Fact]
    public void PropertyReadReassignment_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ""seed"";
            result = ext.Prop;
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = ext.Prop!!", printed);
    }

    /// <summary>
    /// Positive test: a parenthesized RHS resolves the same underlying
    /// symbol (Roslyn's <c>GetSymbolInfo</c> sees through parentheses), so the
    /// forgiveness still applies.
    /// </summary>
    [Fact]
    public void ParenthesizedRhs_ForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ""seed"";
            result = (ext.Combine(""hello""));
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = (ext.Combine(\"hello\"))!!", printed);
    }

    /// <summary>
    /// Negative test: an external oblivious method whose declared return is an
    /// UNSUBSTITUTED type parameter (<c>T Generic&lt;T&gt;(T seed)</c>) is
    /// excluded by <c>IsObliviousExternalNullableMember</c> — the same filter
    /// #2202/#2425 already rely on — so the assignment must not be forgiven.
    /// </summary>
    [Fact]
    public void GenericMethod_UnsubstitutedTypeParameterReturn_IsNotForgiven()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ""seed"";
            result = ext.Generic(""seed"");
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = ext.Generic(\"seed\")", printed);
        Assert.DoesNotContain("ext.Generic(\"seed\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: the SAME oblivious external member assigned via
    /// a COMPOUND assignment (<c>+=</c>). Scoped out deliberately — a compound
    /// assignment's RHS is a distinct shape (also flows through
    /// <c>CoerceCompoundAssignmentRhs</c>'s numeric-coercion logic) and is not
    /// addressed by this fix.
    /// </summary>
    [Fact]
    public void CompoundAssignment_IsNotForgiven_ScopeControl()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ""seed"";
            result += ext.Combine(""hello"");
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result += ext.Combine(\"hello\")", printed);
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: an already nullable-annotated target (`string?
    /// result`) already accepts a `T?` RHS unchanged — nothing to forgive.
    /// </summary>
    [Fact]
    public void NullableAnnotatedTarget_IsNotForgiven_ScopeControl()
    {
        string printed = TranslateObliviousWithAnnotatedTargetLibrary(@"
namespace Demo
{
#nullable enable
    public class C
    {
        public void Format(ExtLib ext, string? result)
        {
            result = ext.Combine(""hello"");
            System.Console.WriteLine(result);
        }
    }
#nullable disable
}");

        Assert.Contains("result = ext.Combine(\"hello\")", printed);
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Negative/scope control: a SAME-PROJECT (source) member RHS must not be
    /// touched by this fix — only an EXTERNAL (metadata) oblivious member
    /// qualifies.
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
        public void Format(Helper h)
        {
            string result = ""seed"";
            result = h.Get();
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = h.Get()", printed);
        Assert.DoesNotContain("h.Get()!!", printed);
    }

    /// <summary>
    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely <c>string?</c>-returning method is a
    /// real, deliberate nullability that must be preserved, not papered over
    /// with a blind assignment `!!`.
    /// </summary>
    [Fact]
    public void AnnotatedExternalNullableReturn_IsNotForgiven()
    {
        string printed = TranslateObliviousWithAnnotatedLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(AnnotatedLib lib)
        {
            string result = ""seed"";
            result = lib.MaybeNull();
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = lib.MaybeNull()", printed);
        Assert.DoesNotContain("lib.MaybeNull()!!", printed);
    }

    /// <summary>
    /// A nullable-enabled consumer still sees a nullable-oblivious producer's
    /// unannotated reference return as T? in G#, so assignment needs the bridge.
    /// </summary>
    [Fact]
    public void NullableEnabledCompilation_IsForgiven()
    {
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ""seed"";
            result = ext.Combine(""hello"");
            System.Console.WriteLine(result);
        }
    }
}");

        Assert.Contains("result = ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Positive/scope control: the target local's `var` ORIGIN does not block
    /// the assignment-side fix — unlike #2425 (scoped to explicit-typed
    /// DECLARATIONS), this fix operates on an already-established local's
    /// type (inferred or explicit), which is the same non-null `string`
    /// either way by the time a later reassignment is translated.
    /// </summary>
    [Fact]
    public void VarLocalOrigin_StillForgivenAtAssignment()
    {
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            var result = ""seed"";
            result = ext.Combine(""hello"");
            return result;
        }
    }
}");

        Assert.Contains("result = ext.Combine(\"hello\")!!", printed);
    }

    /// <summary>
    /// Direct-return/local-initializer parity: a reassignment-then-return and
    /// a direct return of the identical call both end up with exactly one
    /// <c>!!</c> bridging the same oblivious external member — the
    /// assignment-side fix reproduces the #2202 direct-return outcome rather
    /// than a different one (no double-forgiveness at the later return).
    /// </summary>
    [Fact]
    public void ReassignmentThenReturn_MatchesDirectReturnForgivenessCount()
    {
        string viaReassignment = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ""seed"";
            result = ext.Combine(""hello"");
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

        Assert.Equal(1, CountForgiveness(viaReassignment));
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
    public static string AsUncIfLong(this string path)
    {
        return path;
    }

    public static string ToUrlBase64String(this byte[] bytes)
    {
        return System.Convert.ToBase64String(bytes);
    }
}
";
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "Issue2427ObliviousExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2427.ObliviousExternalAssignmentInMemory",
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
    /// Same oblivious external library, but the CONSUMING snippet declares its
    /// own reassignment target with an explicit nullable-annotated (`#nullable
    /// enable`) parameter type — used for the already-nullable-target scope
    /// control.
    /// </summary>
    private static string TranslateObliviousWithAnnotatedTargetLibrary(string source)
    {
        const string LibSource = @"
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
";
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "Issue2427ObliviousExtLibForAnnotatedTarget");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2427.AnnotatedTargetInMemory",
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
        MetadataReference libRef = CompileAnnotatedLibrary(LibSource, "Issue2427AnnotatedExtLib");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2427.AnnotatedExternalReturnInMemory",
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
        MetadataReference libRef = CompileObliviousLibrary(LibSource, "Issue2427ObliviousExtLibForEnabled");

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2427.EnabledCallingObliviousInMemory",
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
