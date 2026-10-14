// <copyright file="Adr0185TupleDestructuringParameterEmitTests.cs" company="GSharp">
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

/// ADR-0185 — end-to-end emit tests for tuple-destructuring arrow-lambda
/// parameters (`((x string, y int)) -> g(x, y)`), the language feature
/// that retires cs2gs's `__q{N}` synthetic-identifier family (issue
/// #4304). Compiles a real program, runs it, and asserts on the actual
/// output — this repo's established `*EmitTests.cs` pattern (see
/// `Issue1172ArrowLambdaParityEmitTests`).
open class Adr0185TupleDestructuringParameterEmitTests {
    @Fact
    func DestructuredParameter_TwoElements_UnpacksAndComputes() {
        const Source = `package P1

func main() int32 {
    let f = ((x int32, y int32)) -> x + y
    return f((3, 4))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DestructuredParameter_TwoElements_UnpacksAndComputes")
        try {
            Assert.Equal(7, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DestructuredParameter_ThreeElements_MixedTypes() {
        const Source = `package P2
import System

func main() int32 {
    let f = ((name string, count int32, active bool)) -> {
        if !active {
            return 0
        }

        return name.Length + count
    }
    return f(("hi", 5, true))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DestructuredParameter_ThreeElements_MixedTypes")
        try {
            Assert.Equal(7, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DestructuredParameter_DiscardElement_Ignored() {
        // The `_` element is bound but never referenceable — mirrors the
        // statement-position `let (x, _) = e` discard (ADR-0032/0168).
        const Source = `package P3

func main() int32 {
    let f = ((x int32, _ int32)) -> x
    return f((10, 999))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DestructuredParameter_DiscardElement_Ignored")
        try {
            Assert.Equal(10, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DestructuredParameter_BlockBody_PreludeRunsBeforeOwnStatements() {
        // The destructuring prelude must run BEFORE any statement the
        // lambda's own block body writes, since those statements may
        // reference the destructured names.
        const Source = `package P4

func main() int32 {
    let f = ((x int32, y int32)) -> {
        let sum = x + y
        return sum * 2
    }
    return f((3, 4))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DestructuredParameter_BlockBody_PreludeRunsBeforeOwnStatements")
        try {
            Assert.Equal(14, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DestructuredParameter_SecondPositionAmongOrdinaryParameters() {
        // ADR-0185 does not restrict destructuring to the sole/first
        // parameter — an ordinary parameter and a destructured one may
        // coexist in either order.
        const Source = `package P5

func main() int32 {
    let f = (z int32, (x int32, y int32)) -> z + x + y
    return f(1, (2, 3))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DestructuredParameter_SecondPositionAmongOrdinaryParameters")
        try {
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func OrdinaryTupleTypedParameter_RegressionStillWorks() {
        // ADR-0185's regression guard: a single parameter whose TYPE happens
        // to be a parenthesized tuple must keep meaning exactly that — one
        // parameter named `pair`, of tuple type — not silently become a
        // destructured pattern.
        const Source = `package P6

func main() int32 {
    let f = (pair (int32, int32)) -> pair.Item1 + pair.Item2
    return f((5, 6))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "OrdinaryTupleTypedParameter_RegressionStillWorks")
        try {
            Assert.Equal(11, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DestructuredParameter_AsyncLambda_Unpacks() {
        const Source = `package P7
import System.Threading.Tasks

func main() int32 {
    let f = async ((x int32, y int32)) -> {
        return x + y
    }
    return f((4, 5)).Result
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DestructuredParameter_AsyncLambda_Unpacks")
        try {
            Assert.Equal(9, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    shared {
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
    }
}
