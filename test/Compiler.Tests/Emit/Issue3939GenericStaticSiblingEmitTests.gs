// <copyright file="Issue3939GenericStaticSiblingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3939: two emit paths that reason about GENERIC context and disagreed
/// with a sibling path a few lines away — the #3705 defect class, swept for in
/// the emitter rather than waiting for a migrated app to trip over it.
/// @remarks Finding A: a `shared` (static) call chose EITHER a
/// TypeSpec-parented MemberRef (naming which type owns the method, #1209 /
/// #1433) OR a MethodSpec (naming how the METHOD is instantiated, ADR-0087
/// §3 R3+R4) with an `else if`. Those are independent axes and a
/// `shared func Make[U]()` on a generic `Box[T]` needs both. The
/// INSTANCE sibling in `MethodBodyEmitter.Calls.cs` — and
/// `EmitMethodGroupTarget` in `MethodBodyEmitter.Closures.cs` — have
/// always applied them sequentially.
///
/// Finding B: `StateMachineEmitter.EmitAsyncKickoffBody` re-derived
/// the type parameters in scope at an async kickoff instead of reading the list
/// its state machine was REIFIED from, and its copy never picked up the
/// `StaticOwnerType` half that #3932 root C added to the reification. Both
/// now route through one primitive.
///
/// Grouped by EMITTED IL, not by symptom: finding A's four surface shapes
/// print three different diagnostics (ILVerify `[found ref
/// 'string'][expected ref '!!0']`, `InvalidOperationException` "not
/// fully instantiated", and — once A is fixed — B's `TypeLoadException`)
/// and are one cause, `call <TypeSpec-parented MemberRef naming an open
/// generic method>`.
///
/// Every test COMPILES, ILVERIFIES, RUNS and asserts on behaviour. All
/// three are load-bearing on the #3501 effort: within one week a defect
/// ILVerified clean and threw `TypeLoadException` at load (#3936), and
/// another passed an executing test and was caught only by ILVerify (#3900).
/// Two tests additionally read the emitted metadata back, because "the token is
/// a MethodSpec, not a bare MemberRef" and "the state machine's arity equals
/// its self-instantiation's argument count" are encoding facts no behavioural
/// assertion can name.
///
/// Discrimination (ADR-0154): every test carries controls that passed
/// BEFORE the fix — the same construct in its instance form, its non-generic-
/// method form, and its non-generic-encloser form — so a mutant that applies
/// the new path unconditionally is caught as surely as one that never applies
/// it.
open class Issue3939GenericStaticSiblingEmitTests {
    /// Finding A, the plain shape: a generic `shared` method on a generic
    /// user CLASS. Before the fix the call emitted a TypeSpec-parented MemberRef
    /// naming the OPEN generic method and no MethodSpec at all.
    @Fact
    func GenericSharedMethodOnAGenericClass_GetsBothTheTypeSpecParentAndTheMethodSpec() {
        const source = (`
package main

import System

class Holder[T] {
    shared {
        // The failing shape: BOTH the owner and the method are generic.
        func Plain[U](v T, other U) string -> v.ToString() + "|" + other.ToString()

        // Control: a NON-generic shared method on the same generic type. #1209
        // gave this a TypeSpec-parented MemberRef and no MethodSpec, which is
        // right; a mutant that adds a MethodSpec unconditionally breaks it.
        func PlainNG(v T) string -> "ng:" + v.ToString()
    }

    // Control: the INSTANCE form of the failing shape, which has always
    // resolved the TypeSpec parent and the MethodSpec sequentially.
    func PlainInst[U](v T, other U) string -> v.ToString() + "/" + other.ToString()

    // The SELF-reference shape: the same call from INSIDE the generic type,
    // where the owner instantiation is the OPEN ` + "`" + `!0` + "`" + ` rather than a concrete
    // ` + "`" + `int32` + "`" + `. Both axes still apply, and the TypeSpec is the self one.
    func CallSelf[U](v T, other U) string -> Plain[U](v, other)
}

// Control: a generic shared method on a NON-generic type, which needs a bare
// MethodDef parent and a MethodSpec — the other half of the pair.
class Flat {
    shared {
        func Plain[U](other U) string -> "flat/" + other.ToString()
    }
}

Console.WriteLine("shared=" + Holder[int32].Plain[string](41, "b"))
Console.WriteLine("shared-other-inst=" + Holder[string].Plain[int32]("q", 3))
Console.WriteLine("shared-ng=" + Holder[int32].PlainNG(5))
Console.WriteLine("inst=" + Holder[int32]().PlainInst[string](7, "c"))
Console.WriteLine("self=" + Holder[int32]().CallSelf[string](8, "d"))
Console.WriteLine("flat=" + Flat.Plain[int32](9))
Console.WriteLine("done")
`)
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        // Behaviour: both type arguments really reached the callee, and the
        // SECOND instantiation pins that the MethodSpec is per-call rather than
        // a single cached one — `Holder[string].Plain[int32]` swaps both.
        Assert.Contains("shared=41|b", lines)
        Assert.Contains("shared-other-inst=q|3", lines)
        Assert.Contains("shared-ng=ng:5", lines)
        Assert.Contains("inst=7/c", lines)
        Assert.Contains("self=8|d", lines)
        Assert.Contains("flat=flat/9", lines)
        Assert.Equal("done", lines[^1])
        // Encoding: the token kind IS the bug. A MethodSpec is what carries the
        // method instantiation; before the fix the site emitted the MemberRef
        // directly. The control's kind must stay MemberReference, so a mutant
        // that MethodSpecs every static call on a generic type is caught here.
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        let kinds = CallTokenKinds(reader, pe, "<Program>", "<Main>$$")
        Assert.Contains(HandleKind.MethodSpecification, kinds)
        Assert.Contains(HandleKind.MemberReference, kinds)
    }

    /// Finding A on a generic user INTERFACE — the #1433 branch, which resolved
    /// its TypeSpec-parented MemberRef and then `break`ed out of the case
    /// entirely, so it could never reach the MethodSpec (or the #3226
    /// nullable-lift unwrap) below.
    @Fact
    func GenericSharedMethodOnAGenericInterface_GetsBothTheTypeSpecParentAndTheMethodSpec() {
        const source = `
package main

import System

interface IBox[T] {
    shared {
        // The failing shape.
        func Make[U](v T, other U) string {
            return v.ToString() + "|" + other.ToString()
        }

        // Control: #1433's original shape, which must keep working unchanged.
        func MakeNG(v T) string {
            return "ng:" + v.ToString()
        }
    }
}

// Control: a generic shared method on a NON-generic interface.
interface IFlat {
    shared {
        func Make[U](other U) string {
            return "flat/" + other.ToString()
        }
    }
}

Console.WriteLine("iface=" + IBox[int32].Make[string](41, "b"))
Console.WriteLine("iface-ng=" + IBox[int32].MakeNG(5))
Console.WriteLine("iface-flat=" + IFlat.Make[int32](9))
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source, out _)
        Assert.Contains("iface=41|b", lines)
        Assert.Contains("iface-ng=ng:5", lines)
        Assert.Contains("iface-flat=flat/9", lines)
        Assert.Equal("done", lines[^1])
    }

    /// Finding A reached through an ITERATOR kickoff: a generic `shared`
    /// iterator on a generic type. The state-machine machinery was never at
    /// fault here — the CALL to the kickoff was — which is precisely why
    /// grouping by symptom would have mis-attributed this to
    /// `StateMachineEmitter`.
    @Fact
    func GenericSharedIteratorOnAGenericType_RunsToCompletion() {
        const source = `
package main

import System

class Holder[T] {
    var seed T

    init(seed T) {
        this.seed = seed
    }

    shared {
        // The failing shape.
        func WalkSharedG[U](v T, other U) sequence[string] {
            yield v.ToString()
            yield other.ToString()
        }

        // Control: a non-generic shared iterator on the same generic type.
        func WalkShared(v T) sequence[string] {
            yield v.ToString()
        }
    }

    // Control: the instance generic iterator form.
    func WalkInstanceG[U](other U) sequence[string] {
        yield seed.ToString()
        yield other.ToString()
    }
}

for x in Holder[int32].WalkSharedG[string](41, "b") {
    Console.WriteLine("sg=" + x)
}

for x in Holder[int32].WalkShared(5) {
    Console.WriteLine("s=" + x)
}

for x in Holder[int32](7).WalkInstanceG[string]("c") {
    Console.WriteLine("ig=" + x)
}

Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source, out _)
        // The ORDER matters: an iterator that ran but yielded in the wrong
        // order, or dropped an element, is not caught by a Contains-only check.
        Assert.Equal([]string{"sg=41", "sg=b", "s=5", "ig=7", "ig=c", "done"}, lines)
    }

    /// Finding B: with A fixed, a generic `shared async` method on a
    /// generic type still failed, because `EmitAsyncKickoffBody` derived
    /// the kickoff's in-scope type parameters from `ReceiverType` alone —
    /// the very `StaticOwnerType` gap #3932 root C closed one file over,
    /// on the reification side. The struct was reified at arity 2 and
    /// self-instantiated with 1 argument: `TypeLoadException`, "used with
    /// the wrong number of generic arguments".
    @Fact
    func GenericSharedAsyncOnAGenericType_SelfInstantiatesAtTheReifiedArity() {
        const source = (`
package main

import System
import System.Threading.Tasks

class Holder[T] {
    var seed T

    init(seed T) {
        this.seed = seed
    }

    shared {
        // The failing shape: BOTH the encloser and the kickoff are generic,
        // and the kickoff is ` + "`" + `shared` + "`" + `.
        async func FetchSharedG[U](v T, other U) ValueTask[string] {
            await Task.Yield()
            return v.ToString() + "|" + other.ToString()
        }

        // Control: a NON-generic ` + "`" + `shared async` + "`" + ` on a generic type — #3932
        // root C's shape, arity 1, which must stay at arity 1.
        async func FetchShared(v T) ValueTask[string] {
            await Task.Yield()
            return "ng:" + v.ToString()
        }
    }

    // Control: the INSTANCE generic async form on a generic type, arity 2,
    // which was already right.
    async func FetchInstanceG[U](other U) ValueTask[string] {
        await Task.Yield()
        return seed.ToString() + "/" + other.ToString()
    }
}

// Control: a generic ` + "`" + `shared async` + "`" + ` on a NON-generic type, arity 1 (the
// method's own U only).
class Flat {
    shared {
        async func FetchSharedG[U](other U) ValueTask[string] {
            await Task.Yield()
            return "flat/" + other.ToString()
        }
    }
}

Console.WriteLine("sg=" + Holder[int32].FetchSharedG[string](41, "b").AsTask().GetAwaiter().GetResult())
Console.WriteLine("s=" + Holder[int32].FetchShared(5).AsTask().GetAwaiter().GetResult())
Console.WriteLine("ig=" + Holder[int32](7).FetchInstanceG[string]("c").AsTask().GetAwaiter().GetResult())
Console.WriteLine("flat=" + Flat.FetchSharedG[int32](9).AsTask().GetAwaiter().GetResult())
Console.WriteLine("done")
`)
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        Assert.Contains("sg=41|b", lines)
        Assert.Contains("s=ng:5", lines)
        Assert.Contains("ig=7/c", lines)
        Assert.Contains("flat=flat/9", lines)
        Assert.Equal("done", lines[^1])
        // Encoding: the arity of each state machine, read straight out of the
        // metadata. The failing shape is 2 (T then U); every control pins a
        // DIFFERENT expected arity, so a mutant that reifies unconditionally at
        // 2 — or that reverts to `ReceiverType` only — is caught.
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        Assert.Equal(2, StateMachineGenericParameterCount(reader, "FetchSharedG", "Holder`1"))
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchShared", "Holder`1"))
        Assert.Equal(2, StateMachineGenericParameterCount(reader, "FetchInstanceG", "Holder`1"))
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchSharedG", "Flat"))
    }

    shared {
        /// Returns the distinct handle kinds of every `call` token in
        /// [`methodName`](paramref).
        /// @param reader The metadata reader.
        /// @param pe The PE reader.
        /// @param typeName The declaring type's metadata name.
        /// @param methodName The method whose body is scanned.
        /// @returns The set of token kinds appearing on `call` instructions.
        private func CallTokenKinds(reader MetadataReader, pe PEReader, typeName string, methodName string) HashSet[
            HandleKind
        ] {
            let type = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((t TypeDefinition) -> reader.GetString(t.Name) == typeName)
            let method = type
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single((m MethodDefinition) -> reader.GetString(m.Name) == methodName)
            let il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILContent()
            let kinds = HashSet[HandleKind]()
            // `call` is 0x28 followed by a 4-byte token. Scanning for the opcode
            // byte can in principle land inside an operand; every hit is therefore
            // required to decode to a token kind that a `call` can legally carry,
            // and the assertions only ever check for PRESENCE of a kind.
            for var i = 0; i + 4 < il.Length; i++ {
                if il[i] != uint8(0x28) {
                    continue
                }
                let token = int32(il[i + 1]) | (int32(il[i + 2]) << 8) | (int32(il[i + 3]) << 16) | (
                    int32(il[i + 4]) << 24
                )
                if token == 0 {
                    continue
                }
                let kind = MetadataTokens.EntityHandle(token).Kind
                if kind == HandleKind.MethodDefinition ||
                    kind == HandleKind.MemberReference ||
                    kind == HandleKind.MethodSpecification {
                    kinds.Add(kind)
                }
            }
            return kinds
        }

        /// Returns the generic-parameter count of the state machine synthesized for
        /// [`methodName`](paramref) inside [`enclosingTypeName`](paramref).
        /// @param reader The metadata reader.
        /// @param methodName The kickoff method's name.
        /// @param enclosingTypeName The kickoff method's declaring type.
        /// @returns The state-machine type's generic-parameter count.
        private func StateMachineGenericParameterCount(
            reader MetadataReader,
            methodName string,
            enclosingTypeName string
        ) int32 {
            let enclosing = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((t TypeDefinition) -> reader.GetString(t.Name) == enclosingTypeName)
            let stateMachine = enclosing
                .GetNestedTypes()
                .Select(reader.GetTypeDefinition)
                .Single(
                (t TypeDefinition) -> reader.GetString(t.Name).StartsWith(
                    "<" + methodName + ">d__",
                    StringComparison.Ordinal
                )
            )
            return stateMachine.GetGenericParameters().Count
        }

        private func CompileVerifyAndRun(source string, out assemblyPath string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3939_").FullName
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, "Program.dll")
            assemblyPath = outPath
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
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
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine).Split(
                Environment.NewLine,
                StringSplitOptions.RemoveEmptyEntries
            )
        }
    }
}
