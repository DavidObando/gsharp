// <copyright file="Issue2871CovariantRecordCloneEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Buffers.Binary
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

/// Issue #2871: abstract data classes retain the C# record clone contract.
/// Abstract clones have no body; derived covariant clones use MethodImpl rows
/// and PreserveBaseOverridesAttribute so every base-typed with-expression
/// dispatches to the most-derived copy constructor without TypeLoadException.
class Issue2871CovariantRecordCloneEmitTests {
    @Fact
    func AbstractCloneChain_HasPlannedRowsMethodImplsAndPreserveAttributes() {
        const source = `package i2871metadata

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
}`
        let directory = CreateArtifactsDirectory()
        try {
            let libraryPath = CompileGSharpLibrary(directory, "Records", source)
            IlVerifier.Verify(libraryPath)
            using let stream = File.OpenRead(libraryPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let baseType = FindType(reader, "Base")
            let middleType = FindType(reader, "Middle")
            let leafType = FindType(reader, "Leaf")
            let baseClone = FindMethod(reader, baseType, "<Clone>$$")
            let middleClone = FindMethod(reader, middleType, "<Clone>$$")
            let leafClone = FindMethod(reader, leafType, "<Clone>$$")
            AssertAbstractClone(reader.GetMethodDefinition(baseClone))
            AssertAbstractClone(reader.GetMethodDefinition(middleClone))
            let leafCloneDefinition = reader.GetMethodDefinition(leafClone)
            Assert.True((leafCloneDefinition.Attributes & MethodAttributes.Virtual) != 0)
            Assert.True((leafCloneDefinition.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.True((leafCloneDefinition.Attributes & MethodAttributes.Abstract) == 0)
            Assert.NotEqual(0, leafCloneDefinition.RelativeVirtualAddress)
            AssertCloneMethodImpl(reader, middleType, middleClone, baseClone)
            AssertCloneMethodImpl(reader, leafType, leafClone, middleClone)
            Assert.False(HasPreserveBaseOverridesAttribute(reader, baseClone))
            Assert.True(HasPreserveBaseOverridesAttribute(reader, middleClone))
            Assert.True(HasPreserveBaseOverridesAttribute(reader, leafClone))
            let describe = FindMethod(reader, baseType, "Describe")
            // ADR-0199 adds the synthesized PrintMembers row after the other
            // synthesized members, ahead of the user's Describe.
            Assert.Equal(9, MetadataTokens.GetRowNumber(describe) - MetadataTokens.GetRowNumber(baseClone))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func CSharpWithExpression_ThroughAbstractCloneChain_Runs() {
        const gsharp = `package i2871runtime

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
}`
        const csharp = `using i2871runtime;

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
}`
        Assert.Equal("Leaf:7:3|Leaf:7:3|8", CompileCSharpConsumerAndRun(gsharp, csharp))
    }

    @Fact
    func OpenNonDataIntermediary_InheritsAbstractClone_EmitsAbstractAndTypeLoads() {
        const source = `package i2871intermediary

open data class Base {
    open prop Kind string {
        get;
    }
}

open class Middle : Base {
    override prop Kind string -> "middle"
}`
        let directory = CreateArtifactsDirectory()
        try {
            let libraryPath = CompileGSharpLibrary(directory, "Records", source)
            IlVerifier.Verify(libraryPath)
            {
                using let stream = File.OpenRead(libraryPath)
                {
                    using let peReader = PEReader(stream)
                    let reader = peReader.GetMetadataReader()
                    let middleType = FindType(reader, "Middle")
                    let middleDefinition = reader.GetTypeDefinition(middleType)
                    Assert.True((middleDefinition.Attributes & TypeAttributes.Abstract) != 0)
                    Assert.DoesNotContain(
                        middleDefinition.GetMethods(),
                        (handle MethodDefinitionHandle) -> reader.GetString(
                            reader.GetMethodDefinition(handle).Name
                        ) == "<Clone>$$"
                    )
                }
            }
            let loadContext = AssemblyLoadContext(
                "Issue2871-intermediary-" + Guid.NewGuid().ToString(),
                isCollectible: true
            )
            try {
                let assembly = loadContext.LoadFromAssemblyPath(libraryPath)
                Assert.True(assembly.GetType("i2871intermediary.Middle", throwOnError: true)!!.IsAbstract)
            } finally {
                loadContext.Unload()
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ConcreteNonDataSubclass_OfAbstractDataClass_ReportsCloneDiagnostic() {
        let syntax = GsSyntaxTree.Parse(SourceText.From(`package i2871nondataderived

open data class Base {
    open prop Kind string {
        get;
    }
}

open class Middle : Base {
    override prop Kind string -> "leaf"
}

class Leaf : Middle {
}`))
        let compilation = GsCompilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2871.NonDataDerived")
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0387" &&
                diagnostic
                .Message
                .Contains("<Clone>$$", StringComparison.Ordinal)
        )
    }

    @Fact
    func CSharpWithExpression_ThroughConstructedGenericAbstractBase_RunsAndPreservesBaseFields() {
        const source = `package i2871genericruntime

open data class Base[T] {
    prop Value T { get; init; }

    open prop Kind string {
        get;
    }
}

data class Leaf(Extra int32) : Base[int32] {
    override prop Kind string -> "leaf"
}`
        const csharp = `using i2871genericruntime;

public static class Probe
{
    public static string Run()
    {
        Base<int> original = new Leaf(7) { Value = 3 };
        var clone = original with { };
        return $"{clone.GetType().Name}:{((Leaf)clone).Extra}:{original.Value}:{clone.Value}";
    }
}`
        let directory = CreateArtifactsDirectory()
        try {
            let libraryPath = CompileGSharpLibrary(directory, "Records", source)
            IlVerifier.Verify(libraryPath)
            {
                using let stream = File.OpenRead(libraryPath)
                {
                    using let peReader = PEReader(stream)
                    let reader = peReader.GetMetadataReader()
                    let baseType = FindType(reader, "Base`1")
                    let leafType = FindType(reader, "Leaf")
                    let baseClone = FindMethod(reader, baseType, "<Clone>$$")
                    let leafClone = FindMethod(reader, leafType, "<Clone>$$")
                    let leafCloneToken = MetadataTokens.GetToken(leafClone)
                    let methodImpl = reader
                        .GetTypeDefinition(leafType)
                        .GetMethodImplementations()
                        .Select(reader.GetMethodImplementation)
                        .Single((row MethodImplementation) -> MetadataTokens.GetToken(row.MethodBody) == leafCloneToken)
                    Assert.Equal(HandleKind.MemberReference, methodImpl.MethodDeclaration.Kind)
                    let baseCloneReference = reader.GetMemberReference(
                        MemberReferenceHandle(methodImpl.MethodDeclaration)
                    )
                    Assert.Equal(reader.GetTypeDefinition(leafType).BaseType, baseCloneReference.Parent)
                    Assert.Equal(
                        reader.GetBlobBytes(reader.GetMethodDefinition(baseClone).Signature),
                        reader.GetBlobBytes(baseCloneReference.Signature)
                    )
                    let baseCopyConstructor = FindCopyConstructor(reader, baseType)
                    let baseCopyConstructorSignature = reader.GetBlobBytes(
                        reader.GetMethodDefinition(baseCopyConstructor).Signature
                    )
                    let baseCopyConstructorReference = reader.MemberReferences.Single(
                        (handle MemberReferenceHandle) -> {
                            let reference = reader.GetMemberReference(handle)
                            return reader.GetString(reference.Name) == ".ctor" &&
                                reference.Parent == reader
                                .GetTypeDefinition(leafType).BaseType && reader.GetBlobBytes(reference.Signature)
                                .SequenceEqual(baseCopyConstructorSignature)
                        }
                    )
                    Assert.Equal(
                        HandleKind.TypeSpecification,
                        reader.GetMemberReference(baseCopyConstructorReference).Parent.Kind
                    )
                    Assert.True(TypeContainsCallTo(peReader, reader, leafType, baseCopyConstructorReference))
                }
            }
            Assert.Equal("Leaf:7:3:3", CompileCSharpConsumerAndRun(directory, libraryPath, csharp))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func CopyConstructor_DerivedDeclaredBeforeBase_UsesPlannedBaseRowAndPreservesFields() {
        const source = `package i2871reversed

data class Leaf(Extra int32) : Base {
    override prop Kind string -> "leaf"
}

open data class Base {
    prop Id int32 { get; init; }

    open prop Kind string {
        get;
    }
}`
        const csharp = `using i2871reversed;

public static class Probe
{
    public static string Run()
    {
        Base original = new Leaf(7) { Id = 3 };
        var clone = original with { };
        return $"{clone.GetType().Name}:{((Leaf)clone).Extra}:{clone.Id}";
    }
}`
        let directory = CreateArtifactsDirectory()
        try {
            let libraryPath = CompileGSharpLibrary(directory, "Records", source)
            IlVerifier.Verify(libraryPath)
            {
                using let stream = File.OpenRead(libraryPath)
                {
                    using let peReader = PEReader(stream)
                    let reader = peReader.GetMetadataReader()
                    let baseCopyConstructor = FindCopyConstructor(reader, FindType(reader, "Base"))
                    let leafCopyConstructor = FindCopyConstructor(reader, FindType(reader, "Leaf"))
                    Assert.True(MethodContainsCallTo(peReader, reader, leafCopyConstructor, baseCopyConstructor))
                }
            }
            Assert.Equal("Leaf:7:3", CompileCSharpConsumerAndRun(directory, libraryPath, csharp))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func CopyConstructor_ThroughNonDataIntermediary_UsesDirectCtorChainAndPreservesFields() {
        const source = `package i2871copyintermediary

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
}`
        const csharp = `using i2871copyintermediary;

public static class Probe
{
    public static string Run()
    {
        Base original = new Leaf(7) { BaseValue = 3, MiddleValue = 5 };
        var clone = (Leaf)(original with { });
        return $"{clone.GetType().Name}:{clone.LeafValue}:{clone.MiddleValue}:{clone.BaseValue}";
    }
}`
        let directory = CreateArtifactsDirectory()
        try {
            let libraryPath = CompileGSharpLibrary(directory, "Records", source)
            IlVerifier.Verify(libraryPath)
            {
                using let stream = File.OpenRead(libraryPath)
                {
                    using let peReader = PEReader(stream)
                    let reader = peReader.GetMetadataReader()
                    let baseType = FindType(reader, "Base")
                    let middleType = FindType(reader, "Middle")
                    let leafType = FindType(reader, "Leaf")
                    let baseCopyConstructor = FindCopyConstructor(reader, baseType)
                    let middleCopyConstructor = FindCopyConstructor(reader, middleType)
                    let leafCopyConstructor = FindCopyConstructor(reader, leafType)
                    Assert.True(MethodContainsCallTo(peReader, reader, middleCopyConstructor, baseCopyConstructor))
                    Assert.True(MethodContainsCallTo(peReader, reader, leafCopyConstructor, middleCopyConstructor))
                    AssertCloneMethodImpl(
                        reader,
                        leafType,
                        FindMethod(reader, leafType, "<Clone>$$"),
                        FindMethod(reader, baseType, "<Clone>$$")
                    )
                }
            }
            Assert.Equal("Leaf:7:5:3", CompileCSharpConsumerAndRun(directory, libraryPath, csharp))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func AssertAbstractClone(clone MethodDefinition) {
            Assert.True((clone.Attributes & MethodAttributes.Abstract) != 0)
            Assert.True((clone.Attributes & MethodAttributes.Virtual) != 0)
            Assert.True((clone.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.Equal(0, clone.RelativeVirtualAddress)
        }

        private func AssertCloneMethodImpl(
            reader MetadataReader,
            implementingType TypeDefinitionHandle,
            body MethodDefinitionHandle,
            declaration MethodDefinitionHandle
        ) {
            let bodyToken = MetadataTokens.GetToken(body)
            let methodImpl = reader
                .GetTypeDefinition(implementingType)
                .GetMethodImplementations()
                .Select(reader.GetMethodImplementation)
                .Single((row MethodImplementation) -> MetadataTokens.GetToken(row.MethodBody) == bodyToken)
            Assert.Equal(MetadataTokens.GetToken(declaration), MetadataTokens.GetToken(methodImpl.MethodDeclaration))
        }

        private func HasPreserveBaseOverridesAttribute(
            reader MetadataReader,
            methodHandle MethodDefinitionHandle
        ) bool {
            for attributeHandle in reader.GetMethodDefinition(methodHandle).GetCustomAttributes() {
                let attribute = reader.GetCustomAttribute(attributeHandle)
                if attribute.Constructor.Kind != HandleKind.MemberReference {
                    continue
                }
                let constructor = reader.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                if constructor.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let attributeType = reader.GetTypeReference(TypeReferenceHandle(constructor.Parent))
                if reader.GetString(attributeType.Namespace) == "System.Runtime.CompilerServices" && reader.GetString(
                    attributeType.Name
                ) == "PreserveBaseOverridesAttribute" {
                    return true
                }
            }
            return false
        }

        private func FindType(reader MetadataReader, name string) TypeDefinitionHandle {
            return reader.TypeDefinitions.Single(
                (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == name
            )
        }

        private func FindMethod(
            reader MetadataReader,
            typeHandle TypeDefinitionHandle,
            name string
        ) MethodDefinitionHandle {
            return reader
                .GetTypeDefinition(typeHandle)
                .GetMethods()
                .Single(
                (handle MethodDefinitionHandle) -> reader.GetString(reader.GetMethodDefinition(handle).Name) == name
            )
        }

        private func FindCopyConstructor(
            reader MetadataReader,
            typeHandle TypeDefinitionHandle
        ) MethodDefinitionHandle {
            return reader
                .GetTypeDefinition(typeHandle)
                .GetMethods()
                .Where(
                (handle MethodDefinitionHandle) -> reader.GetString(reader.GetMethodDefinition(handle).Name) == ".ctor"
            )
                .Single(
                (handle MethodDefinitionHandle) -> {
                    let definition = reader.GetMethodDefinition(handle)
                    if (definition.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public {
                        return false
                    }
                    var signature = reader.GetBlobReader(definition.Signature)
                    var header = signature.ReadSignatureHeader()
                    if header.IsGeneric {
                        let _ = signature.ReadCompressedInteger()
                    }
                    return signature.ReadCompressedInteger() == 1
                }
            )
        }

        private func TypeContainsCallTo(
            peReader PEReader,
            reader MetadataReader,
            typeHandle TypeDefinitionHandle,
            target MemberReferenceHandle
        ) bool {
            for methodHandle in reader.GetTypeDefinition(typeHandle).GetMethods() {
                if MethodContainsCallTo(peReader, reader, methodHandle, target) {
                    return true
                }
            }
            return false
        }

        private func MethodContainsCallTo(
            peReader PEReader,
            reader MetadataReader,
            methodHandle MethodDefinitionHandle,
            target EntityHandle
        ) bool {
            let method = reader.GetMethodDefinition(methodHandle)
            if method.RelativeVirtualAddress == 0 {
                return false
            }
            let targetToken = MetadataTokens.GetToken(target)
            let il[]?uint8 = peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
            for var i = 0; il != nil && i + 4 < il.Length; i++ {
                if il[i] == uint8(0x28) && BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(i + 1, 4)) == targetToken {
                    return true
                }
            }
            return false
        }

        private func CompileCSharpConsumerAndRun(gsharp string, csharp string) string? {
            let directory = CreateArtifactsDirectory()
            try {
                let libraryPath = CompileGSharpLibrary(directory, "Records", gsharp)
                IlVerifier.Verify(libraryPath)
                return CompileCSharpConsumerAndRun(directory, libraryPath, csharp)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileCSharpConsumerAndRun(directory string, libraryPath string, csharp string) string? {
            let consumerPath = Path.Combine(directory, "Consumer.dll")
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .Append(MetadataReference.CreateFromFile(libraryPath))
            let consumer = CSharpCompilation.Create(
                "Consumer",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(csharp, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let output = File.Create(consumerPath)
                let result = consumer.Emit(output)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            let loadContext = AssemblyLoadContext("Issue2871-" + Guid.NewGuid().ToString(), isCollectible: true)
            try {
                let libraryAssembly = loadContext.LoadFromAssemblyPath(libraryPath)
                let _ = libraryAssembly.GetTypes()
                let consumerAssembly = loadContext.LoadFromAssemblyPath(consumerPath)
                return cast[string](
                    consumerAssembly.GetType("Probe", throwOnError: true)!!.GetMethod(
                        "Run",
                        BindingFlags.Public | BindingFlags.Static
                    )!!.Invoke(nil, nil)!!
                )
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileGSharpLibrary(directory string, assemblyName string, source string) string {
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            let libraryPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + libraryPath, "/target:library", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
            return libraryPath
        }

        private func CreateArtifactsDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2871-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
