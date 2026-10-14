// <copyright file="Issue4779NullableReflectionArgumentsSelfMigrationTests.cs" company="GSharp">
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
import System.Security.Cryptography
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

class Issue4779NullableReflectionArgumentsSelfMigrationTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    async func ActualClassifierTestUnit_CompilesAndRunsDefensiveContracts() {
        let root = GsharpTestProjectRunner.FindRepoRoot()!!
        let project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Tests", "Cs2Gs.Tests.csproj")
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(
            project.Documents,
            (candidate LoadedDocument) -> Path.GetFileName(
                candidate.FilePath
            ) == "Issue4770NullableClassifierCoalescingTests.cs"
        )
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context)
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "issue4779",
            Guid.NewGuid().ToString("N")
        )
        let previousRoot string? = Environment.GetEnvironmentVariable(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable
        )
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, "Issue4770NullableClassifierCoalescingTests.gs")
            File.WriteAllText(source, printed)
            File.Copy(document.FilePath, Path.ChangeExtension(source, ".cs"))
            let guardDocument = Assert.Single(
                project.Documents,
                (candidate LoadedDocument) -> Path.GetFileName(
                    candidate.FilePath
                ) == "Issue4779NullableReflectionArgumentsSelfMigrationTests.cs"
            )
            let guardContext = TranslationContext(
                project.Compilation,
                guardDocument.SemanticModel,
                guardDocument.FilePath
            )
            let guardPath = Path.Combine(directory, "Issue4779NullableReflectionArgumentsSelfMigrationTests.gs")
            File.WriteAllText(
                guardPath,
                GSharpPrinter.Print(
                    CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(guardDocument, guardContext)
                )
            )
            Assert.DoesNotContain(
                guardContext.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            File.Copy(guardDocument.FilePath, Path.ChangeExtension(guardPath, ".cs"))
            // Internal source helpers accompany the verbatim test unit instead
            // of relaxing their imported CLR visibility.
            let helperDocument = Assert.Single(
                project.Documents,
                (candidate LoadedDocument) -> Path.GetFileName(
                    candidate.FilePath
                ) == "LocalFunctionHoistTranslationTests.cs"
            )
            let helper = Assert.Single(
                helperDocument.SyntaxTree.GetRoot().DescendantNodes().OfType[MethodDeclarationSyntax](),
                (method MethodDeclarationSyntax) -> method.Identifier.ValueText == "FindCompiler"
            )
            let helperSource = `using System;
using System.IO;
namespace Cs2Gs.Tests;
public class LocalFunctionHoistTranslationTests
{` + helper.ToFullString() + "\n}"
            let helperProject = CSharpProjectLoader.LoadInMemory(
                [](string, helperSource string){("CompilerHelper.cs", helperSource)}
            )
            Assert.True(
                helperProject.BoundWithoutErrors,
                string.Join(Environment.NewLine, helperProject.ErrorDiagnostics)
            )
            let helperUnit = Assert.Single(helperProject.Documents)
            let helperContext = TranslationContext(
                helperProject.Compilation,
                helperUnit.SemanticModel,
                helperUnit.FilePath
            )
            let helperPath = Path.Combine(directory, "CompilerHelper.gs")
            File.WriteAllText(
                helperPath,
                GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(helperUnit, helperContext))
            )
            File.WriteAllText(Path.ChangeExtension(helperPath, ".cs"), helperSource)
            let pipeline = await CSharpProjectLoader.LoadProjectAsync(
                Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Pipeline", "Cs2Gs.Pipeline.csproj")
            )
            Assert.True(pipeline.BoundWithoutErrors, string.Join(Environment.NewLine, pipeline.ErrorDiagnostics))
            let helperPaths = List[string]{helperPath}
            for name in[]string{"GsharpTestProjectRunner.cs", "CanonicalRootPath.cs", "RepositoryRootMarker.cs"} {
                var dependency = Assert.Single(
                    pipeline.Documents,
                    (candidate LoadedDocument) -> Path.GetFileName(candidate.FilePath) == name
                )
                if name == "GsharpTestProjectRunner.cs" {
                    let originalRoot = dependency.GetRoot()
                    let originalType = Assert.Single(
                        originalRoot.DescendantNodes().OfType[ClassDeclarationSyntax](),
                        (type ClassDeclarationSyntax) -> type.Identifier.ValueText == "GsharpTestProjectRunner"
                    )
                    let selectedType = originalType.WithMembers(
                        SyntaxFactory.List(
                            originalType.Members.Where(
                                (member MemberDeclarationSyntax) -> member is MethodDeclarationSyntax method &&
                                    (
                                    method
                                        .Identifier
                                        .ValueText is "FindRepoRoot" or
                                        "FindRepoRootAbove" or
                                        "ResolveConfiguredSourceRoot"
                                ) ||
                                    member is FieldDeclarationSyntax field &&
                                    field
                                    .Declaration
                                    .Variables
                                    .Any(
                                    (variable VariableDeclaratorSyntax) -> variable
                                        .Identifier
                                        .ValueText == "SourceRootEnvironmentVariable"
                                )
                            )
                        )
                    )
                    let tree = CSharpSyntaxTree.Create(
                        originalRoot.ReplaceNode(originalType, selectedType),
                        cast[CSharpParseOptions](dependency.SyntaxTree.Options),
                        dependency.FilePath
                    )
                    let compilation = pipeline.Compilation.ReplaceSyntaxTree(dependency.SyntaxTree, tree)
                    dependency = LoadedDocument(dependency.FilePath, tree, compilation.GetSemanticModel(tree))
                }
                let dependencyContext = TranslationContext(
                    cast[CSharpCompilation](dependency.SemanticModel.Compilation),
                    dependency.SemanticModel,
                    dependency.FilePath
                )
                let path = Path.Combine(directory, Path.ChangeExtension(name, ".gs"))
                File.WriteAllText(
                    path,
                    GSharpPrinter.Print(
                        CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(
                            dependency,
                            dependencyContext
                        )
                    )
                )
                File.WriteAllText(Path.ChangeExtension(path, ".cs"), dependency.GetRoot().ToFullString())
                helperPaths.Add(path)
            }
            let image = Path.Combine(directory, "Issue4779.Translated.dll")
            let nativeProduct = typeof(Issue4770NullableClassifierCoalescingTests).Assembly.Location
            let native = Path.Combine(directory, AssemblyName.GetAssemblyName(nativeProduct).Name + ".dll")
            {
                using let stream = File.Create(native)
                let emitted = project
                    .Compilation
                    .WithOptions(project.Compilation.Options.WithDeterministic(true))
                    .Emit(stream)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
                this.output.WriteLine("Actual project Roslyn native build succeeded: " + native)
            }
            let productReferences = []string{
                typeof(CSharpCompilation).Assembly.Location,
                typeof(Compilation).Assembly.Location,
                typeof(CSharpProjectLoader).Assembly.Location,
                typeof(CSharpToGSharpTranslator).Assembly.Location,
                typeof(GSharpPrinter).Assembly.Location,
                typeof(ProcessRunner).Assembly.Location,
                typeof(TypeSymbol).Assembly.Location
            }
            let references = Directory
                .EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
                .Concat(productReferences)
                .Append(typeof(Assert).Assembly.Location)
                .Append(typeof(FactAttribute).Assembly.Location)
                .Append(typeof(ITestOutputHelper).Assembly.Location)
                .Append(native)
                .Distinct()
                .ToArray()
            let arguments = List[string]{
                LocalFunctionHoistTranslationTests.FindCompiler()!!,
                "/target:library",
                "/out:" + image
            }
            arguments.AddRange(references.Select((reference string) -> ("/r:" + reference)))
            arguments.Add(source)
            arguments.Add(guardPath)
            arguments.AddRange(helperPaths)
            this.output.WriteLine(
                "Actual source SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(document.FilePath)))
            )
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", arguments))
            let compiled = ProcessRunner.Run("dotnet", arguments)
            this.output.WriteLine(compiled.Output)
            Assert.False(compiled.TimedOut, compiled.Output)
            Assert.Equal(0, compiled.ExitCode)
            let verifyArguments = List[string]{"tool", "run", "ilverify", image, "-s", "System.Private.CoreLib"}
            for reference in references {
                verifyArguments.Add("-r")
                verifyArguments.Add(reference)
            }
            this.output.WriteLine("STRICT ILVerify: dotnet " + string.Join(" ", verifyArguments))
            let verified = ProcessRunner.Run("dotnet", verifyArguments, IlVerifyRunner().RepoRoot)
            this.output.WriteLine(verified.Output)
            Assert.False(verified.TimedOut, verified.Output)
            Assert.Equal(0, verified.ExitCode)
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, root)
            for path in[]string{native, image} {
                let assembly = EmittedFixture.Load(path)
                let type Type? = assembly.GetType(typeof(Issue4770NullableClassifierCoalescingTests).FullName!!)
                Assert.NotNull(type)
                let instance object? = Activator.CreateInstance(type!!, this.output)
                for name in[]string{
                    "DefensiveCoalescing_DoesNotWidenFixedParameterOrMemberContracts",
                    "OriginalParamsControl_CompilesVerifiesAndRuns",
                    "FixedNonNullContract_RetainsRequiredBridge"
                } {
                    let control MethodInfo? = type!!.GetMethod(name)
                    Assert.NotNull(control)
                    Assert.Null(control!!.Invoke(instance, nil))
                    this.output.WriteLine(Path.GetFileName(path) + " CLR control passed: " + name)
                }
            }
        } finally {
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, previousRoot)
            let evidence string? = Environment.GetEnvironmentVariable("GSHARP_ISSUE4779_EVIDENCE")
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
}
