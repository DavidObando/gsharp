// <copyright file="HotReloadDeltaBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import Gsharp.HotReload.Runtime
import System
import System.Buffers.Binary
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Tests G#'s System.Reflection.Metadata-based Edit-and-Continue deltas.
open class HotReloadDeltaBuilderTests {
    @Fact
    func ModuleInitializerAttribute_EmitsModuleStaticConstructor() {
        let image = Emit(`package HotReloadTests
import System.Runtime.CompilerServices

class Bootstrap {
    shared {
        @ModuleInitializer
        internal func Initialize() {}
    }
}`)
        using let stream = MemoryStream(image, writable: false)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let moduleType = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single((type TypeDefinition) -> reader.GetString(type.Name) == "<Module>")
        let moduleInitializer = moduleType
            .GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single((method MethodDefinition) -> reader.GetString(method.Name) == ".cctor")
        Assert.NotEqual(0, moduleInitializer.RelativeVirtualAddress)
        let il[]?uint8 = peReader.GetMethodBody(moduleInitializer.RelativeVirtualAddress).GetILBytes()
        Assert.Equal(0x28, int32(il!![0]))
        Assert.Equal(0x2a, int32(il!![^1]))
    }

    @Fact
    func MethodBodyEdit_ProducesMinimalEncDelta() {
        let baseline = Emit("package HotReloadTests\nfunc Value() int32 { return 1 }")
        let current = Emit("package HotReloadTests\nfunc Value() int32 { return 2 }")
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status)
        Assert.NotEmpty(update.MetadataDelta)
        Assert.NotEmpty(update.IlDelta)
        Assert.Empty(update.PdbDelta)
        Assert.Contains(update.UpdatedMethods, (name string) -> name.EndsWith(".Value", StringComparison.Ordinal))
        using let provider = MetadataReaderProvider.FromMetadataImage(ImmutableArray.CreateRange(update.MetadataDelta))
        let reader = provider.GetMetadataReader()
        Assert.True(reader.GetTableRowCount(TableIndex.MethodDef) > 0)
        Assert.True(reader.GetTableRowCount(TableIndex.EncLog) > 0)
        Assert.Contains(
            reader.GetEditAndContinueMapEntries(),
            (handle EntityHandle) -> handle.Kind == HandleKind.MethodDefinition
        )
        Assert.Equal(1, reader.GetModuleDefinition().Generation)
    }

    @Fact
    func MultipleMethodBodyEdits_PreserveMethodDefinitionRowsAndEmitCompleteDelta() {
        let baseline = Emit(`package HotReloadTests
func First() int32 { return 1 }
func Middle() int32 { return 2 }
func Last() int32 { return 3 }`)
        let current = Emit(`package HotReloadTests
func First() int32 { return 11 }
func Middle() int32 { return 2 }
func Last() int32 { return 33 }`)
        let methodNames = []string{"First", "Middle", "Last"}
        let baselineRows = GetMethodDefinitionRows(baseline, methodNames)
        let currentRows = GetMethodDefinitionRows(current, methodNames)
        Assert.Equal(methodNames.Length, baselineRows.Count)
        Assert.Equal(methodNames.Length, currentRows.Count)
        Assert.All(methodNames, (name string) -> Assert.Equal(baselineRows[name], currentRows[name]))
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status)
        Assert.Equal(
            []string{"First", "Last"},
            update.UpdatedMethods.Select((name string) -> name[(name.LastIndexOf('.') + 1) ..]).ToArray()
        )
        Assert.NotEmpty(update.MetadataDelta)
        Assert.NotEmpty(update.IlDelta)
        Assert.Empty(update.PdbDelta)
        using let provider = MetadataReaderProvider.FromMetadataImage(ImmutableArray.CreateRange(update.MetadataDelta))
        let reader = provider.GetMetadataReader()
        Assert.Equal(1, reader.GetModuleDefinition().Generation)
        Assert.Equal(2, reader.GetTableRowCount(TableIndex.MethodDef))
        let deltaMethods = reader
            .MethodDefinitions
            .Select((handle MethodDefinitionHandle) -> (Handle: handle, Definition: reader.GetMethodDefinition(handle)))
            .ToArray()
        let expectedHandles = []MethodDefinitionHandle{
            MetadataTokens.MethodDefinitionHandle(baselineRows["First"]),
            MetadataTokens.MethodDefinitionHandle(baselineRows["Last"])
        }
        let mappedMethods = reader
            .GetEditAndContinueMapEntries()
            .Where((handle EntityHandle) -> handle.Kind == HandleKind.MethodDefinition)
            .Select((handle EntityHandle) -> MethodDefinitionHandle(handle))
            .ToArray()
        Assert.Equal(expectedHandles, mappedMethods)
        let loggedMethods = reader
            .GetEditAndContinueLogEntries()
            .Where((entry EditAndContinueLogEntry) -> entry.Handle.Kind == HandleKind.MethodDefinition)
            .ToArray()
        Assert.Equal(
            expectedHandles,
            loggedMethods.Select((entry EditAndContinueLogEntry) -> MethodDefinitionHandle(entry.Handle)).ToArray()
        )
        Assert.All(
            loggedMethods,
            (entry EditAndContinueLogEntry) -> Assert.Equal(EditAndContinueOperation.Default, entry.Operation)
        )
        Assert.All(
            deltaMethods,
            (method(Handle MethodDefinitionHandle, Definition MethodDefinition)) -> Assert.NotEqual(
                0,
                method.Item2.RelativeVirtualAddress
            )
        )
        Assert.NotEqual(deltaMethods[0].Item2.RelativeVirtualAddress, deltaMethods[1].Item2.RelativeVirtualAddress)
        Assert.Equal(11, ReadReturnedInt32(update.IlDelta, deltaMethods[0].Item2.RelativeVirtualAddress))
        Assert.Equal(33, ReadReturnedInt32(update.IlDelta, deltaMethods[1].Item2.RelativeVirtualAddress))
    }

    @Fact
    func MethodBodyEdits_ReportChangedTypesInRoslynOrder() {
        // Issue #4960: metadata update handlers receive the changed types the
        // way Roslyn's delta writer reports them: each changed method's
        // declaring type and every type containing it, once, with top-level
        // types (in TypeDef order) before nested types. `Second` only
        // contains a change and `Inner` has two changed methods.
        let source = `package HotReloadTests

class First {
    shared {
        func Value() int32 { return 1 }
    }
}

class Second {
    shared {
        func Value() int32 { return 2 }
    }

    class Inner {
        shared {
            func Value() int32 { return 3 }
            func Other() int32 { return 4 }
        }
    }
}

class Third {
    shared {
        func Value() int32 { return 5 }
    }
}

class Unchanged {
    shared {
        func Value() int32 { return 6 }
    }
}`
        let baseline = Emit(source)
        let current = Emit(
            source
                .Replace("return 1", "return 11")
                .Replace("return 3", "return 33")
                .Replace("return 4", "return 44")
                .Replace("return 5", "return 55")
        )
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status)
        Assert.Equal(4, update.UpdatedMethods.Length)
        Assert.Equal(
            []string{
                "HotReloadTests.First",
                "HotReloadTests.Second",
                "HotReloadTests.Third",
                "HotReloadTests.Second+Inner"
            },
            GetTypeNames(current, update.UpdatedTypes)
        )
    }

    @Fact
    func NoChangesAndRejectedEdits_ReportNoChangedTypes() {
        let baseline = Emit("package HotReloadTests\nfunc Value() int32 { return 1 }")
        Assert.Empty(HotReloadDeltaBuilder(baseline).CreateUpdate(baseline).UpdatedTypes)
        let renamed = Emit("package HotReloadTests\nfunc Renamed() int32 { return 1 }")
        Assert.Empty(HotReloadDeltaBuilder(baseline).CreateUpdate(renamed).UpdatedTypes)
    }

    @Fact
    func StringLiteralEdit_AddsUserStringHeapEntry() {
        let baseline = Emit("package HotReloadTests\nfunc Value() string { return \"before\" }")
        let current = Emit("package HotReloadTests\nfunc Value() string { return \"after\" }")
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status)
        using let provider = MetadataReaderProvider.FromMetadataImage(ImmutableArray.CreateRange(update.MetadataDelta))
        Assert.True(provider.GetMetadataReader().GetHeapSize(HeapIndex.UserString) > 1)
    }

    @Fact
    func ConsecutiveEdits_AdvanceEncGenerationAndBaseId() {
        let baseline = Emit("package HotReloadTests\nfunc Value() string { return \"one\" }")
        let second = Emit("package HotReloadTests\nfunc Value() string { return \"two\" }")
        let third = Emit("package HotReloadTests\nfunc Value() string { return \"three\" }")
        let builder = HotReloadDeltaBuilder(baseline)
        let firstUpdate = builder.CreateUpdate(second)
        Assert.Equal(HotReloadDeltaStatus.Ready, firstUpdate.Status)
        firstUpdate.Commit()
        let secondUpdate = builder.CreateUpdate(third)
        Assert.Equal(HotReloadDeltaStatus.Ready, secondUpdate.Status)
        using let provider = MetadataReaderProvider.FromMetadataImage(
            ImmutableArray.CreateRange(secondUpdate.MetadataDelta)
        )
        let module = provider.GetMetadataReader().GetModuleDefinition()
        Assert.Equal(2, module.Generation)
        Assert.False(module.BaseGenerationId.IsNil)
    }

    @Fact
    func NewLocalSignature_IsMappedIntoDelta() {
        let baseline = Emit("package HotReloadTests\nfunc Value() int32 { return 1 }")
        let current = Emit(`package HotReloadTests
func Value() int32 {
    var value int32 = 2
    return value
}`)
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status)
        using let provider = MetadataReaderProvider.FromMetadataImage(ImmutableArray.CreateRange(update.MetadataDelta))
        let reader = provider.GetMetadataReader()
        Assert.True(reader.GetTableRowCount(TableIndex.StandAloneSig) > 0)
        Assert.Contains(
            reader.GetEditAndContinueMapEntries(),
            (handle EntityHandle) -> handle.Kind == HandleKind.StandaloneSignature
        )
    }

    @Fact
    func AddedMethod_ReportsExplicitRestartDiagnostic() {
        let baseline = Emit("package HotReloadTests\nfunc Value() int32 { return 1 }")
        let current = Emit(`package HotReloadTests
func Value() int32 { return 2 }
func Added() int32 { return 3 }`)
        let baselineMethodCount = GetTableRowCount(baseline, TableIndex.MethodDef)
        let currentMethodCount = GetTableRowCount(current, TableIndex.MethodDef)
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status)
        Assert.Contains("GSHR1001", update.Diagnostic, StringComparison.Ordinal)
        Assert.Contains("MethodDef", update.Diagnostic, StringComparison.Ordinal)
        Assert.Contains(
            "MethodDef rows $baselineMethodCount -> $currentMethodCount",
            update.Diagnostic,
            StringComparison.Ordinal
        )
        Assert.Contains("requires restart", update.Diagnostic, StringComparison.Ordinal)
        Assert.Empty(update.MetadataDelta)
        Assert.Empty(update.IlDelta)
        Assert.Empty(update.UpdatedMethods)
    }

    @Fact
    func MethodThatStartsSuspending_ReportsGshr1002RestartDiagnostic() {
        // ADR-0174 P3-9: adding a channel receive to a plain func flips its
        // compiled shape (int32 -> ValueTask[int32] state machine) — a body
        // edit at the source level that is a signature change in metadata.
        let baseline = Emit("package HotReloadTests\nfunc Value(ch chan[int32]) int32 { return 1 }")
        let current = Emit("package HotReloadTests\nfunc Value(ch chan[int32]) int32 { return <-ch }")
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status)
        Assert.StartsWith(
            "GSHR1002: method 'HotReloadTests.<Program>.Value' changed suspension",
            update.Diagnostic,
            StringComparison.Ordinal
        )
        Assert.Contains("now performs a channel operation", update.Diagnostic, StringComparison.Ordinal)
        Assert.Contains("Restart required", update.Diagnostic, StringComparison.Ordinal)
        Assert.Empty(update.MetadataDelta)
        Assert.Empty(update.IlDelta)
    }

    @Fact
    func MethodThatStartsSuspending_WithAReferenceResult_ReportsGshr1002RestartDiagnostic() {
        // Issue #4287: a `string` result becomes `ValueTask<string>`, whose
        // [Nullable] flags ([0, 1]) put a sequence-0 RETURN row into the
        // method's Param table that the plain method did not have. The
        // suspension-flip pairing key counts parameters, and counted that
        // return row too, so the two versions stopped pairing and the flip
        // fell through to the generic GSHR1001 shape diagnostic.
        let baseline = Emit("package HotReloadTests\nfunc Value(ch chan[string]) string { return \"a\" }")
        let current = Emit("package HotReloadTests\nfunc Value(ch chan[string]) string { return <-ch }")
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status)
        Assert.StartsWith(
            "GSHR1002: method 'HotReloadTests.<Program>.Value' changed suspension",
            update.Diagnostic,
            StringComparison.Ordinal
        )
    }

    @Fact
    func MethodThatStopsSuspending_ReportsGshr1002RestartDiagnostic() {
        let baseline = Emit("package HotReloadTests\nfunc Value(ch chan[int32]) int32 { return <-ch }")
        let current = Emit("package HotReloadTests\nfunc Value(ch chan[int32]) int32 { return 1 }")
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status)
        Assert.StartsWith(
            "GSHR1002: method 'HotReloadTests.<Program>.Value' changed suspension",
            update.Diagnostic,
            StringComparison.Ordinal
        )
        Assert.Contains("no longer performs a channel operation", update.Diagnostic, StringComparison.Ordinal)
    }

    @Fact
    func SuspendingMethod_BodyEdit_KeepsSuspending_IsNotGshr1002() {
        // The same method suspending before and after is an ordinary body edit
        // as far as the suspension check goes; whatever else the delta builder
        // says about it, it must not be blamed on a suspension change.
        let baseline = Emit("package HotReloadTests\nfunc Value(ch chan[int32]) int32 { return <-ch }")
        let current = Emit("package HotReloadTests\nfunc Value(ch chan[int32]) int32 { return <-ch + 1 }")
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.DoesNotContain("GSHR1002", update.Diagnostic ?? string.Empty, StringComparison.Ordinal)
    }

    @Fact
    func RenamedMethod_ReportsMetadataShapeRestartDiagnostic() {
        let baseline = Emit("package HotReloadTests\nfunc Value() int32 { return 1 }")
        let current = Emit("package HotReloadTests\nfunc Renamed() int32 { return 1 }")
        Assert.Equal(GetTableRowCount(baseline, TableIndex.MethodDef), GetTableRowCount(current, TableIndex.MethodDef))
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status)
        Assert.Equal(
            "GSHR1001: MethodDef metadata changed. Restart required; in-place updates currently support existing managed method bodies only.",
            update.Diagnostic
        )
        Assert.Empty(update.MetadataDelta)
        Assert.Empty(update.IlDelta)
        Assert.Empty(update.UpdatedMethods)
    }

    @Fact
    func NewMetadataReference_ReportsExplicitRestartDiagnostic() {
        let baseline = Emit(`package HotReloadTests
import System

func Value() int32 { return 1 }`)
        let current = Emit(`package HotReloadTests
import System

func Value() int32 { return Math.Abs(-1) }`)
        let update = HotReloadDeltaBuilder(baseline).CreateUpdate(current)
        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status)
        Assert.Contains("GSHR1001", update.Diagnostic, StringComparison.Ordinal)
        Assert.Contains("rows", update.Diagnostic, StringComparison.Ordinal)
        Assert.Contains("requires restart", update.Diagnostic, StringComparison.Ordinal)
        Assert.Empty(update.MetadataDelta)
        Assert.Empty(update.IlDelta)
        Assert.Empty(update.PdbDelta)
    }

    shared {
        private func Emit(source string)[]uint8 {
            let compilation = Compilation(SyntaxTree.Parse(source)){
                AssemblyName = "HotReloadTests",
                IsLibrary = true,
                Optimize = false
            }
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "HotReloadTests",
                assemblyVersion: "1.0.0"
            )
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            return peStream.ToArray()
        }

        private func GetTypeNames(image[]uint8, tokens ImmutableArray[int32])[]string {
            using let stream = MemoryStream(image, writable: false)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let names = List[string]()
            for token in tokens {
                let handle = TypeDefinitionHandle(MetadataTokens.EntityHandle(token))
                names.Add(GetTypeName(reader, handle))
            }
            return names.ToArray()
        }

        private func GetTypeName(reader MetadataReader, handle TypeDefinitionHandle) string {
            let type = reader.GetTypeDefinition(handle)
            let name = reader.GetString(type.Name)
            let declaringType = type.GetDeclaringType()
            if !declaringType.IsNil {
                return GetTypeName(reader, declaringType) + "+" + name
            }
            let namespaceName = reader.GetString(type.Namespace)
            return if namespaceName.Length == 0 {
                name
            } else {
                "$namespaceName.$name"
            }
        }

        private func GetMethodDefinitionRows(image[]uint8, methodNames IEnumerable[string]) Dictionary[string, int32] {
            let names = methodNames.ToHashSet(StringComparer.Ordinal)
            using let stream = MemoryStream(image, writable: false)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            return reader
                .MethodDefinitions
                .Select(
                (handle MethodDefinitionHandle) -> (
                    Name: reader.GetString(reader.GetMethodDefinition(handle).Name),
                    Row: MetadataTokens.GetRowNumber(handle)
                )
            )
                .Where((method(Name string, Row int32)) -> names.Contains(method.Item1))
                .ToDictionary(
                func (method(Name string, Row int32)) string {
                    return method.Item1
                },
                (method(Name string, Row int32)) -> method.Item2,
                StringComparer.Ordinal
            )
        }

        private func GetTableRowCount(image[]uint8, table TableIndex) int32 {
            using let stream = MemoryStream(image, writable: false)
            using let peReader = PEReader(stream)
            return peReader.GetMetadataReader().GetTableRowCount(table)
        }

        private func ReadReturnedInt32(ilDelta[]uint8, methodBodyOffset int32) int32 {
            Assert.InRange(methodBodyOffset, 0, ilDelta.Length - 1)
            let body = ilDelta.AsSpan(methodBodyOffset)
            let format = int32(body[0]) & 0x3
            var headerSize int32
            var codeSize int32
            if format == 0x2 {
                headerSize = 1
                codeSize = int32(body[0]) >> 2
            } else if format == 0x3 {
                Assert.True(body.Length >= 12)
                let flagsAndSize = BinaryPrimitives.ReadUInt16LittleEndian(body[.. 2])
                headerSize = ((int32(flagsAndSize) >> 12) & 0xf) * 4
                codeSize = BinaryPrimitives.ReadInt32LittleEndian(body.Slice(4, 4))
            } else {
                throw BadImageFormatException("Unexpected managed method header format 0x${format:x2}.")
            }
            Assert.True(headerSize > 0)
            Assert.True(codeSize > 0)
            Assert.True(body.Length >= headerSize + codeSize)
            let il = body.Slice(headerSize, codeSize)
            Assert.Equal(0x2a, int32(il[^1]))
            var value int32
            var instructionSize int32
            if il[0] == uint8(0x15) {
                value = -1
                instructionSize = 1
            } else if il[0] >= uint8(0x16) && il[0] <= uint8(0x1e) {
                value = int32(il[0]) - 0x16
                instructionSize = 1
            } else if il[0] == uint8(0x1f) {
                Assert.True(il.Length >= 3)
                value = unchecked(int8(il[1]))
                instructionSize = 2
            } else if il[0] == uint8(0x20) {
                Assert.True(il.Length >= 6)
                value = BinaryPrimitives.ReadInt32LittleEndian(il.Slice(1, 4))
                instructionSize = 5
            } else {
                throw BadImageFormatException(
                    "Expected ldc.i4 at the start of the delta method body, found 0x${il[0]:x2}."
                )
            }
            Assert.Equal(instructionSize + 1, il.Length)
            return value
        }
    }
}
