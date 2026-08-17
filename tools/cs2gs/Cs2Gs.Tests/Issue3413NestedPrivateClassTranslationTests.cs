// <copyright file="Issue3413NestedPrivateClassTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #3413 nested private class declaration preservation.</summary>
[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue3413NestedPrivateClassTranslationTests
{
    private const string Source = """
        using System;

        namespace Issue3413
        {
            public static class Program
            {
                private sealed class EntryHelper<T>
                {
                    public EntryHelper(T value)
                    {
                        Value = value;
                    }

                    public T Value { get; }
                }

                public static void Main()
                {
                    Console.WriteLine(new EntryHelper<int>(42).Value);
                }
            }

            public static class ExtensionOwner
            {
                private static class Cache<T>
                {
                    public static T Echo(T value) => value;
                }

                public static T Identity<T>(this T value) => value;
            }

            public sealed class GenericOwner<TOuter>
            {
                private sealed class Helper<TInner> : LateBase<TOuter, TInner>
                {
                    protected override TOuter EchoOuter(TOuter value) => value;

                    protected override TInner EchoInner(TInner value) => value;
                }
            }

            public class LateBase<TOuter, TInner> : Root<TOuter, TInner>
            {
                protected override TOuter EchoOuter(TOuter value) => value;

                protected override TInner EchoInner(TInner value) => value;
            }

            public abstract class Root<TOuter, TInner>
            {
                protected abstract TOuter EchoOuter(TOuter value);

                protected abstract TInner EchoInner(TInner value);
            }
        }
        """;

    [Fact]
    public void EntryAndGenericNestedClasses_RetainStructuralOwnersAndPrivateVisibility()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(Source);

        TypeDeclaration program = unit.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "Program");
        TypeDeclaration entryHelper = program.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "EntryHelper");
        Assert.Equal(Visibility.Private, entryHelper.Visibility);
        Assert.Single(entryHelper.TypeParameters);
        Assert.Contains(
            Assert.Single(program.Members.OfType<SharedBlock>()).Members.OfType<MethodDeclaration>(),
            method => method.Name == "Main");

        TypeDeclaration genericOwner = unit.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "GenericOwner");
        TypeDeclaration genericHelper = genericOwner.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "Helper");
        Assert.Equal(Visibility.Private, genericHelper.Visibility);
        Assert.Single(genericOwner.TypeParameters);
        Assert.Single(genericHelper.TypeParameters);
        Assert.DoesNotContain(
            unit.Members.OfType<TypeDeclaration>(),
            type => type.Name is "EntryHelper" or "Helper");

        TypeDeclaration extensionOwner = unit.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "ExtensionOwner");
        TypeDeclaration cache = Assert.Single(extensionOwner.Members.OfType<TypeDeclaration>());
        Assert.Equal("Cache", cache.Name);
        Assert.Equal(Visibility.Private, cache.Visibility);
        Assert.Single(cache.TypeParameters);

        string rendered = GSharpPrinter.Print(unit);
        Assert.Contains("private class EntryHelper[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("private class Cache[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("class GenericOwner[TOuter]", rendered, StringComparison.Ordinal);
        Assert.Contains("private open class Helper[TInner]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public async Task Pipeline_CompilesVerifiesRunsAndEmitsNestedPrivateGenericMetadata()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue3413");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue3413.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), Source);
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(goldenPath, "42\n");

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/Issue3413",
            projectPath,
            TargetKind.Exe,
            stdoutGolden: goldenPath);
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
                Config = "Release",
                CompileViaSdk = false,
            },
            new IMigrationStage[]
            {
                new TranslateStage(),
                new CompileStage(),
                new IlVerifyStage(),
                new TestParityStage(),
            });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string appDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("class Program", translated, StringComparison.Ordinal);
        Assert.Contains("private class EntryHelper[T]", translated, StringComparison.Ordinal);
        Assert.Contains("private class Cache[T]", translated, StringComparison.Ordinal);
        Assert.Contains("class GenericOwner[TOuter]", translated, StringComparison.Ordinal);
        Assert.Contains("private open class Helper[TInner]", translated, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());

        string assemblyPath = Path.Combine(appDirectory, "Issue3413.dll");
        Assert.True(File.Exists(assemblyPath), $"Expected emitted assembly at '{assemblyPath}'.");
        Assembly assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));

        Type program = Assert.Single(assembly.GetTypes(), type => type.Name == "Program");
        Assert.Equal(program, assembly.EntryPoint?.DeclaringType);
        Type entryHelper = Assert.Single(
            program.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            type => type.Name.StartsWith("EntryHelper", StringComparison.Ordinal));
        Assert.True(entryHelper.IsNestedPrivate);
        Assert.Equal(program, entryHelper.DeclaringType);
        Assert.Single(entryHelper.GetGenericArguments());

        Type extensionOwner = Assert.Single(assembly.GetTypes(), type => type.Name == "ExtensionOwner");
        Type cache = Assert.Single(
            extensionOwner.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            type => type.Name.StartsWith("Cache", StringComparison.Ordinal));
        Assert.True(cache.IsNestedPrivate);
        Assert.Equal(extensionOwner, cache.DeclaringType);
        Assert.Single(cache.GetGenericArguments());

        Type genericOwner = Assert.Single(
            assembly.GetTypes(),
            type => type.Name.StartsWith("GenericOwner", StringComparison.Ordinal));
        Type genericHelper = Assert.Single(
            genericOwner.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            type => type.Name.StartsWith("Helper", StringComparison.Ordinal));
        Assert.True(genericHelper.IsNestedPrivate);
        Assert.Equal(genericOwner, genericHelper.DeclaringType);
        Type[] genericArguments = genericHelper.GetGenericArguments();
        Assert.Equal(2, genericArguments.Length);
        Assert.Equal(
            0,
            genericHelper.GetMethod("EchoOuter", BindingFlags.NonPublic | BindingFlags.Instance)!
                .ReturnType.GenericParameterPosition);
        Assert.Equal(
            1,
            genericHelper.GetMethod("EchoInner", BindingFlags.NonPublic | BindingFlags.Instance)!
                .ReturnType.GenericParameterPosition);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        Microsoft.CodeAnalysis.SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Program.cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            "Issue3413.Translation",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.ConsoleApplication)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument(tree.FilePath, tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return (new CSharpToGSharpTranslator().TranslateDocument(document, context), context);
    }

    private static bool IlVerifyToolAvailable()
    {
        try
        {
            return !IlVerifyRunner.IsEnabled || new IlVerifyRunner().EnsureToolAvailable();
        }
        catch
        {
            return false;
        }
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue3413",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
