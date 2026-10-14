// <copyright file="Issue4663EmitOrderIndependenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #4663: emitted output must not depend on the identity-hash order of
/// the symbol-keyed dictionaries the lowering passes walk.
/// @remarks The existing determinism guards (#598) compile the same input twice with
/// the same compiler, which is exactly the case identity hashes reproduce:
/// CoreCLR derives them from a per-thread generator, so the same binary
/// allocating the same objects gets the same hashes. These tests perturb
/// what actually varies in practice — an unrelated input file, the file
/// order — and pin the synthesized names themselves to source order. Before
/// the fix the capture-box classes were numbered in hash-bucket order
/// (`n18_1 n15_2 n32_3 …`), renumbered when an unrelated file was
/// added, and a G#-built compiler numbered them differently again, which is
/// what broke the self-host stage-2 equivalence check (#4631).
open class Issue4663EmitOrderIndependenceTests {
    /// The capture boxes are numbered in source order.
    @Fact
    func CaptureBoxes_AreNumberedInSourceOrder() {
        let image = Emit(ProgramTree())
        let boxes = BoxTypeNames(image)
        Assert.Equal(Enumerable.Range(0, CaptureCount).Select((i int32) -> "<>__Box_n${i}_${i + 1}").ToArray(), boxes)
    }

    /// An unrelated, closure-free file — before or after the program —
    /// changes nothing the program's own code compiles to.
    @Fact
    func UnrelatedFile_PrependedOrAppended_LeavesTheProgramsCodeUnchanged() {
        let alone = ProgramMethodBodies(Emit(ProgramTree()))
        let appended = ProgramMethodBodies(Emit(ProgramTree(), UnrelatedTree()))
        let prepended = ProgramMethodBodies(Emit(UnrelatedTree(), ProgramTree()))
        Assert.NotEmpty(alone)
        Assert.Equal(alone, appended)
        Assert.Equal(alone, prepended)
        Assert.Equal(BoxTypeNames(Emit(ProgramTree())), BoxTypeNames(Emit(UnrelatedTree(), ProgramTree())))
    }

    /// Reversing the input file order yields the same IL and metadata (MVID zeroed).
    @Fact
    func ReversedFileOrder_ProducesIdenticalIlAndMetadata() {
        let forward = HashIlAndMetadata(Emit(ProgramTree(), UnrelatedTree(), ShapesTree()))
        let reversed = HashIlAndMetadata(Emit(ShapesTree(), UnrelatedTree(), ProgramTree()))
        Assert.Equal(forward, reversed)
    }

    /// Synthesized types (state machines, closure classes, boxes) keep their
    /// names and order whatever unrelated input surrounds them. A single
    /// perturbation can leave a tie in its old order by chance, so this
    /// compiles the shapes beside unrelated files of several sizes, before and
    /// after, and requires one answer across all of them.
    @Fact
    func SynthesizedTypes_AreTheSameWhateverUnrelatedInputSurroundsThem() {
        let layouts = List[IReadOnlyList[string]]()
        for size in[]int32{1, 7, 23, 61, 157, 401} {
            layouts.Add(Issue4663EmitOrderIndependenceTests.TypeLayout(Emit(UnrelatedTree(size), ShapesTree())))
            layouts.Add(Issue4663EmitOrderIndependenceTests.TypeLayout(Emit(ShapesTree(), UnrelatedTree(size))))
        }
        Assert.Contains(layouts[0], (name string) -> name.Contains("Run", StringComparison.Ordinal))
        Assert.All(layouts, (layout IReadOnlyList[string]) -> Assert.Equal(layouts[0], layout))
    }

    shared {
        private const CaptureCount int32 = 24
        private let OpCodesByValue Dictionary[int16, OpCode] = typeof(OpCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Select((field FieldInfo) -> OpCode(field.GetValue(nil)!!))
            .ToDictionary((opCode OpCode) -> opCode.Value)

        private func ProgramTree() SyntaxTree {
            let source = StringBuilder(`package Repro

import System

`)
            for var i = 0; i < CaptureCount; i++ {
                source.Append((`func f` + "$i" + `() int32 {
    var n` + "$i" + ` = ` + "$i" + `
    var bump = func () { n` + "$i" + ` = n` + "$i" + ` + 1 }
`)).Append("    bump()\n").Append((`    return n` + "$i" + `
}

`))
            }
            source
                .Append("Console.WriteLine(")
                .Append(string.Join(" + ", Enumerable.Range(0, CaptureCount).Select((i int32) -> "f$i()")))
                .Append(")\n")
            return SyntaxTree.Parse(SourceText.From(source.ToString(), "Program.gs"))
        }

        // Enough closure-free declarations to shift every allocation the binder
        // and lowering passes make, which is what reshuffled identity hashes.
        private func UnrelatedTree(functions int32 = 200) SyntaxTree {
            let source = StringBuilder(`package Repro

`)
            for var i = 0; i < functions; i++ {
                source.Append((`func g` + "$i" + `(x int32) int32 {
    let y = x * ` + "$i" + ` + 1
    return y
}

`))
            }
            return SyntaxTree.Parse(SourceText.From(source.ToString(), "Unrelated.gs"))
        }

        // Shapes whose synthesized names were numbered in a pass that walked the
        // program in hash order, or ordered by a key that ties: same-named
        // iterators and async methods in different types, interpolation, and
        // closures inside constructors (initialization plans).
        private func ShapesTree() SyntaxTree -> SyntaxTree.Parse(
            SourceText.From(ShapesSource + FieldLambdaClasses(), "Shapes.gs")
        )

        // Field initializers become per-type initialization plans, a second
        // symbol-keyed dictionary; a dozen of them make a hash-order walk of
        // the plans visibly unstable.
        private func FieldLambdaClasses() string {
            let source = StringBuilder()
            for var i = 0; i < 12; i++ {
                source.Append((`
class Plan` + "$i" + ` {
    var Apply Func[int32, int32] = func (x int32) int32 { return x + ` + "$i" + ` }
}
`))
            }
            return source.ToString()
        }

        private const ShapesSource string = `package Repro

import System
import System.Collections.Generic
import System.Threading.Tasks

class Left(Seed int32) {
    func Items() IEnumerable[int32] {
        yield Seed
        yield Seed + 1
    }

    async func Run(n int32) int32 {
        await Task.Delay(1)
        return Seed + n
    }

    func Describe() string {
        return "left $Seed"
    }
}

class Right(Seed int32) {
    func Items() IEnumerable[int32] {
        yield Seed * 2
    }

    async func Run(n int32) int32 {
        await Task.Delay(1)
        return Seed * n
    }

    func Describe() string {
        return "right $Seed"
    }
}

class Hooks {
    var Count int32
    var Twice Func[int32, int32] = func (x int32) int32 { return x * 2 }

    init() {
        var k = 1
        var bump = func () { k = k + 1 }
        bump()
        Count = k
    }
}

class Gauges {
    var Level int32
    var Thrice Func[int32, int32] = func (x int32) int32 { return x * 3 }

    init() {
        var m = 2
        var grow = func () { m = m * 3 }
        grow()
        Level = m
    }
}
`

        private func Emit(trees ...SyntaxTree)[]uint8 {
            let compilation = Compilation(trees){DebugInformation = DebugInformationOptions{Deterministic: true}}
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream: peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "GSharp.Issue4663",
                assemblyVersion: "1.0.0.0"
            )
            Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            return peStream.ToArray()
        }

        // Every TypeDef as "Enclosing/Name" in table order; the unrelated file
        // declares no types, so any difference is the shapes' own.
        private func TypeLayout(image[]uint8) IReadOnlyList[string] {
            using let pe = PEReader(MemoryStream(image, writable: false))
            let reader = pe.GetMetadataReader()
            return reader
                .TypeDefinitions
                .Select(
                (handle TypeDefinitionHandle) -> {
                    let type = reader.GetTypeDefinition(handle)
                    let enclosing = type.GetDeclaringType()
                    let outer = if enclosing.IsNil {
                        string.Empty
                    } else {
                        reader.GetString(reader.GetTypeDefinition(enclosing).Name)
                    }
                    return outer + "/" + reader.GetString(type.Name)
                }
            )
                .ToArray()
        }

        private func BoxTypeNames(image[]uint8) IReadOnlyList[string] {
            using let pe = PEReader(MemoryStream(image, writable: false))
            let reader = pe.GetMetadataReader()
            return reader
                .TypeDefinitions
                .Select((handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name))
                .Where((name string) -> name.StartsWith("<>__Box_", StringComparison.Ordinal))
                .ToArray()
        }

        // The IL of every method the program file declares (f0..fN and the
        // closures and box constructors they own), keyed by declaring type and
        // name, with metadata tokens resolved to names so a body compares equal
        // only if it references the same members by the same names.
        private func ProgramMethodBodies(image[]uint8) IReadOnlyDictionary[string, string] {
            using let pe = PEReader(MemoryStream(image, writable: false))
            let reader = pe.GetMetadataReader()
            let bodies = SortedDictionary[string, string](StringComparer.Ordinal)
            for handle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(handle)
                let name = reader.GetString(method.Name)
                let type = reader.GetString(reader.GetTypeDefinition(method.GetDeclaringType()).Name)
                if name.StartsWith('g') || method.RelativeVirtualAddress == 0 {
                    continue
                }
                let il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? Array.Empty[uint8]()
                bodies[type + "::" + name] = Convert.ToHexString(SHA256.HashData(StripTokens(il)))
            }
            return bodies
        }

        // Tokens are row numbers, which legitimately shift when another file adds
        // rows; the opcode stream (and, through the type and method names keyed
        // above, the synthesized names) is what must not change. Blank every
        // metadata-token operand.
        private func StripTokens(il[]uint8)[]uint8 {
            let copy = cast[[]uint8](il.Clone())
            var offset = 0
            while offset < copy.Length {
                let value = if copy[offset] == uint8(0xFE) && offset + 1 < copy.Length {
                    int16((0xFE00 | int32(copy[offset + 1])))
                } else {
                    int16(copy[offset])
                }
                let opCode = OpCodesByValue[value]
                offset += opCode.Size
                switch opCode.OperandType {
                    case OperandType.InlineField,
                    OperandType.InlineMethod,
                    OperandType.InlineSig,
                    OperandType.InlineString,
                    OperandType.InlineTok,
                    OperandType.InlineType {
                        Array.Clear(copy, offset, 4)
                        offset += 4
                    }
                    case OperandType.InlineSwitch {
                        offset += 4 + (4 * BitConverter.ToInt32(copy, offset))
                    }
                    case OperandType.InlineI8, OperandType.InlineR {
                        offset += 8
                    }
                    case OperandType.InlineBrTarget, OperandType.InlineI, OperandType.ShortInlineR {
                        offset += 4
                    }
                    case OperandType.InlineVar {
                        offset += 2
                    }
                    case OperandType.ShortInlineBrTarget, OperandType.ShortInlineI, OperandType.ShortInlineVar {
                        offset += 1
                    }
                    case OperandType.InlineNone { }
                    default {
                        // An unhandled operand type would stall the walk; fail with a clear message instead.
                        throw InvalidOperationException(
                            "Unhandled IL operand type ${opCode.OperandType} for ${opCode.Name}."
                        )
                    }
                }
            }
            return copy
        }

        private func HashIlAndMetadata(bytes[]uint8) string {
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let reader = pe.GetMetadataReader()
            let metadata = bytes.AsSpan(pe.PEHeaders.MetadataStartOffset, pe.PEHeaders.MetadataSize).ToArray()
            let mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid).ToByteArray()
            for var at = metadata.AsSpan().IndexOf(mvid); at >= 0; at = metadata.AsSpan().IndexOf(mvid) {
                metadata.AsSpan(at, mvid.Length).Clear()
            }
            using let hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            hash.AppendData(metadata)
            for handle in reader.MethodDefinitions {
                let rva = reader.GetMethodDefinition(handle).RelativeVirtualAddress
                if rva != 0 {
                    hash.AppendData(pe.GetMethodBody(rva).GetILBytes() ?? Array.Empty[uint8]())
                }
            }
            return Convert.ToHexString(hash.GetHashAndReset())
        }
    }
}
