// <copyright file="Issue3932GenericEmitSitesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3932: four places where gsc emitted IL for a GENERIC context using a
/// shape that is only correct for a non-generic one. Each one compiled without
/// a diagnostic and each one produced IL the verifier rejects, so they were
/// invisible until `src/Sdk/Gsharp.Runtime.Channels` compiled cleanly for
/// the first time (#3907) and its ilverify stage became reachable.
/// @remarks What makes all four the same story: in every case gsc's OWN
/// neighbouring path already got it right, and only one sibling was missed.
/// A `newobj` on a generic user type parents its ctor MemberRef at the
/// self TypeSpec, but the chained `init(...)` did not. An imported generic
/// METHOD slot takes a raw `T`, but the imported generic CTOR slot boxed
/// it. An INSTANCE async method reifies its state machine over the enclosing
/// type's parameters, but a `shared` one did not. A CONCRETE element type
/// emits `Memory`1::op_Implicit` at an extension-call argument, but an
/// open one emitted nothing.
///
/// Every case COMPILES, ILVERIFIES and RUNS, and asserts on observed
/// behaviour — all three are load-bearing on the #3501 effort, where an
/// executing test has passed a build only ILVerify caught and an ILVerify-clean
/// build has produced a wrong runtime answer. Two cases additionally read the
/// emitted metadata back, because "the token is a MethodDef, not a
/// TypeSpec-parented MemberRef" and "the state machine has arity 0" are
/// encoding facts a behavioural assertion cannot name.
///
/// Discrimination (ADR-0154): every test carries a control that passed
/// BEFORE the fix — the same construct in the non-generic / instance /
/// concrete-element form — so a mutant that applies the new path
/// unconditionally is caught as surely as one that never applies it.
open class Issue3932GenericEmitSitesTests {
    /// Root 1 (9 of the 19 ilverify findings): a `convenience init`
    /// delegating to a sibling inside a GENERIC aggregate emitted
    /// `call Box`1::.ctor` against the raw MethodDef, which names the OPEN
    /// definition. The verifier then sees a `Box`1<!0>` receiver
    /// handed to a ctor on `Box`1`: `this` is never marked
    /// initialized (`CallCtor` + `ThisUninitReturn`) and the argument
    /// slots stay uninstantiated (`StackUnexpected`).
    @Fact
    func ChainedInitInsideAGenericType_TargetsTheSelfTypeSpec() {
        const source = `
package main

import System

class Box[T] {
    var items []T
    var tag string

    // Two hops of chaining, so a fix that only handles the last one is caught.
    convenience init() {
        init(4, "default")
    }

    convenience init(capacity int32) {
        init(capacity, "sized")
    }

    init(capacity int32, tag string) {
        items = [capacity]T
        this.tag = tag
    }

    func Describe() string -> tag + ":" + items.Length.ToString()
}

// Control: the identical chaining shape on a NON-generic type has always been
// correct, because a bare MethodDef IS the right token there.
class Plain {
    var tag string

    convenience init() {
        init("plain")
    }

    init(tag string) {
        this.tag = tag
    }

    func Describe() string -> tag
}

Console.WriteLine("zeroArg=" + Box[int32]().Describe())
Console.WriteLine("oneArg=" + Box[string](7).Describe())
Console.WriteLine("twoArg=" + Box[int32](2, "explicit").Describe())
Console.WriteLine("plain=" + Plain().Describe())
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        // Behaviour: both convenience hops really ran the designated
        // initializer, so the tag and the buffer length are the chained ones
        // rather than a default-constructed instance's.
        Assert.Contains("zeroArg=default:4", lines)
        Assert.Contains("oneArg=sized:7", lines)
        Assert.Contains("twoArg=explicit:2", lines)
        Assert.Contains("plain=plain", lines)
        Assert.Equal("done", lines[^1])
        // Encoding: the chained call must go through a MemberRef (which carries
        // the TypeSpec parent) on the GENERIC type, and must stay a plain
        // MethodDef on the non-generic one. Reading the token kind out of the
        // emitted body is the only way to state that; ILVerify agrees but says
        // it as a stack-shape complaint three instructions later.
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        Assert.Equal(HandleKind.MemberReference, SingleChainedCtorCallTokenKind(reader, pe, "Box`1"))
        Assert.Equal(HandleKind.MethodDefinition, SingleChainedCtorCallTokenKind(reader, pe, "Plain"))
    }

    /// Root 2 (7 of the 19): an argument at an IMPORTED generic constructor's
    /// own type-parameter slot (`ValueTask<T>(!0)`) was converted to
    /// the type-erased `object`, so gsc emitted `box !!T` in front of
    /// a `newobj` whose parent TypeSpec is the correctly symbolic
    /// `ValueTask`1<!!T>`.
    /// @remarks A ctor has no receiver, so neither #765's
    /// `TrySubstituteParameterTypeFromReceiver` nor #1540's
    /// `TryRecoverReceiverTypeParameterSlot` — the two helpers that keep
    /// `List[T].Add(v)` off the boxing path — could fire.
    /// `ViaMethod` below is exactly that already-correct sibling, and it
    /// is what makes this a ctor-only hole rather than a general erasure gap.
    @Fact
    func ImportedGenericCtorSlot_TakesTheRawTypeParameterNotABox() {
        const source = (`
package main

import System
import System.Collections.Generic
import System.Threading.Tasks

class Ops {
    shared {
        // Control: the imported generic METHOD slot has always been correct.
        func ViaMethod[T](v T) List[T] {
            var l = List[T]()
            l.Add(v)
            return l
        }

        // The failing shape: the imported generic CTOR slot.
        func ViaCtor[T](v T) ValueTask[T] {
            return ValueTask[T](v)
        }

        // The same defect one level in: the boxed operand also dragged the
        // TUPLE's own element type to ` + "`" + `object` + "`" + `, emitting
        // ` + "`" + `ValueTuple` + "`" + `2<object,bool>` + "`" + ` where ` + "`" + `ValueTuple` + "`" + `2<!!T,bool>` + "`" + ` belongs.
        func ViaCtorTuple[T](v T, ok bool) ValueTask[(Value T, Ok bool)] {
            return ValueTask[(Value T, Ok bool)]((v, ok))
        }
    }
}

// A VALUE type is the discriminating instantiation: a stray box on a
// reference ` + "`" + `T` + "`" + ` is merely redundant, but on ` + "`" + `int32` + "`" + ` it changes the value's
// representation at the slot.
Console.WriteLine("method-int=" + Ops.ViaMethod[int32](7)[0].ToString())
Console.WriteLine("ctor-int=" + Ops.ViaCtor[int32](7).Result.ToString())
Console.WriteLine("ctor-string=" + Ops.ViaCtor[string]("hi").Result)

let t = Ops.ViaCtorTuple[int32](9, true)
let (value, ok) = t.Result
Console.WriteLine("tuple-int=" + value.ToString() + ":" + ok.ToString())

let s = Ops.ViaCtorTuple[string]("nine", false)
let (svalue, sok) = s.Result
Console.WriteLine("tuple-string=" + svalue + ":" + sok.ToString())
Console.WriteLine("done")
`)
        let lines = CompileVerifyAndRun(source, out _)
        Assert.Contains("method-int=7", lines)
        Assert.Contains("ctor-int=7", lines)
        Assert.Contains("ctor-string=hi", lines)
        Assert.Contains("tuple-int=9:True", lines)
        Assert.Contains("tuple-string=nine:False", lines)
        Assert.Equal("done", lines[^1])
    }

    /// Root 3: a `shared` (static) async method on a generic type has no
    /// `ReceiverType`, so the state-machine reifier saw no class type
    /// parameters and emitted the struct at arity ZERO — leaving every hoisted
    /// field carrying a dangling `!0`.
    /// @remarks The instance form has always been right, and so has the iterator
    /// sibling, whose scope collection consults `StaticOwnerType` as well.
    @Fact
    func SharedAsyncOnAGenericType_ReifiesItsStateMachineOverTheTypeParameters() {
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
        // The failing shape: ` + "`" + `shared async` + "`" + ` on a generic type.
        async func FetchShared(v T) ValueTask[T] {
            await Task.Yield()
            return v
        }
    }

    // Control: the instance form always reified at the right arity.
    async func FetchInstance() ValueTask[T] {
        await Task.Yield()
        return seed
    }
}

// Control: ` + "`" + `shared async` + "`" + ` on a NON-generic type needs no reification at all.
class Flat {
    shared {
        async func FetchShared(v int32) ValueTask[int32] {
            await Task.Yield()
            return v
        }
    }
}

Console.WriteLine("shared-int=" + Holder[int32].FetchShared(41).AsTask().GetAwaiter().GetResult().ToString())
Console.WriteLine("shared-string=" + Holder[string].FetchShared("hi").AsTask().GetAwaiter().GetResult())
Console.WriteLine("instance-int=" + Holder[int32](7).FetchInstance().AsTask().GetAwaiter().GetResult().ToString())
Console.WriteLine("flat=" + Flat.FetchShared(3).AsTask().GetAwaiter().GetResult().ToString())
Console.WriteLine("done")
`)
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        Assert.Contains("shared-int=41", lines)
        Assert.Contains("shared-string=hi", lines)
        Assert.Contains("instance-int=7", lines)
        Assert.Contains("flat=3", lines)
        Assert.Equal("done", lines[^1])
        // Encoding: the arity of the emitted state machine IS the bug. Read it
        // straight out of the metadata so a regression is named precisely
        // rather than inferred from a stack-shape complaint.
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchShared", "Holder`1"))
        Assert.Equal(1, StateMachineGenericParameterCount(reader, "FetchInstance", "Holder`1"))
        // Control, in metadata: the non-generic encloser's state machine must
        // stay at arity 0. A mutant that reifies unconditionally fails here.
        Assert.Equal(0, StateMachineGenericParameterCount(reader, "FetchShared", "Flat"))
    }

    /// Root 4: at an extension-call argument whose parameter type still
    /// CONTAINS a type parameter, gsc skipped conversion entirely. That skip is
    /// right for a BARE open `T` slot (erased to `object`, boxed by
    /// the emitter) but wrong for `Memory[T]`, which emits as a real
    /// constructed slot — so a `[]T` argument reached it with no
    /// `Memory`1::op_Implicit` at all.
    @Fact
    func OpenElementArrayAtAMemorySlot_EmitsTheImplicitConversion() {
        const source = (`
package main

import System
import System.Collections.Generic

// An extension function, which is the shape the channels runtime uses
// (` + "`" + `reader.ReceiveBatch(buffer, …)` + "`" + `).
func (list List[T]) TakeMemory[T](m Memory[T]) int32 -> m.Length * 10 + list.Count

// The bare-` + "`" + `T` + "`" + ` slot the skip actually exists for: it must keep passing the
// argument through unconverted, so a mutant that converts everything is caught.
func (list List[T]) TakeBare[T](v T) string -> v.ToString() + ":" + list.Count.ToString()

class Ops {
    shared {
        // The failing shape: an OPEN element array at a Memory[T] slot.
        func ViaOpen[T](l List[T], buffer []T) int32 -> l.TakeMemory(buffer)

        // Control: the identical call with a CONCRETE element has always
        // emitted the operator.
        func ViaConcrete(l List[int32], buffer []int32) int32 -> l.TakeMemory(buffer)

        func ViaBare[T](l List[T], v T) string -> l.TakeBare(v)
    }
}

Console.WriteLine("open-string=" + Ops.ViaOpen[string](List[string]{ "z" }, []string{ "a", "b", "c" }).ToString())
Console.WriteLine("open-int=" + Ops.ViaOpen[int32](List[int32]{ 9, 9 }, []int32{ 1, 2 }).ToString())
Console.WriteLine("concrete=" + Ops.ViaConcrete(List[int32]{ 9 }, []int32{ 1, 2 }).ToString())
Console.WriteLine("bare-int=" + Ops.ViaBare[int32](List[int32]{ 5 }, 4))
Console.WriteLine("bare-string=" + Ops.ViaBare[string](List[string]{ "q" }, "w"))
Console.WriteLine("done")
`)
        let lines = CompileVerifyAndRun(source, out _)
        // The arithmetic pins that the CONVERTED value carried the right
        // length: a `Memory` built from a 3-element array reports 3, so
        // 3*10 + 1 = 31. A dropped conversion cannot produce this at all
        // (the assembly does not verify), and a conversion applied to the
        // wrong operand would not produce these exact numbers.
        Assert.Contains("open-string=31", lines)
        Assert.Contains("open-int=22", lines)
        Assert.Contains("concrete=21", lines)
        Assert.Contains("bare-int=4:1", lines)
        Assert.Contains("bare-string=w:1", lines)
        Assert.Equal("done", lines[^1])
    }

    /// Minimal signature provider used only to count a constructor's
    /// parameters, so the chaining assertion can pick the parameterless
    /// overload without depending on a reflection context.
    private class SignatureArity : ISignatureTypeProvider[string, object] {
        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetTypeFromDefinition(
            reader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string -> reader.GetString(reader.GetTypeDefinition(handle).Name)

        func GetTypeFromReference(
            reader MetadataReader,
            handle TypeReferenceHandle,
            rawTypeKind uint8
        ) string -> reader.GetString(reader.GetTypeReference(handle).Name)

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(",", typeArguments) + ">"

        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "method*"

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetPinnedType(elementType string) string -> elementType

        func GetTypeFromSerializedName(name string) string -> name

        func GetUnderlyingEnumType(type string) PrimitiveTypeCode -> PrimitiveTypeCode.Int32

        func IsSystemType(type string) bool -> false
    }

    shared {
        /// Returns the token kind of the single chained-constructor `call`
        /// inside [`typeName`](paramref)'s parameterless convenience ctor.
        /// @param reader The metadata reader.
        /// @param pe The PE reader.
        /// @param typeName The emitted type's metadata name.
        /// @returns The handle kind of the called constructor's token.
        private func SingleChainedCtorCallTokenKind(reader MetadataReader, pe PEReader, typeName string) HandleKind {
            let type = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((t TypeDefinition) -> reader.GetString(t.Name) == typeName)
            // The parameterless ctor is the convenience one that chains.
            let ctor = type
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single(
                (m MethodDefinition) -> reader.GetString(m.Name) == ".ctor" &&
                    m
                    .DecodeSignature(SignatureArity(), genericContext: nil)
                    .ParameterTypes
                    .Length == 0
            )
            let body = pe.GetMethodBody(ctor.RelativeVirtualAddress)
            let il = body.GetILContent()
            // `ldarg.0` (0x02) then the argument loads, then `call` (0x28) with a
            // 4-byte token, then `ret`. Scan for the single `call`.
            for var i = 0; i < il.Length - 4; i++ {
                if il[i] != uint8(0x28) {
                    continue
                }
                let token = int32(il[i + 1]) | (int32(il[i + 2]) << 8) | (int32(il[i + 3]) << 16) | (
                    int32(il[i + 4]) << 24
                )
                return MetadataTokens.EntityHandle(token).Kind
            }
            throw InvalidOperationException("No 'call' instruction found in $typeName's parameterless constructor.")
        }

        /// Returns the generic-parameter count of the async state machine
        /// synthesized for [`methodName`](paramref) inside
        /// [`enclosingTypeName`](paramref).
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
            let tempDir = Directory.CreateTempSubdirectory("gs_3932_").FullName
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
