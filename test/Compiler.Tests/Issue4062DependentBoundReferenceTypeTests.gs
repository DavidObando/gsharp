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

/// Issue #4062: a DEPENDENT constraint propagates the bounding parameter's
/// `class` constraint, so `nil` is legal at
/// `[TBase class, TDerived TBase]`.
/// @remarks <b>The defect.</b> `return nil` at a `TDerived` slot under
/// `[TBase class, TDerived TBase]` reported
/// `GS0155: Cannot convert type 'nil' to 'TDerived'.` — measured on
/// `origin/main` @ `7708be7d` before anything was written. C#
/// propagates a bounding parameter's special constraints to the bounded one, so
/// `TDerived : TBase : class` proves `TDerived` is a reference type in
/// every instantiation and `csc` accepts `TDerived x = null;`.
/// `[T class]` on its own was already accepted (#2354's rule); the
/// reference-ness simply did not travel down a `TypeParameterBound`
/// chain.
///
/// <b>Root cause and the shape of the repair.</b> #4043 made
/// `TypeParameterSymbol.TypeParameterBound` a SEPARATE slot from
/// `ClassConstraint` on purpose: roughly forty consumers read
/// `ClassConstraint != null` as "this parameter is a reference type" AND
/// as "this is the type it derives from", and the second reading drives boxing
/// and `callvirt` decisions in the emitter that a dependent bound cannot
/// supply. Merging the slots is #4027's defect shape — a slot that looks like a
/// reference emitting `ldnull` at a `!!T` position that is not one.
/// The repair therefore answers only the reference-ness HALF, in one new
/// depth-bounded property (`DependentBoundProvesReferenceType`) read by
/// exactly ONE consumer,
/// the nil rule of `Conversion.Classify` (the old predicate was removed by #4316).
/// `IsReferenceConstrainedTypeParameter` — which also drives
/// `IsReferenceLikeTarget`'s conversion arms, where `ClassConstraint`
/// additionally names the type to box or upcast TO — is deliberately left
/// alone, so this widens `nil` acceptance and nothing else.
///
/// <b>The IL is #4027's shape, not a bare <c>ldnull</c>.</b> The issue
/// asks for `default(T)` (`ldloca; initobj; ldloc`) rather than
/// `ldnull`, and that falls out for free:
/// `ConversionClassifier` already lowers `nil` at ANY bare
/// type-parameter target to a `BoundDefaultExpression` (#4027), so no emit
/// path changed at all. Every green row below IL-verifies and RUNS, and the
/// running rows observe the value — `== nil` prints `True` — so
/// "compiles" is never mistaken for "means nil".
///
/// <b>What must stay refused, and why that is the whole soundness
/// argument.</b> A dependent bound whose chain root carries NO `class`
/// proves nothing: `[TBase, TDerived TBase]` can be instantiated with a
/// struct, and `[TBase struct, TDerived TBase]` certainly is one. Both
/// still report `GS0155`, which is what keeps this a completeness fix
/// rather than a soundness regression — the checker never starts accepting what
/// the CLR refuses.
///
/// <b>Not #4070's rule.</b> Measured, not asserted. #4070 walks
/// `ClassConstraint` for INTERFACE implication in
/// `ClrOverloadResolution`; this walks `TypeParameterBound` for
/// REFERENCE-NESS in `TypeParameterSymbol`/`Conversion`. Disjoint
/// slots, disjoint files, and each commit's witness leaves the other's rows
/// unmoved. They share only a PRINCIPLE — a bound implies what the bounding
/// thing proves — which has three entry points that cannot share a helper
/// (the third is filed as #4084).
open class Issue4062DependentBoundReferenceTypeTests {
    /// `nil` at a type parameter whose dependent-bound chain roots in
    /// `class` now compiles, IL-verifies, runs, and observably carries a
    /// null.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("NilAccepted")
    func ADependentBoundRootedInClass_AcceptsNil(name string, source string, expectedLines[]string) {
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

    /// A dependent bound whose chain does not prove reference-ness still
    /// refuses `nil` with `GS0155` — the fix is a completeness fix
    /// and never accepts what the CLR refuses.
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

    /// The chain walk is terminated by VISITED-SYMBOL cycle detection, not by a
    /// depth limit, so a chain that is merely LONG still proves reference-ness
    /// (review of PR #4088). Swept across depths rather than tested at one, for
    /// the reason PR #4068's own replacement of a depth cap failed.
    /// @remarks <b>The finding.</b> The first version used a fixed 32-hop cap.
    /// Measured on that build: `[T0 class, T1 T0, … T33 T32]` — where the
    /// reference constraint is proven 33 hops away — reported
    /// `GS0155: Cannot convert type 'nil' to 'T33'.` A cap is a SEMANTIC
    /// answer ("no") to a question about length, which is the wrong shape; the
    /// only thing that may stop the walk is actually revisiting a parameter.
    ///
    /// <b>Why a sweep and not one deep row.</b> PR #4068 replaced the same
    /// kind of cap and its first attempt keyed cycle detection on
    /// `ClrTypeUtilities.IsSameAs`, whose `Type.FullName` is
    /// `null` for an open constructed generic — so every nested
    /// generic compared equal, a FALSE cycle fired at the first hop, and the
    /// catchable depth collapsed from seven to one while the change looked like
    /// a fix. A single deep row would not have caught that; a SWEEP does,
    /// because a false cycle shows up as the SHALLOW rows failing. The walk here
    /// keys on reference identity of the `TypeParameterSymbol`, which needs
    /// no name at all and so cannot have that defect — and these rows are what
    /// says so rather than the argument.
    /// @param depth The number of hops from the bounded parameter to the `class` root.
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
    func ALongButValidDependentChain_StillAcceptsNil(depth int32) {
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
            return nil
        }
    }
}

Console.WriteLine(Fixture.Deep[` + "$arguments" + `]("a") == nil)`)
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_deep_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Deep$depth.dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0155", appLog, StringComparison.Ordinal)
            Assert.True(
                File.Exists(appPath),
                (`a ` + "$depth" + `-hop chain rooted in ` + "\u0060" + `class` + "\u0060" + ` must compile. Log:
` + "$appLog")
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
            return nil
        }

        func Bare[T class](d T) T? {
            return nil
        }
    }
}

Console.WriteLine(Fixture.Dependent[object, string]("a") == nil)
Console.WriteLine(Fixture.Bare[string]("a") == nil)`
        let tempDir = Directory.CreateTempSubdirectory("gs_4062_il_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Il.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
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
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// Every position at which `nil` must now be accepted under a
        /// dependent bound whose chain root is `class`. Each of these reported
        /// `GS0155` on the parent.
        /// @returns Case name, G# source, expected stdout lines.
        func NilAccepted() sequence[[]object] {
            // THE ISSUE'S OWN REPRO, with the return value observed rather than
            // merely compiled.
            yield[]object{"the-issues-repro-nil-returned-at-a-dependent-bound", `package P

import System

class Fixture {
    shared {
        func Take[TBase class, TDerived TBase](d TDerived) TDerived? {
            return nil
        }
    }
}

Console.WriteLine(Fixture.Take[object, string]("a") == nil)`, []string{"True"}}
            // A LOCAL initialiser rather than a return. Same predicate, different
            // sink — the #4027 lowering has to fire at every one of them.
            yield[]object{"a-local-initialiser-at-a-dependent-bound", `package P

import System

class Fixture {
    shared {
        func Take[TBase class, TDerived TBase](d TDerived) bool {
            var local TDerived? = nil
            return local == nil
        }
    }
}

Console.WriteLine(Fixture.Take[object, string]("a"))`, []string{"True"}}
            // ARGUMENT position, which routes through
            // OverloadResolver.CallBinding rather than through the ordinary
            // conversion classifier.
            yield[]object{"argument-position-at-a-dependent-bound", `package P

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
            yield[]object{"assignment-to-a-declared-local-at-a-dependent-bound", `package P

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
            yield[]object{"a-three-link-chain-whose-root-carries-class", `package P

import System

class Fixture {
    shared {
        func Chain[A class, B A, C B](c C) C? {
            var local C? = nil
            return local
        }
    }
}

Console.WriteLine(Fixture.Chain[object, object, string]("a") == nil)`, []string{"True"}}
            // The ENCLOSING-TYPE shape (#4068's third placement): a generic
            // method's parameter bounded by its CLASS's parameter, which is where
            // the `class` constraint lives.
            yield[]object{"a-method-parameter-bounded-by-the-enclosing-types-class-parameter", `package P

import System

class Box[T class] {
    public func Accept[U T](u U) string {
        var v U? = nil
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
            yield[]object{"a-chain-whose-root-carries-a-class-base-bound", `package P

import System

open class Animal {
    public var Name string = "a"
}

class Fixture {
    shared {
        func Take[TBase Animal, TDerived TBase](d TDerived) TDerived? {
            return nil
        }
    }
}

Console.WriteLine(Fixture.Take[Animal, Animal](Animal()) == nil)`, []string{"True"}}
            // CONTROL — #2354's own rule, which this must not disturb: a bare
            // `[T class]` still accepts nil, with the same #4027 lowering.
            yield[]object{"control-a-bare-class-constraint-still-accepts-nil", `package P

import System

class Fixture {
    shared {
        func Take[T class](d T) T? {
            return nil
        }
    }
}

Console.WriteLine(Fixture.Take[string]("a") == nil)`, []string{"True"}}
            // CONTROL — a dependent bound with no nil anywhere still compiles,
            // verifies and runs exactly as #4043 left it. The new property is read
            // only at a nil, so a program without one must be untouched.
            yield[]object{"control-a-dependent-bound-without-a-nil-is-unchanged", `package P

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
            yield[]object{"a-dependent-bound-over-an-unconstrained-root", `package P

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
            yield[]object{"a-dependent-bound-over-a-struct-constrained-root", `package P

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
            yield[]object{"a-three-link-chain-whose-root-is-unconstrained", `package P

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
            yield[]object{"a-dependent-bound-over-an-interface-constrained-root", `package P

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
            yield[]object{"control-a-bare-unconstrained-parameter-still-refuses-nil", `package P

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
