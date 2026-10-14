// <copyright file="Issue2427ObliviousExternalAssignmentForgivenessTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #2427: a plain REASSIGNMENT (`path =
/// external.ObliviousReturn();`) to an already-declared non-null local/
/// parameter/field/property/indexer used to drop null forgiveness for an
/// oblivious EXTERNAL (metadata, no nullable context) member result, which gsc
/// then imported as `T?` (ADR-0136). Issue #2202's value-read logic asserted
/// `!!` on a DIRECT return of such a member (`return
/// external.ObliviousReturn();`), and issue #2425's fix asserted `!!` at an
/// explicit-typed LOCAL DECLARATION's initializer (`T x =
/// external.ObliviousReturn();`) — but neither reached a subsequent bare
/// assignment STATEMENT: `TranslateExpressionStatement`'s
/// `AssignmentExpressionSyntax` case computes its RHS via
/// `CoerceConstantToUnsigned` / `CoerceCompoundAssignmentRhs` /
/// `CoercePointerConversion` /
/// `ForgiveElementAccessAssignmentRhs`, none of which applied
/// `IsObliviousExternalNullableMember` forgiveness. This is exactly the
/// real-world `Oahu.Core` `BookLibrary.gs:469` shape surfaced by #2426:
/// `path = (pathStub + ext).AsUncIfLong();`, where `AsUncIfLong` is an
/// oblivious external extension method and `path` is an already
/// non-null-typed local.
///
/// Since ADR-0186 step 3 gsc imports the oblivious result as the platform type
/// `T!` and checks it itself at the store, so these tests now pin that cs2gs
/// emits no `!!` on the RHS (ADR-0186 step 6, PR 0). The test names
/// (`…Forgiven…`) predate ADR-0186 step 6 and are kept for issue traceability;
/// the assertions state the current contract.
open class Issue2427ObliviousExternalAssignmentForgivenessTranslationTests {
    /// Positive test: the exact real-world `Oahu.Core`
    /// `BookLibrary.gs:469` shape — a non-null local declared earlier in
    /// the method, reassigned from a string-concatenation receiver's
    /// oblivious external EXTENSION method call.
    @Fact
    func BookLibraryShape_ExtensionMethodReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Resolve(string pathStub, string ext)
        {
            string path = "seed";
            path = (pathStub + ext).AsUncIfLong();
            return path;
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("path = (pathStub + ext).AsUncIfLong()", printed)
        Assert.DoesNotContain("path = (pathStub + ext).AsUncIfLong()!!", printed)
        Assert.DoesNotContain("(pathStub + ext)!!", printed)
        // Parity with a direct return: the later `return path` gets no `!!`
        // either.
        Assert.DoesNotContain("return path!!", printed)
    }

    @Fact
    func Issue3422_CheckedCastOfObliviousExternalResult_PreservesNull() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Cast(ExtLib ext)
        {
            return (string)ext.Combine("hello");
        }
    }
}`)
        Assert.Contains("cast[string](ext.Combine(\"hello\"))", printed)
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed)
        TranslationTestValidation.AssertBinds(printed, `class ExtLib {
    func Combine(separator string) string -> separator
}`)
    }

    @Fact
    func ParameterReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext, string result)
        {
            result = ext.Combine("hello");
            System.Console.WriteLine(result);
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("result = ext.Combine(\"hello\")!!", printed)
    }

    @Fact
    func InstanceFieldReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Cached = "seed";

        public void Format(ExtLib ext)
        {
            this.Cached = ext.Combine("hello");
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("this.Cached = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("this.Cached = ext.Combine(\"hello\")!!", printed)
    }

    @Fact
    func InstancePropertyReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Cached { get; set; } = "seed";

        public void Format(ExtLib ext)
        {
            this.Cached = ext.Combine("hello");
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("this.Cached = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("this.Cached = ext.Combine(\"hello\")!!", printed)
    }

    @Fact
    func StaticFieldReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public static string Cached = "seed";

        public static void Format(ExtLib ext)
        {
            C.Cached = ext.Combine("hello");
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("C.Cached = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("C.Cached = ext.Combine(\"hello\")!!", printed)
    }

    @Fact
    func IndexerReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext, string[] arr)
        {
            arr[0] = ext.Combine("hello");
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("arr[0] = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("arr[0] = ext.Combine(\"hello\")!!", printed)
    }

    @Fact
    func StaticMethodResultReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format()
        {
            string result = "seed";
            result = ExtLib.StaticCombine("hello");
            System.Console.WriteLine(result);
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = ExtLib.StaticCombine(\"hello\")", printed)
        Assert.DoesNotContain("result = ExtLib.StaticCombine(\"hello\")!!", printed)
    }

    @Fact
    func FieldReadReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = "seed";
            result = ext.Field;
            System.Console.WriteLine(result);
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = ext.Field", printed)
        Assert.DoesNotContain("result = ext.Field!!", printed)
    }

    @Fact
    func PropertyReadReassignment_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = "seed";
            result = ext.Prop;
            System.Console.WriteLine(result);
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = ext.Prop", printed)
        Assert.DoesNotContain("result = ext.Prop!!", printed)
    }

    /// A parenthesized RHS resolves the same underlying symbol (Roslyn's
    /// `GetSymbolInfo` sees through parentheses), so it is treated like
    /// the bare call: emitted with no `!!`.
    @Fact
    func ParenthesizedRhs_ForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = "seed";
            result = (ext.Combine("hello"));
            System.Console.WriteLine(result);
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = (ext.Combine(\"hello\"))", printed)
        Assert.DoesNotContain("result = (ext.Combine(\"hello\"))!!", printed)
    }

    /// Negative test: an external oblivious method whose declared return is an
    /// UNSUBSTITUTED type parameter (`T Generic<T>(T seed)`) is
    /// excluded by `IsObliviousExternalNullableMember` — the same filter
    /// #2202/#2425 already rely on — so the assignment must not be forgiven.
    @Fact
    func GenericMethod_UnsubstitutedTypeParameterReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = "seed";
            result = ext.Generic("seed");
            System.Console.WriteLine(result);
        }
    }
}`)
        Assert.Contains("result = ext.Generic(\"seed\")", printed)
        Assert.DoesNotContain("ext.Generic(\"seed\")!!", printed)
    }

    /// Negative/scope control: the SAME oblivious external member assigned via
    /// a COMPOUND assignment (`+=`). Scoped out deliberately — a compound
    /// assignment's RHS is a distinct shape (also flows through
    /// `CoerceCompoundAssignmentRhs`'s numeric-coercion logic) and is not
    /// addressed by this fix.
    @Fact
    func CompoundAssignment_IsNotForgiven_ScopeControl() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = "seed";
            result += ext.Combine("hello");
            System.Console.WriteLine(result);
        }
    }
}`)
        Assert.Contains("result += ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed)
    }

    /// Negative/scope control: an already nullable-annotated target (`string?
    /// result`) accepts the oblivious RHS unchanged — nothing to forgive.
    @Fact
    func NullableAnnotatedTarget_IsNotForgiven_ScopeControl() {
        let printed = TranslateObliviousWithAnnotatedTargetLibrary(`
namespace Demo
{
#nullable enable
    public class C
    {
        public void Format(ExtLib ext, string? result)
        {
            result = ext.Combine("hello");
            System.Console.WriteLine(result);
        }
    }
#nullable disable
}`)
        Assert.Contains("result = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("ext.Combine(\"hello\")!!", printed)
    }

    /// Negative/scope control: a SAME-PROJECT (source) member RHS must not be
    /// touched by this fix — only an EXTERNAL (metadata) oblivious member
    /// qualifies.
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
        public void Format(Helper h)
        {
            string result = "seed";
            result = h.Get();
            System.Console.WriteLine(result);
        }
    }
}`)
        Assert.Contains("result = h.Get()", printed)
        Assert.DoesNotContain("h.Get()!!", printed)
    }

    /// Negative test: the SAME external library but compiled WITH nullable
    /// annotations enabled — a genuinely `string?`-returning method is a
    /// real, deliberate nullability that must be preserved, not papered over
    /// with a blind assignment `!!`.
    @Fact
    func AnnotatedExternalNullableReturn_IsNotForgiven() {
        let printed = TranslateObliviousWithAnnotatedLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(AnnotatedLib lib)
        {
            string result = "seed";
            result = lib.MaybeNull();
            System.Console.WriteLine(result);
        }
    }
}`)
        Assert.Contains("result = lib.MaybeNull()", printed)
        Assert.DoesNotContain("lib.MaybeNull()!!", printed)
    }

    /// A nullable-enabled consumer of a nullable-oblivious producer gets the same
    /// result: gsc used to import the unannotated return as `T?` regardless of
    /// the consumer's context, and now imports it as `T!`, so the assignment
    /// carries no `!!`.
    @Fact
    func NullableEnabledCompilation_IsForgiven() {
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Format(ExtLib ext)
        {
            string result = "seed";
            result = ext.Combine("hello");
            System.Console.WriteLine(result);
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("result = ext.Combine(\"hello\")!!", printed)
    }

    /// Positive/scope control: the target local's `var` ORIGIN does not block
    /// the assignment-side fix — unlike #2425 (scoped to explicit-typed
    /// DECLARATIONS), this fix operates on an already-established local's
    /// type (inferred or explicit), which is the same non-null `string`
    /// either way by the time a later reassignment is translated.
    @Fact
    func VarLocalOrigin_StillForgivenAtAssignment() {
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            var result = "seed";
            result = ext.Combine("hello");
            return result;
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("result = ext.Combine(\"hello\")", printed)
        Assert.DoesNotContain("result = ext.Combine(\"hello\")!!", printed)
    }

    /// Direct-return/local-initializer parity: a reassignment-then-return and
    /// a direct return of the identical call agree, and neither needs a
    /// `!!` for the oblivious external member (both used to carry exactly
    /// one, with no second one at the later return).
    @Fact
    func ReassignmentThenReturn_MatchesDirectReturnForgivenessCount() {
        let viaReassignment = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Format(ExtLib ext)
        {
            string result = "seed";
            result = ext.Combine("hello");
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
        // ADR-0186 step 6 (PR 0): both shapes still agree. Neither needs a
        // `!!` now: gsc reads the oblivious metadata result as `T!` and
        // checks it at the non-null coercion itself.
        Assert.Equal(0, CountForgiveness(viaReassignment))
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
    public static string AsUncIfLong(this string path)
    {
        return path;
    }

    public static string ToUrlBase64String(this byte[] bytes)
    {
        return System.Convert.ToBase64String(bytes);
    }
}
`
            let libRef = CompileObliviousLibrary(LibSource, "Issue2427ObliviousExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2427.ObliviousExternalAssignmentInMemory",
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

        /// Same oblivious external library, but the CONSUMING snippet declares its
        /// own reassignment target with an explicit nullable-annotated (`#nullable
        /// enable`) parameter type — used for the already-nullable-target scope
        /// control.
        private func TranslateObliviousWithAnnotatedTargetLibrary(source string) string {
            const LibSource = `
public class ExtLib
{
    public string Combine(string separator) { return separator; }
}
`
            let libRef = CompileObliviousLibrary(LibSource, "Issue2427ObliviousExtLibForAnnotatedTarget")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2427.AnnotatedTargetInMemory",
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
            let libRef = CompileAnnotatedLibrary(LibSource, "Issue2427AnnotatedExtLib")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2427.AnnotatedExternalReturnInMemory",
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
            let libRef = CompileObliviousLibrary(LibSource, "Issue2427ObliviousExtLibForEnabled")
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2427.EnabledCallingObliviousInMemory",
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
