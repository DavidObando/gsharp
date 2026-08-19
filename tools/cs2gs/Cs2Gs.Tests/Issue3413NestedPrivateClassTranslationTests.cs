// <copyright file="Issue3413NestedPrivateClassTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
        using System.Threading.Tasks;

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
                    Console.WriteLine(1.Identity());
                    Console.WriteLine(35.AddCached());
                    Console.WriteLine(6.DelayIdentityAsync().GetAwaiter().GetResult());
                    7.DelayAsync().GetAwaiter().GetResult();
                    Func<Task<int>> lengthAsync = "four".LengthAsync;
                    Console.WriteLine(lengthAsync().GetAwaiter().GetResult());
                    Func<Task> delayAsync = "later".DelayTextAsync;
                    delayAsync().GetAwaiter().GetResult();
                    Console.WriteLine(9.ValueAsync().AsTask().GetAwaiter().GetResult());
                    10.ValueNoteAsync().AsTask().GetAwaiter().GetResult();
                    Func<ValueTask<int>> valueLengthAsync = "five".ValueLengthAsync;
                    Console.WriteLine(valueLengthAsync().AsTask().GetAwaiter().GetResult());
                    Func<ValueTask> valueDelayAsync = "later".ValueDelayAsync;
                    valueDelayAsync().AsTask().GetAwaiter().GetResult();
                    Console.WriteLine("async");
                }
            }

            public static class ExtensionOwner
            {
                private sealed class Cache<T>
                {
                    public Cache(T value)
                    {
                        Value = value;
                    }

                    public T Value { get; }

                    public static T Echo(T value) => value;
                }

                private static Cache<int> cache = new Cache<int>(7);

                public static T Identity<T>(this T value) => Cache<T>.Echo(value);

                public static int AddCached(this int value) => value + cache.Value;

                public static async Task<T> DelayIdentityAsync<T>(this T value)
                {
                    await Task.Yield();
                    return Cache<T>.Echo(value);
                }

                public static async Task DelayAsync(this int value)
                {
                    await Task.Yield();
                }

                public static async Task<int> LengthAsync(this string value)
                {
                    await Task.Yield();
                    return value.Length;
                }

                public static async Task DelayTextAsync(this string value)
                {
                    await Task.Yield();
                }

                public static async ValueTask<int> ValueAsync(this int value)
                {
                    await Task.Yield();
                    return value;
                }

                public static async ValueTask ValueNoteAsync(this int value)
                {
                    await Task.Yield();
                }

                public static async ValueTask<int> ValueLengthAsync(this string value)
                {
                    await Task.Yield();
                    return value.Length;
                }

                public static async ValueTask ValueDelayAsync(this string value)
                {
                    await Task.Yield();
                }
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
        SharedBlock extensionShared = Assert.Single(extensionOwner.Members.OfType<SharedBlock>());
        Assert.Equal(
            Visibility.Private,
            extensionShared.Members.OfType<FieldDeclaration>().Single(field => field.Name == "cache").Visibility);
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "Identity");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "AddCached");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "DelayIdentityAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "DelayAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "LengthAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "DelayTextAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "ValueAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "ValueNoteAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "ValueLengthAsync");
        Assert.Contains(extensionShared.Members.OfType<MethodDeclaration>(), method => method.Name == "ValueDelayAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "Identity");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "AddCached");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "DelayIdentityAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "DelayAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "LengthAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "DelayTextAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "ValueAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "ValueNoteAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "ValueLengthAsync");
        Assert.Contains(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "ValueDelayAsync");

        string rendered = GSharpPrinter.Print(unit);
        Assert.Contains("private class EntryHelper[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("private class Cache[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("private var cache Cache[int32]", rendered, StringComparison.Ordinal);
        Assert.Contains("ExtensionOwner.Identity", rendered, StringComparison.Ordinal);
        Assert.Contains("ExtensionOwner.AddCached", rendered, StringComparison.Ordinal);
        Assert.Contains("return await ExtensionOwner.DelayIdentityAsync", rendered, StringComparison.Ordinal);
        Assert.Contains("await ExtensionOwner.DelayAsync", rendered, StringComparison.Ordinal);
        Assert.Contains("class GenericOwner[TOuter]", rendered, StringComparison.Ordinal);
        Assert.Contains("private open class Helper[TInner]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ExtensionUsingPrivateNestedGenericHelper_StaysOnOwnerAndBinds()
    {
        const string source = """
            using System;

            namespace Issue3413
            {
                public static class Program
                {
                    public static void Main() => Console.WriteLine(42.Identity());
                }

                public static class ExtensionOwner
                {
                    private static class Cache<T>
                    {
                        public static T Echo(T value) => value;
                    }

                    public static T Identity<T>(this T value) => Cache<T>.Echo(value);
                }
            }
            """;

        (CompilationUnit unit, _) = Translate(source);
        TypeDeclaration owner = unit.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "ExtensionOwner");
        TypeDeclaration cache = Assert.Single(owner.Members.OfType<TypeDeclaration>());
        string rendered = GSharpPrinter.Print(unit);
        TranslationTestValidation.AssertBinds(rendered);
        SharedBlock shared = Assert.Single(owner.Members.OfType<SharedBlock>());

        Assert.Equal(Visibility.Private, cache.Visibility);
        Assert.Contains(shared.Members.OfType<MethodDeclaration>(), method => method.Name == "Identity");
        Assert.Contains(unit.Members.OfType<MethodDeclaration>(), method => method.Name == "Identity");
        Assert.Contains("private class Cache[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("Cache[T].Echo(value)", rendered, StringComparison.Ordinal);
        Assert.Contains("ExtensionOwner.Identity", rendered, StringComparison.Ordinal);
        Assert.Contains(
            "func (value T) Identity[T]() T -> ExtensionOwner.Identity[T](value)",
            rendered,
            StringComparison.Ordinal);
    }

    [Fact]
    public void PrivateOwnerScopedExtension_RemainsStaticHelper()
    {
        const string source = """
            using System;

            namespace Issue3413
            {
                public static class Program
                {
                    public static void Main() => Console.WriteLine(Owner.Run("ok"));
                }

                public static class Owner
                {
                    private sealed class Cache
                    {
                    }

                    private static string Secret(this string value) => value + "!";

                    public static string Run(string value) => value.Secret();
                }
            }
            """;

        (CompilationUnit unit, _) = Translate(source);
        string rendered = GSharpPrinter.Print(unit);
        TypeDeclaration owner = unit.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "Owner");

        Assert.Contains(
            Assert.Single(owner.Members.OfType<SharedBlock>()).Members.OfType<MethodDeclaration>(),
            method => method.Name == "Secret" && method.Visibility == Visibility.Private);
        Assert.DoesNotContain(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "Secret");
        Assert.Contains("Owner.Secret(value)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void OwnerScopedCompanion_RespectsInstanceAndSiblingCollisions()
    {
        const string source = """
            using System;

            namespace Issue3413
            {
                public static class Program
                {
                    public static void Main() => Console.WriteLine(new Host().Describe());
                }

                public sealed class Host
                {
                    public string Describe() => "instance";

                    public string func_() => "instance keyword";
                }

                public static class OwnerScoped
                {
                    private sealed class Cache
                    {
                    }

                    public static string Describe(this Host host) => "extension";

                    public static string Format(this string value) => "owner";

                    public static string @func(this Host host) => "extension keyword";

                    public static string @func(this string value) => "owner keyword";
                }

                public static class Sibling
                {
                    public static string Format(this string value) => "sibling";

                    public static string func_(this string value) => "sibling keyword";
                }
            }
            """;

        (CompilationUnit unit, _) = Translate(source);
        string rendered = GSharpPrinter.Print(unit);
        TypeDeclaration owner = unit.Members
            .OfType<TypeDeclaration>()
            .Single(type => type.Name == "OwnerScoped");
        SharedBlock shared = Assert.Single(owner.Members.OfType<SharedBlock>());

        Assert.Contains(shared.Members.OfType<MethodDeclaration>(), method => method.Name == "Describe");
        Assert.Contains(shared.Members.OfType<MethodDeclaration>(), method => method.Name == "Format");
        Assert.DoesNotContain(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "Describe");
        Assert.Single(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "Format");
        Assert.Single(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "func_");
        Assert.DoesNotContain(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name == "func__");
        Assert.Equal(
            2,
            shared.Members.OfType<MethodDeclaration>().Count(method => method.Name == "func_"));
        Assert.DoesNotContain(
            shared.Members.OfType<MethodDeclaration>(),
            method => method.Name == "func__");
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void OwnerScopedCompanion_DeduplicatesCanonicalSiblingSignatures()
    {
        LoadedCSharpProject first = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("First.cs", """
                    namespace Shared;

                    public static class First
                    {
                        private sealed class Cache
                        {
                        }

                        public static object Convert(this object value, dynamic argument) => argument;
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences(),
            "Z.Dependency");
        Assert.True(first.BoundWithoutErrors, string.Join(Environment.NewLine, first.ErrorDiagnostics));
        using var firstImage = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult firstEmit =
            first.Compilation.Emit(firstImage);
        Assert.True(firstEmit.Success, string.Join(Environment.NewLine, firstEmit.Diagnostics));
        MetadataReference firstReference =
            MetadataReference.CreateFromImage(firstImage.ToArray());

        LoadedCSharpProject second = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Second.cs", """
                    namespace Shared;

                    public static class Second
                    {
                        private sealed class Cache
                        {
                        }

                        public static object Convert(this object value, object argument) => argument;
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences().Append(firstReference).ToList(),
            "A.Dependent");
        Assert.True(second.BoundWithoutErrors, string.Join(Environment.NewLine, second.ErrorDiagnostics));

        string printedFirst = TranslateProject(
            first,
            new[] { first.Compilation });
        string printedSecond = TranslateProject(
            second,
            new[] { first.Compilation, second.Compilation });
        string combined = printedFirst + printedSecond;

        Assert.Equal(
            1,
            CountOccurrences(combined, "func (value object) Convert(argument object) object"));
        Assert.Contains(
            "func (value object) Convert(argument object) object",
            printedFirst,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "func (value object) Convert(argument object) object",
            printedSecond,
            StringComparison.Ordinal);
        Assert.Contains("class First", combined, StringComparison.Ordinal);
        Assert.Contains("class Second", combined, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printedFirst, printedSecond);
    }

    [Fact]
    public void OwnerScopedCompanion_RejectsExternAndNonPublicOwners()
    {
        const string source = """
            using System;
            using System.Runtime.InteropServices;

            namespace Issue3413
            {
                public static class Program
                {
                    public static void Main()
                    {
                        Console.WriteLine("a".InternalEcho());
                        Console.WriteLine("b".FileEcho());
                    }
                }

                internal static class InternalOwner
                {
                    private sealed class Cache
                    {
                    }

                    public static string InternalEcho(this string value) => value;
                }

                file static class FileOwner
                {
                    private sealed class Cache
                    {
                    }

                    public static string FileEcho(this string value) => value;
                }

                public static class NativeOwner
                {
                    private sealed class Cache
                    {
                    }

                    [DllImport("libc")]
                    public static extern int NativeAbs(this int value);
                }
            }
            """;

        (CompilationUnit unit, _) = Translate(source);
        string rendered = GSharpPrinter.Print(unit);

        Assert.DoesNotContain(
            unit.Members.OfType<MethodDeclaration>(),
            method => method.Name is "InternalEcho" or "FileEcho" or "NativeAbs");
        Assert.Contains("InternalOwner.InternalEcho(\"a\")", rendered, StringComparison.Ordinal);
        Assert.Contains("FileOwner.FileEcho(\"b\")", rendered, StringComparison.Ordinal);
        Assert.Contains("func NativeAbs(value int32) int32", rendered, StringComparison.Ordinal);
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
        File.WriteAllText(goldenPath, "42\n1\n42\n6\n4\n9\n4\nasync\n");

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
        Assert.Contains("return await ExtensionOwner.DelayIdentityAsync", translated, StringComparison.Ordinal);
        Assert.Contains("await ExtensionOwner.DelayAsync", translated, StringComparison.Ordinal);
        Assert.Contains(
            "let lengthAsync async () -> int32 = () -> ExtensionOwner.LengthAsync(\"four\")",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "let delayAsync async () -> void = () -> ExtensionOwner.DelayTextAsync(\"later\")",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "async func (value int32) ValueAsync() ValueTask[int32]",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "return await ExtensionOwner.ValueAsync(value)",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "async func (value int32) ValueNoteAsync() ValueTask",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "await ExtensionOwner.ValueNoteAsync(value)",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "let valueLengthAsync () -> ValueTask[int32] = () -> ExtensionOwner.ValueLengthAsync(\"five\")",
            translated,
            StringComparison.Ordinal);
        Assert.Contains(
            "let valueDelayAsync () -> ValueTask = () -> ExtensionOwner.ValueDelayAsync(\"later\")",
            translated,
            StringComparison.Ordinal);
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
        Assert.True(
            extensionOwner.GetField("cache", BindingFlags.NonPublic | BindingFlags.Static)!.IsPrivate);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("Identity", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("AddCached", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("DelayIdentityAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("DelayAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("LengthAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("DelayTextAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueNoteAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueLengthAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueDelayAsync", BindingFlags.Public | BindingFlags.Static)!.DeclaringType);

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

    [Fact]
    public void PrivateNestedExtensionBody_StaysOnOwnerAcrossProjectBoundary()
    {
        LoadedCSharpProject producer = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Producer.cs", """
                    namespace Issue3413;

                    public static class Extensions
                    {
                        private sealed class Box<T>
                        {
                            public static T Echo(T value) => value;
                        }

                        public static T Echo<T>(this T value) => Box<T>.Echo(value);
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences(),
            "Issue3413.Producer");
        Assert.True(
            producer.BoundWithoutErrors,
            string.Join(Environment.NewLine, producer.ErrorDiagnostics));

        using var image = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = producer.Compilation.Emit(image);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));

        MetadataReference producerReference = MetadataReference.CreateFromImage(image.ToArray());
        LoadedCSharpProject consumer = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Consumer.cs", """
                    using Issue3413;

                    namespace Consumer;

                    public static class Use
                    {
                        public static string Run(string value) => value.Echo();
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences().Append(producerReference).ToList(),
            "Issue3413.Consumer");
        Assert.True(
            consumer.BoundWithoutErrors,
            string.Join(Environment.NewLine, consumer.ErrorDiagnostics));

        CSharpCompilation[] siblings = { producer.Compilation, consumer.Compilation };
        LoadedDocument producerDocument = Assert.Single(producer.Documents);
        LoadedDocument consumerDocument = Assert.Single(consumer.Documents);
        string printedProducer = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(
                producerDocument,
                new TranslationContext(
                    producer.Compilation,
                    producerDocument.SemanticModel,
                    producerDocument.FilePath,
                    siblings)));
        string printedConsumer = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(
                consumerDocument,
                new TranslationContext(
                    consumer.Compilation,
                    consumerDocument.SemanticModel,
                    consumerDocument.FilePath,
                    siblings)));

        Assert.Contains("private class Box[T]", printedProducer, StringComparison.Ordinal);
        Assert.Contains("func Echo[T](value T) T", printedProducer, StringComparison.Ordinal);
        Assert.Contains(
            "func (value T) Echo[T]() T -> Extensions.Echo[T](value)",
            printedProducer,
            StringComparison.Ordinal);
        Assert.Contains("value.Echo()", printedConsumer, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printedProducer, printedConsumer);
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

    private static string TranslateProject(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> siblings)
    {
        var translator = new CSharpToGSharpTranslator();
        return string.Join(
            Environment.NewLine,
            project.Documents.Select(document =>
            {
                var context = new TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath,
                    siblings);
                return GSharpPrinter.Print(
                    translator.TranslateDocument(document, context));
            }));
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int index = text.IndexOf(value, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
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
