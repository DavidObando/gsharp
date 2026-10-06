// <copyright file="Issue4722SelfHostedTypeArgumentRemappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
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

public sealed class Issue4722SelfHostedTypeArgumentRemappingTests
{
    private readonly ITestOutputHelper output;

    public Issue4722SelfHostedTypeArgumentRemappingTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ActualRemappingMethods_CompileVerifyAndPreserveImportedContracts()
    {
        string path = Path.Combine(GsharpTestProjectRunner.FindRepoRoot(),
            "tools", "cs2gs", "Cs2Gs.Translator", "ObliviousNullabilityAnalyzer.cs");
        string original = File.ReadAllText(path);
        SyntaxNode root = CSharpSyntaxTree.ParseText(original).GetRoot();
        MethodDeclarationSyntax[] methods = root.DescendantNodes().OfType<MethodDeclarationSyntax>()
            .Where(method => method.Identifier.ValueText
                is "RemapToCompilation" or "RemapSourceDeclaration" or "RemapMemberOwner").ToArray();
        Assert.Equal(3, methods.Length);
        FieldDeclarationSyntax sourceTrees = Assert.Single(
            root.DescendantNodes().OfType<FieldDeclarationSyntax>(),
            field => field.Declaration.Variables.Any(variable => variable.Identifier.ValueText == "SourceTrees"));
        string source = """
            using System;
            using System.Collections.Generic;
            using System.Linq;
            using System.Collections.Immutable;
            using System.Runtime.CompilerServices;
            using Microsoft.CodeAnalysis;
            #nullable disable
            namespace RootRemapping;
            public static class Remapper {
                public static ISymbol Remap(Compilation target, ISymbol symbol) =>
                    RemapToCompilation(target, symbol);
            """ + sourceTrees.ToFullString()
                + string.Join(Environment.NewLine, methods.Select(method => method.ToFullString())) + "\n}";
        MetadataReference[] references = CSharpProjectLoader.RuntimeReferences()
            .Concat(new[] { MetadataReference.CreateFromFile(typeof(Compilation).Assembly.Location) }).ToArray();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ActualRemapping.cs", source) }, references, "RootRemappingNative");
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string directory = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "issue4722-selfhost", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "ActualRemapping.cs"), source);
            string gs = Path.Combine(directory, "ActualRemapping.gs");
            File.WriteAllText(gs, printed);
            string native = Path.Combine(directory, "RootRemappingNative.dll");
            var emitted = project.Compilation.WithOptions(project.Compilation.Options.WithDeterministic(true)).Emit(native);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            this.output.WriteLine("Actual production source SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))));
            this.output.WriteLine("Actual extracted methods SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.ChangeExtension(gs, ".cs")))));

            string translated = Path.Combine(directory, "RootRemappingTranslated.dll");
            string[] runtimeReferences = references.OfType<PortableExecutableReference>()
                .Select(reference => reference.FilePath).ToArray();
            var args = new List<string> { LocalFunctionHoistTranslationTests.FindCompiler(), "/target:library", "/out:" + translated };
            args.AddRange(runtimeReferences.Select(reference => "/r:" + reference));
            args.Add(gs);
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", args));
            ProcessRunResult compiled = ProcessRunner.Run("dotnet", args);
            this.output.WriteLine(compiled.Output);
            Assert.False(compiled.TimedOut, compiled.Output);
            Assert.Equal(0, compiled.ExitCode);

            foreach (string image in new[] { native, translated })
            {
                var verify = new List<string> { "tool", "run", "ilverify", image, "-s", "System.Private.CoreLib" };
                verify.AddRange(runtimeReferences.SelectMany(reference => new[] { "-r", reference }));
                this.output.WriteLine("UNSUPPRESSED STRICT: dotnet " + string.Join(" ", verify));
                ProcessRunResult verified = ProcessRunner.Run("dotnet", verify, new IlVerifyRunner().RepoRoot);
                this.output.WriteLine(verified.Output);
                Assert.False(verified.TimedOut, verified.Output);
                Assert.Equal(0, verified.ExitCode);
                this.AssertImportedContracts(EmittedFixture.Load(image), directory);
                this.output.WriteLine(Path.GetFileName(image) + " actual CLR imported-contract controls passed");
            }
        }
        finally
        {
            string evidence = Environment.GetEnvironmentVariable("GSHARP_ISSUE4722_SELFHOST_EVIDENCE");
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

    private void AssertImportedContracts(Assembly remapper, string directory)
    {
        const string contract = """
            #nullable enable
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
                    string? Echo(string? item) => item;
                    return Echo(local);
                }
            }
            public sealed class Consumer { public Outer<string?>.Rows<(string? Value, int Code)> Value; }
            """;
        LoadedCSharpProject native = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("NativePart.cs", "public sealed partial class Outer<T> { }"),
                ("Contracts.cs", contract),
            },
            CSharpProjectLoader.RuntimeReferences(), "RemappingContracts");
        Assert.True(native.BoundWithoutErrors, string.Join(Environment.NewLine, native.ErrorDiagnostics));
        string image = Path.Combine(directory, "RemappingContracts.dll");
        File.WriteAllText(Path.Combine(directory, "Contracts.cs"), contract);
        var emitted = native.Compilation.Emit(image);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        this.output.WriteLine("Explicit Roslyn imported contract SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(image))));
        LoadedCSharpProject target = CSharpProjectLoader.LoadInMemory(
            new[] { ("Target.cs", "public sealed class Target { }") },
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(image)).ToArray());
        Assert.True(target.BoundWithoutErrors, string.Join(Environment.NewLine, target.ErrorDiagnostics));
        LoadedCSharpProject linkedTarget = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("LinkedPart.cs", "public sealed partial class Outer<T> { }"),
                ("Contracts.cs", contract),
            },
            CSharpProjectLoader.RuntimeReferences(),
            "LinkedRemappingContracts");
        Assert.True(linkedTarget.BoundWithoutErrors, string.Join(Environment.NewLine, linkedTarget.ErrorDiagnostics));
        INamedTypeSymbol input = Assert.IsAssignableFrom<INamedTypeSymbol>(
            Assert.Single(native.Compilation.GetTypeByMetadataName("Consumer").GetMembers("Value").OfType<IFieldSymbol>()).Type);
        Type type = remapper.GetType("RootRemapping.Remapper");
        Assert.NotNull(type);
        MethodInfo method = type.GetMethod("Remap");
        Assert.NotNull(method);
        var targets = new[]
        {
            (Compilation: target.Compilation, ExpectedAssembly: native.Compilation.Assembly.Identity),
            (Compilation: linkedTarget.Compilation, ExpectedAssembly: linkedTarget.Compilation.Assembly.Identity),
        };
        foreach (var remappingTarget in targets)
        {
            INamedTypeSymbol mapped = Assert.IsAssignableFrom<INamedTypeSymbol>(
                method.Invoke(null, new object[] { remappingTarget.Compilation, input }));
            Assert.Equal(NullableAnnotation.Annotated, Assert.Single(mapped.ContainingType.TypeArguments).NullableAnnotation);
            INamedTypeSymbol tuple = Assert.IsAssignableFrom<INamedTypeSymbol>(Assert.Single(mapped.TypeArguments));
            Assert.True(tuple.IsTupleType);
            Assert.Equal(NullableAnnotation.Annotated, tuple.TupleElements[0].Type.NullableAnnotation);
            Assert.Equal(SpecialType.System_Int32, tuple.TupleElements[1].Type.SpecialType);
            Assert.Equal(remappingTarget.ExpectedAssembly, mapped.ContainingAssembly.Identity);
            IMethodSymbol[] members = input.GetMembers("Read").OfType<IMethodSymbol>().ToArray();
            Assert.Equal(2, members.Length);
            foreach (IMethodSymbol member in members)
            {
                IMethodSymbol constructed = member.Arity == 0 ? member : member.Construct(
                    native.Compilation.GetSpecialType(SpecialType.System_String).WithNullableAnnotation(NullableAnnotation.Annotated));
                IMethodSymbol result = Assert.IsAssignableFrom<IMethodSymbol>(
                    method.Invoke(null, new object[] { remappingTarget.Compilation, constructed }));
                Assert.Equal(RefKind.Ref, result.Parameters[0].RefKind);
                Assert.Equal(constructed.OriginalDefinition.GetDocumentationCommentId(), result.OriginalDefinition.GetDocumentationCommentId());
                IParameterSymbol parameter = Assert.IsAssignableFrom<IParameterSymbol>(
                    method.Invoke(null, new object[] { remappingTarget.Compilation, constructed.Parameters[0] }));
                Assert.True(SymbolEqualityComparer.Default.Equals(result.Parameters[0], parameter));
                if (result.Arity != 0)
                {
                    Assert.Equal(NullableAnnotation.Annotated, Assert.Single(result.TypeArguments).NullableAnnotation);
                    Assert.Equal(NullableAnnotation.Annotated, result.ReturnType.NullableAnnotation);
                }
            }

            INamedTypeSymbol outer = native.Compilation.GetTypeByMetadataName("Outer`1");
            IParameterSymbol primary = Assert.Single(
                Assert.Single(outer.InstanceConstructors,
                    constructor => constructor.Parameters.Any(parameter => parameter.Name == "primary")).Parameters);
            IParameterSymbol remappedPrimary = Assert.IsAssignableFrom<IParameterSymbol>(
                method.Invoke(null, new object[] { remappingTarget.Compilation, primary }));
            Assert.Equal(primary.Name, remappedPrimary.Name);

            INamedTypeSymbol snapshot = native.Compilation.GetTypeByMetadataName("Snapshot");
            IParameterSymbol positional = Assert.Single(
                Assert.Single(snapshot.InstanceConstructors,
                    constructor => constructor.Parameters.Any(parameter => parameter.Name == "Value")).Parameters);
            IParameterSymbol remappedPositional = Assert.IsAssignableFrom<IParameterSymbol>(
                method.Invoke(null, new object[] { remappingTarget.Compilation, positional }));
            Assert.Equal(positional.Name, remappedPositional.Name);
        }

        LoadedDocument contractDocument = Assert.Single(
            native.Documents,
            document => document.FilePath == "Contracts.cs");
        SyntaxNode contractRoot = contractDocument.SemanticModel.SyntaxTree.GetRoot();
        ILocalSymbol local = Assert.IsAssignableFrom<ILocalSymbol>(
            contractDocument.SemanticModel.GetDeclaredSymbol(
                Assert.Single(contractRoot.DescendantNodes().OfType<VariableDeclaratorSyntax>(),
                    declaration => declaration.Identifier.ValueText == "local")));
        IMethodSymbol localFunction = Assert.IsAssignableFrom<IMethodSymbol>(
            contractDocument.SemanticModel.GetDeclaredSymbol(
                Assert.Single(contractRoot.DescendantNodes().OfType<LocalFunctionStatementSyntax>())));
        Assert.IsAssignableFrom<ILocalSymbol>(
            method.Invoke(null, new object[] { linkedTarget.Compilation, local }));
        Assert.IsAssignableFrom<IMethodSymbol>(
            method.Invoke(null, new object[] { linkedTarget.Compilation, localFunction }));

        LoadedCSharpProject unrelated = CSharpProjectLoader.LoadInMemory(new[] { ("Unrelated.cs", "public sealed class Unrelated { }") });
        Assert.Null(method.Invoke(null, new object[] { unrelated.Compilation, input }));
    }
}
