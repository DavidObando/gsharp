// <copyright file="Issue5151ImportedRefStructEnumeratorTests.gs" company="GSharp">
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

/// Issue #5151 review: only `Span<T>` and `ReadOnlySpan<T>` use the symbolic
/// struct-enumerator route. Any other imported by-ref-like collection keeps the
/// closed route it always had. These tests build such collections in-process
/// and iterate them over a same-compilation element type and a type parameter:
/// `View<T>` returns a closed `View<int>.Enumerator` and `Fld<A, B>` has an
/// enumerator whose `Current` is a public field. Each loop
/// must compile to verifiable IL.
open class Issue5151ImportedRefStructEnumeratorTests {
    @Fact
    func ClosedEnumeratorReturn_KeepsTheClosedRoute() {
        CompileAgainstLibrary(`package P
import Probe

class Node { var N int32 }

func CountGeneric[U](v View[U]) int32 {
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}
func CountNodes(v View[Node]) int32 {
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}`)
    }

    @Fact
    func FieldCurrent_KeepsTheClosedRoute() {
        CompileAgainstLibrary(`package P
import Probe

func Sum(v Fld[object, (X int32, Y int32)]) int32 {
    var c int32 = 0
    for x in v {
        c += x
    }
    return c
}`)
    }

    shared {
        /// Compiles the source as a library against the in-process `ViewLib`.
        /// The source is a valid program: the compile must exit with 0 (the
        /// captured output is part of the failure message), and the emitted
        /// assembly is then ILVerified.
        private func CompileAgainstLibrary(source string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_5151_view_").FullName
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
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        /// Emits `ViewLib.dll` with by-ref-like generic collections whose
        /// nested struct `Enumerator` is generic over the collection's parameters:
        /// `Probe.View<T>` returns a closed `View<int>.Enumerator`,
        /// and `Probe.Fld<A, B>` has an enumerator with a public `int Current`
        /// field.
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

            // Probe.View<T>: GetEnumerator() returns View<int>.Enumerator.
            let view = moduleBuilder.DefineType("Probe.View`1", structAttrs, parent: typeof(ValueType))
            view.DefineGenericParameters("T")
            view.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let viewEnumerator = view.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            let viewEnumeratorParams = viewEnumerator.DefineGenericParameters("T")
            EmitEnumeratorMembers(viewEnumerator, viewEnumeratorParams[0])
            let closedEnumerator = viewEnumerator.MakeGenericType(typeof(int32))
            EmitDefaultReturn(
                view.DefineMethod("GetEnumerator", methodAttrs, closedEnumerator, Type.EmptyTypes),
                closedEnumerator
            )

            // Probe.Fld<A, B>: the enumerator's Current is a public field.
            let fld = moduleBuilder.DefineType("Probe.Fld`2", structAttrs, parent: typeof(ValueType))
            let fldParams = fld.DefineGenericParameters("A", "B")
            fld.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let fldEnumerator = fld.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            fldEnumerator.DefineGenericParameters("A", "B")
            fldEnumerator.DefineField("Current", typeof(int32), FieldAttributes.Public)
            let fldMoveNext = fldEnumerator.DefineMethod("MoveNext", methodAttrs, typeof(bool), Type.EmptyTypes)
            let fldMoveNextIl = fldMoveNext.GetILGenerator()
            fldMoveNextIl.Emit(OpCodes.Ldc_I4_0)
            fldMoveNextIl.Emit(OpCodes.Ret)
            let ownFldEnumerator = fldEnumerator.MakeGenericType(fldParams[0], fldParams[1])
            EmitDefaultReturn(
                fld.DefineMethod("GetEnumerator", methodAttrs, ownFldEnumerator, Type.EmptyTypes),
                ownFldEnumerator
            )

            viewEnumerator.CreateType()
            fldEnumerator.CreateType()
            view.CreateType()
            fld.CreateType()
            asmBuilder.Save(dllPath)
        }

        private func EmitEnumeratorMembers(enumerator TypeBuilder, currentType Type) {
            let moveNext = enumerator.DefineMethod(
                "MoveNext",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                typeof(bool),
                Type.EmptyTypes
            )
            let moveNextIl = moveNext.GetILGenerator()
            moveNextIl.Emit(OpCodes.Ldc_I4_0)
            moveNextIl.Emit(OpCodes.Ret)
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
