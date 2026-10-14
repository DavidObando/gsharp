// <copyright file="Issue914ObliviousTypeParameterReturnPromotionTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #914 (Oahu.Foundation oblivious
/// deferred-return-promotion): the whole-program oblivious taint analysis
/// ((cref:ObliviousNullabilityAnalyzer)) now also promotes a
/// <em>reference-constrained</em> type-parameter position (`where T : class`)
/// to `T?` when it is null-tainted. Previously #2113 excluded ALL type
/// parameters, so a generic method like
/// `T DeserializeJsonFile<T>() where T : class { … return null; }`
/// kept a non-null `T` return and its `return null` / `T?` flow
/// collided with the non-null return (GS0129 `T == nil`, GS0155 `nil`/
/// `T?` → `T`). Unconstrained type parameters remain excluded because
/// their `IsReferenceType` is `false` and `T?` would mean
/// `Nullable<T>`.
open class Issue914ObliviousTypeParameterReturnPromotionTests {
    @Fact
    func Oblivious_NullReturningReferenceConstrainedTypeParam_RendersNullableReturn() {
        // `Deserialize` returns null on a path and `T : class`, so its return is a
        // well-defined nullable reference `T?`. Without promotion, `return null`
        // is GS0155 "cannot convert nil to T".
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public T Deserialize<T>(bool b) where T : class, new()
        {
            if (b) { return null; }
            return new T();
        }
    }
}`)
        Assert.Contains("Deserialize[T class init()](b bool) T?", printed)
    }

    @Fact
    func Oblivious_TaintedTypeParamLocal_RendersNullableLocalAndFlows() {
        // `settings` is assigned `x as T` (nullable) and null-checked, so it is
        // T? locally; when it also flows to the return, the tainted return is
        // promoted to `T?` too — mirroring Oahu.Foundation SettingsManager.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        private object cached;

        public T Get<T>() where T : class, new()
        {
            var settings = this.cached as T;
            if (settings == null)
            {
                settings = new T();
            }
            return settings;
        }
    }
}`)
        Assert.Contains("settings T?", printed)
    }

    @Fact
    func Oblivious_UnconstrainedTypeParam_StaysNonNull() {
        // Without a `class` constraint, `T` may be a value type, so `T?` would
        // mean `Nullable<T>`. The analysis must NOT promote it — the return stays
        // bare `T` (the `return default` is faithful to the C# default(T)).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public T OrDefault<T>(bool b, T value)
        {
            if (b) { return value; }
            return default;
        }
    }
}`)
        Assert.Contains("OrDefault[T](b bool, value T) T", printed)
        Assert.DoesNotContain("OrDefault[T](b bool, value T) T?", printed)
    }

    @Fact
    func NullableEnabled_ReferenceConstrainedTypeParam_Unchanged() {
        // In a nullable-ENABLED compilation the oblivious analysis must not run:
        // a declared non-null `T` return stays `T` (the `return null!` is the
        // developer's explicit suppression, not a promotion trigger).
        let printed = TranslateEnabled(`
namespace Demo
{
    public class C
    {
        public T Make<T>() where T : class, new()
        {
            return new T();
        }
    }
}`)
        Assert.Contains("Make[T class init()]() T", printed)
        Assert.DoesNotContain("Make[T class init()]() T?", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.EnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
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

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
