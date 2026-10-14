// <copyright file="Issue1192GenericPrimaryCtorFunctionParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1192: when a generic class has a primary constructor whose parameter
/// type is a function/delegate type mentioning the type parameter (e.g.
/// `(T) -> void`), the type argument must be substituted at the
/// constructed type so both direct construction and a derived `: base(...)`
/// call type-check and emit. These end-to-end emit+run tests prove the
/// constructors actually execute at runtime over the substituted delegate type
/// (previously rejected with GS0214 / GS0154).
open class Issue1192GenericPrimaryCtorFunctionParamEmitTests {
    @Fact
    func DirectConstruction_WithSubstitutedFunctionParam_ConstructsAndRuns() {
        const Source = `package P
open class Base[T](report (T) -> void) {
}
func main() int32 {
    var captured = 0
    let b = Base[int32](func (x int32) { captured = x })
    return 42
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DirectConstruction_WithSubstitutedFunctionParam_ConstructsAndRuns")
        try {
            Assert.Equal(42, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DerivedBaseInitializer_WithSubstitutedFunctionParam_ConstructsAndRuns() {
        const Source = `package P
open class Base[T](report (T) -> void) {
}
open class Derived : Base[int32] {
    init(report (int32) -> void) : base(report) { }
}
func main() int32 {
    var captured = 0
    let d = Derived(func (x int32) { captured = x })
    return 7
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "DerivedBaseInitializer_WithSubstitutedFunctionParam_ConstructsAndRuns"
        )
        try {
            Assert.Equal(7, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    shared {
        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
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
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
        }

        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }
    }
}
