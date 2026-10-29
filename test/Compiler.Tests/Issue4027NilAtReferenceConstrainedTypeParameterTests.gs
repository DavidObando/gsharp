// <copyright file="Issue4027NilAtReferenceConstrainedTypeParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #4027: a `nil` literal at a reference-constrained
/// `[T class]` slot emitted a bare `ldnull` against a signature slot
/// typed `!!T` (or `!T`), and the IL did not verify.
/// @remarks <b>Cause.</b> Two sites, one rule. `Conversion.Classify(nil, T)`
/// is `Implicit` for a reference-constrained type parameter and that is
/// deliberate (#2354) — a `[T class]` slot is a reference in every
/// instantiation. But nothing lowered the accepted literal: it stayed a
/// `BoundLiteralExpression(null)` and
/// `MethodBodyEmitter.EmitLiteral` emits `ldnull` for that. ECMA-335
/// III.1.8.1.3 has no rule admitting a null reference at a generic-parameter
/// slot — constraint or no constraint — so ILVerify reported
/// `[StackUnexpected] [found Nullobjref 'NullReference'] [expected value
/// 'T']`.
///
/// <b>Fix.</b> Lower it to `default(T)`, which is what the emitter
/// already materialises correctly. `MethodBodyEmitter.EmitDefault` has
/// routed a type-parameter-typed `BoundDefaultExpression` through
/// `ldloca; initobj; ldloc` since #774, and #814 already sent the
/// `T?` spelling of this very literal there; #4027 sends the BARE
/// spelling too. `ConversionClassifier.BindConversion` covers the
/// declaration, assignment, return and field sinks; the call-argument sink
/// needed its own clause in `OverloadResolver.CallBinding`, because
/// #3222's erasure skip deliberately declines to materialise a bare erased
/// slot whose substituted target is still open — which is exactly this
/// shape.
///
/// <b>The IL choice is not invented.</b> Measured: `csc` compiling
/// `static int Fwd<T>() where T : class => Takes<T>(null);`
/// emits `ldloca.s 0; initobj !!T; ldloc.0; call` and that assembly
/// verifies. gsc now emits the same three opcodes at the same place. A
/// `box`/`unbox.any` pair would also type-check on the stack, but it
/// is two extra opcodes and would differ from the reference implementation for
/// no gain.
///
/// <b>Meaning is preserved, and the rows prove it.</b> For a
/// `[T class]` slot `default(T)` IS the null reference in every
/// instantiation, so the `nil` still ARRIVES. Every row here runs and
/// asserts the value the callee observed, so a change that had quietly stopped
/// passing the argument — or started passing something else — would print the
/// wrong number rather than merely verify.
///
/// <b>Six sinks were red, not one.</b> The issue names the call
/// argument. Sweeping every way a `nil` can reach an open
/// reference-constrained slot found five more: a local declaration, an
/// assignment, a `return`, and — on a generic CLASS, where the slot is
/// `!T` rather than `!!T` — a field write and a member
/// `return`. All six were `StackUnexpected` on the parent
/// (`565b9a04`); all six verify here.
open class Issue4027NilAtReferenceConstrainedTypeParameterTests {
    /// Every sink compiles, IL-VERIFIES, runs, and prints the value the callee
    /// actually observed.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("UnverifiableSinks")
    func ANilAtAnOpenReferenceConstrainedSlot_VerifiesAndArrives(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// Every neighbour that was already green stays green.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines; empty means the
    /// case must NOT compile.
    @Theory
    @MemberData("GreenNeighbours")
    func AGreenNeighbour_IsUnchanged(name string, source string, expectedLines[]string) {
        if expectedLines.Length == 0 {
            let rejectDir = Directory.CreateTempSubdirectory("gs_4027_neg_").FullName
            try {
                let rejectPath = Path.Combine(rejectDir, name + ".dll")
                let rejectLog = Compile(rejectDir, "App.gs", source, rejectPath, "/target:exe")
                Assert.False(File.Exists(rejectPath), (`'` + "$name" + `' must not compile. Log:
` + "$rejectLog"))
                Assert.Contains("GS0154", rejectLog, StringComparison.Ordinal)
            } finally {
                Directory.Delete(rejectDir, recursive: true)
            }
            return
        }
        CompileVerifyAndRun(name, source, expectedLines)
    }

    /// The emitted call site carries the exact three opcodes `csc` emits
    /// for the same C# program — `ldloca.s N`, `initobj !!T`,
    /// `ldloc.N` — and NOT a bare `ldnull`. Pinned because "it
    /// verifies" alone would also accept a `box`/`unbox.any` pair,
    /// and the point of the fix is that gsc matches the reference
    /// implementation.
    /// @remarks The body is DECODED into opcodes rather than scanned as bytes.
    /// A metadata token operand can hold any byte value, `ldnull`'s
    /// `0x14` included, so a raw byte scan can answer for the wrong reason
    /// in either direction — it could report the defect's opcode inside the
    /// `initobj` TypeSpec token, or miss a real one. Raised in review of
    /// PR #4040.
    @Fact
    func TheCallSiteEmitsInitobj_NotLdnull() {
        const Source = `package Demo
import System

func takesClassT[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }
func fwdClassT[T class]() int32 { return takesClassT[T](nil) }

Console.WriteLine(fwdClassT[string]())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4027_il_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Shape.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`the shape case must compile. Log:
` + "$appLog"))
            let opcodes = DecodeOpcodes(ReadMethodIl(appPath, "fwdClassT"))
            // The exact shape `csc` emits for `Takes<T>(null)` under
            // `where T : class`, compared as DECODED OPCODES rather than as raw
            // bytes: a metadata token operand can legitimately contain any byte
            // value, including `ldnull`'s 0x14, so a byte scan can answer for the
            // wrong reason in either direction.
            Assert.Equal([]string{"ldloca.s", "initobj", "ldloc.0", "call", "ret"}, opcodes)
            // And the defect's own instruction is gone as an INSTRUCTION.
            Assert.DoesNotContain("ldnull", opcodes)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// Every sink through which a `nil` reaches an open
        /// reference-constrained type-parameter slot. Each one reported
        /// `StackUnexpected` on the parent.
        /// @returns Case name, G# source, expected stdout lines.
        func UnverifiableSinks() sequence[[]object] {
            // The issue's own repro: the CALL ARGUMENT. `ldnull` at a `!!0` slot.
            yield[]object{"the-issues-repro-a-call-argument-at-an-open-class-constrained-slot", `package Demo
import System

func takesClassT[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }
func fwdClassT[T class]() int32 { return takesClassT[T](nil) }

Console.WriteLine(fwdClassT[string]())`, []string{"1"}}
            // A LOCAL DECLARATION whose declared type is the open parameter.
            yield[]object{"a-local-declaration-of-the-open-type-parameter", `package Demo
import System

func localSink[T class]() int32 {
    let x T? = nil
    if x == nil { return 1 }
    return 2
}

Console.WriteLine(localSink[string]())`, []string{"1"}}
            // An ASSIGNMENT over a variable already holding a real value, so the
            // printed answer changes if the nil fails to land.
            yield[]object{"an-assignment-over-a-live-value-of-the-open-type-parameter", `package Demo
import System

func assignSink[T class](seed T) int32 {
    var x T? = seed
    if x == nil { return 3 }
    x = nil
    if x == nil { return 1 }
    return 2
}

Console.WriteLine(assignSink[string]("seed"))`, []string{"1"}}
            // A RETURN of the open type parameter.
            yield[]object{"a-return-of-the-open-type-parameter", `package Demo
import System

func returnSink[T class]() T? {
    return nil
}

Console.WriteLine(returnSink[string]() == nil)`, []string{"True"}}
            // A generic CLASS's own type parameter is `!T`, not `!!T`. Both the
            // field write and the member return were red.
            yield[]object{"a-generic-classs-own-type-parameter-field-write-and-member-return", `package Demo
import System

class Box[T class] {
    public var V T?

    public func Seed(v T) {
        this.V = v
    }

    public func Clear() {
        this.V = nil
    }

    public func Get() T? {
        return nil
    }
}

let b = Box[string]()
b.Seed("live")
Console.WriteLine(b.V == nil)
b.Clear()
Console.WriteLine(b.V == nil)
Console.WriteLine(b.Get() == nil)`, []string{"False", "True", "True"}}
            // The same call-argument sink, closed at a G#-DECLARED class instead of
            // an imported one, so the argument that arrives is a same-compilation
            // reference. Red on the parent for the same reason as the first row
            // (`1x StackUnexpected`), and it also carries a real `Payload` through
            // the same slot, so a timid gate would print a wrong first number.
            yield[]object{"the-open-slot-closed-at-a-same-compilation-class", `package Demo
import System

class Payload { public var N int32 }

func takesClassT[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }
func fwdNil[T class]() int32 { return takesClassT[T](nil) }

let p = Payload()
p.N = 5
Console.WriteLine(takesClassT[Payload](p))
Console.WriteLine(fwdNil[Payload]())`, []string{"2", "1"}}
            // The whole set in one assembly, which is how the six errors were
            // originally counted. Keeps the rows above from drifting apart.
            yield[]object{"all-six-sinks-in-one-assembly", `package Demo
import System

class Box[T class] {
    public var V T?

    public func Set() {
        this.V = nil
    }

    public func Get() T? {
        return nil
    }
}

func takesClassT[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }

func argSink[T class]() int32 { return takesClassT[T](nil) }

func localSink[T class]() int32 {
    let x T? = nil
    if x == nil { return 1 }
    return 2
}

func assignSink[T class](seed T) int32 {
    var x T? = seed
    x = nil
    if x == nil { return 1 }
    return 2
}

func returnSink[T class]() T? {
    return nil
}

let b = Box[string]()
b.Set()
Console.WriteLine(argSink[string]())
Console.WriteLine(localSink[string]())
Console.WriteLine(assignSink[string]("s"))
Console.WriteLine(returnSink[string]() == nil)
Console.WriteLine(b.Get() == nil)`, []string{"1", "1", "1", "True", "True"}}
        }

        /// Neighbouring shapes that were already green and must stay green — the
        /// controls that stop the lowering from being read as "every nil is now a
        /// default".
        /// @returns Case name, G# source, expected stdout lines.
        func GreenNeighbours() sequence[[]object] {
            // A CLOSED reference slot keeps emitting `ldnull`; the lowering is
            // keyed on the target being an open type parameter, not on `nil`.
            yield[]object{"control-a-closed-reference-slot-still-takes-a-plain-nil", `package Demo
import System

class Node { public var Name string }

func takesNode(n Node?) int32 { if n == nil { return 1 } else { return 2 } }

Console.WriteLine(takesNode(nil))`, []string{"1"}}
            // `T?` over an open parameter — the spelling #814 already lowered.
            // Both constraint kinds, because they take different representations
            // (`!!T` for [T class], `Nullable<!!T>` for [T struct]).
            yield[]object{"control-the-nullable-spellings-over-an-open-parameter-are-unchanged", `package Demo
import System

func takesNullableClass[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }
func fwdNullableClass[T class]() int32 { return takesNullableClass[T](nil) }

func takesNullableStruct[T struct](x T?) int32 { if x == nil { return 3 } else { return 4 } }
func fwdNullableStruct[T struct]() int32 { return takesNullableStruct[T](nil) }

Console.WriteLine(fwdNullableClass[string]())
Console.WriteLine(fwdNullableStruct[int32]())`, []string{"1", "3"}}
            // The gate must not become timid: a REAL value still forwards through
            // the very open parameter the repro used, and is read back out.
            yield[]object{"control-a-real-value-still-forwards-through-the-open-class-constrained-slot", `package Demo
import System

func lengthOf[T class](x T) int32 { if x == nil { return -1 } else { return 7 } }
func forward[T class](x T) int32 { return lengthOf[T](x) }

Console.WriteLine(forward[string]("hello"))`, []string{"7"}}
            // An UNCONSTRAINED `T` still refuses `nil` (#4010). The lowering must
            // not have re-opened that hole by materialising a default.
            yield[]object{"control-an-unconstrained-open-parameter-still-refuses-nil", `package Demo
import System

func takesBareT[T](x T) int32 { return 1 }
func fwdBareT[T]() int32 { return takesBareT[T](nil) }

Console.WriteLine("x")`, Array.Empty[string]()}
        }

        private func CompileVerifyAndRun(name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4027_").FullName
            try {
                let appPath = Path.Combine(tempDir, name + ".dll")
                let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
                Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
                IlVerifier.Verify(appPath, Array.Empty[string]())
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
                let lines = output
                    .Split('\n')
                    .Select((line string) -> line.TrimEnd('\r'))
                    .Where((line string) -> line.Length > 0)
                    .ToArray()
                Assert.Equal(expectedLines, lines)
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func ReadMethodIl(assemblyPath string, methodName string)[]uint8 {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let md = pe.GetMetadataReader()
            for handle in md.MethodDefinitions {
                let method = md.GetMethodDefinition(handle)
                if !string.Equals(md.GetString(method.Name), methodName, StringComparison.Ordinal) {
                    continue
                }
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                return pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? Array.Empty[uint8]()
            }
            throw InvalidOperationException("method '$methodName' not found in '$assemblyPath'")
        }

        /// Decodes a method body into its opcode mnemonics, skipping each
        /// instruction's operand by the operand size its opcode declares. Only the
        /// opcodes this fixture can legitimately encounter are named; anything else
        /// surfaces as its hex value so a drift shows up as a readable mismatch
        /// rather than as a silent pass.
        /// @param il The raw method body bytes.
        /// @returns The decoded opcode mnemonics, in order.
        private func DecodeOpcodes(il[]uint8)[]string {
            // (mnemonic, operand bytes) for the single-byte opcodes reachable here.
            let oneByte = Dictionary[uint8, (Name string, Operand int32)]{
                [0x00] = ("nop", 0),
                [0x02] = ("ldarg.0", 0),
                [0x06] = ("ldloc.0", 0),
                [0x0A] = ("stloc.0", 0),
                [0x11] = ("ldloc.s", 1),
                [0x12] = ("ldloca.s", 1),
                [0x13] = ("stloc.s", 1),
                [0x14] = ("ldnull", 0),
                [0x16] = ("ldc.i4.0", 0),
                [0x17] = ("ldc.i4.1", 0),
                [0x18] = ("ldc.i4.2", 0),
                [0x28] = ("call", 4),
                [0x2A] = ("ret", 0),
                [0x2B] = ("br.s", 1),
                [0x2C] = ("brfalse.s", 1),
                [0x2D] = ("brtrue.s", 1),
                [0x39] = ("brfalse", 4),
                [0x3A] = ("brtrue", 4),
                [0x6F] = ("callvirt", 4),
                [0x74] = ("castclass", 4),
                [0x8C] = ("box", 4),
                [0xA5] = ("unbox.any", 4)
            }
            // (mnemonic, operand bytes) for the 0xFE-prefixed opcodes reachable here.
            let twoByte = Dictionary[uint8, (Name string, Operand int32)]{[0x01] = ("ceq", 0), [0x15] = ("initobj", 4)}
            let decoded = List[string]()
            var i = 0
            while i < il.Length {
                if il[i] == uint8(0xFE) {
                    Assert.True(i + 1 < il.Length, "truncated two-byte opcode at $i: ${Describe(il)}")
                    Assert.True(
                        twoByte.TryGetValue(il[i + 1], out var wide),
                        "unhandled opcode FE ${il[i + 1]:X2} at $i: ${Describe(il)}"
                    )
                    decoded.Add(wide.Name)
                    i += 2 + wide.Operand
                    continue
                }
                Assert.True(
                    oneByte.TryGetValue(il[i], out var op),
                    "unhandled opcode ${il[i]:X2} at $i: ${Describe(il)}"
                )
                decoded.Add(op.Name)
                i += 1 + op.Operand
            }
            Assert.True(i == il.Length, "operand decoding overran the body: ${Describe(il)}")
            return decoded.ToArray()
        }

        private func Describe(il[]uint8) string -> string.Join(
            " ",
            il.Select((b uint8) -> b.ToString("X2", CultureInfo.InvariantCulture))
        )

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
