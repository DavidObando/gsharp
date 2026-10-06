// <copyright file="Issue4769NullableSelectorObservationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue4769NullableSelectorObservationTests
{
    [Theory]
    [InlineData("Any(value => value is string text && text.Length == 2)", "True|3")]
    [InlineData("All(value => value is string text && text.Length == 2)", "False|1")]
    [InlineData("Where(value => value is string text && text.Length == 2).Count()", "1|3")]
    [InlineData("FirstOrDefault(value => value is string text && text.Length == 2) != null", "True|3")]
    [InlineData("Any(value => value is null)", "True|1")]
    [InlineData("All(value => value is not null)", "False|1")]
    public void InferredSelector_NullObservingPredicate_PreservesNullAndEvaluationOrder(
        string consumer,
        string expected)
    {
        string source = """
            using System;
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
                        var result = new[] { 0, 1, 2 }.Select(value => Read(value)).
            """ + consumer + """
                        ;
                        return result + "|" + calls;
                    }
                }
            }
            """;
        LoadedCSharpProject project = Load(source);
        AssertNativeAndMigrated(project, assembly =>
        {
            Type probe = assembly.GetType("Issue4769.Probe");
            Assert.NotNull(probe);
            Assert.Equal(expected, probe.GetMethod("Run").Invoke(null, null));
        });
    }

    [Theory]
    [InlineData("class C { int M() { int Visit(int n) => n == 0 ? 1 : Visit(n - 1); return Visit(2); } }", false, false)]
    [InlineData("class C<T> { T M(T value) { T Visit(int n) => n == 0 ? value : Visit(n - 1); return Visit(2); } }", false, false)]
    [InlineData("class C<T> { T M(T value) { T Visit(int n) => n == 0 ? value : Visit(n - 1); return Visit(2); } }", true, true)]
    [InlineData("class C { U M<U>(U value) { U Visit(int n) => n == 0 ? value : Visit(n - 1); return Visit(2); } }", false, true)]
    [InlineData("class C<T> { int M() { int Visit(int n) => nameof(T).Length; return Visit(2); } }", true, false)]
    [InlineData("class C<T> { private int Read() => 7; int M() { int Visit(int n) => Read(); return Visit(2); } }", true, true)]
    public void MigratedOriginalRecursiveLiftQuery_HandlesUnboundNodesAndOwnerTypeParameters(
        string input,
        bool includeContainingTypeParameters,
        bool expected)
    {
        LoadedCSharpProject inputProject = Load(input);
        LoadedDocument inputDocument = Assert.Single(inputProject.Documents);
        LocalFunctionStatementSyntax candidateSyntax = Assert.Single(
            inputDocument.SyntaxTree.GetRoot().DescendantNodes().OfType<LocalFunctionStatementSyntax>());
        IMethodSymbol candidateSymbol = Assert.IsAssignableFrom<IMethodSymbol>(
            inputDocument.SemanticModel.GetDeclaredSymbol(candidateSyntax));
        Assert.Contains(
            candidateSyntax.DescendantNodes(),
            node => inputDocument.SemanticModel.GetSymbolInfo(node).Symbol == null);

        // Compile the real production query and its helpers, not a hand-kept port.
        string constructors = File.ReadAllText(TestFixtureSource.Resolve(
            "tools", "cs2gs", "Cs2Gs.Translator", "CSharpToGSharpTranslator.Constructors.cs"));
        string invocations = File.ReadAllText(TestFixtureSource.Resolve(
            "tools", "cs2gs", "Cs2Gs.Translator", "CSharpToGSharpTranslator.Invocations.cs"));
        SyntaxNode constructorRoot = CSharpSyntaxTree.ParseText(constructors).GetRoot();
        string query = Assert.Single(
            constructorRoot.DescendantNodes().OfType<LocalFunctionStatementSyntax>(),
            node => node.Identifier.ValueText == "ReferencesEnclosingTypeParameter").ToFullString();
        string insideNameOf = Assert.Single(
            constructorRoot.DescendantNodes().OfType<LocalFunctionStatementSyntax>(),
            node => node.Identifier.ValueText == "IsInsideNameOf").ToFullString();
        string containsTypeParameter = Assert.Single(
            CSharpSyntaxTree.ParseText(invocations).GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>(),
            node => node.Identifier.ValueText == "TypeContainsTypeParameter").ToFullString();
        string source = """
            using System;
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
                    {
            """ + insideNameOf + query + """
                        return ReferencesEnclosingTypeParameter(candidate, includeContainingTypeParameters);
                    }
            """ + containsTypeParameter + """
                }
            }
            """;
        LoadedCSharpProject project = Load(source);
        AssertNativeAndMigrated(project, assembly =>
        {
            Type queryType = assembly.GetType("Issue4769.Query");
            Assert.NotNull(queryType);
            var context = new TranslationContext(
                inputProject.Compilation, inputDocument.SemanticModel, inputDocument.FilePath);
            object queryInstance = Activator.CreateInstance(queryType, context);
            Assert.Equal(expected, queryType.GetMethod("Run").Invoke(
                queryInstance,
                new object[] { (candidateSyntax, candidateSymbol), includeContainingTypeParameters }));
        }, assertMetadata: assembly =>
        {
            MethodInfo selector = Assert.Single(
                assembly.GetTypes().SelectMany(type => type.GetMethods()),
                method => method.Name == "Invoke" && method.ReturnType == typeof(ISymbol));
            Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(selector.ReturnParameter).ReadState);
            Assert.Equal(typeof(SyntaxNode), Assert.Single(selector.GetParameters()).ParameterType);
        });
    }

    private static LoadedCSharpProject Load(string source)
    {
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Concat(new[]
            {
                MetadataReference.CreateFromFile(typeof(SyntaxNode).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(CSharpCompilation).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(TranslationContext).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(GSharp.Core.CodeAnalysis.Symbols.TypeSymbol).Assembly.Location),
            })
            .DistinctBy(reference => reference.Display)
            .ToArray();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("SelectorObservation.cs", source) }, references, "Issue4769.Native");
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static void AssertNativeAndMigrated(
        LoadedCSharpProject project,
        Action<Assembly> assert,
        Action<Assembly> assertMetadata = null)
    {
        using var image = new MemoryStream();
        var emitted = project.Compilation.Emit(image);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        Assert.True(image.Length > 0);
        assert(EmittedFixture.Load(image.ToArray()));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        string compiler = GscInvoker.Resolve(null, "Release", AppContext.BaseDirectory);
        Assert.NotNull(compiler);
        string directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4769NullableSelectorObservationTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string source = Path.Combine(directory, "Query.gs");
            string assembly = Path.Combine(directory, "Query.dll");
            string nativeAssembly = Path.Combine(directory, "Native.dll");
            File.WriteAllBytes(nativeAssembly, image.ToArray());
            File.WriteAllText(source, printed);
            string[] references = project.Compilation.References
                .OfType<PortableExecutableReference>()
                .Select(reference => reference.FilePath)
                .Where(path => path != null)
                .ToArray();
            AssertStrictIl(nativeAssembly, references);
            GscResult compiled = new GscInvoker(compiler).Compile(
                new[] { source }, assembly, TargetKind.Library, references);
            Assert.True(compiled.ExitCode == 0, compiled.Output + Environment.NewLine + printed);
            Assert.True(File.Exists(assembly), compiled.Output);
            AssertStrictIl(assembly, references);
            Assembly migrated = EmittedFixture.Load(assembly);
            Exception failure = Record.Exception(() => assert(migrated));
            Assert.True(failure == null, "Migrated CLR execution must match the native control: " + failure);
            assertMetadata?.Invoke(migrated);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void AssertStrictIl(string assembly, IEnumerable<string> references)
    {
        var arguments = new List<string>
        {
            "tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib",
        };
        foreach (string reference in references)
        {
            arguments.Add("-r");
            arguments.Add(reference);
        }

        ProcessRunResult result = ProcessRunner.Run("dotnet", arguments, new IlVerifyRunner().RepoRoot);
        Assert.False(result.TimedOut, result.Output);
        Assert.True(result.ExitCode == 0, result.Output);
    }
}
