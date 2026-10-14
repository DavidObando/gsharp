// <copyright file="AsyncFunctionTypeClauseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading.Tasks
import Xunit

/// End-to-end tests for ADR-0043: `async func(P) R` as a type-clause
/// spelling for `func(P) Task[R]` in any type-clause position
/// (parameters, locals, fields, generic arguments, function-type return
/// slots, etc.).
open class AsyncFunctionTypeClauseTests {
    @Fact
    func AsyncFunctionTypeClause_Parameter_BindsToFuncReturningTaskOfInt() {
        const Source = `package AsyncFuncParam
import System
import System.Threading.Tasks

func runEach(cb async func(int32) int32) {
    Console.Out.WriteLine("ok")
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncFunctionTypeClause_Parameter_BindsToFuncReturningTaskOfInt")
        try {
            let method = GetProgramMethod(asm, "runEach")
            let parameters = method.GetParameters()
            Assert.Single(parameters)
            // The parameter is a delegate type (Func<int, Task<int>>) — verify the
            // Invoke method shape rather than depending on the exact CLR delegate
            // shape GSharp's emitter chose.
            let paramType = parameters[0].ParameterType
            let invoke MethodInfo? = paramType.GetMethod("Invoke")
            Assert.NotNull(invoke)
            Assert.Equal(typeof(Task[int32]), invoke!!.ReturnType)
            Assert.Single(invoke!!.GetParameters())
            Assert.Equal(typeof(int32), invoke!!.GetParameters()[0].ParameterType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncFunctionTypeClause_VoidReturn_AliasesToFuncReturningPlainTask() {
        const Source = `package AsyncFuncVoid
import System
import System.Threading.Tasks

func runVoid(cb async func(int32)) {
    Console.Out.WriteLine("ok")
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncFunctionTypeClause_VoidReturn_AliasesToFuncReturningPlainTask")
        try {
            let method = GetProgramMethod(asm, "runVoid")
            let paramType = method.GetParameters()[0].ParameterType
            let invoke MethodInfo? = paramType.GetMethod("Invoke")
            Assert.NotNull(invoke)
            Assert.Equal(typeof(Task), invoke!!.ReturnType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncFunctionTypeClause_AndExplicitTaskWrap_AreSameType() {
        // `async func(int) int` and `func(int) Task[int]` must resolve to the
        // exact same FunctionTypeSymbol — i.e., the same CLR parameter type.
        const Source = `package AsyncFuncEquiv
import System
import System.Threading.Tasks

func viaModifier(cb async func(int32) int32) {
}

func viaTaskWrap(cb func(int32) Task[int32]) {
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncFunctionTypeClause_AndExplicitTaskWrap_AreSameType")
        try {
            let viaModifier = GetProgramMethod(asm, "viaModifier")
            let viaTaskWrap = GetProgramMethod(asm, "viaTaskWrap")
            Assert.Equal(viaModifier.GetParameters()[0].ParameterType, viaTaskWrap.GetParameters()[0].ParameterType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncFunctionTypeClause_InReturnSlot_OfOuterFunction() {
        // The outer function `factory` returns `async func() int` — i.e.,
        // `func() Task[int]`. Verify the outer return type's delegate-Invoke
        // shape via reflection.
        const Source = `package AsyncFuncReturn
import System
import System.Threading.Tasks

func factory() async func(int32) int32 {
    return async func(x int32) int32 { return x + 1 }
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncFunctionTypeClause_InReturnSlot_OfOuterFunction")
        try {
            let factory = GetProgramMethod(asm, "factory")
            let returnType = factory.ReturnType
            let invoke MethodInfo? = returnType.GetMethod("Invoke")
            Assert.NotNull(invoke)
            Assert.Equal(typeof(Task[int32]), invoke!!.ReturnType)
            Assert.Single(invoke!!.GetParameters())
            Assert.Equal(typeof(int32), invoke!!.GetParameters()[0].ParameterType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncFunctionTypeClause_AsyncSequenceReturn_KeepsIAsyncEnumerableUnwrapped() {
        // Iterator carve-out: `async func() sequence[int]` and
        // `async func() async sequence[int]` parameter types both resolve to
        // `func() IAsyncEnumerable[int]` — no Task wrap.
        const Source = `package AsyncFuncIterReturn
import System
import System.Collections.Generic
import System.Threading.Tasks

func acceptImplicit(cb async func() sequence[int32]) {
}

func acceptExplicit(cb async func() async sequence[int32]) {
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "AsyncFunctionTypeClause_AsyncSequenceReturn_KeepsIAsyncEnumerableUnwrapped"
        )
        try {
            let acceptImplicit = GetProgramMethod(asm, "acceptImplicit")
            let acceptExplicit = GetProgramMethod(asm, "acceptExplicit")
            let implicitParamType = acceptImplicit.GetParameters()[0].ParameterType
            let explicitParamType = acceptExplicit.GetParameters()[0].ParameterType
            let implicitInvoke MethodInfo? = implicitParamType.GetMethod("Invoke")
            let explicitInvoke MethodInfo? = explicitParamType.GetMethod("Invoke")
            Assert.NotNull(implicitInvoke)
            Assert.NotNull(explicitInvoke)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), implicitInvoke!!.ReturnType)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), explicitInvoke!!.ReturnType)
            Assert.Equal(implicitParamType, explicitParamType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncFunctionTypeClause_ExplicitTaskReturn_IsRejected() {
        // ADR-0043 rejects `async func(...) Task[X]` because the `async`
        // modifier already implies the Task wrap.
        const Source = `package AsyncFuncDoubleWrap
import System
import System.Threading.Tasks

func bad(cb async func(int32) Task[int32]) {
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("implicitly wrapped in 'Task'", StringComparison.Ordinal)
        )
    }

    @Fact
    func AsyncPrefix_FollowedByNonFuncNonSequence_IsRejected() {
        // After ADR-0043 the legal followers are `func` and `sequence` only.
        const Source = `package AsyncBadPrefix
import System

func bad(s async int32) {
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains(
                "'async' modifier in a type clause is only valid before 'sequence[T]', '(T) -> R', or 'func(...)'",
                StringComparison.Ordinal
            )
        )
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
