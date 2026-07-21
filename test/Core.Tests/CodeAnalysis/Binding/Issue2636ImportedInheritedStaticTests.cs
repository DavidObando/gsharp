// <copyright file="Issue2636ImportedInheritedStaticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2636ImportedInheritedStaticTests
{
    [Fact]
    public void OahuBookDbContextLazyLoad_StartupAsyncAndStaticData_BindAcrossAssemblies()
    {
        var (basePath, derivedPath) = EmitLibraries();
        var result = Compile(
            basePath,
            derivedPath,
            """
            package Issue2636.Consumer
            import System.Threading.Tasks
            import Issue2636.Derived

            async func MainWindowStartupAsync() bool {
                let canConnect bool = await BookDbContextLazyLoad.StartupAsync()!!
                return canConnect
            }

            class CoreEnvironment {
                shared {
                    func InitializeDatabaseAsync() Task[bool] ->
                        BookDbContextLazyLoad.StartupAsync()!!

                    func InitializeDatabase() bool ->
                        BookDbContextLazyLoad.StartupAsync()!!.GetAwaiter().GetResult()

                    func InitializeFromMethodGroup() bool {
                        let value () -> int32 = BookDbContextLazyLoad.Value
                        return value() == 42
                    }
                }
            }

            func ReadStaticData() string ->
                BookDbContextLazyLoad.Field!! + BookDbContextLazyLoad.Property!!
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void DerivedDeclaration_HidesBaseOverloadSet()
    {
        var (basePath, derivedPath) = EmitLibraries();
        var valid = Compile(
            basePath,
            derivedPath,
            """
            package Issue2636.Consumer
            import Issue2636.Derived
            func Pick() string -> HidingDerived.Pick("derived")!!
            """);
        Assert.True(valid.Success, string.Join(Environment.NewLine, valid.Diagnostics));

        var invalid = Compile(
            basePath,
            derivedPath,
            """
            package Issue2636.Consumer
            import Issue2636.Derived
            func Pick() string -> HidingDerived.Pick(1)
            """);
        Assert.Contains(invalid.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void InaccessibleDeclarations_DoNotExposeInheritedStaticMembers()
    {
        var (basePath, derivedPath) = EmitLibraries();
        var result = Compile(
            basePath,
            derivedPath,
            """
            package Issue2636.Consumer
            import Issue2636.Derived

            func PrivateCall() string -> BookDbContextLazyLoad.PrivateOnly()
            func InternalCall() string -> BookDbContextLazyLoad.InternalOnly()
            func ProtectedCall() string -> BookDbContextLazyLoad.ProtectedOnly()
            """);

        Assert.Equal(3, result.Diagnostics.Count(d => d.Id == "GS0159"));
    }

    [Fact]
    public void InaccessibleDerivedDeclaration_DoesNotHideAccessibleBaseMember()
    {
        var (basePath, derivedPath) = EmitLibraries();
        var result = Compile(
            basePath,
            derivedPath,
            """
            package Issue2636.Consumer
            import Issue2636.Derived
            func Pick() string -> InaccessibleHidingDerived.Pick(1)!!
            """);

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void InheritedOverloadAmbiguity_RemainsAmbiguous()
    {
        var (basePath, derivedPath) = EmitLibraries();
        var result = Compile(
            basePath,
            derivedPath,
            """
            package Issue2636.Consumer
            import Issue2636.Base
            import Issue2636.Derived
            func Pick(value Both) string -> BookDbContextLazyLoad.Ambiguous(value)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0160");
    }

    private static (string BasePath, string DerivedPath) EmitLibraries()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2636ImportedInheritedStaticTests));
        Directory.CreateDirectory(directory);
        var basePath = Path.Combine(directory, "Issue2636.Base.dll");
        var derivedPath = Path.Combine(directory, "Issue2636.Derived.dll");

        EmitCSharp(
            basePath,
            "Issue2636.Base",
            """
            using System.Threading.Tasks;

            namespace Issue2636.Base;

            public interface ILeft;
            public interface IRight;
            public sealed class Both : ILeft, IRight;

            public class BookDbContext
            {
                public static string Field = "field";
                public static string Property => "property";
                public static int Value() => 42;
                public static Task<bool> StartupAsync() => Task.FromResult(true);
                public static string Ambiguous(ILeft value) => "left";
                public static string Ambiguous(IRight value) => "right";
                private static string PrivateOnly() => "private";
                internal static string InternalOnly() => "internal";
                protected static string ProtectedOnly() => "protected";
            }

            public class HidingBase
            {
                public static string Pick(int value) => "base";
            }
            """);

        EmitCSharp(
            derivedPath,
            "Issue2636.Derived",
            """
            using Issue2636.Base;

            namespace Issue2636.Derived;

            public sealed class BookDbContextLazyLoad : BookDbContext;

            public sealed class HidingDerived : HidingBase
            {
                public new static string Pick(string value) => "derived";
            }

            public sealed class InaccessibleHidingDerived : HidingBase
            {
                private new static string Pick(int value) => "hidden";
            }
            """,
            basePath);

        return (basePath, derivedPath);
    }

    private static (bool Success, System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics) Compile(
        string basePath,
        string derivedPath,
        string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { basePath, derivedPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2636.Consumer");
        return (result.Success, result.Diagnostics);
    }

    private static void EmitCSharp(string path, string assemblyName, string source, params string[] additionalReferences)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(reference => (MetadataReference)MetadataReference.CreateFromFile(reference))
            .Concat(additionalReferences.Select(reference => MetadataReference.CreateFromFile(reference)));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
