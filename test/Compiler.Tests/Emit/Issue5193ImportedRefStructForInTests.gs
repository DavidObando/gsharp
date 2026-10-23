// <copyright file="Issue5193ImportedRefStructForInTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #5193: `for x in view` over an imported by-ref-like collection other
/// than `Span`/`ReadOnlySpan` typed the enumerator from the erased CLR type
/// (`GView<object>.Enumerator`), so the emitted assembly failed IL
/// verification. The enumerator is now mapped from the type arguments of the
/// open `GetEnumerator()` return type. These tests build three by-ref-like
/// collections in-process: `GView<T>` returns its own nested enumerator,
/// `Swap<A, B>` returns `Swap<B, A>.Enumerator`, and `Fld<A, B>` has an
/// enumerator whose `Current` is a public field. Each enumerator yields one
/// element, so the loops run and the results are exact.
open class Issue5193ImportedRefStructForInTests {
    private func SourceText() string {
        return `package P
import Probe

class Node { var N int32 }

func CountView() int32 {
    let v = GView[Node]()
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}
func ViewValue(v GView[Node]) int32 {
    for x in v {
        return x.N
    }
    return -1
}
func CountGeneric[U]() int32 {
    let v = GView[U]()
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}
func CountSwap() int32 {
    let v = Swap[int32, Node]()
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}
func SwapValue(v Swap[int32, Node]) int32 {
    for x in v {
        return x.N
    }
    return -1
}
func CountField() int32 {
    let v = Fld[Node, int32]()
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}
func FieldValue(v Fld[Node, int32]) int32 {
    for x in v {
        return x.N
    }
    return -1
}`
    }

    @Fact
    func ImportedRefStructLoops_EmitVerifiableIL() {
        // CompileAndRun asserts exit code 0 and runs ILVerify.
        CompileAndRun(SourceText(), (program Type) -> { })
    }

    @Fact
    func ImportedRefStructLoops_RunAndKeepTheirResults() {
        CompileAndRun(
            SourceText(),
            (program Type) -> {
                Assert.Equal(1, Invoke(program, "CountView"))
                Assert.Equal(1, Invoke(program, "CountSwap"))
                Assert.Equal(1, Invoke(program, "CountField"))
                Assert.Equal(
                    1,
                    GetMethod(program, "CountGeneric").MakeGenericMethod(typeof(string)).Invoke(nil, default([]?object))
                )
            }
        )
    }

    @Fact
    func ImportedRefStructLoops_KeepTheElementTypeOfTheLoopVariable() {
        CompileAndRun(
            SourceText(),
            (program Type) -> {
                // The loop variable keeps its element type: no unbox or box
                // from `object` is needed to read `x.N`.
                for name in[]string{"ViewValue", "SwapValue", "FieldValue"} {
                    let opCodes = ReadOpCodes(GetMethod(program, name))
                    Assert.DoesNotContain(opCodes, (o OpCode) -> o == OpCodes.Unbox_Any || o == OpCodes.Box)
                }
            }
        )
    }

    shared {
        private func Invoke(program Type, name string) object? -> GetMethod(program, name).Invoke(
            nil,
            default([]?object)
        )

        private func GetMethod(type Type, name string) MethodInfo -> type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Missing method ${type.FullName}.$name")

        private func ReadOpCodes(method MethodInfo)[]OpCode {
            let il = method.GetMethodBody()!!.GetILAsByteArray()
            return IlInstructionReader.Read(il).Select((i IlInstruction) -> i.OpCode).ToArray()
        }

        /// Compiles the source as a library against the in-process `ViewLib`.
        /// The source is a valid program: the compile must exit with 0 (the
        /// captured output is part of the failure message), the emitted
        /// assembly is ILVerified, and then it is loaded for [`check`](paramref).
        private func CompileAndRun(source string, check(Type) -> void) {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue5193Emit", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            try {
                let libPath = Path.Combine(tempDir, "ViewLib.dll")
                BuildLibrary(libPath)
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/r:" + libPath
                }
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
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
                let output = "$compileOut" + "$compileErr"
                Assert.True(compileExit == 0, "gsc failed with exit code $compileExit:${Environment.NewLine}$output")
                IlVerifier.Verify(outPath, additionalReferences: []string{libPath})
                let assembly = EmittedFixture.Load(outPath)
                check(assembly.GetTypes().Single((t Type) -> t.Name == "<Program>"))
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        /// Emits `ViewLib.dll`: by-ref-like generic collections whose nested
        /// struct enumerators yield one element.
        private func BuildLibrary(dllPath string) {
            let asmBuilder = PersistedAssemblyBuilder(
                AssemblyName("ViewLib"){Version = Version(1, 0, 0, 0)},
                typeof(object).Assembly
            )
            let moduleBuilder = asmBuilder.DefineDynamicModule("ViewLib")
            let byRefLikeAttribute = typeof(object).Assembly.GetType(
                "System.Runtime.CompilerServices.IsByRefLikeAttribute",
                throwOnError: true
            )!!
            let byRefLikeCtor = byRefLikeAttribute.GetConstructor(Type.EmptyTypes)!!

            const structAttrs = TypeAttributes.Public | TypeAttributes.Sealed | TypeAttributes.SequentialLayout |
            TypeAttributes.BeforeFieldInit
            const nestedAttrs = TypeAttributes.NestedPublic | TypeAttributes.Sealed | TypeAttributes.SequentialLayout |
            TypeAttributes.BeforeFieldInit
            const methodAttrs = MethodAttributes.Public | MethodAttributes.HideBySig

            // Probe.GView<T>: GetEnumerator() returns GView<T>.Enumerator.
            let view = moduleBuilder.DefineType("Probe.GView`1", structAttrs, parent: typeof(ValueType))
            let viewParams = view.DefineGenericParameters("T")
            view.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let viewEnumerator = view.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            let viewEnumeratorParams = viewEnumerator.DefineGenericParameters("T")
            EmitOneShotEnumerator(viewEnumerator, viewEnumeratorParams[0], currentIsField: false)
            let ownViewEnumerator = viewEnumerator.MakeGenericType(viewParams[0])
            EmitDefaultReturn(
                view.DefineMethod("GetEnumerator", methodAttrs, ownViewEnumerator, Type.EmptyTypes),
                ownViewEnumerator
            )

            // Probe.Swap<A, B>: GetEnumerator() returns Swap<B, A>.Enumerator,
            // whose Current is its first type argument.
            let swap = moduleBuilder.DefineType("Probe.Swap`2", structAttrs, parent: typeof(ValueType))
            let swapParams = swap.DefineGenericParameters("A", "B")
            swap.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let swapEnumerator = swap.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            let swapEnumeratorParams = swapEnumerator.DefineGenericParameters("A", "B")
            EmitOneShotEnumerator(swapEnumerator, swapEnumeratorParams[0], currentIsField: false)
            let permutedEnumerator = swapEnumerator.MakeGenericType(swapParams[1], swapParams[0])
            EmitDefaultReturn(
                swap.DefineMethod("GetEnumerator", methodAttrs, permutedEnumerator, Type.EmptyTypes),
                permutedEnumerator
            )

            // Probe.Fld<A, B>: the enumerator's Current is a public field of type A.
            let fld = moduleBuilder.DefineType("Probe.Fld`2", structAttrs, parent: typeof(ValueType))
            let fldParams = fld.DefineGenericParameters("A", "B")
            fld.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let fldEnumerator = fld.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            let fldEnumeratorParams = fldEnumerator.DefineGenericParameters("A", "B")
            EmitOneShotEnumerator(fldEnumerator, fldEnumeratorParams[0], currentIsField: true)
            let ownFldEnumerator = fldEnumerator.MakeGenericType(fldParams[0], fldParams[1])
            EmitDefaultReturn(
                fld.DefineMethod("GetEnumerator", methodAttrs, ownFldEnumerator, Type.EmptyTypes),
                ownFldEnumerator
            )

            viewEnumerator.CreateType()
            swapEnumerator.CreateType()
            fldEnumerator.CreateType()
            view.CreateType()
            swap.CreateType()
            fld.CreateType()
            asmBuilder.Save(dllPath)
        }

        /// Defines a `done` field, a `MoveNext()` that returns true once, and
        /// a `Current` member (a property, or a public field) of [`currentType`](paramref).
        private func EmitOneShotEnumerator(enumerator TypeBuilder, currentType Type, currentIsField bool) {
            let done = enumerator.DefineField("done", typeof(bool), FieldAttributes.Public)
            let moveNext = enumerator.DefineMethod(
                "MoveNext",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                typeof(bool),
                Type.EmptyTypes
            )
            let il = moveNext.GetILGenerator()
            let finished = il.DefineLabel()
            il.Emit(OpCodes.Ldarg_0)
            il.Emit(OpCodes.Ldfld, done)
            il.Emit(OpCodes.Brtrue_S, finished)
            il.Emit(OpCodes.Ldarg_0)
            il.Emit(OpCodes.Ldc_I4_1)
            il.Emit(OpCodes.Stfld, done)
            il.Emit(OpCodes.Ldc_I4_1)
            il.Emit(OpCodes.Ret)
            il.MarkLabel(finished)
            il.Emit(OpCodes.Ldc_I4_0)
            il.Emit(OpCodes.Ret)
            if currentIsField {
                enumerator.DefineField("Current", currentType, FieldAttributes.Public)
                return
            }
            let getter = enumerator.DefineMethod(
                "get_Current",
                MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig,
                currentType,
                Type.EmptyTypes
            )
            EmitDefaultReturn(getter, currentType)
            let property = enumerator.DefineProperty(
                "Current",
                PropertyAttributes.None,
                currentType,
                parameterTypes: nil
            )
            property.SetGetMethod(getter)
        }

        private func EmitDefaultReturn(method MethodBuilder, returnType Type) {
            let il = method.GetILGenerator()
            let local = il.DeclareLocal(returnType)
            il.Emit(OpCodes.Ldloca_S, cast[uint8](local.LocalIndex))
            il.Emit(OpCodes.Initobj, returnType)
            il.Emit(OpCodes.Ldloc_0)
            il.Emit(OpCodes.Ret)
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
