// <copyright file="Issue2852GenericUnmanagedStackAllocEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Buffers.Binary
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #2852: runtime and metadata coverage for
/// `stackalloc [n]T` under `T unmanaged`.
open class Issue2852GenericUnmanagedStackAllocEmitTests {
    @Fact
    func GenericUnmanagedStackAlloc_WritesAndReadsUsingRuntimeElementSize() {
        let outputPath = CompileLibrary(Source, "GenericUnmanagedStackAlloc_WritesAndReadsUsingRuntimeElementSize")
        IlVerifier.Verify(outputPath, nil, StackAllocIlVerifyIgnored)
        let loadContext = AssemblyLoadContext(
            "GenericUnmanagedStackAlloc_WritesAndReadsUsingRuntimeElementSize",
            isCollectible: true
        )
        try {
            let assembly = loadContext.LoadFromAssemblyPath(outputPath)
            let probe = assembly.GetType("Probe.StackAllocProbe") ??
                throw InvalidOperationException("StackAllocProbe type not found.")
            Assert.Equal(7, probe.GetMethod("Byte")!!.Invoke(nil, nil))
            Assert.Equal(123456, probe.GetMethod("Int32")!!.Invoke(nil, nil))
            Assert.Equal(9876543210L, probe.GetMethod("Int64")!!.Invoke(nil, nil))
        } finally {
            loadContext.Unload()
            TryDeleteDirectory(Path.GetDirectoryName(outputPath)!!)
        }
    }

    @Fact
    func GenericUnmanagedStackAlloc_EmitsSymbolicSizeAndSpanConstructor() {
        let outputPath = CompileLibrary(Source, "GenericUnmanagedStackAlloc_EmitsSymbolicSizeAndSpanConstructor")
        try {
            using let pe = PEReader(File.OpenRead(outputPath))
            let metadata = pe.GetMetadataReader()
            let il = GetMethodIl(pe, metadata, "RoundTrip")
            let sizeOfOperands = GetSizeOfOperands(il)
            Assert.NotEmpty(sizeOfOperands)
            for operand in sizeOfOperands {
                Assert.Equal(HandleKind.TypeSpecification, operand.Kind)
                let signature = metadata.GetBlobBytes(
                    metadata.GetTypeSpecification(TypeSpecificationHandle(operand)).Signature
                )
                Assert.True(
                    ContainsSequence(signature, uint8(0x1E), uint8(0x00)),
                    "sizeof operand must name method type parameter !!0: ${BitConverter.ToString(signature)}"
                )
            }
            Assert.True(
                HasSymbolicSpanConstructor(metadata),
                "Span constructor parent must be a TypeSpec closed over method type parameter !!0."
            )
        } finally {
            TryDeleteDirectory(Path.GetDirectoryName(outputPath)!!)
        }
    }

    @Fact
    func ImportedEnumStackAlloc_UnderReference_CompilesCleanly() {
        let fixtureDirectory = CreateArtifactDirectory("ImportedEnumStackAlloc_UnderReference_CompilesCleanly")
        let fixturePath = Path.Combine(fixtureDirectory, "ImportedTypes.dll")
        var outputPath string? = nil
        try {
            EmitFixture(fixturePath)
            outputPath = CompileLibrary(
                ImportedEnumSource,
                "ImportedEnumStackAlloc_UnderReference_CompilesCleanly",
                fixturePath
            )
            IlVerifier.Verify(outputPath, []string{fixturePath}, StackAllocIlVerifyIgnored)
            let loadContext = AssemblyLoadContext(
                "ImportedEnumStackAlloc_UnderReference_CompilesCleanly",
                isCollectible: true
            )
            try {
                let fixture = loadContext.LoadFromAssemblyPath(fixturePath)
                let assembly = loadContext.LoadFromAssemblyPath(outputPath)
                let probe = assembly.GetType("Probe.ImportedEnumProbe") ??
                    throw InvalidOperationException("ImportedEnumProbe type not found.")
                let enumType = fixture.GetType("ImportedTypes.ImportedEnum") ??
                    throw InvalidOperationException("ImportedEnum type not found.")
                let value = Enum.ToObject(enumType, 1)
                Assert.Equal(value, probe.GetMethod("RoundTrip")!!.Invoke(nil, []object{value}))
            } finally {
                loadContext.Unload()
            }
        } finally {
            if outputPath != nil {
                TryDeleteDirectory(Path.GetDirectoryName(outputPath)!!)
            }
            TryDeleteDirectory(fixtureDirectory)
        }
    }

    shared {
        private let StackAllocIlVerifyIgnored[]string = []string{"Unverifiable"}

        private const Source string = `package Probe

public class StackAllocProbe {
    shared {
        public func RoundTrip[T unmanaged](value T) T {
            var values = stackalloc [4]T
            values[3] = value
            return values[3]
        }

        public func Byte() int32 -> int32(RoundTrip[uint8](uint8(7)))
        public func Int32() int32 -> RoundTrip[int32](123456)
        public func Int64() int64 -> RoundTrip[int64](9876543210)
    }
}`

        private const ImportedEnumSource string = `package Probe
import ImportedTypes

public class ImportedEnumProbe {
    shared {
        public func RoundTrip(value ImportedEnum) ImportedEnum {
            var values = stackalloc [2]ImportedEnum
            values[1] = value
            return values[1]
        }
    }
}`

        private const ImportedEnumFixtureSource string = `namespace ImportedTypes;

public enum ImportedEnum : short
{
    Zero,
    One,
}`

        private func CompileLibrary(source string, testName string, references ...string) string {
            let directory = CreateArtifactDirectory(testName)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, "/target:library", "/targetframework:net10.0"}
            args.AddRange(references.Select((reference string) -> ("/r:" + reference)))
            args.Add(sourcePath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            let diagnostics = compileOut.ToString() + compileErr.ToString()
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
            Assert.True(exitCode == 0, ("$testName" + `: gsc failed:
` + "$diagnostics"))
            return outputPath
        }

        private func CreateArtifactDirectory(testName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue2852-artifacts",
                testName,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func EmitFixture(path string) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((reference string) -> MetadataReference.CreateFromFile(reference))
            let compilation = CSharpCompilation.Create(
                "ImportedTypes",
                []SyntaxTree{CSharpSyntaxTree.ParseText(ImportedEnumFixtureSource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func GetMethodIl(pe PEReader, metadata MetadataReader, methodName string)[]uint8 {
            for handle in metadata.MethodDefinitions {
                let method = metadata.GetMethodDefinition(handle)
                if metadata.GetString(method.Name) == methodName && method.RelativeVirtualAddress != 0 {
                    return pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ??
                        throw InvalidOperationException("Method '$methodName' has no IL body.")
                }
            }
            throw InvalidOperationException("Method '$methodName' not found.")
        }

        private func GetSizeOfOperands(il[]uint8) List[EntityHandle] {
            let operands = List[EntityHandle]()
            for var i = 0; i + 5 < il.Length; i++ {
                if il[i] != uint8(0xFE) || il[i + 1] != uint8(0x1C) {
                    continue
                }
                let token = BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(i + 2, 4))
                operands.Add(MetadataTokens.EntityHandle(token))
                i += 5
            }
            return operands
        }

        private func HasSymbolicSpanConstructor(metadata MetadataReader) bool {
            for handle in metadata.MemberReferences {
                let member = metadata.GetMemberReference(handle)
                if metadata.GetString(member.Name) != ".ctor" || member.Parent.Kind != HandleKind.TypeSpecification {
                    continue
                }
                let signature = metadata.GetBlobBytes(
                    metadata.GetTypeSpecification(TypeSpecificationHandle(member.Parent)).Signature
                )
                if ContainsSequence(signature, uint8(0x1E), uint8(0x00)) {
                    return true
                }
            }
            return false
        }

        private func ContainsSequence(bytes[]uint8, $sequence ...uint8) bool {
            for var i = 0; i + $sequence.Length <= bytes.Length; i++ {
                var match = true
                for var j = 0; j < $sequence.Length; j++ {
                    if (bytes[i + j] != $sequence[j]) {
                        match = false
                        break
                    }
                }
                if match {
                    return true
                }
            }
            return false
        }

        private func TryDeleteDirectory(directory string?) {
            try {
                Directory.Delete(directory!!, recursive: true)
            } catch {
                // ignored

            }
        }
    }
}
