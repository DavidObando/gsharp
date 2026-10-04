// <copyright file="Issue4779NullableReflectionArgumentsSelfMigrationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using Xunit.Abstractions;

namespace Cs2Gs.Tests;

public sealed class Issue4779NullableReflectionArgumentsSelfMigrationTests
{
    private readonly ITestOutputHelper output;

    public Issue4779NullableReflectionArgumentsSelfMigrationTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public async Task ActualClassifierTestUnit_CompilesAndRunsDefensiveContracts()
    {
        string root = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Tests", "Cs2Gs.Tests.csproj"));
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents, candidate =>
            Path.GetFileName(candidate.FilePath) == "Issue4770NullableClassifierCoalescingTests.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string directory = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "issue4779", Guid.NewGuid().ToString("N"));
        string previousRoot = Environment.GetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable);
        Directory.CreateDirectory(directory);
        try
        {
            string source = Path.Combine(directory, "Issue4770NullableClassifierCoalescingTests.gs");
            File.WriteAllText(source, printed);
            File.Copy(document.FilePath, Path.ChangeExtension(source, ".cs"));
            LoadedDocument guardDocument = Assert.Single(project.Documents, candidate =>
                Path.GetFileName(candidate.FilePath) == "Issue4779NullableReflectionArgumentsSelfMigrationTests.cs");
            var guardContext = new TranslationContext(project.Compilation, guardDocument.SemanticModel, guardDocument.FilePath);
            string guardPath = Path.Combine(directory, "Issue4779NullableReflectionArgumentsSelfMigrationTests.gs");
            File.WriteAllText(guardPath, GSharpPrinter.Print(
                new CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(guardDocument, guardContext)));
            File.Copy(guardDocument.FilePath, Path.ChangeExtension(guardPath, ".cs"));
            // Internal source helpers accompany the verbatim test unit instead
            // of relaxing their imported CLR visibility.
            LoadedDocument helperDocument = Assert.Single(project.Documents, candidate =>
                Path.GetFileName(candidate.FilePath) == "LocalFunctionHoistTranslationTests.cs");
            MethodDeclarationSyntax helper = Assert.Single(
                helperDocument.SyntaxTree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>(),
                method => method.Identifier.ValueText == "FindCompiler");
            string helperSource = """
                using System;
                using System.IO;
                namespace Cs2Gs.Tests;
                public class LocalFunctionHoistTranslationTests
                {
                """ + helper.ToFullString() + "\n}";
            LoadedCSharpProject helperProject = CSharpProjectLoader.LoadInMemory(new[] { ("CompilerHelper.cs", helperSource) });
            Assert.True(helperProject.BoundWithoutErrors, string.Join(Environment.NewLine, helperProject.ErrorDiagnostics));
            LoadedDocument helperUnit = Assert.Single(helperProject.Documents);
            var helperContext = new TranslationContext(helperProject.Compilation, helperUnit.SemanticModel, helperUnit.FilePath);
            string helperPath = Path.Combine(directory, "CompilerHelper.gs");
            File.WriteAllText(helperPath, GSharpPrinter.Print(
                new CSharpToGSharpTranslator().TranslateDocument(helperUnit, helperContext)));
            File.WriteAllText(Path.ChangeExtension(helperPath, ".cs"), helperSource);
            LoadedCSharpProject pipeline = await CSharpProjectLoader.LoadProjectAsync(
                Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Pipeline", "Cs2Gs.Pipeline.csproj"));
            Assert.True(pipeline.BoundWithoutErrors, string.Join(Environment.NewLine, pipeline.ErrorDiagnostics));
            var helperPaths = new List<string> { helperPath };
            foreach (string name in new[] { "GsharpTestProjectRunner.cs", "CanonicalRootPath.cs" })
            {
                LoadedDocument dependency = Assert.Single(pipeline.Documents, candidate =>
                    Path.GetFileName(candidate.FilePath) == name);
                if (name == "GsharpTestProjectRunner.cs")
                {
                    CompilationUnitSyntax originalRoot = dependency.GetRoot();
                    ClassDeclarationSyntax originalType = Assert.Single(
                        originalRoot.DescendantNodes().OfType<ClassDeclarationSyntax>(),
                        type => type.Identifier.ValueText == "GsharpTestProjectRunner");
                    ClassDeclarationSyntax selectedType = originalType.WithMembers(SyntaxFactory.List(
                        originalType.Members.Where(member =>
                            member is MethodDeclarationSyntax method &&
                                method.Identifier.ValueText is "FindRepoRoot" or "ResolveConfiguredSourceRoot" ||
                            member is FieldDeclarationSyntax field &&
                                field.Declaration.Variables.Any(variable => variable.Identifier.ValueText == "SourceRootEnvironmentVariable"))));
                    SyntaxTree tree = CSharpSyntaxTree.Create(originalRoot.ReplaceNode(originalType, selectedType),
                        (CSharpParseOptions)dependency.SyntaxTree.Options, dependency.FilePath);
                    CSharpCompilation compilation = pipeline.Compilation.ReplaceSyntaxTree(dependency.SyntaxTree, tree);
                    dependency = new LoadedDocument(dependency.FilePath, tree, compilation.GetSemanticModel(tree));
                }

                var dependencyContext = new TranslationContext(
                    (CSharpCompilation)dependency.SemanticModel.Compilation, dependency.SemanticModel, dependency.FilePath);
                string path = Path.Combine(directory, Path.ChangeExtension(name, ".gs"));
                File.WriteAllText(path, GSharpPrinter.Print(
                    new CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(dependency, dependencyContext)));
                File.WriteAllText(Path.ChangeExtension(path, ".cs"), dependency.GetRoot().ToFullString());
                helperPaths.Add(path);
            }

            string image = Path.Combine(directory, "Issue4779.Translated.dll");
            string nativeProduct = typeof(Issue4770NullableClassifierCoalescingTests).Assembly.Location;
            string native = Path.Combine(directory, AssemblyName.GetAssemblyName(nativeProduct).Name + ".dll");
            using (var stream = File.Create(native))
            {
                var emitted = project.Compilation.WithOptions(project.Compilation.Options.WithDeterministic(true)).Emit(stream);
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
                this.output.WriteLine("Actual project Roslyn native build succeeded: " + native);
            }

            var productReferences = new[]
            {
                typeof(CSharpCompilation).Assembly.Location,
                typeof(Compilation).Assembly.Location,
                typeof(CSharpProjectLoader).Assembly.Location,
                typeof(CSharpToGSharpTranslator).Assembly.Location,
                typeof(GSharpPrinter).Assembly.Location,
                typeof(ProcessRunner).Assembly.Location,
                typeof(GSharp.Core.CodeAnalysis.Symbols.TypeSymbol).Assembly.Location,
            };
            string[] references = Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll")
                .Concat(productReferences).Append(typeof(Assert).Assembly.Location)
                .Append(typeof(FactAttribute).Assembly.Location)
                .Append(typeof(ITestOutputHelper).Assembly.Location).Append(native).Distinct().ToArray();
            var arguments = new List<string>
            {
                LocalFunctionHoistTranslationTests.FindCompiler(),
                "/target:library",
                "/out:" + image,
            };
            arguments.AddRange(references.Select(reference => "/r:" + reference));
            arguments.Add(source);
            arguments.Add(guardPath);
            arguments.AddRange(helperPaths);
            this.output.WriteLine("Actual source SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(document.FilePath))));
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", arguments));
            ProcessRunResult compiled = ProcessRunner.Run("dotnet", arguments);
            this.output.WriteLine(compiled.Output);
            Assert.False(compiled.TimedOut, compiled.Output);
            Assert.Equal(0, compiled.ExitCode);

            var verifyArguments = new List<string> { "tool", "run", "ilverify", image, "-s", "System.Private.CoreLib" };
            foreach (string reference in references)
            {
                verifyArguments.Add("-r");
                verifyArguments.Add(reference);
            }

            this.output.WriteLine("STRICT ILVerify: dotnet " + string.Join(" ", verifyArguments));
            ProcessRunResult verified = ProcessRunner.Run("dotnet", verifyArguments, new IlVerifyRunner().RepoRoot);
            this.output.WriteLine(verified.Output);
            Assert.False(verified.TimedOut, verified.Output);
            Assert.Equal(0, verified.ExitCode);
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, root);
            foreach (string path in new[] { native, image })
            {
                Assembly assembly = EmittedFixture.Load(path);
                Type type = assembly.GetType(typeof(Issue4770NullableClassifierCoalescingTests).FullName);
                Assert.NotNull(type);
                object instance = Activator.CreateInstance(type, this.output);
                foreach (string name in new[]
                {
                    nameof(Issue4770NullableClassifierCoalescingTests.DefensiveCoalescing_DoesNotWidenFixedParameterOrMemberContracts),
                    nameof(Issue4770NullableClassifierCoalescingTests.OriginalParamsControl_CompilesVerifiesAndRuns),
                })
                {
                    MethodInfo control = type.GetMethod(name);
                    Assert.NotNull(control);
                    Assert.Null(control.Invoke(instance, null));
                    this.output.WriteLine(Path.GetFileName(path) + " CLR control passed: " + name);
                }
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, previousRoot);
            string evidence = Environment.GetEnvironmentVariable("GSHARP_ISSUE4779_EVIDENCE");
            if (!string.IsNullOrEmpty(evidence))
            {
                string destination = Path.Combine(evidence, Path.GetFileName(directory));
                Directory.CreateDirectory(destination);
                foreach (string file in Directory.EnumerateFiles(directory))
                {
                    File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), overwrite: true);
                }
            }

            Directory.Delete(directory, recursive: true);
        }
    }
}
