// <copyright file="Issue4378FixedBufferPinEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #4378 / ADR-0125 amendment: a `fixed` statement accepts a
/// fixed-size buffer field (ADR-0122 §10, `fixed Name [32]int8`) reached
/// through a movable variable as its pinning source, mirroring C#
/// `fixed (sbyte* p = Name) { … }`. The pointer binds to the buffer's
/// first element and the containing storage stays pinned for the whole block
/// through a `int8& pinned` local loaded from
/// `ldflda Name; ldflda FixedElementField` — the IL csc emits. Each
/// runtime test compiles with `gsc`, ilverifies (tolerating the inherent
/// unmanaged-pointer codes), and executes under `dotnet exec`.
/// Also covers issue #4377: a bare (implicit-`this`) buffer name inside
/// the declaring struct decays exactly like the explicit `this.Name`.
open class Issue4378FixedBufferPinEmitTests {
    @Fact
    func ClassFieldReceiver_PinsAndReadsThroughPointer() {
        let source = BoneInfoPrelude + `unsafe func run() {
    var h = Holder()
    h.B.Name[0] = int8(71)
    h.B.Name[1] = int8(35)
    fixed p *int8 = h.B.Name {
        Console.WriteLine(int32(p[0]))
        Console.WriteLine(int32(p[1]))
        p[2] = int8(33)
    }
    Console.WriteLine(int32(h.B.Name[2]))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal(Lines("71", "35", "33"), output)
    }

    @Fact
    func BareBufferNameInsideDeclaringStruct_PinsIndexesAndWrites() {
        // The C# source shape `fixed (sbyte* p = Name) return p[0];` inside the
        // struct (receiver `this`, a movable ref) plus bare `Name[i]` reads and
        // writes (issue #4377).
        let source = BoneInfoPrelude + `unsafe func run() {
    var h = Holder()
    h.B.SetAt(0, int8(66))
    h.B.SetAt(5, int8(-3))
    Console.WriteLine(int32(h.B.First()))
    Console.WriteLine(int32(h.B.GetAt(5)))
    Console.WriteLine(int32(h.B.Name[5]))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal(Lines("66", "-3", "-3"), output)
    }

    @Fact
    func ArrayElementAndRefParameterReceivers_Pin() {
        let source = BoneInfoPrelude + `unsafe func sum4(ref b BoneInfo) int32 {
    var total = 0
    fixed p *int8 = b.Name {
        for var i = 0; i < 4; i++ {
            total = total + int32(p[i])
        }
    }
    return total
}

unsafe func run() {
    var bones = []BoneInfo{BoneInfo{}, BoneInfo{}}
    fixed q *int8 = bones[1].Name {
        q[0] = int8(1)
        q[1] = int8(2)
        q[2] = int8(3)
        q[3] = int8(4)
    }
    Console.WriteLine(int32(bones[1].Name[3]))
    Console.WriteLine(int32(bones[0].Name[3]))
    Console.WriteLine(sum4(ref bones[1]))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal(Lines("4", "0", "10"), output)
    }

    @Fact
    func GenericStructBuffer_PinsInMethodAndInsideLambda() {
        // A buffer on a generic struct addresses its field through the
        // constructed TypeSpec; inside a lambda the holder is a captured
        // variable, so the pin is rooted at a closure field.
        let source = `package Probe
import System

unsafe struct GBuf[T] {
    fixed Data [4]int32
    var Tag T

    func Sum() int32 {
        var t = 0
        fixed p *int32 = Data {
            for var i = 0; i < 4; i++ {
                t = t + p[i]
            }
        }
        return t
    }
}

unsafe class Box {
    var G GBuf[string]
}

unsafe func run() {
    var b = Box()
    b.G.Data[0] = 5
    b.G.Data[3] = 7
    Console.WriteLine(b.G.Sum())
    var f = func() int32 {
        fixed q *int32 = b.G.Data {
            q[1] = 30
            return q[3]
        }
    }
    Console.WriteLine(f())
    Console.WriteLine(b.G.Sum())
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal(Lines("12", "7", "42"), output)
    }

    @Fact
    func PinnedBuffer_SurvivesCollectionsInsideTheBlock() {
        // The pin must hold the heap object in place while the body allocates
        // and forces full compacting collections; the raw pointer taken before
        // the collections must still address the object's live buffer.
        let source = BoneInfoPrelude + `unsafe func churn() {
    var junk = []Object{}
    for var i = 0; i < 20000; i++ {
        junk = []Object{Object()}
    }
    GC.Collect()
    GC.WaitForPendingFinalizers()
    GC.Collect()
}

unsafe func run() {
    var h = Holder()
    fixed p *int8 = h.B.Name {
        churn()
        p[7] = int8(99)
        churn()
        Console.WriteLine(int32(p[7]))
    }
    Console.WriteLine(int32(h.B.Name[7]))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal(Lines("99", "99"), output)
    }

    @Fact
    func BareBufferPin_EmitsPinnedByRefToFixedElementField() {
        // C# emits, for `fixed (sbyte* p = Name)` in a struct method:
        //   ldarg.0
        //   ldflda  valuetype BoneInfo/'<Name>e__FixedBuffer' BoneInfo::Name
        //   ldflda  int8 BoneInfo/'<Name>e__FixedBuffer'::FixedElementField
        //   stloc   [int8& pinned]
        // gsc must produce the same pin: an `int8& pinned` local loaded from
        // the element-field address, released (nulled) in a finally.
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4378_il_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, BoneInfoPrelude)
            Compile(srcPath, outPath, "library")
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let first = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single((m MethodDefinition) -> md.GetString(m.Name) == "First")
            let body = pe.GetMethodBody(first.RelativeVirtualAddress)
            // The local signature carries ELEMENT_TYPE_PINNED ELEMENT_TYPE_BYREF ELEMENT_TYPE_I1.
            Assert.False(body.LocalSignature.IsNil, "expected a local signature")
            let localSig = md.GetBlobBytes(md.GetStandaloneSignature(body.LocalSignature).Signature)
            Assert.True(
                ContainsSequence(localSig, []uint8{0x45, 0x10, 0x04}),
                "expected an 'int8& pinned' local; signature was ${BitConverter.ToString(localSig)}"
            )
            // The pin is loaded from `ldflda Name; ldflda FixedElementField; stloc`.
            // (IlInstructionReader records operand tokens for calls only; `ldflda`
            // is a one-byte opcode followed by its 4-byte field token.)
            let ilBytes = body.GetILBytes() ?? Array.Empty[uint8]()
            let il = IlInstructionReader.Read(ilBytes)
            let LdfldaField = func (i IlInstruction) string {
                return FieldName(md, BitConverter.ToInt32(ilBytes, i.Offset + 1))
            }
            let ldfldaFields = il.Where((i IlInstruction) -> i.OpCode == OpCodes.Ldflda).Select(LdfldaField).ToList()
            Assert.Equal([]string{"Name", "FixedElementField"}, ldfldaFields)
            let elementIndex = Array.FindIndex(
                il,
                (i IlInstruction) -> i.OpCode == OpCodes.Ldflda && LdfldaField(i) == "FixedElementField"
            )
            Assert.True(
                IsStloc(il[elementIndex + 1].OpCode),
                "expected stloc after ldflda FixedElementField, got ${il[elementIndex + 1].OpCode}"
            )
            // The pin is released in a finally region.
            Assert.Contains(body.ExceptionRegions, (r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Finally)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch {
                // ignored

            }
        }
    }

    shared {
        private let FixedIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        // The Raylib-cs `BoneInfo` shape: a 32-byte name buffer next to a parent index.
        private const BoneInfoPrelude string = `package Probe
import System

unsafe struct BoneInfo {
    fixed Name [32]int8
    var Parent int32

    func First() int8 {
        fixed p *int8 = Name {
            return p[0]
        }
    }

    func SetAt(i int32, v int8) {
        Name[i] = v
    }

    func GetAt(i int32) int8 {
        return Name[i]
    }
}

unsafe class Holder {
    var B BoneInfo
}
`

        private func Lines(lines ...string) string -> string.Concat(lines.Select((l string) -> l + Environment.NewLine))

        private func IsStloc(opCode OpCode) bool -> opCode == OpCodes.Stloc ||
            opCode == OpCodes.Stloc_S ||
            opCode == OpCodes.Stloc_0 ||
            opCode == OpCodes.Stloc_1 ||
            opCode == OpCodes.Stloc_2 ||
            opCode == OpCodes.Stloc_3

        private func FieldName(md MetadataReader, token int32) string {
            let handle = MetadataTokens.EntityHandle(token)
            return switch handle.Kind {
                case HandleKind.FieldDefinition: md.GetString(md.GetFieldDefinition(FieldDefinitionHandle(handle)).Name)
                case HandleKind.MemberReference: md.GetString(md.GetMemberReference(MemberReferenceHandle(handle)).Name)
                default: string.Empty
            }
        }

        private func ContainsSequence(haystack[]uint8, needle[]uint8) bool {
            for var i = 0; i + needle.Length <= haystack.Length; i++ {
                if haystack.AsSpan(i, needle.Length).SequenceEqual(needle) {
                    return true
                }
            }
            return false
        }

        private func Compile(srcPath string, outPath string, target string) {
            let args = []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4378_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                Compile(srcPath, outPath, "exe")
                IlVerifier.Verify(outPath, nil, FixedIlVerifyIgnored)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdoutTask = proc.StandardOutput.ReadToEndAsync()
                let stderrTask = proc.StandardError.ReadToEndAsync()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
