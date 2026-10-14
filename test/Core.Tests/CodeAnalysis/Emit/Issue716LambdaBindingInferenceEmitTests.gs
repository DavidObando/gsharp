// <copyright file="Issue716LambdaBindingInferenceEmitTests.cs" company="GSharp">
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

/// Issue #716 / ADR-0076 — end-to-end emit tests for lambda binding type
/// inference: when a `let` / `var` binding is initialized with a
/// lambda whose parameter types are all spelled out, the binding's type is
/// inferred to be the lambda's function type `(T1, ...) -> R`. The
/// emitted IL must call the inferred local through the synthesized Func / Action
/// delegate exactly as if the user had written the function-type clause.
open class Issue716LambdaBindingInferenceEmitTests {
    @Fact
    func InferredSingleParamLambda_IsCallable() {
        const Source = `package InferredSquare
import System

func main() int32 {
    var square = (n int32) -> n * n
    return square(7)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredSingleParamLambda_IsCallable")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(49, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredStringIdentityLambda_IsCallable() {
        const Source = `package InferredStringId
import System

func main() string {
    let id = (s string) -> s
    return id("hello")
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredStringIdentityLambda_IsCallable")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal("hello", method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredMultiParamLambda_IsCallable() {
        const Source = `package InferredMulti
import System

func main() int32 {
    let add = (a int32, b int32) -> a + b
    return add(20, 22)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredMultiParamLambda_IsCallable")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(42, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredZeroParamLambda_IsCallable() {
        const Source = `package InferredZero
import System

func main() int32 {
    let always = () -> 42
    return always()
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredZeroParamLambda_IsCallable")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(42, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredBlockBodyLambda_IsCallable() {
        const Source = `package InferredBlock
import System

func main() int32 {
    let inc = (n int32) -> { return n + 1 }
    return inc(41)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredBlockBodyLambda_IsCallable")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(42, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredVoidReturningLambda_IsCallable() {
        const Source = `package InferredVoid
import System

func main() int32 {
    let log = (msg string) -> Console.Out.WriteLine(msg)
    log("ok")
    return 7
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredVoidReturningLambda_IsCallable")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(7, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredLambda_CapturesLocal() {
        const Source = `package InferredCapture
import System

func main() int32 {
    let basis = 100
    let addBase = (n int32) -> n + basis
    return addBase(7)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredLambda_CapturesLocal")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(107, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredLambda_PassesThroughTypedParameter() {
        const Source = `package InferredPass
import System

func apply(f (int32) -> int32, v int32) int32 { return f(v) }

func main() int32 {
    let triple = (x int32) -> x * 3
    return apply(triple, 14)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredLambda_PassesThroughTypedParameter")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(42, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func TargetTypedLambda_ParametersCanBeOmitted() {
        const Source = `package TargetTypedOmit
import System

func main() int32 {
    let twice (int32) -> int32 = (x) -> x * 2
    return twice(21)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "TargetTypedLambda_ParametersCanBeOmitted")
        try {
            let method = GetProgramMethod(asm, "main")
            Assert.Equal(42, method.Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func OpenLambdaBinding_EmitsGS0304() {
        const Source = `package OpenLambda
import System

func main() int32 {
    let f = (x) -> x + 1
    return 0
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        let open_ = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0304").ToList()
        Assert.NotEmpty(open_)
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
