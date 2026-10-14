// <copyright file="Issue2425ExplicitLocalObliviousExternalForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

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
open class Issue2425ExplicitLocalObliviousExternalForgivenessTranslationTests {
    /// Positive test: the exact real-world `Oahu.Core`
    /// `Login.CreateCodeVerifier` shape — an explicit-typed local
    /// initialized from an oblivious external EXTENSION method, later returned.
    @Fact
    func LoginCreateCodeVerifierShape_ExtensionMethodResult_ForgivenAtInitialization() {
        let printed = TranslateObliviousWithObliviousLibrary(`
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
}`)
        Assert.Contains("let codeVerifier = tokenBytes.ToUrlBase64String()!!", printed)
        Assert.Contains("return codeVerifier", printed)
        // Parity: the local's declaration absorbs the SAME single forgiveness a
        // direct return would need — the later `return codeVerifier` must not
        // need (or get) a second one.
        Assert.DoesNotContain("return codeVerifier!!", printed)
    }

    @Fact
    func InstanceMethodResult_ForgivenAtInitialization() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Combine("hello");
            return result;
        }
    }
}`)
        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed)
    }

    @Fact
    func StaticMethodResult_ForgivenAtInitialization() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format()
        {
            string result = ExtLib.StaticCombine("hello");
            return result;
        }
    }
}`)
        Assert.Contains("let result = ExtLib.StaticCombine(\"hello\")!!", printed)
    }

    @Fact
    func FieldResult_ForgivenAtInitialization() {
        let printed = TranslateObliviousWithObliviousLibrary(`
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
}`)
        Assert.Contains("let result = ext.Field!!", printed)
    }

    @Fact
    func PropertyResult_ForgivenAtInitialization() {
        let printed = TranslateObliviousWithObliviousLibrary(`
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
}`)
        Assert.Contains("let result = ext.Prop!!", printed)
    }

    /// Negative test: an external oblivious method whose declared return is an
    /// UNSUBSTITUTED type parameter (`T Generic<T>(T seed)`) is
    /// excluded by `IsObliviousExternalNullableMember` — a type parameter's
    /// own nullability is decided by its substituted argument, not the
    /// declaring assembly's nullable context — so the local must not be
    /// forgiven.
    @Fact
    func GenericMethod_UnsubstitutedTypeParameterReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Generic("seed");
            return result;
        }
    }
}`)
        Assert.Contains("let result = ext.Generic(\"seed\")", printed)
        Assert.DoesNotContain("ext.Generic(\"seed\")!!", printed)
    }

    /// Positive test: a parenthesized initializer resolves the same underlying
    /// symbol (Roslyn's `GetSymbolInfo` sees through parentheses), so the
    /// forgiveness still applies — matching the direct-return path's behavior
    /// for the identical shape.
    @Fact
    func ParenthesizedInitializer_ForgivenAtInitialization() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = (ext.Combine("hello"));
            return result;
        }
    }
}`)
        Assert.Contains("let result = (ext.Combine(\"hello\"))!!", printed)
    }

    @Fact
    func MultipleDeclarators_EachForgivenIndependently() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string a = ext.Combine("x"), b = ext.Combine("y");
            return a + b;
        }
    }
}`)
        Assert.Contains("let a = ext.Combine(\"x\")!!", printed)
        Assert.Contains("let b = ext.Combine(\"y\")!!", printed)
    }

    @Fact
    func LocalUsedAsArgument_ForgivenAtInitializationOnly() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Sink(string s) { }

        public void Format(ExtLib ext)
        {
            string result = ext.Combine("hello");
            this.Sink(result);
        }
    }
}`)
        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed)
        Assert.Contains("this.Sink(result)", printed)
        Assert.DoesNotContain("this.Sink(result!!)", printed)
    }

    @Fact
    func LocalUsedInAssignment_ForgivenAtInitializationOnly() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = ext.Combine("hello");
            string other;
            other = result;
            System.Console.WriteLine(other);
        }
    }
}`)
        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed)
        Assert.Contains("other = result", printed)
        Assert.DoesNotContain("other = result!!", printed)
    }

    /// A `var` local also needs forgiveness at its oblivious external initializer
    /// so G# infers the same non-null type that C# does.
    @Fact
    func VarLocal_IsForgivenAtInitializer() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            var result = ext.Combine("hello");
            return result;
        }
    }
}`)
        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed)
    }

    /// Negative/scope control: an explicit-typed local initialized from a
    /// SAME-PROJECT (source) member must not be touched by this fix — only an
    /// EXTERNAL (metadata) oblivious member qualifies. A plain source method
    /// returning a definitely-non-null literal is not itself tainted by the
    /// whole-program fixpoint (issue #1737/#2412 territory), so the type
    /// clause and initializer are both left exactly as before.
    @Fact
    func SameProjectSourceMember_IsNotForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class Helper
    {
        public string Get() { return "a"; }
    }

    public class C
    {
        public string Format(Helper h)
        {
            string result = h.Get();
            return result;
        }
    }
}`)
        Assert.Contains("let result = h.Get()", printed)
        Assert.DoesNotContain("h.Get()!!", printed)
    }

    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely `string?`-returning method is a
    /// real, deliberate nullability that must be preserved (as `T?`), not
    /// papered over with a blind initializer `!!`.
    @Fact
    func AnnotatedExternalNullableReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithAnnotatedLibrary(`
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
}`)
        Assert.Contains("result string? = lib.MaybeNull()", printed)
        Assert.DoesNotContain("lib.MaybeNull()!!", printed)
    }

    /// A nullable-enabled consumer still sees a nullable-oblivious producer's
    /// unannotated reference return as T? in G#, so it needs the same bridge.
    @Fact
    func NullableEnabledCompilation_IsForgiven() {
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Combine("hello");
            return result;
        }
    }
}`)
        Assert.Contains("let result = ext.Combine(\"hello\")!!", printed)
    }

    /// Direct-return parity, as it stands after ADR-0186 step 6 (PR 0). The
    /// local keeps exactly one `!!`, at its initializer: cs2gs may drop the
    /// type clause, and the local then takes its type from the initializer, so
    /// the `!!` keeps it a non-null `T` rather than the platform type
    /// `T!`. The direct return needs none, because gsc reads the oblivious
    /// result as `T!` and checks it at the return itself. Neither shape
    /// asserts twice.
    @Fact
    func ExplicitLocalThenReturn_MatchesDirectReturnForgivenessCount() {
        let viaLocal = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = ext.Combine("hello");
            return result;
        }
    }
}`)
        let direct = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            return ext.Combine("hello");
        }
    }
}`)
        let CountForgiveness = func (printed string) int32 {
            return printed.Split("!!").Length - 1
        }
        Assert.Equal(1, CountForgiveness(viaLocal))
        Assert.Equal(0, CountForgiveness(direct))
    }

    shared {
        /// Compiles a tiny "external" library WITHOUT a nullable context (oblivious),
        /// then translates the [`source`](paramref) snippet referencing it in an
        /// oblivious compilation.
        private func TranslateObliviousWithObliviousLibrary(source string) string {
            const LibSource = `
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
`
            let libRef = CompileObliviousLibrary(LibSource, "Issue2425ObliviousExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2425.ExplicitLocalObliviousExternalInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        /// Compiles a tiny "external" library WITH nullable annotations enabled (a
        /// genuinely `string?`-returning method), then translates the
        /// [`source`](paramref) snippet referencing it in an oblivious
        /// compilation.
        private func TranslateObliviousWithAnnotatedLibrary(source string) string {
            const LibSource = `
#nullable enable
public class AnnotatedLib
{
    public string? MaybeNull() { return null; }
}
`
            let libRef = CompileAnnotatedLibrary(LibSource, "Issue2425AnnotatedExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2425.AnnotatedExternalReturnInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        /// Translates the [`source`](paramref) in a nullable-ENABLED compilation
        /// referencing the same oblivious external library — verifies the fix is gated.
        private func TranslateEnabledWithObliviousLibrary(source string) string {
            const LibSource = `
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
`
            let libRef = CompileObliviousLibrary(LibSource, "Issue2425ObliviousExtLibForEnabled")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2425.EnabledCallingObliviousInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libRef).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func CompileObliviousLibrary(libSource string, assemblyName string) MetadataReference {
            let libTree = CSharpSyntaxTree.ParseText(libSource, CSharpParseOptions(LanguageVersion.Latest))
            let libCompilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{libTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            using let peStream = MemoryStream()
            let emit = libCompilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return MetadataReference.CreateFromStream(peStream)
        }

        private func CompileAnnotatedLibrary(libSource string, assemblyName string) MetadataReference {
            let libTree = CSharpSyntaxTree.ParseText(libSource, CSharpParseOptions(LanguageVersion.Latest))
            let libCompilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{libTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let peStream = MemoryStream()
            let emit = libCompilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return MetadataReference.CreateFromStream(peStream)
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Consumer-only fixture omits the referenced C# metadata library from emitted G#."
            )
            Assert.True(result.Success, "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + printed)
            return printed
        }
    }
}
