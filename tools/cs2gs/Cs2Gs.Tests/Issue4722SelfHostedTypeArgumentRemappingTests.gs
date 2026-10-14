// <copyright file="Issue4722SelfHostedTypeArgumentRemappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import Xunit
import Xunit.Abstractions

class Issue4722SelfHostedTypeArgumentRemappingTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func ActualRemappingMethods_CompileVerifyAndPreserveImportedContracts() {
        let path = Path.Combine(
            GsharpTestProjectRunner.FindRepoRoot()!!,
            "tools",
            "cs2gs",
            "Cs2Gs.Translator",
            "ObliviousNullabilityAnalyzer.cs"
        )
        let original = File.ReadAllText(path)
        let root = CSharpSyntaxTree.ParseText(original).GetRoot()
        let methods = root
            .DescendantNodes()
            .OfType[MethodDeclarationSyntax]()
            .Where(
            (method MethodDeclarationSyntax) -> (
                method.Identifier.ValueText is "RemapToCompilation" or "RemapSourceDeclaration" or "RemapMemberOwner"
            )
        )
            .ToArray()
        Assert.Equal(3, methods.Length)
        let sourceTrees = Assert.Single(
            root.DescendantNodes().OfType[FieldDeclarationSyntax](),
            (field FieldDeclarationSyntax) -> field
                .Declaration
                .Variables
                .Any((variable VariableDeclaratorSyntax) -> variable.Identifier.ValueText == "SourceTrees")
        )
        let source = `using System;
using System.Collections.Generic;
using System.Linq;
using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
#nullable disable
namespace RootRemapping;
public static class Remapper {
    public static ISymbol Remap(Compilation target, ISymbol symbol) =>
        RemapToCompilation(target, symbol);` + sourceTrees.ToFullString() + string.Join(
            Environment.NewLine,
            methods.Select((method MethodDeclarationSyntax) -> method.ToFullString())
        ) +
            "\n}"
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Concat(
            []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(Compilation).Assembly.Location)}
        )
            .ToArray()
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ActualRemapping.cs", source)},
            references,
            "RootRemappingNative"
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "issue4722-selfhost",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            File.WriteAllText(Path.Combine(directory, "ActualRemapping.cs"), source)
            let gs = Path.Combine(directory, "ActualRemapping.gs")
            File.WriteAllText(gs, printed)
            let native = Path.Combine(directory, "RootRemappingNative.dll")
            let emitted = project
                .Compilation
                .WithOptions(project.Compilation.Options.WithDeterministic(true))
                .Emit(native)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            this.output.WriteLine(
                "Actual production source SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
            )
            this.output.WriteLine(
                "Actual extracted methods SHA256=" + Convert.ToHexString(
                    SHA256.HashData(File.ReadAllBytes(Path.ChangeExtension(gs, ".cs")))
                )
            )
            let translated = Path.Combine(directory, "RootRemappingTranslated.dll")
            let runtimeReferences = references
                .OfType[PortableExecutableReference]()
                .Select((reference PortableExecutableReference) -> reference.FilePath!!)
                .ToArray()
            let args = List[string]{
                LocalFunctionHoistTranslationTests.FindCompiler()!!,
                "/target:library",
                "/out:" + translated
            }
            args.AddRange(runtimeReferences.Select((reference string) -> ("/r:" + reference)))
            args.Add(gs)
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", args))
            let compiled = ProcessRunner.Run("dotnet", args)
            this.output.WriteLine(compiled.Output)
            Assert.False(compiled.TimedOut, compiled.Output)
            Assert.Equal(0, compiled.ExitCode)
            for image in[]string{native, translated} {
                let verify = List[string]{"tool", "run", "ilverify", image, "-s", "System.Private.CoreLib"}
                verify.AddRange(
                    runtimeReferences.SelectMany(
                        func (reference string) IEnumerable[string] {
                            return []string{"-r", reference}
                        }
                    )
                )
                this.output.WriteLine("UNSUPPRESSED STRICT: dotnet " + string.Join(" ", verify))
                let verified = ProcessRunner.Run("dotnet", verify, IlVerifyRunner().RepoRoot)
                this.output.WriteLine(verified.Output)
                Assert.False(verified.TimedOut, verified.Output)
                Assert.Equal(0, verified.ExitCode)
                this.AssertImportedContracts(EmittedFixture.Load(image), directory)
                this.output.WriteLine(Path.GetFileName(image) + " actual CLR imported-contract controls passed")
            }
        } finally {
            let evidence string? = Environment.GetEnvironmentVariable("GSHARP_ISSUE4722_SELFHOST_EVIDENCE")
            if !string.IsNullOrEmpty(evidence) {
                let destination = Path.Combine(evidence, Path.GetFileName(directory))
                Directory.CreateDirectory(destination)
                for file in Directory.EnumerateFiles(directory) {
                    File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), overwrite: true)
                }
            }
            Directory.Delete(directory, recursive: true)
        }
    }

    private func AssertImportedContracts(remapper Assembly, directory string) {
        const contract = `#nullable enable
public sealed partial class Outer<T>(T primary) {
    public T Primary => primary;
    public sealed class Rows<U> {
        public U Read(ref T value) => default!;
        public V Read<V>(ref U value, V replacement) => replacement;
    }
}
public sealed record Snapshot(string? Value);
public static class SharedLocals {
    public static string? Run(string? value) {
        string? local = value;
        T Echo<T>(T item) => item;
        return Echo(local);
    }
#if !TARGET
    public static string? Conditional(string? value) {
        string? conditional = value;
        return conditional;
    }
#endif
}
public sealed class Consumer { public Outer<string?>.Rows<(string? Value, int Code)> Value; }`
        let native = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                ("NativePart.cs", "public sealed partial class Outer<T> { }"),
                ("Contracts.cs", contract)
            },
            CSharpProjectLoader.RuntimeReferences(),
            "RemappingContracts"
        )
        Assert.True(native.BoundWithoutErrors, string.Join(Environment.NewLine, native.ErrorDiagnostics))
        let image = Path.Combine(directory, "RemappingContracts.dll")
        File.WriteAllText(Path.Combine(directory, "Contracts.cs"), contract)
        let emitted = native.Compilation.Emit(image)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        this.output.WriteLine(
            "Explicit Roslyn imported contract SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(image)))
        )
        let target = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Target.cs", "public sealed class Target { }")},
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(image)).ToArray()
        )
        Assert.True(target.BoundWithoutErrors, string.Join(Environment.NewLine, target.ErrorDiagnostics))
        let linkedTarget = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                ("LinkedPart.cs", "public sealed partial class Outer<T> { }"),
                ("Contracts.cs", contract)
            },
            CSharpProjectLoader.RuntimeReferences(),
            "LinkedRemappingContracts"
        )
        Assert.True(linkedTarget.BoundWithoutErrors, string.Join(Environment.NewLine, linkedTarget.ErrorDiagnostics))
        let input = Assert.IsAssignableFrom[INamedTypeSymbol](
            Assert.Single(
                native.Compilation.GetTypeByMetadataName("Consumer")!!.GetMembers("Value").OfType[IFieldSymbol]()
            )
                .Type
        )
        let type Type? = remapper.GetType("RootRemapping.Remapper")
        Assert.NotNull(type)
        let method MethodInfo? = type!!.GetMethod("Remap")
        Assert.NotNull(method)
        let targets = [](Compilation CSharpCompilation, ExpectedAssembly AssemblyIdentity){
            (Compilation: target.Compilation, ExpectedAssembly: native.Compilation.Assembly.Identity),
            (Compilation: linkedTarget.Compilation, ExpectedAssembly: linkedTarget.Compilation.Assembly.Identity)
        }
        for remappingTarget in targets {
            let mapped = Assert.IsAssignableFrom[INamedTypeSymbol](
                method!!.Invoke(nil, []object{remappingTarget.Item1, input})
            )
            Assert.Equal(
                Microsoft.CodeAnalysis.NullableAnnotation.Annotated,
                Assert.Single(mapped.ContainingType.TypeArguments).NullableAnnotation
            )
            let tuple = Assert.IsAssignableFrom[INamedTypeSymbol](Assert.Single(mapped.TypeArguments))
            Assert.True(tuple.IsTupleType)
            Assert.Equal(
                Microsoft.CodeAnalysis.NullableAnnotation.Annotated,
                tuple.TupleElements[0].Type.NullableAnnotation
            )
            Assert.Equal(SpecialType.System_Int32, tuple.TupleElements[1].Type.SpecialType)
            Assert.Equal(remappingTarget.Item2, mapped.ContainingAssembly.Identity)
            let members = input.GetMembers("Read").OfType[IMethodSymbol]().ToArray()
            Assert.Equal(2, members.Length)
            for member in members {
                let constructed = if member.Arity == 0 {
                    member
                } else {
                    member.Construct(
                        native
                            .Compilation
                            .GetSpecialType(SpecialType.System_String)
                            .WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
                    )
                }
                let result = Assert.IsAssignableFrom[IMethodSymbol](
                    method!!.Invoke(nil, []object{remappingTarget.Item1, constructed})
                )
                Assert.Equal(RefKind.Ref, result.Parameters[0].RefKind)
                Assert.Equal(
                    constructed.OriginalDefinition.GetDocumentationCommentId(),
                    result.OriginalDefinition.GetDocumentationCommentId()
                )
                let parameter = Assert.IsAssignableFrom[IParameterSymbol](
                    method!!.Invoke(nil, []object{remappingTarget.Item1, constructed.Parameters[0]})
                )
                Assert.True(SymbolEqualityComparer.Default.Equals(result.Parameters[0], parameter))
                if result.Arity != 0 {
                    Assert.Equal(
                        Microsoft.CodeAnalysis.NullableAnnotation.Annotated,
                        Assert.Single(result.TypeArguments).NullableAnnotation
                    )
                    Assert.Equal(
                        Microsoft.CodeAnalysis.NullableAnnotation.Annotated,
                        result.ReturnType.NullableAnnotation
                    )
                }
            }
            let outer INamedTypeSymbol? = native.Compilation.GetTypeByMetadataName("Outer`1")
            let primaryConstructor = Assert.Single(
                outer!!.InstanceConstructors,
                (constructor IMethodSymbol) -> constructor.Parameters.Any(
                    (parameter IParameterSymbol) -> parameter.Name == "primary"
                )
            )
            let remappedPrimaryConstructor = Assert.IsAssignableFrom[IMethodSymbol](
                method!!.Invoke(nil, []object{remappingTarget.Item1, primaryConstructor})
            )
            Assert.Equal(MethodKind.Constructor, remappedPrimaryConstructor.MethodKind)
            let primary = Assert.Single(primaryConstructor.Parameters)
            let remappedPrimary = Assert.IsAssignableFrom[IParameterSymbol](
                method!!.Invoke(nil, []object{remappingTarget.Item1, primary})
            )
            Assert.Equal(primary.Name, remappedPrimary.Name)
            let snapshot INamedTypeSymbol? = native.Compilation.GetTypeByMetadataName("Snapshot")
            let positional = Assert.Single(
                Assert.Single(
                    snapshot!!.InstanceConstructors,
                    (constructor IMethodSymbol) -> constructor.Parameters.Any(
                        (parameter IParameterSymbol) -> parameter.Name == "Value"
                    )
                )
                    .Parameters
            )
            let remappedPositional = Assert.IsAssignableFrom[IParameterSymbol](
                method!!.Invoke(nil, []object{remappingTarget.Item1, positional})
            )
            Assert.Equal(positional.Name, remappedPositional.Name)
            let positionalProperty = Assert.Single(snapshot!!.GetMembers("Value").OfType[IPropertySymbol]())
            let remappedPositionalProperty = Assert.IsAssignableFrom[IPropertySymbol](
                method!!.Invoke(nil, []object{remappingTarget.Item1, positionalProperty})
            )
            Assert.Equal(positionalProperty.Name, remappedPositionalProperty.Name)
        }
        let contractDocument = Assert.Single(
            native.Documents,
            (document LoadedDocument) -> document.FilePath == "Contracts.cs"
        )
        let contractRoot = contractDocument.SemanticModel.SyntaxTree.GetRoot()
        let local = Assert.IsAssignableFrom[ILocalSymbol](
            contractDocument.SemanticModel.GetDeclaredSymbol(
                Assert.Single(
                    contractRoot.DescendantNodes().OfType[VariableDeclaratorSyntax](),
                    (declaration VariableDeclaratorSyntax) -> declaration.Identifier.ValueText == "local"
                )
            )
        )
        let localFunction = Assert.IsAssignableFrom[IMethodSymbol](
            contractDocument.SemanticModel.GetDeclaredSymbol(
                Assert.Single(contractRoot.DescendantNodes().OfType[LocalFunctionStatementSyntax]())
            )
        )
        Assert.IsAssignableFrom[ILocalSymbol](method!!.Invoke(nil, []object{linkedTarget.Compilation, local}))
        Assert.IsAssignableFrom[IMethodSymbol](method!!.Invoke(nil, []object{linkedTarget.Compilation, localFunction}))
        let constructedLocalFunction = localFunction.Construct(
            native
                .Compilation
                .GetSpecialType(SpecialType.System_String)
                .WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
        )
        let remappedConstructedLocalFunction = Assert.IsAssignableFrom[IMethodSymbol](
            method!!.Invoke(nil, []object{linkedTarget.Compilation, constructedLocalFunction})
        )
        Assert.Equal(
            Microsoft.CodeAnalysis.NullableAnnotation.Annotated,
            Assert.Single(remappedConstructedLocalFunction.TypeArguments).NullableAnnotation
        )
        let conditional = Assert.IsAssignableFrom[ILocalSymbol](
            contractDocument.SemanticModel.GetDeclaredSymbol(
                Assert.Single(
                    contractRoot.DescendantNodes().OfType[VariableDeclaratorSyntax](),
                    (declaration VariableDeclaratorSyntax) -> declaration.Identifier.ValueText == "conditional"
                )
            )
        )
        let linkedContractTree = Assert.Single(
            linkedTarget.Compilation.SyntaxTrees,
            (tree SyntaxTree) -> tree.FilePath == "Contracts.cs"
        )
        let preprocessedTree = CSharpSyntaxTree.ParseText(
            contract,
            CSharpParseOptions(LanguageVersion.Latest, preprocessorSymbols: []string{"TARGET"}),
            path: "Contracts.cs"
        )
        let preprocessedTarget = linkedTarget.Compilation.ReplaceSyntaxTree(linkedContractTree, preprocessedTree)
        Assert.Null(method!!.Invoke(nil, []object{preprocessedTarget, conditional}))
        let caseVariantTree = CSharpSyntaxTree.ParseText(
            contract,
            CSharpParseOptions(LanguageVersion.Latest),
            path: "contracts.cs"
        )
        let caseVariantTarget = linkedTarget.Compilation.ReplaceSyntaxTree(linkedContractTree, caseVariantTree)
        let caseVariantResult object? = method!!.Invoke(nil, []object{caseVariantTarget, input})
        if OperatingSystem.IsWindows() {
            Assert.IsAssignableFrom[INamedTypeSymbol](caseVariantResult)
        } else {
            Assert.Null(caseVariantResult)
        }
        let duplicatePathTree = CSharpSyntaxTree.ParseText(
            "public sealed class Collision { }",
            CSharpParseOptions(LanguageVersion.Latest),
            path: "Contracts.cs"
        )
        let duplicatePathTarget = linkedTarget
            .Compilation
            .RemoveSyntaxTrees(linkedContractTree)
            .AddSyntaxTrees(duplicatePathTree, linkedContractTree)
        Assert.IsAssignableFrom[INamedTypeSymbol](method!!.Invoke(nil, []object{duplicatePathTarget, input}))
        let unrelated = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Unrelated.cs", "public sealed class Unrelated { }")}
        )
        Assert.Null(method!!.Invoke(nil, []object{unrelated.Compilation, input}))
    }
}
