// <copyright file="Issue4062DependentBoundReferenceTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Dependent nullable contracts require a concrete reference-class proof, not another parameter's bare class flag.
/// Original unsafe inputs remain rejection witnesses beside constrained, strict-IL runtime controls.
open class Issue4062DependentBoundReferenceTypeTests {
    /// Preserves the original inputs and their valid concrete-reference migrations.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("OriginalNilCases")
    func DependentNilSources_RequireSoundReferenceProofs(name string, source string, expectedLines[]string) {
        var source = source
        if name is not(
            "a-chain-whose-root-carries-a-class-base-bound" or
                "control-a-bare-class-constraint-still-accepts-nil" or
                "control-a-dependent-bound-without-a-nil-is-unchanged"
        ) {
            AssertFirstQuestionIsRejected(source)
            source = source
                .Replace("TBase class", "TBase System.IO.Stream")
                .Replace("A class", "A System.IO.Stream")
                .Replace("Box[T class]", "Box[T System.IO.Stream]")
                .Replace("Sink[T]", "Sink[T System.IO.Stream]")
                .Replace("[object, object, string]", "[System.IO.Stream, System.IO.Stream, System.IO.MemoryStream]")
                .Replace("[object, string]", "[System.IO.Stream, System.IO.MemoryStream]")
                .Replace("Box[object]().Accept[string]", "Box[System.IO.Stream]().Accept[System.IO.MemoryStream]")
                .Replace("\"a\"", "System.IO.MemoryStream()")
        }
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0155", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(expectedLines, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Bare unknown-kind parameters still refuse nil conversions.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @MemberData("NilStillRefused")
    func ADependentBoundThatProvesNothing_StillRefusesNil(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // Assert the COUNT, not the presence.
            let occurrences = appLog.Split("GS0155", StringSplitOptions.None).Length - 1
            Assert.True(occurrences == 1, (`'` + "$name" + `' must report GS0155 exactly once, saw ` + "$occurrences" + `. Log:
` + "$appLog"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A long chain preserves the difference between bare class flags and concrete reference-class bounds.
    /// @param depth The number of dependent-bound hops.
    @Theory
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    @InlineData(int32(7))
    @InlineData(int32(12))
    @InlineData(int32(31))
    @InlineData(int32(32))
    @InlineData(int32(33))
    @InlineData(int32(64))
    func ALongDependentChain_RequiresAConcreteReferenceProof(depth int32) {
        // `[T0 class, T1 T0, ... Tdepth T(depth-1)]`, with the nil at `Tdepth`.
        let parameters = List[string]{"T0 class"}
        for var i = 1; i <= depth; i++ {
            parameters.Add("T$i T${i - 1}")
        }
        let arguments = string.Join(", ", Enumerable.Repeat("object", depth + 1))
        let source = (`package P

import System

class Fixture {
    shared {
        func Deep[` + "${string.Join(", ", parameters)}" + `](d T` + "$depth" + `) T` + "$depth" + `? {
            let joined = false ? d : nil
            return joined
        }
    }
}

Console.WriteLine(Fixture.Deep[` + "$arguments" + `]("a") == nil)`)
        AssertFirstQuestionIsRejected(source)
        let migrated = source
            .Replace("T0 class", "T0 System.IO.Stream")
            .Replace(arguments, string.Join(", ", Enumerable.Repeat("System.IO.Stream", depth + 1)))
            .Replace("\"a\"", "System.IO.MemoryStream()")
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_deep_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Deep$depth.dll")
            let appLog = Compile(tempDir, "App.gs", migrated, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0155", appLog, StringComparison.Ordinal)
            Assert.True(
                File.Exists(appPath),
                "A $depth-hop concrete reference-bound chain must compile. Log:${Environment.NewLine}$appLog"
            )
            IlVerifier.Verify(appPath)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`a ` + "$depth" + `-hop chain must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal([]string{"True"}, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The same sweep in the REJECTING direction: however long the chain, a root
    /// that proves nothing still refuses `nil`. This is what stops the
    /// cycle-detection rewrite from having quietly turned the walk into "answer
    /// yes once it runs out of parameters".
    /// @param depth The number of hops to the unconstrained root.
    @Theory
    @InlineData(int32(1))
    @InlineData(int32(12))
    @InlineData(int32(33))
    func ALongDependentChainOverAnUnconstrainedRoot_StillRefusesNil(depth int32) {
        let parameters = List[string]{"T0"}
        for var i = 1; i <= depth; i++ {
            parameters.Add("T$i T${i - 1}")
        }
        let source = (`package P

import System

class Fixture {
    shared {
        func Deep[` + "${string.Join(", ", parameters)}" + `](d T` + "$depth" + `) T` + "$depth" + ` {
            return nil
        }
    }
}

Console.WriteLine("x")`)
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_deepneg_").FullName
        try {
            let appPath = Path.Combine(tempDir, "DeepNeg$depth.dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`a ` + "$depth" + `-hop unconstrained chain must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            let occurrences = appLog.Split("GS0155", StringSplitOptions.None).Length - 1
            Assert.True(
                occurrences == 1,
                "a $depth-hop unconstrained chain must report GS0155 exactly once, saw $occurrences. " + (`Log:
` + "$appLog")
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A CYCLIC dependent bound terminates rather than spinning, and does not
    /// admit `nil` on the strength of a chain that has no root. #4043
    /// already reports `GS0581` and CLEARS the bound; this row is what
    /// makes "the visited set is belt-and-braces, not the only thing standing
    /// between us and a hang" a measurement.
    @Fact
    func ACyclicDependentBound_TerminatesAndStillRefusesNil() {
        const Source = `package P

import System

class Fixture {
    shared {
        func Cycle[A B, B A](d A) A {
            return nil
        }
    }
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_cyc_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Cycle.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`a cyclic bound must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // #4043's own rule fires, once.
            let cycleOccurrences = appLog.Split("GS0581", StringSplitOptions.None).Length - 1
            Assert.True(
                cycleOccurrences == 1,
                (`the cycle must report GS0581 exactly once, saw ` + "$cycleOccurrences" + `. Log:
` + "$appLog")
            )
            // And the nil is still refused: a cleared cycle proves nothing.
            let nilOccurrences = appLog.Split("GS0155", StringSplitOptions.None).Length - 1
            Assert.True(nilOccurrences == 1, (`the nil must report GS0155 exactly once, saw ` + "$nilOccurrences" + `. Log:
` + "$appLog"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The emitted IL for a `nil` at a dependent-bound parameter is
    /// `default(T)` — `ldloca; initobj !!T; ldloc` — and NOT a bare
    /// `ldnull`. That is what the issue asks for, for #4027's reasons:
    /// ECMA-335 III.1.8.1.3 has no rule letting a null reference match a
    /// generic-parameter slot, so `ldnull` at a `!!T` position is
    /// `[StackUnexpected] [found Nullobjref]` no matter what the
    /// constraint says.
    /// @remarks IL verification alone would catch the wrong shape, but only as a
    /// verifier error; this asserts the OPCODES, so a future lowering that
    /// happens to verify for an unrelated reason cannot silently replace them.
    /// The dependent-bound method's body is compared against the bare
    /// `[T class]` method's, which #4027 already pinned — the point of
    /// this change is that the two are the same.
    @Fact
    func TheEmittedNilIsDefaultOfTAndNotABareLdnull() {
        const Source = `package P

import System

class Fixture {
    shared {
        func Dependent[TBase class, TDerived TBase](d TDerived) TDerived? {
            let joined = false ? d : nil
            return joined
        }

        func Bare[T class](d T) T? {
            let joined = false ? d : nil
            return joined
        }
    }
}

Console.WriteLine(Fixture.Dependent[object, string]("a") == nil)
Console.WriteLine(Fixture.Bare[string]("a") == nil)`
        AssertFirstQuestionIsRejected(Source)
        let migrated = Source.Replace("TBase class", "TBase System.IO.Stream").Replace(
            "Fixture.Dependent[object, string](\"a\")",
            "Fixture.Dependent[System.IO.Stream, System.IO.MemoryStream](System.IO.MemoryStream())"
        )
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_il_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Il.dll")
            let appLog = Compile(tempDir, "App.gs", migrated, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`the program must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath)
            let dependentIl = DisassembleMethodBody(appPath, "Dependent")
            let bareIl = DisassembleMethodBody(appPath, "Bare")
            Assert.Contains("initobj", dependentIl, StringComparison.Ordinal)
            Assert.DoesNotContain("ldnull", dependentIl, StringComparison.Ordinal)
            // The dependent-bound body is the SAME shape #4027 pinned for the
            // bare `class` constraint. Comparing them is what makes "no emit
            // path changed" a measurement rather than a claim.
            Assert.Equal(bareIl, dependentIl)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the program must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal([]string{"True", "True"}, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private func AssertFirstQuestionIsRejected(source string) {
            let offset = source.IndexOf('?')
            Assert.True(offset >= 0)
            let line = source.Substring(0, offset).Count((c char) -> c == '\n') + 1
            let column = offset - source.LastIndexOf('\n', offset)
            Issue6040GenericNullableReturnDriverTests.CheckRejected(
                source,
                []string{"GS0641@${line},${column},${line},${column + 1}"}
            )
        }

        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// Original dependent-bound inputs, including unsafe class-flag cases and valid controls.
        /// @returns Case name, G# source, expected stdout lines.
        func OriginalNilCases() sequence[[]object] {
            // THE ISSUE'S OWN REPRO, with the return value observed rather than
            // merely compiled.
            yield []object{"the-issues-repro-nil-returned-at-a-dependent-bound", `package P

import System

class Fixture {
    shared {
        func Take[TBase class, TDerived TBase](d TDerived) TDerived? {
            let joined = false ? d : nil
            return joined
        }
    }
}

Console.WriteLine(Fixture.Take[object, string]("a") == nil)`, []string{"True"}}
            // A LOCAL initialiser rather than a return. Same predicate, different
            // sink — the #4027 lowering has to fire at every one of them.
            yield []object{"a-local-initialiser-at-a-dependent-bound", `package P

import System

class Fixture {
    shared {
        func Take[TBase class, TDerived TBase](d TDerived) bool {
            var local = false ? d : nil
            return local == nil
        }
    }
}

Console.WriteLine(Fixture.Take[object, string]("a"))`, []string{"True"}}
            // ARGUMENT position, which routes through
            // OverloadResolver.CallBinding rather than through the ordinary
            // conversion classifier.
            yield []object{"argument-position-at-a-dependent-bound", `package P

import System

class Fixture {
    shared {
        func Sink[T](d T?) string {
            if d == nil {
                return "got-nil"
            }
            return "got-value"
        }

        func Pass[TBase class, TDerived TBase]() string {
            return Sink[TDerived](nil)
        }
    }
}

Console.WriteLine(Fixture.Pass[object, string]())`, []string{"got-nil"}}
            // ASSIGNMENT to an already-declared local — the fourth sink #4027
            // enumerated.
            yield []object{"assignment-to-a-declared-local-at-a-dependent-bound", `package P

import System

class Fixture {
    shared {
        func Take[TBase class, TDerived TBase](d TDerived) bool {
            var local TDerived? = d
            local = nil
            return local == nil
        }
    }
}

Console.WriteLine(Fixture.Take[object, string]("a"))`, []string{"True"}}
            // A CHAIN of depth three, so the walk is a walk and not a single hop.
            yield []object{"a-three-link-chain-whose-root-carries-class", `package P

import System

class Fixture {
    shared {
        func Chain[A class, B A, C B](c C) C? {
            var local = false ? c : nil
            return local
        }
    }
}

Console.WriteLine(Fixture.Chain[object, object, string]("a") == nil)`, []string{"True"}}
            // The ENCLOSING-TYPE shape (#4068's third placement): a generic
            // method's parameter bounded by its CLASS's parameter, which is where
            // the `class` constraint lives.
            yield []object{"a-method-parameter-bounded-by-the-enclosing-types-class-parameter", `package P

import System

class Box[T class] {
    public func Accept[U T](u U) string {
        var v = false ? u : nil
        if v == nil {
            return "nil-ok"
        }
        return "not-nil"
    }
}

Console.WriteLine(Box[object]().Accept[string]("a"))`, []string{"nil-ok"}}
            // The root carries a CLASS-BASE bound rather than the bare `class`
            // flag. `IsReferenceConstrainedTypeParameter` treats the two as equally
            // strong proof of reference-ness (#2188), and the chain walk must too.
            yield []object{"a-chain-whose-root-carries-a-class-base-bound", `package P

import System

open class Animal {
    public var Name string = "a"
}

class Fixture {
    shared {
        func Take[TBase Animal, TDerived TBase](d TDerived) TDerived? {
            let joined = false ? d : nil
            return joined
        }
    }
}

Console.WriteLine(Fixture.Take[Animal, Animal](Animal()) == nil)`, []string{"True"}}
            // CONTROL — #2354's own rule, which this must not disturb: a bare
            // `[T class]` still accepts nil, with the same #4027 lowering.
            yield []object{"control-a-bare-class-constraint-still-accepts-nil", `package P

import System

class Fixture {
    shared {
        func Take[T class](d T) T? {
            let joined = false ? d : nil
            return joined
        }
    }
}

Console.WriteLine(Fixture.Take[string]("a") == nil)`, []string{"True"}}
            // CONTROL — a dependent bound with no nil anywhere still compiles,
            // verifies and runs exactly as #4043 left it. The new property is read
            // only at a nil, so a program without one must be untouched.
            yield []object{"control-a-dependent-bound-without-a-nil-is-unchanged", `package P

import System

class Fixture {
    shared {
        func Take[TBase class, TDerived TBase](d TDerived) TDerived {
            return d
        }
    }
}

Console.WriteLine(Fixture.Take[object, string]("kept"))`, []string{"kept"}}
        }

        /// Every dependent bound whose chain does NOT prove reference-ness. These
        /// must stay `GS0155`: a bound over an unconstrained or
        /// value-type-constrained parameter admits a struct, and `nil` at a
        /// value-type slot is #4027's unverifiable defect.
        /// @returns Case name, G# source.
        func NilStillRefused() sequence[[]object] {
            // The root is UNCONSTRAINED, so TDerived can be a struct.
            yield []object{"a-dependent-bound-over-an-unconstrained-root", `package P

import System

class Fixture {
    shared {
        func Take[TBase, TDerived TBase](d TDerived) TDerived {
            return nil
        }
    }
}

Console.WriteLine("x")`}
            // The root is `struct`, so TDerived is certainly a value type.
            yield []object{"a-dependent-bound-over-a-struct-constrained-root", `package P

import System

class Fixture {
    shared {
        func Take[TBase struct, TDerived TBase](d TDerived) TDerived {
            return nil
        }
    }
}

Console.WriteLine("x")`}
            // A three-link chain whose ROOT is unconstrained. The walk must reach
            // the root before it answers, not stop at the first link.
            yield []object{"a-three-link-chain-whose-root-is-unconstrained", `package P

import System

class Fixture {
    shared {
        func Chain[A, B A, C B](c C) C {
            return nil
        }
    }
}

Console.WriteLine("x")`}
            // The root's only bound is an INTERFACE. C# does not treat an
            // interface constraint as proof of reference-ness either — a struct
            // may implement it — so this stays refused, exactly as a bare
            // `[T IDisposable]` does.
            yield []object{"a-dependent-bound-over-an-interface-constrained-root", `package P

import System

class Fixture {
    shared {
        func Take[TBase IDisposable, TDerived TBase](d TDerived) TDerived {
            return nil
        }
    }
}

Console.WriteLine("x")`}
            // CONTROL, one bound-kind over: a bare unconstrained parameter still
            // refuses nil. This is the rule the chain walk must not have widened
            // past — the walk starts at TypeParameterBound, so a parameter with no
            // bound at all is answered by the pre-existing predicate alone.
            yield []object{"control-a-bare-unconstrained-parameter-still-refuses-nil", `package P

import System

class Fixture {
    shared {
        func Take[T](d T) T {
            return nil
        }
    }
}

Console.WriteLine("x")`}
        }

        /// Returns the opcode names of [`methodName`](paramref)'s IL body,
        /// with operands stripped so the two generic methods' bodies compare on
        /// SHAPE rather than on their differing type tokens.
        /// @param assemblyPath The emitted assembly.
        /// @param methodName The method to disassemble.
        /// @returns The opcode names, one per line.
        private func DisassembleMethodBody(assemblyPath string, methodName string) string {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            for handle in reader.MethodDefinitions {
                let definition = reader.GetMethodDefinition(handle)
                if !string.Equals(reader.GetString(definition.Name), methodName, StringComparison.Ordinal) {
                    continue
                }
                let body = peReader.GetMethodBody(definition.RelativeVirtualAddress)
                let il = body.GetILBytes() ?? throw InvalidOperationException("'$methodName' has no IL body.")
                let opcodes = List[string]()
                for var offset = 0; offset < il.Length; {
                    let (name, size) = DecodeOpcode(il, offset)
                    opcodes.Add(name)
                    offset += size
                }
                return string.Join("\n", opcodes)
            }
            throw InvalidOperationException("method '$methodName' was not found in $assemblyPath.")
        }

        /// Decodes the opcode at [`offset`](paramref), returning its name and
        /// its total size in bytes (opcode plus inline operand). Covers only the
        /// opcodes these two method bodies can contain; anything else fails loudly
        /// rather than mis-parsing.
        /// @param il The method's IL bytes.
        /// @param offset The offset to decode at.
        /// @returns The opcode name and its total encoded size.
        private func DecodeOpcode(il[]uint8, offset int32)(Name string, Size int32) {
            return switch il[offset] {
                case 0x00: ("nop", 1)
                case 0x02: ("ldarg.0", 1)
                case 0x03: ("ldarg.1", 1)
                case 0x06: ("ldloc.0", 1)
                case 0x07: ("ldloc.1", 1)
                case 0x0A: ("stloc.0", 1)
                case 0x0B: ("stloc.1", 1)
                case 0x11: ("ldloc.s", 2)
                case 0x12: ("ldloca.s", 2)
                case 0x13: ("stloc.s", 2)
                case 0x14: ("ldnull", 1)
                case 0x16: ("ldc.i4.0", 1)
                case 0x2C: ("brfalse.s", 2)
                case 0x2D: ("brtrue.s", 2)
                case 0x39: ("brfalse", 5)
                case 0x3A: ("brtrue", 5)
                case 0x25: ("dup", 1)
                case 0x2A: ("ret", 1)
                case 0x38: ("br", 5)
                case 0x2B: ("br.s", 2)
                case 0xFE: switch il[offset + 1] {
                    case 0x15: ("initobj", 6)
                    default: throw InvalidOperationException("unexpected two-byte opcode 0xFE${il[offset + 1]:X2}.")
                }
                default: throw InvalidOperationException("unexpected opcode 0x${il[offset]:X2} at offset $offset.")
            }
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

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
