// <copyright file="Issue4769NullableSelectorObservationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

@Collection("IlVerifyPipeline")
class Issue4769NullableSelectorObservationTests {
    @Theory
    @InlineData("Any(value => value is string text && text.Length == 2)", "True|3")
    @InlineData("All(value => value is string text && text.Length == 2)", "False|1")
    @InlineData("Where(value => value is string text && text.Length == 2).Count()", "1|3")
    @InlineData("FirstOrDefault(value => value is string text && text.Length == 2) != null", "True|3")
    @InlineData("Any(value => value is null)", "True|1")
    @InlineData("All(value => value is not null)", "False|1")
    func InferredSelector_NullObservingPredicate_PreservesNullAndEvaluationOrder(consumer string, expected string) {
        let source = `using System;
using System.Linq;
namespace Issue4769
{
    public static class Probe
    {
        private static int calls;
#nullable enable
        private static object? Read(int value)
        {
            calls++;
            return value == 0 ? null : value == 1 ? (object)7 : "ok";
        }
#nullable restore
        public static string Run()
        {
            calls = 0;
            var result = new[] { 0, 1, 2 }.Select(value => Read(value)).` + consumer + `            ;
            return result + "|" + calls;
        }
    }
}`
        let project = Load(source)
        AssertNativeAndMigrated(
            project,
            (assembly Assembly) -> {
                let probe Type? = assembly.GetType("Issue4769.Probe")
                Assert.NotNull(probe)
                Assert.Equal(expected, probe!!.GetMethod("Run")!!.Invoke(nil, nil))
            }
        )
    }

    @Theory
    @InlineData("class C { int M() { int Visit(int n) => n == 0 ? 1 : Visit(n - 1); return Visit(2); } }", false, false)
    @InlineData(
        "class C<T> { T M(T value) { T Visit(int n) => n == 0 ? value : Visit(n - 1); return Visit(2); } }",
        false,
        false
    )
    @InlineData(
        "class C<T> { T M(T value) { T Visit(int n) => n == 0 ? value : Visit(n - 1); return Visit(2); } }",
        true,
        true
    )
    @InlineData(
        "class C { U M<U>(U value) { U Visit(int n) => n == 0 ? value : Visit(n - 1); return Visit(2); } }",
        false,
        true
    )
    @InlineData("class C<T> { int M() { int Visit(int n) => nameof(T).Length; return Visit(2); } }", true, false)
    @InlineData(
        "class C<T> { private int Read() => 7; int M() { int Visit(int n) => Read(); return Visit(2); } }",
        true,
        true
    )
    func MigratedOriginalRecursiveLiftQuery_HandlesUnboundNodesAndOwnerTypeParameters(
        input string,
        includeContainingTypeParameters bool,
        expected bool
    ) {
        let inputProject = Load(input)
        let inputDocument = Assert.Single(inputProject.Documents)
        let candidateSyntax = Assert.Single(
            inputDocument.SyntaxTree.GetRoot().DescendantNodes().OfType[LocalFunctionStatementSyntax]()
        )
        let candidateSymbol = Assert.IsAssignableFrom[IMethodSymbol](
            inputDocument.SemanticModel.GetDeclaredSymbol(candidateSyntax)
        )
        Assert.Contains(
            candidateSyntax.DescendantNodes(),
            (node SyntaxNode) -> inputDocument.SemanticModel.GetSymbolInfo(node).Symbol == nil
        )
        // Compile the real production query and its helpers, not a hand-kept port.
        let constructors = File.ReadAllText(
            TestFixtureSource.Resolve(
                "tools",
                "cs2gs",
                "Cs2Gs.Translator",
                "CSharpToGSharpTranslator.Constructors.cs"
            )!!
        )
        let invocations = File.ReadAllText(
            TestFixtureSource.Resolve("tools", "cs2gs", "Cs2Gs.Translator", "CSharpToGSharpTranslator.Invocations.cs")!!
        )
        let constructorRoot = CSharpSyntaxTree.ParseText(constructors).GetRoot()
        let query = Assert.Single(
            constructorRoot.DescendantNodes().OfType[LocalFunctionStatementSyntax](),
            (node LocalFunctionStatementSyntax) -> node.Identifier.ValueText == "ReferencesEnclosingTypeParameter"
        )
            .ToFullString()
        let insideNameOf = Assert.Single(
            constructorRoot.DescendantNodes().OfType[LocalFunctionStatementSyntax](),
            (node LocalFunctionStatementSyntax) -> node.Identifier.ValueText == "IsInsideNameOf"
        )
            .ToFullString()
        let containsTypeParameter = Assert.Single(
            CSharpSyntaxTree.ParseText(invocations).GetRoot().DescendantNodes().OfType[MethodDeclarationSyntax](),
            (node MethodDeclarationSyntax) -> node.Identifier.ValueText == "TypeContainsTypeParameter"
        )
            .ToFullString()
        let source = `using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.Translator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
namespace Issue4769
{
    public sealed class Query
    {
        private readonly TranslationContext context;
        public Query(TranslationContext context) { this.context = context; }
        public bool Run(
            (LocalFunctionStatementSyntax Syntax, IMethodSymbol Symbol) candidate,
            bool includeContainingTypeParameters)
        {` + insideNameOf + query + "            return ReferencesEnclosingTypeParameter(candidate, includeContainingTypeParameters);\n        }" + containsTypeParameter + "    }\n}"
        let project = Load(source)
        AssertNativeAndMigrated(
            project,
            (assembly Assembly) -> {
                let queryType Type? = assembly.GetType("Issue4769.Query")
                Assert.NotNull(queryType)
                let context = TranslationContext(
                    inputProject.Compilation,
                    inputDocument.SemanticModel,
                    inputDocument.FilePath
                )
                let queryInstance object? = Activator.CreateInstance(queryType!!, context)
                Assert.Equal(
                    expected,
                    queryType!!.GetMethod("Run")!!.Invoke(
                        queryInstance,
                        []object{(candidateSyntax, candidateSymbol), includeContainingTypeParameters}
                    )
                )
            },
            assertMetadata: (assembly Assembly) -> {
                let selector = Assert.Single(
                    assembly.GetTypes().SelectMany(
                        func (type Type) IEnumerable[MethodInfo] {
                            return type.GetMethods()
                        }
                    ),
                    (method MethodInfo) -> method.Name == "Invoke" && method.ReturnType == typeof(ISymbol)
                )
                Assert.Equal(
                    NullabilityState.Nullable,
                    NullabilityInfoContext().Create(selector.ReturnParameter).ReadState
                )
                Assert.Equal(typeof(SyntaxNode), Assert.Single(selector.GetParameters()).ParameterType)
            }
        )
    }

    shared {
        private func Load(source string) LoadedCSharpProject {
            let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Concat(
                []PortableExecutableReference{
                    MetadataReference.CreateFromFile(typeof(SyntaxNode).Assembly.Location),
                    MetadataReference.CreateFromFile(typeof(CSharpCompilation).Assembly.Location),
                    MetadataReference.CreateFromFile(typeof(TranslationContext).Assembly.Location),
                    MetadataReference.CreateFromFile(typeof(TypeSymbol).Assembly.Location)
                }
            )
                .DistinctBy((reference MetadataReference) -> reference.Display!!)
                .ToArray()
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("SelectorObservation.cs", source)},
                references,
                "Issue4769.Native"
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            return project
        }

        private func AssertNativeAndMigrated(
            project LoadedCSharpProject,
            assert(Assembly) -> void,
            assertMetadata((Assembly) -> void)? = nil
        ) {
            using let image = MemoryStream()
            let emitted = project.Compilation.Emit(image)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            Assert.True(image.Length > int64(0))
            assert(EmittedFixture.Load(image.ToArray()))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
            Assert.NotNull(compiler)
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4769NullableSelectorObservationTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let source = Path.Combine(directory, "Query.gs")
                let assembly = Path.Combine(directory, "Query.dll")
                let nativeAssembly = Path.Combine(directory, "Native.dll")
                File.WriteAllBytes(nativeAssembly, image.ToArray())
                File.WriteAllText(source, printed)
                let references = project
                    .Compilation
                    .References
                    .OfType[PortableExecutableReference]()
                    .Select((reference PortableExecutableReference) -> reference.FilePath)
                    .Where((path string) -> path != nil)
                    .ToArray()
                AssertStrictIl(nativeAssembly, references)
                let compiled = GscInvoker(compiler!!).Compile(
                    []string{source},
                    assembly,
                    TargetKind.Library,
                    references
                )
                Assert.True(compiled.ExitCode == 0, compiled.Output + Environment.NewLine + printed)
                Assert.True(File.Exists(assembly), compiled.Output)
                AssertStrictIl(assembly, references)
                let migrated = EmittedFixture.Load(assembly)
                let failure Exception? = Record.Exception(() -> assert(migrated))
                Assert.True(
                    failure == nil,
                    "Migrated CLR execution must match the native control: " + failure?.ToString()
                )
                assertMetadata?(migrated)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func AssertStrictIl(assembly string, references IEnumerable[string]) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            for reference in references {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let result = ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }
    }
}
