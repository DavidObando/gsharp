// <copyright file="UnscopedRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// ADR-0184 / issue #376: emit-level proof for definition-side
/// `@UnscopedRef`. Two things have to be true in the produced PE, and
/// neither is observable from the binder's diagnostics alone:
/// 1. `UnscopedRefAttribute` really reaches CLR metadata, on the method row for the `func` spelling and
/// on the property row for the `prop`/indexer spelling — so a C# (or later G#) consumer reading the
/// assembly sees the same contract gsc enforced. The bound attribute is a real type-identity-resolved
/// attribute, not a compiler-intrinsic marker, so this is what the
/// `import System.Diagnostics.CodeAnalysis` buys.
/// 2. The body emits `ldarg.0` (not `ldarga.s`) followed by `ldflda`. A struct instance method's arg0
/// is already the managed pointer `ref S`; `ldarga.0` would yield a pointer to that pointer and the
/// returned reference would be garbage. This is exactly what csc emits for
/// `[UnscopedRef] public ref int F() => ref field;`.
open class UnscopedRefEmitTests {
    @Fact
    func MethodSpelling_EmitsUnscopedRefAttribute_OnTheMethodRow() {
        let acc = LoadAcc()
        let slot MethodInfo? = acc.GetMethod(
            "Slot",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(slot)
        Assert.Contains(
            slot!!.GetCustomAttributesData(),
            (d CustomAttributeData) -> d.AttributeType.FullName == UnscopedRefAttributeFullName
        )
    }

    @Theory
    @InlineData("Ref")
    @InlineData("Item")
    func PropertySpelling_EmitsUnscopedRefAttribute_OnThePropertyRow(propertyName string) {
        let acc = LoadAcc()
        let property PropertyInfo? = acc.GetProperty(
            propertyName,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(property)
        // ADR-0184 §7 pins the PROPERTY row specifically for the `prop`/indexer
        // spelling, so assert that row and nothing else. An earlier version
        // accepted `property OR getter`, which would also have passed had the
        // emitter regressed to writing the attribute only on `get_Item` — the
        // getter-row placement is a CLR-INPUT shape gsc must READ (covered by
        // Issue4265SpanByValueRefReturnTests over a C# fixture), not an output
        // shape gsc may choose.
        Assert.True(
            Carries(property!!.GetCustomAttributesData()),
            "'$propertyName' does not carry $UnscopedRefAttributeFullName on its property row; " +
                "getter row carries it: ${Carries(property!!.GetGetMethod(nonPublic: true)!!.GetCustomAttributesData())}"
        )
    }

    /// The IL half: the receiver is loaded with `ldarg.0` and the field
    /// address taken with `ldflda`. A regression to `ldarga.s` here
    /// would compile, verify and return a reference to a stack slot holding a
    /// pointer — silently wrong at run time, which is why this asserts opcodes
    /// rather than just "it compiled".
    @Fact
    func RefReturnOfOwnField_Emits_Ldarg0_Then_Ldflda() {
        let acc = LoadAcc()
        let slot MethodInfo? = acc.GetMethod(
            "Slot",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(slot)
        let il[]?uint8 = slot!!.GetMethodBody()?.GetILAsByteArray()
        Assert.NotNull(il)
        Assert.NotEmpty(il!!)
        Assert.Equal(Ldarg0, il!![0])
        Assert.DoesNotContain(LdargaS, il!!)
        Assert.Contains(Ldflda, il!!)
    }

    /// ADR-0184 amendment, the emit-level half of the caller-side fix. The
    /// binder now rejects a `ref` forwarded through a READ-ONLY receiver,
    /// because the emitter defensively copies such a receiver into a
    /// function-local temp. This asserts the complementary fact at the metadata
    /// level rather than inferring it from a runtime value: the SAFE path — a
    /// genuine `ref` parameter receiver — emits a direct
    /// `ldarg`-style pass-through with NO spill sequence
    /// (`ldobj`/`stloc`/`ldloca`) between the receiver load and
    /// the `call`. If hook B ever started treating the `ref`-parameter
    /// path as copied too, or the emitter started copying it, this body would
    /// grow exactly that sequence.
    @Fact
    func RefParameterReceiver_ForwardsWithoutADefensiveReceiverCopy() {
        let assembly = CompileToAssembly(Source + `

func Forward(ref a Acc) ref int32 {
    return ref a.Slot()
}`, ignoredErrorScope: "(Acc\\.(Slot|get_Ref|get_Item)|Forward)$$")
        let forward = assembly
            .GetTypes()
            .SelectMany(
            func (type Type) IEnumerable[MethodInfo] {
                return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            }
        )
            .Single((method MethodInfo) -> method.Name == "Forward")
        let il[]?uint8 = forward.GetMethodBody()?.GetILAsByteArray()
        Assert.NotNull(il)
        Assert.NotEmpty(il!!)
        // arg0 is already `ref Acc`; forwarding it is a straight load.
        Assert.Equal(Ldarg0, il!![0])
        Assert.DoesNotContain(LdargaS, il!!)
        // No value copy and no spill slot — the whole point of the assertion.
        Assert.DoesNotContain(Ldobj, il!!)
        Assert.DoesNotContain(il!!, (opcode uint8) -> StoreLocalOpcodes.Contains(opcode))
    }

    shared {
        private const UnscopedRefAttributeFullName string = "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute"

        /// Opcode `ldarg.0`, the correct receiver load in a struct instance method.
        private const Ldarg0 uint8 = uint8(0x02)

        /// Opcode `ldarga.s`, which would be wrong here (pointer-to-pointer).
        private const LdargaS uint8 = uint8(0x0F)

        /// Opcode `ldflda`.
        private const Ldflda uint8 = uint8(0x7C)

        private const Source string = `package P
import System.Diagnostics.CodeAnalysis

struct Acc {
    var Total int32

    @UnscopedRef
    func Slot() ref int32 {
        return ref this.Total
    }

    @UnscopedRef
    prop Ref ref int32 {
        get { return ref this.Total }
    }

    @UnscopedRef
    prop this[i int32] ref int32 {
        get { return ref this.Total }
    }
}`

        /// Opcode `ldobj`, the value-copy half of a defensive receiver spill.
        private const Ldobj uint8 = uint8(0x71)

        /// Opcodes `stloc.0`–`stloc.3`, `stloc.s` and `stloc`'s prefix.
        private let StoreLocalOpcodes[]uint8 = []uint8{0x0A, 0x0B, 0x0C, 0x0D, 0x13, 0xFE}

        private func Carries(attributes IList[CustomAttributeData]) bool -> attributes.Any(
            (attribute CustomAttributeData) -> attribute.AttributeType.FullName == UnscopedRefAttributeFullName
        )

        private func LoadAcc() Type {
            let assembly = CompileToAssembly(Source)
            return assembly.GetTypes().Single((t Type) -> t.Name == "Acc")
        }

        private func CompileToAssembly(
            source string,
            ignoredErrorScope string = "Acc\\.(Slot|get_Ref|get_Item)$$"
        ) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_unscopedref_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            // ADR-0181 already records this as a verifier limitation, not an
            // emitter bug: ilverify 10.0.8 reports `ReturnPtrToStack` for the
            // minimal incoming byref forwarder (`ldarg; ret`) emitted by BOTH
            // Roslyn and G#. It rejects any byref return signature outright — it
            // has no notion of `[UnscopedRef]` or of a permanent home — so csc's
            // IL for the same `[UnscopedRef] public ref int Slot() => ref
            // this.Total;` fails identically. Scoped to the three ref-returning
            // members: IlVerifier.Verify runs the rest of the assembly in a second
            // pass with no suppression at all.
            IlVerifier.Verify(
                outPath,
                ignoredErrorCodes: IlVerifier.KnownIssues.RefStruct,
                ignoredErrorScope: ignoredErrorScope
            )
            return EmittedFixture.Load(outPath)
        }
    }
}
