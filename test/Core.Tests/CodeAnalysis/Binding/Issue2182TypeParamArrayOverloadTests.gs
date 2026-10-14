// <copyright file="Issue2182TypeParamArrayOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2182: a slice `[]T` whose element `T` is a generic type
/// parameter has a null backing `ClrType` during binding. #2140 made the
/// element-INDEPENDENT array supertypes ((cref:System.Array), the
/// non-generic collection interfaces) accepted by
/// `Conversion.Classify` in assignment / return position, but the
/// OVERLOAD- and CONSTRUCTOR-resolution applicability check surfaced no
/// effective CLR type for such an argument, so it never ran and the
/// constructor-as-call lookup dead-ended with GS0159 'Cannot find function'.
/// The fix surfaces the erased array type (`[]T` -> `object[]`,
/// mirroring the ADR-0004 type-parameter-to-`object` erasure) so
/// `[]T` becomes applicable to an array-base parameter exactly where a
/// concrete `[]int32` argument (backing `int[]`) and a direct
/// (cref:System.Array) argument already are.
open class Issue2182TypeParamArrayOverloadTests {
    @Fact
    func TypeParamArray_ToSystemArrayParameter_MethodCall_Binds() {
        const source = `
package P
class C[T] {
    func Take(a System.Array) int32 { return a.Length }
    func Call(a []T) int32 { return Take(a) }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TypeParamArray_ToNonGenericCollectionParameters_MethodCall_Binds() {
        const source = `
package P
import System.Collections
class C[T] {
    func TakeColl(a ICollection) int32 { return a.Count }
    func TakeList(a IList) int32 { return a.Count }
    func TakeEnum(a IEnumerable) int32 { return 0 }
    func Call(a []T) int32 { return TakeColl(a) + TakeList(a) + TakeEnum(a) }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TypeParamArray_ToConstructorTakingICollection_Binds() {
        // Constructor-call path: ArrayList(ICollection). Before the fix this
        // reported GS0159 because no applicable ctor was found for the
        // untyped []T argument.
        const source = `
package P
import System.Collections
class C[T] {
    func Make(a []T) ArrayList { return ArrayList(a) }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TypeParamArray_ToNestedImportedConstructor_Binds() {
        // The original repro: a nested imported type's constructor
        // (TypeConverter.StandardValuesCollection(ICollection)).
        const source = `
package P
import System
import System.ComponentModel
class C[T Enum struct] {
    func WithTypeParamArr(a []T) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TypeParamArray_AndConcreteArray_AndArrayBase_AllBindTogether() {
        // The three sibling overloads from the issue: []T, []int32, and
        // System.Array must ALL bind against the same constructor.
        const source = `
package P
import System
import System.ComponentModel
class C[T Enum struct] {
    func WithTypeParamArr(a []T) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
    func WithConcreteArr(a []int32) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
    func WithArrayBase(a System.Array) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ConcreteArray_ToConstructor_StillBinds_Control() {
        // Control: the concrete-element path (backing ClrType non-null) must
        // remain unaffected.
        const source = `
package P
import System.Collections
class C {
    func Make(a []int32) ArrayList { return ArrayList(a) }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TypeParamArray_ToMismatchedConstructor_StillRejected() {
        // Guard against over-broadening: []T must not become applicable to an
        // unrelated non-array parameter. System.Uri has no ctor taking any
        // array-base type, so this must still fail.
        const source = `
package P
import System
class C[T] {
    func Bad(a []T) Uri { return Uri(a) }
}
`
        Assert.NotEmpty(GetDiagnostics(source))
    }

    @Fact
    func TypeParamArray_ToICollectionParameter_EmitsAndRuns() {
        // Runtime/emit assertion: the selected ICollection overload must
        // actually execute against the real []T backing array at runtime.
        const source = `package Issue2182Rt
import System
import System.Collections

class Bag[T] {
    func CountColl(a ICollection) int32 { return a.Count }
    func Run(a []T) int32 { return CountColl(a) }
}

let b = Bag[int32]()
let arr = []int32{10, 20, 30}
Console.WriteLine(b.Run(arr))
`
        let output = CompileAndRun(source, "Issue2182Rt")
        Assert.Equal("3", output.Trim())
    }

    /// Thin wrapper so the test cases can call `Assert.Empty` against a
    /// (cref:ImmutableArray{T}) without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for diagnostic in this.diagnostics {
                yield diagnostic
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator -> this.GetEnumerator()
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        private func GetDiagnostics(source string) Issue2182TypeParamArrayOverloadTests.ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            let all = parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue2182TypeParamArrayOverloadTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
