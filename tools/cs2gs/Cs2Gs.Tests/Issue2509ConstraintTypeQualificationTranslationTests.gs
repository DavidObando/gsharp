// <copyright file="Issue2509ConstraintTypeQualificationTranslationTests.cs" company="GSharp">
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

/// Issue #2509: every class/interface constraint type must use the same
/// semantic, collision-aware type mapper as generic constraints and ordinary
/// type positions.
class Issue2509ConstraintTypeQualificationTranslationTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceHomonyms_AllDeclarationKinds_KeepExactConstraintIdentity(reverseTypeFileOrder bool) {
        let first(FileName string, Source string) = ("A.cs", `namespace A
{
    public interface IContract { }
    public interface IGeneric<T> { }
    public class Base { }
    public static class Outer
    {
        public interface IContract { }
    }
}`)
        let second(FileName string, Source string) = ("B.cs", `namespace B
{
    public interface IContract { }
    public interface IGeneric<T> { }
    public class Base { }
    public static class Outer
    {
        public interface IContract { }
    }
}`)
        let sources = if reverseTypeFileOrder {
            [](string, string){second, first, ("Caller.cs", CallerSource)}
        } else {
            [](string, string){first, second, ("Caller.cs", CallerSource)}
        }
        let (printed, context) = TranslateInMemory(sources, "Caller.cs")
        Assert.Contains("class BaseHost[T A.Base]", printed, StringComparison.Ordinal)
        Assert.Contains("interface InterfaceHost[T A.IContract]", printed, StringComparison.Ordinal)
        Assert.Contains("delegate Handler[T A.IContract](", printed, StringComparison.Ordinal)
        Assert.Contains("func Generic[T A.IGeneric[T]]", printed, StringComparison.Ordinal)
        Assert.Contains("func Nested[T A.Outer.IContract]", printed, StringComparison.Ordinal)
        Assert.Contains("func Multiple[T A.Base init()]", printed, StringComparison.Ordinal)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Message!!.Contains(
                "multiple constraint types; only the first ('A.Base')",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func MetadataConstraint_WithSourceHomonym_UsesQualifiedSemanticIdentity() {
        let contractReference = CompileLibrary(`namespace A
{
    public interface IContract { }
}`, "Issue2509MetadataA")
        const SourceHomonym = `namespace B
{
    public interface IContract { }
}`
        const Caller = `using Contract = A.IContract;

namespace App
{
    public static class Repro
    {
        public static void Add<T>() where T : class, Contract, new() { }
        public static B.IContract GetOther() => null;
    }
}`
        let printed = TranslateWithReferences(
            [](string, string){("B.cs", SourceHomonym), ("Caller.cs", Caller)},
            "Caller.cs",
            contractReference
        )
        Assert.Contains("func Add[T A.IContract class init()]", printed, StringComparison.Ordinal)
    }

    @Fact
    func MetadataConstraint_WithMetadataHomonym_UsesQualifiedSemanticIdentity() {
        let first = CompileLibrary(`namespace A
{
    public interface IContract { }
}`, "Issue2509MetadataFirst")
        let second = CompileLibrary(`namespace B
{
    public interface IContract { }
}`, "Issue2509MetadataSecond")
        const Caller = `using A;

namespace App
{
    public static class Repro
    {
        public static void Add<T>() where T : IContract { }
        public static B.IContract GetOther() => null;
    }
}`
        let printed = TranslateWithReferences(
            [](string, Caller string){("Caller.cs", Caller)},
            "Caller.cs",
            first,
            second
        )
        Assert.Contains("func Add[T A.IContract]", printed, StringComparison.Ordinal)
    }

    @Fact
    func NestedMetadataConstraint_WithCollidingOutermostTypes_UsesNamespaceQualification() {
        let first = CompileLibrary(`namespace A
{
    public static class Outer
    {
        public interface IContract { }
    }
}`, "Issue2509NestedMetadataFirst")
        let second = CompileLibrary(`namespace B
{
    public static class Outer
    {
        public interface IContract { }
    }
}`, "Issue2509NestedMetadataSecond")
        const Caller = `using A;

namespace App
{
    public static class Repro
    {
        public static void Add<T>() where T : Outer.IContract { }
        public static B.Outer.IContract GetOther() => null;
    }
}`
        let printed = TranslateWithReferences(
            [](string, Caller string){("Caller.cs", Caller)},
            "Caller.cs",
            first,
            second
        )
        Assert.Contains("func Add[T A.Outer.IContract]", printed, StringComparison.Ordinal)
    }

    @Fact
    func NullableConstraintAnnotation_IsAuditedAndDroppedFromUnsupportedConstraintSlot() {
        let (printed, context) = TranslateInMemory([](string, string){("Caller.cs", `#nullable enable
namespace Solo
{
    public interface IContract { }
    public sealed class Holder<T> where T : IContract? { }
}`)}, "Caller.cs")
        Assert.Contains("class Holder[T IContract]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("IContract?", printed, StringComparison.Ordinal)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Message!!.Contains(
                "generic-constraint slot has no nullable form",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func NoCollision_NonGenericConstraint_RemainsShort() {
        let (printed, _) = TranslateInMemory([](string, string){("Caller.cs", `namespace Solo
{
    public interface IContract { }
    public sealed class Holder<T> where T : IContract { }
}`)}, "Caller.cs")
        Assert.Contains("class Holder[T IContract]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Solo.IContract", printed, StringComparison.Ordinal)
    }

    shared {
        private const CallerSource string = `using A;
using Contract = A.IContract;

namespace App
{
    public class BaseHost<T> where T : Base { }
    public interface InterfaceHost<T> where T : Contract { }
    public delegate void Handler<T>() where T : IContract;

    public static class Repro
    {
        public static void Generic<T>() where T : IGeneric<T> { }
        public static void Nested<T>() where T : Outer.IContract { }
        public static void Multiple<T>() where T : Base, IContract, new() { }

        public static B.IContract GetOther() => null;
        public static B.IGeneric<int> GetOtherGeneric() => null;
        public static B.Base GetOtherBase() => null;
        public static B.Outer.IContract GetOtherNested() => null;
    }
}`

        private func TranslateInMemory(sources[](FileName string, Source string), targetFile string)(
            Printed string,
            Context TranslationContext
        ) {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(
                project.BoundWithoutErrors,
                "Inline C# should bind without errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let translator = CSharpToGSharpTranslator()
            let translated = project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let unit = translator.TranslateDocument(document, context)
                    return (document.FilePath, Context: context, Printed: GSharpPrinter.Print(unit))
                }
            )
                .ToArray()
            for result in translated {
                let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                    result.Item3,
                    "Binder.BindGlobalScope flattens multi-package fixtures and cannot resolve their qualified source types."
                )
                Assert.True(
                    roundTrip.Success,
                    string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + result.Item3
                )
            }
            let target = translated.Single(
                (result(FilePath string, Context TranslationContext, Printed string)) -> result.Item1.EndsWith(
                    targetFile,
                    StringComparison.Ordinal
                )
            )
            return (target.Item3, target.Item2)
        }

        private func TranslateWithReferences(
            sources[](FileName string, Source string),
            targetFile string,
            additionalReferences ...MetadataReference
        ) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let trees = sources.Select(
                (source(FileName string, Source string)) -> CSharpSyntaxTree.ParseText(
                    source.Source,
                    parseOptions,
                    path: source.FileName
                )
            )
                .ToArray()
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2509.ConstraintQualification",
                trees,
                CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let target = trees.Single((tree SyntaxTree) -> tree.FilePath.EndsWith(targetFile, StringComparison.Ordinal))
            let model = compilation.GetSemanticModel(target)
            let document = LoadedDocument(target.FilePath, target, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidateRoundTripOnly(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidateRoundTripOnly(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Target-only fixture omits source or metadata declarations used solely to test type qualification."
            )
            Assert.True(
                roundTrip.Success,
                string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + printed
            )
            return printed
        }

        private func CompileLibrary(source string, assemblyName string) MetadataReference {
            let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = MemoryStream()
            let emit = compilation.Emit(stream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            stream.Position = 0
            return MetadataReference.CreateFromStream(stream)
        }
    }
}
