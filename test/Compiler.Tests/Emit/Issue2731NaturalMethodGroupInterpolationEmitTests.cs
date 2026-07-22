// <copyright file="Issue2731NaturalMethodGroupInterpolationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and ILVerify coverage for issue #2731.</summary>
public sealed class Issue2731NaturalMethodGroupInterpolationEmitTests
{
    [Fact]
    public void OahuCoreImportedExtensionMethodGroup_Interpolation_InfersFuncAndRuns()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2731NaturalMethodGroupInterpolationEmitTests));
        Directory.CreateDirectory(directory);
        var libraryPath = EmitOahuCoreLibrary(directory);
        var consumerPath = Path.Combine(directory, "Issue2731.Consumer.dll");

        const string source = """
            package Issue2731
            import Oahu.Core

            func SourceChecksum() uint32 -> 42u

            data class Profile(AccountName string?) {
                func Render() string ->
                    "imported=${AccountName!!.Checksum32}; source=${SourceChecksum}"
            }

            func Run() string -> Profile("account").Render()
            """;

        using (var resolver = ReferenceResolver.WithReferences(new[] { libraryPath }))
        {
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(source)))
            {
                IsLibrary = true,
            };

            using var output = File.Create(consumerPath);
            var result = compilation.Emit(
                output,
                pdbStream: null,
                refStream: null,
                assemblyName: "Issue2731.Consumer");
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var loadContext = new AssemblyLoadContext("Issue2731", isCollectible: true);
        try
        {
            _ = loadContext.LoadFromAssemblyPath(libraryPath);
            var consumer = loadContext.LoadFromAssemblyPath(consumerPath);
            var run = consumer.GetTypes()
                .Single(type => type.Name == "<Program>")
                .GetMethod("Run", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(run);
            Assert.Equal(
                "imported=System.Func`1[System.UInt32]; source=System.Func`1[System.UInt32]",
                run!.Invoke(null, null));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static string EmitOahuCoreLibrary(string directory)
    {
        const string source = """
            namespace Oahu.Core;

            public static class ChecksumExtensions
            {
                public static uint Checksum32(this string value) => (uint)value.Length;
            }
            """;

        var libraryPath = Path.Combine(directory, "Oahu.Core.dll");
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Oahu.Core",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var output = File.Create(libraryPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
