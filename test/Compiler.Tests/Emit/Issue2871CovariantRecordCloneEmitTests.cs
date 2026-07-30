// <copyright file="Issue2871CovariantRecordCloneEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

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

    [Fact]
    public void OpenNonDataIntermediary_InheritsAbstractClone_EmitsAbstractAndTypeLoads()
    {
        const string source = """
            package i2871intermediary

            open data class Base {
                open prop Kind string {
                    get;
                }
            }

            open class Middle : Base {
                override prop Kind string -> "middle"
            }
            """;

        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", source);
            IlVerifier.Verify(libraryPath);

            using (var stream = File.OpenRead(libraryPath))
            using (var peReader = new PEReader(stream))
            {
                var reader = peReader.GetMetadataReader();
                var middleType = FindType(reader, "Middle");
                var middleDefinition = reader.GetTypeDefinition(middleType);
                Assert.True((middleDefinition.Attributes & TypeAttributes.Abstract) != 0);
                Assert.DoesNotContain(
                    middleDefinition.GetMethods(),
                    handle => reader.GetString(reader.GetMethodDefinition(handle).Name) == "<Clone>$");
            }

            var loadContext = new AssemblyLoadContext("Issue2871-intermediary-" + Guid.NewGuid(), isCollectible: true);
            try
            {
                var assembly = loadContext.LoadFromAssemblyPath(libraryPath);
                Assert.True(assembly.GetType("i2871intermediary.Middle", throwOnError: true)!.IsAbstract);
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

    [Fact]
    public void ConcreteNonDataSubclass_OfAbstractDataClass_ReportsCloneDiagnostic()
    {
        var syntax = GsSyntaxTree.Parse(SourceText.From(
            """
            package i2871nondataderived

            open data class Base {
                open prop Kind string {
                    get;
                }
            }

            open class Middle : Base {
                override prop Kind string -> "leaf"
            }

            class Leaf : Middle {
            }
            """));
        var compilation = new GsCompilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue2871.NonDataDerived");

        Assert.False(result.Success);
        Assert.Contains(
            result.Diagnostics,
            diagnostic =>
                diagnostic.Id == "GS0387"
                && diagnostic.Message.Contains("<Clone>$", StringComparison.Ordinal));
    }

    [Fact]
    public void CSharpWithExpression_ThroughConstructedGenericAbstractBase_RunsAndPreservesBaseFields()
    {
        const string source = """
            package i2871genericruntime

            open data class Base[T] {
                prop Value T { get; init; }

                open prop Kind string {
                    get;
                }
            }

            data class Leaf(Extra int32) : Base[int32] {
                override prop Kind string -> "leaf"
            }
            """;
        const string csharp = """
            using i2871genericruntime;

            public static class Probe
            {
                public static string Run()
                {
                    Base<int> original = new Leaf(7) { Value = 3 };
                    var clone = original with { };
                    return $"{clone.GetType().Name}:{((Leaf)clone).Extra}:{original.Value}:{clone.Value}";
                }
            }
            """;

        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", source);
            IlVerifier.Verify(libraryPath);
            using (var stream = File.OpenRead(libraryPath))
            using (var peReader = new PEReader(stream))
            {
                var reader = peReader.GetMetadataReader();
                var baseType = FindType(reader, "Base`1");
                var leafType = FindType(reader, "Leaf");
                var baseClone = FindMethod(reader, baseType, "<Clone>$");
                var leafClone = FindMethod(reader, leafType, "<Clone>$");
                var leafCloneToken = MetadataTokens.GetToken(leafClone);
                var methodImpl = reader.GetTypeDefinition(leafType)
                    .GetMethodImplementations()
                    .Select(reader.GetMethodImplementation)
                    .Single(row => MetadataTokens.GetToken(row.MethodBody) == leafCloneToken);

                Assert.Equal(HandleKind.MemberReference, methodImpl.MethodDeclaration.Kind);
                var baseCloneReference = reader.GetMemberReference((MemberReferenceHandle)methodImpl.MethodDeclaration);
                Assert.Equal(reader.GetTypeDefinition(leafType).BaseType, baseCloneReference.Parent);
                Assert.Equal(
                    reader.GetBlobBytes(reader.GetMethodDefinition(baseClone).Signature),
                    reader.GetBlobBytes(baseCloneReference.Signature));

                var baseCopyConstructor = FindCopyConstructor(reader, baseType);
                var baseCopyConstructorSignature = reader.GetBlobBytes(
                    reader.GetMethodDefinition(baseCopyConstructor).Signature);
                var baseCopyConstructorReference = reader.MemberReferences.Single(handle =>
                {
                    var reference = reader.GetMemberReference(handle);
                    return reader.GetString(reference.Name) == ".ctor"
                        && reference.Parent == reader.GetTypeDefinition(leafType).BaseType
                        && reader.GetBlobBytes(reference.Signature).SequenceEqual(baseCopyConstructorSignature);
                });
                Assert.Equal(
                    HandleKind.TypeSpecification,
                    reader.GetMemberReference(baseCopyConstructorReference).Parent.Kind);
                Assert.True(TypeContainsCallTo(peReader, reader, leafType, baseCopyConstructorReference));
            }

            Assert.Equal(
                "Leaf:7:3:3",
                CompileCSharpConsumerAndRun(directory, libraryPath, csharp));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void CopyConstructor_DerivedDeclaredBeforeBase_UsesPlannedBaseRowAndPreservesFields()
    {
        const string source = """
            package i2871reversed

            data class Leaf(Extra int32) : Base {
                override prop Kind string -> "leaf"
            }

            open data class Base {
                prop Id int32 { get; init; }

                open prop Kind string {
                    get;
                }
            }
            """;
        const string csharp = """
            using i2871reversed;

            public static class Probe
            {
                public static string Run()
                {
                    Base original = new Leaf(7) { Id = 3 };
                    var clone = original with { };
                    return $"{clone.GetType().Name}:{((Leaf)clone).Extra}:{clone.Id}";
                }
            }
            """;

        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", source);
            IlVerifier.Verify(libraryPath);

            using (var stream = File.OpenRead(libraryPath))
            using (var peReader = new PEReader(stream))
            {
                var reader = peReader.GetMetadataReader();
                var baseCopyConstructor = FindCopyConstructor(reader, FindType(reader, "Base"));
                var leafCopyConstructor = FindCopyConstructor(reader, FindType(reader, "Leaf"));
                Assert.True(MethodContainsCallTo(
                    peReader,
                    reader,
                    leafCopyConstructor,
                    baseCopyConstructor));
            }

            Assert.Equal(
                "Leaf:7:3",
                CompileCSharpConsumerAndRun(directory, libraryPath, csharp));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void CopyConstructor_ThroughNonDataIntermediary_UsesDirectCtorChainAndPreservesFields()
    {
        const string source = """
            package i2871copyintermediary

            data class Leaf(LeafValue int32) : Middle {
            }

            open class Middle : Base {
                prop MiddleValue int32 { get; init; }

                override prop Kind string -> "middle"
            }

            open data class Base {
                prop BaseValue int32 { get; init; }

                open prop Kind string {
                    get;
                }
            }
            """;
        const string csharp = """
            using i2871copyintermediary;

            public static class Probe
            {
                public static string Run()
                {
                    Base original = new Leaf(7) { BaseValue = 3, MiddleValue = 5 };
                    var clone = (Leaf)(original with { });
                    return $"{clone.GetType().Name}:{clone.LeafValue}:{clone.MiddleValue}:{clone.BaseValue}";
                }
            }
            """;

        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", source);
            IlVerifier.Verify(libraryPath);

            using (var stream = File.OpenRead(libraryPath))
            using (var peReader = new PEReader(stream))
            {
                var reader = peReader.GetMetadataReader();
                var baseType = FindType(reader, "Base");
                var middleType = FindType(reader, "Middle");
                var leafType = FindType(reader, "Leaf");
                var baseCopyConstructor = FindCopyConstructor(reader, baseType);
                var middleCopyConstructor = FindCopyConstructor(reader, middleType);
                var leafCopyConstructor = FindCopyConstructor(reader, leafType);

                Assert.True(MethodContainsCallTo(
                    peReader,
                    reader,
                    middleCopyConstructor,
                    baseCopyConstructor));
                Assert.True(MethodContainsCallTo(
                    peReader,
                    reader,
                    leafCopyConstructor,
                    middleCopyConstructor));
                AssertCloneMethodImpl(
                    reader,
                    leafType,
                    FindMethod(reader, leafType, "<Clone>$"),
                    FindMethod(reader, baseType, "<Clone>$"));
            }

            Assert.Equal(
                "Leaf:7:5:3",
                CompileCSharpConsumerAndRun(directory, libraryPath, csharp));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void CopyConstructor_FromImportedDataBase_UsesMemberRefAndPreservesFields()
    {
        const string baseSource = """
            package i2871importedbase

            open data class Base {
                prop BaseValue int32 { get; init; }

                open prop Kind string {
                    get;
                }
            }
            """;
        const string derivedSource = """
            package i2871importedderived

            import i2871importedbase

            data class Leaf(LeafValue int32) : Base {
                override prop Kind string -> "leaf"
            }
            """;
        const string csharp = """
            using i2871importedbase;
            using i2871importedderived;

            public static class Probe
            {
                public static string Run()
                {
                    Base original = new Leaf(7) { BaseValue = 3 };
                    var clone = original with { };
                    return $"{clone.GetType().Name}:{((Leaf)clone).LeafValue}:{clone.BaseValue}";
                }
            }
            """;

        var directory = CreateArtifactsDirectory();
        try
        {
            var basePath = CompileGSharpLibrary(directory, "BaseRecords", baseSource);
            var derivedPath = CompileGSharpLibrary(directory, "DerivedRecords", derivedSource, basePath);
            IlVerifier.Verify(basePath);
            IlVerifier.Verify(derivedPath, new[] { basePath });

            using (var stream = File.OpenRead(derivedPath))
            using (var peReader = new PEReader(stream))
            {
                var reader = peReader.GetMetadataReader();
                var leafType = FindType(reader, "Leaf");
                var leafCopyConstructor = FindCopyConstructor(reader, leafType);
                var importedBaseCopyConstructor = reader.MemberReferences.Single(handle =>
                {
                    var reference = reader.GetMemberReference(handle);
                    if (reader.GetString(reference.Name) != ".ctor"
                        || reference.Parent.Kind != HandleKind.TypeReference
                        || GetParameterCount(reader, reference.Signature) != 1)
                    {
                        return false;
                    }

                    var parent = reader.GetTypeReference((TypeReferenceHandle)reference.Parent);
                    return reader.GetString(parent.Namespace) == "i2871importedbase"
                        && reader.GetString(parent.Name) == "Base";
                });

                Assert.True(MethodContainsCallTo(
                    peReader,
                    reader,
                    leafCopyConstructor,
                    importedBaseCopyConstructor));
            }

            Assert.Equal(
                "Leaf:7:3",
                CompileCSharpConsumerAndRun(directory, new[] { basePath, derivedPath }, csharp));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
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

    private static MethodDefinitionHandle FindCopyConstructor(
        MetadataReader reader,
        TypeDefinitionHandle typeHandle)
    {
        return reader.GetTypeDefinition(typeHandle)
            .GetMethods()
            .Where(handle => reader.GetString(reader.GetMethodDefinition(handle).Name) == ".ctor")
            .Single(handle =>
            {
                var definition = reader.GetMethodDefinition(handle);
                if ((definition.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public)
                {
                    return false;
                }

                var signature = reader.GetBlobReader(definition.Signature);
                var header = signature.ReadSignatureHeader();
                if (header.IsGeneric)
                {
                    _ = signature.ReadCompressedInteger();
                }

                return signature.ReadCompressedInteger() == 1;
            });
    }

    private static int GetParameterCount(MetadataReader reader, BlobHandle signatureHandle)
    {
        var signature = reader.GetBlobReader(signatureHandle);
        var header = signature.ReadSignatureHeader();
        if (header.IsGeneric)
        {
            _ = signature.ReadCompressedInteger();
        }

        return signature.ReadCompressedInteger();
    }

    private static bool TypeContainsCallTo(
        PEReader peReader,
        MetadataReader reader,
        TypeDefinitionHandle typeHandle,
        MemberReferenceHandle target)
    {
        foreach (var methodHandle in reader.GetTypeDefinition(typeHandle).GetMethods())
        {
            if (MethodContainsCallTo(peReader, reader, methodHandle, target))
            {
                return true;
            }
        }

        return false;
    }

    private static bool MethodContainsCallTo(
        PEReader peReader,
        MetadataReader reader,
        MethodDefinitionHandle methodHandle,
        EntityHandle target)
    {
        var method = reader.GetMethodDefinition(methodHandle);
        if (method.RelativeVirtualAddress == 0)
        {
            return false;
        }

        var targetToken = MetadataTokens.GetToken(target);
        var il = peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes();
        for (var i = 0; il != null && i + 4 < il.Length; i++)
        {
            if (il[i] == 0x28
                && BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(i + 1, 4)) == targetToken)
            {
                return true;
            }
        }

        return false;
    }

    private static string CompileCSharpConsumerAndRun(string gsharp, string csharp)
    {
        var directory = CreateArtifactsDirectory();
        try
        {
            var libraryPath = CompileGSharpLibrary(directory, "Records", gsharp);
            IlVerifier.Verify(libraryPath);
            return CompileCSharpConsumerAndRun(directory, libraryPath, csharp);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileCSharpConsumerAndRun(string directory, string libraryPath, string csharp)
        => CompileCSharpConsumerAndRun(directory, new[] { libraryPath }, csharp);

    private static string CompileCSharpConsumerAndRun(string directory, string[] libraryPaths, string csharp)
    {
        var consumerPath = Path.Combine(directory, "Consumer.dll");
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Concat(libraryPaths.Select(path => MetadataReference.CreateFromFile(path)));
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
            foreach (var libraryPath in libraryPaths)
            {
                _ = loadContext.LoadFromAssemblyPath(libraryPath).GetTypes();
            }

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

    private static string CompileGSharpLibrary(
        string directory,
        string assemblyName,
        string source,
        params string[] references)
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
            var arguments = new[]
                {
                    "/out:" + libraryPath,
                    "/target:library",
                    "/targetframework:net10.0",
                }
                .Concat(references.Select(reference => "/r:" + reference))
                .Append(sourcePath)
                .ToArray();
            exitCode = Program.Main(arguments);
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
