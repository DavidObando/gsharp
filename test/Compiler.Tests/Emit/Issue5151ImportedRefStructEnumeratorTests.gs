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

/// Issue #5151 review: the struct-enumerator for-in path types the enumerator
/// over the receiver's own type arguments, which is only correct when the
/// collection's `GetEnumerator()` returns its nested `Enumerator` instantiated
/// with the collection's own type parameters in declaration order. These tests
/// build an imported by-ref-like collection that returns a closed
/// (`View<int>.Enumerator`) or permuted (`Swap<B, A>.Enumerator`) enumerator and
/// iterate it over a same-compilation element type and over a type parameter.
/// The loop must compile to verifiable IL (or report a diagnostic).
open class Issue5151ImportedRefStructEnumeratorTests {
    @Fact
    func ClosedEnumeratorReturn_IsNotRetypedOverTheReceiversArguments() {
        let output = CompileAgainstLibrary(`package P
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
        Assert.DoesNotContain("GS9998", output)
    }

    @Fact
    func PermutedEnumeratorReturn_IsNotRetypedOverTheReceiversArguments() {
        let output = CompileAgainstLibrary(`package P
import Probe

class Node { var N int32 }

func CountGeneric[X, Y](v Swap[X, Y]) int32 {
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}
func CountNodes(v Swap[Node, string]) int32 {
    var c int32 = 0
    for x in v {
        c += 1
    }
    return c
}`)
        Assert.DoesNotContain("GS9998", output)
    }

    shared {
        /// Compiles the source as a library against the in-process `ViewLib`.
        /// When the compiler accepts the source, the output is ILVerified; when
        /// it rejects it, the failure must be a diagnostic, not an internal
        /// error. Returns the compiler's output.
        private func CompileAgainstLibrary(source string) string {
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
                if compileExit == 0 {
                    IlVerifier.Verify(outPath, additionalReferences: []string{libPath})
                } else {
                    Assert.Contains("error GS", output)
                }
                return output
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        /// Emits `ViewLib.dll` with two by-ref-like generic collections whose
        /// nested struct `Enumerator` is generic over the same parameters but
        /// is not what `GetEnumerator()` returns:
        /// `Probe.View<T>.GetEnumerator()` returns `View<int>.Enumerator` and
        /// `Probe.Swap<A, B>.GetEnumerator()` returns `Swap<B, A>.Enumerator`.
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

            // Probe.View<T>
            let view = moduleBuilder.DefineType("Probe.View`1", structAttrs, parent: typeof(ValueType))
            let viewParams = view.DefineGenericParameters("T")
            view.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let viewEnumerator = view.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            let viewEnumeratorParams = viewEnumerator.DefineGenericParameters("T")
            EmitEnumeratorMembers(viewEnumerator, viewEnumeratorParams[0])
            let viewGetEnumerator = view.DefineMethod(
                "GetEnumerator",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                viewEnumerator.MakeGenericType(typeof(int32)),
                Type.EmptyTypes
            )
            EmitDefaultReturn(viewGetEnumerator, viewEnumerator.MakeGenericType(typeof(int32)))
            // Keep the T parameter referenced by a member so it is a real generic.
            let _ = viewParams

            // Probe.Swap<A, B>
            let swap = moduleBuilder.DefineType("Probe.Swap`2", structAttrs, parent: typeof(ValueType))
            let swapParams = swap.DefineGenericParameters("A", "B")
            swap.SetCustomAttribute(CustomAttributeBuilder(byRefLikeCtor, []object{}))
            let swapEnumerator = swap.DefineNestedType("Enumerator", nestedAttrs, parent: typeof(ValueType))
            let swapEnumeratorParams = swapEnumerator.DefineGenericParameters("A", "B")
            EmitEnumeratorMembers(swapEnumerator, swapEnumeratorParams[0])
            let permuted = swapEnumerator.MakeGenericType(swapParams[1], swapParams[0])
            let swapGetEnumerator = swap.DefineMethod(
                "GetEnumerator",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                permuted,
                Type.EmptyTypes
            )
            EmitDefaultReturn(swapGetEnumerator, permuted)

            viewEnumerator.CreateType()
            swapEnumerator.CreateType()
            view.CreateType()
            swap.CreateType()
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
