// <copyright file="Issue2202ExternalObliviousReturnForgivenessTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #2202: a call to an EXTERNAL (metadata)
/// method whose return type is oblivious (`NullableAnnotation.None`, i.e.
/// the declaring assembly was compiled without a nullable context), used as the
/// return/expression-body value in an oblivious compilation. gsc used to import
/// such a value as nullable (`T?`, ADR-0136), so cs2gs asserted `!!`
/// to bridge C#'s implicit acceptance and gsc's strict nullability, mirroring
/// the RECEIVER-position handling (issue #2113) for VALUE positions (return
/// statements, expression bodies). Since ADR-0186 step 3 gsc imports the value
/// as the platform type `T!` and checks it itself, so these tests now pin
/// that cs2gs emits no `!!` (ADR-0186 step 6, PR 0).
///
/// The test names (`…AssertsNonNull`) predate ADR-0186 step 6 and are kept
/// for issue traceability; the assertions state the current contract.
open class Issue2202ExternalObliviousReturnForgivenessTranslationTests {
    /// An oblivious external method's return value returned directly from a
    /// method with a non-null declared return type is emitted bare.
    @Fact
    func ExpressionBody_ObliviousExternalReturn_AssertsNonNull() {
        let printed = TranslateObliviousWithObliviousLibrary(`
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
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed)
    }

    /// The oblivious external method return used as a direct expression-bodied
    /// member (arrow syntax) is also emitted bare.
    @Fact
    func ArrowBody_ObliviousExternalReturn_AssertsNonNull() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext) => ext.Combine("world");
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("ext.Combine(\"world\")", printed)
        Assert.DoesNotContain("ext.Combine(\"world\")!!", printed)
    }

    /// An oblivious external extension method's return value used as a return
    /// statement is emitted bare — mirrors the real `Oahu.Data`
    /// `Combine` extension pattern.
    @Fact
    func ReturnStatement_ObliviousExternalExtensionReturn_AssertsNonNull() {
        let printed = TranslateObliviousWithObliviousLibrary(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Format(IEnumerable<string> items)
        {
            return items.Merge(" - ");
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("items.Merge(\" - \")", printed)
        Assert.DoesNotContain("items.Merge(\" - \")!!", printed)
    }

    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely `string?`-returning method
    /// represents a REAL, deliberate nullability that cs2gs should NOT paper
    /// over with blind `!!`. (The truly oblivious case, which cs2gs used
    /// to bridge with `!!`, is now emitted bare and checked by gsc.)
    @Fact
    func AnnotatedExternalNullableReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithAnnotatedLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(AnnotatedLib lib)
        {
            return lib.MaybeNull();
        }
    }
}`)
        // The annotated nullable return must NOT get !! — it's a real nullable
        // that the ObliviousNullabilityAnalyzer should propagate/promote (the
        // method's return type should become string? or the value remains T?
        // without blind forgiveness).
        Assert.DoesNotContain("lib.MaybeNull()!!", printed)
    }

    /// Negative test: a nullable-ENABLED compilation calling an oblivious
    /// external method — the fix is gated to oblivious compilations only, so
    /// a nullable-enabled project must NOT get the `!!` forgiveness
    /// (its own nullable flow analysis handles correctness).
    @Fact
    func NullableEnabledCompilation_ObliviousExternalReturn_IsNotForgiven() {
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext) => ext.Combine("test")!;
    }
}`)
        // In a nullable-enabled compilation, the C# author explicitly handles
        // the nullability (using ! here). cs2gs should NOT add its own !!
        // on top of the author's suppression — the gate `IsObliviousCompilation()`
        // must exclude this path. The ! already maps to !! in translation.
        // No DOUBLE assertion (!!!! or similar anomaly).
        Assert.DoesNotContain("!!!!", printed)
    }

    @Fact
    func NullableEnabled_InferredLocalFromObliviousExternalReturn_RendersNullableType() {
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Run(ExtLib ext)
        {
            var response = ext.GetResponse();
            if (response is null) return;
            System.Console.WriteLine(response.Value);
        }
    }
}`)
        Assert.Contains("response ExternalResponse? =", printed)
        Assert.Contains("if response == nil", printed)
    }

    @Fact
    func NullableEnabled_InferredLocalFromAnnotatedNullableReturn_RendersNullableType() {
        let printed = TranslateEnabledWithObliviousLibrary(`
using System.Linq;

namespace Demo
{
    public sealed class AuthSession
    {
        public string AccountId { get; init; } = string.Empty;
    }

    public class C
    {
        public AuthSession? Find(AuthSession[] sessions)
        {
            var match = sessions.FirstOrDefault();
            if (match is not null) return match;
            return null;
        }
    }
}`)
        Assert.Contains("match AuthSession? =", printed)
        Assert.Contains("if match != nil", printed)
    }

    shared {
        /// Compiles a tiny "external" library WITHOUT a nullable context (oblivious),
        /// then translates the [`source`](paramref) snippet referencing it in an
        /// oblivious compilation.
        private func TranslateObliviousWithObliviousLibrary(source string) string {
            const LibSource = `
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
`
            let libRef = CompileObliviousLibrary(LibSource, "ObliviousExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2202.ExternalObliviousReturnInMemory",
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
            let libRef = CompileAnnotatedLibrary(LibSource, "AnnotatedExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2202.AnnotatedExternalReturnInMemory",
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
    public ExternalResponse GetResponse() { return null; }
}

public class ExternalResponse
{
    public string Value { get; set; }
}

`
            let libRef = CompileObliviousLibrary(LibSource, "ObliviousExtLibForEnabled")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2202.EnabledCallingObliviousInMemory",
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
