// <copyright file="Issue2871CovariantRecordCloneEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2871: abstract data classes retain the C# record clone contract.
/// Abstract clones have no body; derived covariant clones use MethodImpl rows
/// and PreserveBaseOverridesAttribute so every base-typed with-expression
/// dispatches to the most-derived copy constructor without TypeLoadException.
/// </summary>
public sealed class Issue2871CovariantRecordCloneEmitTests
{
    [Fact]
    public void AbstractCloneChain_HasPlannedRowsMethodImplsAndPreserveAttributes()
    {
        const string source = """
            package i2871metadata

            open data class Base {
                prop Id int32 { get; init; }

                open prop Kind string {
                    get;
                }

                func Describe() string -> this.Kind + ":" + this.Id.ToString()
            }

            open data class Middle : Base {
            }

            data class Leaf(Value int32) : Middle {
                override prop Kind string -> "leaf"
            }
            """;

        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", source);
            IlVerifier.Verify(libraryPath);

            using var stream = File.OpenRead(libraryPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            var baseType = FindType(reader, "Base");
            var middleType = FindType(reader, "Middle");
            var leafType = FindType(reader, "Leaf");
            var baseClone = FindMethod(reader, baseType, "<Clone>$");
            var middleClone = FindMethod(reader, middleType, "<Clone>$");
            var leafClone = FindMethod(reader, leafType, "<Clone>$");

            AssertAbstractClone(reader.GetMethodDefinition(baseClone));
            AssertAbstractClone(reader.GetMethodDefinition(middleClone));

            var leafCloneDefinition = reader.GetMethodDefinition(leafClone);
            Assert.True((leafCloneDefinition.Attributes & MethodAttributes.Virtual) != 0);
            Assert.True((leafCloneDefinition.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.True((leafCloneDefinition.Attributes & MethodAttributes.Abstract) == 0);
            Assert.NotEqual(0, leafCloneDefinition.RelativeVirtualAddress);

            AssertCloneMethodImpl(reader, middleType, middleClone, baseClone);
            AssertCloneMethodImpl(reader, leafType, leafClone, middleClone);
            Assert.False(HasPreserveBaseOverridesAttribute(reader, baseClone));
            Assert.True(HasPreserveBaseOverridesAttribute(reader, middleClone));
            Assert.True(HasPreserveBaseOverridesAttribute(reader, leafClone));

            var describe = FindMethod(reader, baseType, "Describe");
            Assert.Equal(
                8,
                MetadataTokens.GetRowNumber(describe) - MetadataTokens.GetRowNumber(baseClone));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void CSharpWithExpression_ThroughAbstractCloneChain_Runs()
    {
        const string gsharp = """
            package i2871runtime

            open data class Base {
                prop Id int32 { get; init; }

                open prop Kind string {
                    get;
                }
            }

            open data class Middle : Base {
            }

            data class Leaf(Value int32) : Middle {
                override prop Kind string -> "leaf"
            }
            """;
        const string csharp = """
            using i2871runtime;

            public static class Probe
            {
                public static string Run()
                {
                    Base original = new Leaf(7) { Id = 3 };
                    Middle middle = (Middle)original;
                    Leaf leaf = (Leaf)original;
                    var fromBase = original with { };
                    var fromMiddle = middle with { };
                    var fromLeaf = leaf with { Value = 8 };
                    return $"{fromBase.GetType().Name}:{((Leaf)fromBase).Value}:{fromBase.Id}|{fromMiddle.GetType().Name}:{((Leaf)fromMiddle).Value}:{fromMiddle.Id}|{fromLeaf.Value}";
                }
            }
            """;

        Assert.Equal(
            "Leaf:7:3|Leaf:7:3|8",
            CompileCSharpConsumerAndRun(gsharp, csharp));
    }

    private static void AssertAbstractClone(MethodDefinition clone)
    {
        Assert.True((clone.Attributes & MethodAttributes.Abstract) != 0);
        Assert.True((clone.Attributes & MethodAttributes.Virtual) != 0);
        Assert.True((clone.Attributes & MethodAttributes.NewSlot) != 0);
        Assert.Equal(0, clone.RelativeVirtualAddress);
    }

    private static void AssertCloneMethodImpl(
        MetadataReader reader,
        TypeDefinitionHandle implementingType,
        MethodDefinitionHandle body,
        MethodDefinitionHandle declaration)
    {
        var bodyToken = MetadataTokens.GetToken(body);
        var methodImpl = reader.GetTypeDefinition(implementingType)
            .GetMethodImplementations()
            .Select(reader.GetMethodImplementation)
            .Single(row => MetadataTokens.GetToken(row.MethodBody) == bodyToken);
        Assert.Equal(MetadataTokens.GetToken(declaration), MetadataTokens.GetToken(methodImpl.MethodDeclaration));
    }

    private static bool HasPreserveBaseOverridesAttribute(
        MetadataReader reader,
        MethodDefinitionHandle methodHandle)
    {
        foreach (var attributeHandle in reader.GetMethodDefinition(methodHandle).GetCustomAttributes())
        {
            var attribute = reader.GetCustomAttribute(attributeHandle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            var constructor = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (constructor.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var attributeType = reader.GetTypeReference((TypeReferenceHandle)constructor.Parent);
            if (reader.GetString(attributeType.Namespace) == "System.Runtime.CompilerServices"
                && reader.GetString(attributeType.Name) == "PreserveBaseOverridesAttribute")
            {
                return true;
            }
        }

        return false;
    }

    private static TypeDefinitionHandle FindType(MetadataReader reader, string name)
    {
        return reader.TypeDefinitions.Single(handle =>
            reader.GetString(reader.GetTypeDefinition(handle).Name) == name);
    }

    private static MethodDefinitionHandle FindMethod(
        MetadataReader reader,
        TypeDefinitionHandle typeHandle,
        string name)
    {
        return reader.GetTypeDefinition(typeHandle)
            .GetMethods()
            .Single(handle => reader.GetString(reader.GetMethodDefinition(handle).Name) == name);
    }

    private static string CompileCSharpConsumerAndRun(string gsharp, string csharp)
    {
        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", gsharp);
            IlVerifier.Verify(libraryPath);

            var consumerPath = Path.Combine(directory, "Consumer.dll");
            var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                    ?.Split(Path.PathSeparator)
                    ?? Array.Empty<string>())
                .Where(File.Exists)
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
                .Append(MetadataReference.CreateFromFile(libraryPath));
            var consumer = CSharpCompilation.Create(
                "Consumer",
                new[] { CSharpSyntaxTree.ParseText(csharp, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using (var output = File.Create(consumerPath))
            {
                var result = consumer.Emit(output);
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            }

            var loadContext = new AssemblyLoadContext("Issue2871-" + Guid.NewGuid(), isCollectible: true);
            try
            {
                _ = loadContext.LoadFromAssemblyPath(libraryPath);
                var consumerAssembly = loadContext.LoadFromAssemblyPath(consumerPath);
                return (string)consumerAssembly.GetType("Probe", throwOnError: true)!
                    .GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!
                    .Invoke(null, null)!;
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileGSharpLibrary(string directory, string assemblyName, string source)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var libraryPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
        return libraryPath;
    }

    private static string CreateArtifactsDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2871-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
