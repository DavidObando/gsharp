// <copyright file="Issue715ArrowFunctionTypeClauseEmitTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// Issue #715 / ADR-0075 — end-to-end emit tests for the canonical
/// arrow-form function-type clause `(T) -> R` in real programs.
/// Verifies that emitted delegate types and assignments behave identically
/// to the legacy `func(T) R` spelling.
open class Issue715ArrowFunctionTypeClauseEmitTests {
    @Fact
    func ArrowFunctionType_OnParameter_EmitsFuncDelegate() {
        const Source = `package ArrowFuncParam
import System

func runEach(cb (int32) -> int32) {
    Console.Out.WriteLine("ok")
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_OnParameter_EmitsFuncDelegate")
        try {
            let method = GetProgramMethod(asm, "runEach")
            let parameters = method.GetParameters()
            Assert.Single(parameters)
            let paramType = parameters[0].ParameterType
            let invoke MethodInfo? = paramType.GetMethod("Invoke")
            Assert.NotNull(invoke)
            Assert.Equal(typeof(int32), invoke!!.ReturnType)
            Assert.Single(invoke!!.GetParameters())
            Assert.Equal(typeof(int32), invoke!!.GetParameters()[0].ParameterType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncArrowFunctionType_OnParameter_EmitsFuncDelegateReturningTask() {
        const Source = `package AsyncArrowFuncParam
import System
import System.Threading.Tasks

func runEach(cb async (int32) -> int32) {
    Console.Out.WriteLine("ok")
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncArrowFunctionType_OnParameter_EmitsFuncDelegateReturningTask")
        try {
            let method = GetProgramMethod(asm, "runEach")
            let parameters = method.GetParameters()
            Assert.Single(parameters)
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
    func ArrowAndLegacyForms_EmitTheSameDelegateType() {
        // The two spellings must produce the same FunctionTypeSymbol, which
        // means the emitter must reuse the same delegate type for both.
        const Source = `package ArrowParity
import System

func arrow(cb (int32) -> int32) { }
func legacy(cb func(int32) int32) { }
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowAndLegacyForms_EmitTheSameDelegateType")
        try {
            let arrowParam = GetProgramMethod(asm, "arrow").GetParameters()[0].ParameterType
            let legacyParam = GetProgramMethod(asm, "legacy").GetParameters()[0].ParameterType
            Assert.Same(arrowParam, legacyParam)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ArrowFunctionType_OnLocal_RoundTripsThroughLambdaInvocation() {
        const Source = `package ArrowLocal
import System

func main() int32 {
    var add (int32, int32) -> int32 = (a int32, b int32) -> a + b
    return add(40, 2)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_OnLocal_RoundTripsThroughLambdaInvocation")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(42, result)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ArrowFunctionType_OnLocal_AcceptsMethodGroup() {
        const Source = `package ArrowMethodGroup
import System

func twice(x int32) int32 { return x * 2 }

func main() int32 {
    var g (int32) -> int32 = twice
    return g(21)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_OnLocal_AcceptsMethodGroup")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(42, result)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ArrowFunctionType_PassingLambdaThroughParameter_Works() {
        const Source = `package ArrowLambdaParam
import System

func apply(f (int32) -> int32, v int32) int32 { return f(v) }

func main() int32 {
    return apply((x int32) -> x * 3, 14)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_PassingLambdaThroughParameter_Works")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(42, result)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ArrowFunctionType_ReturnedFromFunction_Works() {
        const Source = `package ArrowReturned
import System

func makeAdder(delta int32) (int32) -> int32 { return (x int32) -> x + delta }

func main() int32 {
    var addTen = makeAdder(10)
    return addTen(32)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_ReturnedFromFunction_Works")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(42, result)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ArrowFunctionType_VoidReturn_Works() {
        const Source = `package ArrowVoid
import System

func main() int32 {
    var g () -> void = () -> Console.Out.WriteLine("ok")
    g()
    return 42
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_VoidReturn_Works")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(42, result)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ArrowFunctionType_TupleReturn_Works() {
        const Source = `package ArrowTupleReturn
import System

func split(s string) (string, int32) { return (s, s.Length) }

func main() int32 {
    var splitter (string) -> (string, int32) = split
    var t = splitter("hello")
    return t.Item2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_TupleReturn_Works")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(5, result)
        } finally {
            ctx.Unload()
        }
    }

    /// Issue #4358 (P0): converting a function value into a function type
    /// whose TUPLE return differs from the source only by a reference-
    /// nullability annotation on one element (`(string, int32)` →
    /// `(string?, int32)`) used to segfault the process at run time
    /// with no diagnostic and no catchable exception.
    ///
    /// Root cause: `TupleTypeSymbol.ClrType` is `null`
    /// whenever any element merely carries a reference-nullable annotation
    /// (`TupleTypeSymbol.BuildClrType` deliberately keeps such a tuple
    /// symbolic). `ReflectionMetadataEmitter.ArgIsSymbolicUserDefined`
    /// did not see this for a tuple whose poisoned element was a bare
    /// reference-nullable wrapper: a `NullableTypeSymbol` element is
    /// unwrapped to its underlying type before recursing (correct for a bare
    /// nullable return, since erasure keeps that type's own `ClrType`
    /// non-null), and a `PlatformTypeSymbol` (`T!`) element has no
    /// case at all and falls straight through to "not symbolic". Either way
    /// the per-element recursion never asks the one question that matters
    /// for a *containing tuple*: whether the tuple's own `ClrType` came
    /// back `null`. `UserTokenResolver.FunctionTypeNeedsSymbolicDelegate`
    /// therefore answered `false` for
    /// `(string) -> (string?, int32)`, so
    /// `MethodBodyEmitter.EmitIndirectCall` resolved the call's
    /// `Invoke` MemberRef through the naive reflection path
    /// (`SignatureEncoder.ResolveDelegateClrType` /
    /// `ResolveDelegateArgClrType`), which silently erased the
    /// poisoned-null tuple return type to `object` — producing
    /// `Func<string, object>::Invoke` over a delegate instance
    /// that was actually `Func<string, ValueTuple<string,
    /// int32>>`. The struct-vs-object return calling-convention
    /// mismatch corrupted the stack instead of throwing.
    ///
    /// ADR-0154 discrimination witness: on the pre-fix commit this test does
    /// not fail an assertion — invoking `main` crashes the process
    /// (SIGSEGV), exactly as `gsc`+`dotnet` did on the file-based
    /// repro from the issue. The fix
    /// (`ReflectionMetadataEmitter.ArgIsSymbolicUserDefined` checking
    /// `tuple.ClrType == null` directly for a `TupleTypeSymbol`
    /// argument) routes the conversion and the call site through the
    /// symbolic `Func<…>` TypeSpec path instead, which encodes the
    /// tuple's real CLR shape regardless of the nullable annotation.
    @Fact
    func ArrowFunctionType_NullableTupleElementReturn_DoesNotSegfault() {
        const Source = `package ArrowNullableTupleReturn
import System

func split(s string) (string, int32) { return (s, s.Length) }

func main() int32 {
    var splitter (string) -> (string?, int32) = split
    var t = splitter("hello")
    return t.Item2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ArrowFunctionType_NullableTupleElementReturn_DoesNotSegfault")
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(5, result)
        } finally {
            ctx.Unload()
        }
    }

    /// Issue #4358 follow-up: a native-source INVOCATION witness. The same
    /// nullable-tuple-element shape, but with the source function's OWN
    /// declared return type already `(string?, int32)` — an identity
    /// conversion rather than the representation-preserving widening that
    /// (cref:ArrowFunctionType_NullableTupleElementReturn_DoesNotSegfault)
    /// goes through.
    ///
    /// This does NOT independently cover the delegate-construction site:
    /// `FunctionTypeSymbol.BuildClrType` already returns
    /// `null` for this function type (its tuple return's
    /// `ClrType` is null), so `EmitMethodGroup`'s own
    /// `functionType.ClrType != null` guard sent the construction through
    /// `GetFunctionDelegateCtorRef` even before the fix. What goes red on
    /// the pre-fix commit is the later `Invoke` call site, as in the first
    /// test. Construction-site coverage for a real named-delegate target lives
    /// in `Issue2876ImportedDataClassDelegateTargetEmitTests
    /// .NullableTupleFunctionToImportedNonGenericNamedDelegate_Verifies`.
    @Fact
    func ArrowFunctionType_SourceNativelyReturnsNullableTupleElement_DoesNotSegfault() {
        const Source = `package ArrowNullableTupleReturnNative
import System

func split(s string) (string?, int32) { return (s, s.Length) }

func main() int32 {
    var splitter (string) -> (string?, int32) = split
    var t = splitter("hello")
    return t.Item2
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "ArrowFunctionType_SourceNativelyReturnsNullableTupleElement_DoesNotSegfault"
        )
        try {
            let method = GetProgramMethod(asm, "main")
            let result object? = method.Invoke(nil, nil)
            Assert.Equal(5, result)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func LegacyFuncForm_StillCompiles_EmitsGS0303_Warning() {
        const Source = `package LegacyDeprecated
import System

func runEach(cb func(int32) int32) {
    Console.Out.WriteLine("ok")
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        let warnings = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303").ToList()
        Assert.Single(warnings)
    }

    @Fact
    func ParenthesizedNullableArrowFunctionType_OnProperty_AcceptsMethodGroupAndNil() {
        const Source = `package Issue1399NullableFunctionProperty

class Args { }

class C {
    prop H ((Args) -> void)?

    func cb(a Args) { }

    func F() { H = cb }

    func G() { H = nil }
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "ParenthesizedNullableArrowFunctionType_OnProperty_AcceptsMethodGroupAndNil"
        )
        try {
            let c = asm.GetTypes().Single((t Type) -> t.Name == "C")
            let h PropertyInfo? = c.GetProperty(
                "H",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(h)
            Assert.Equal(typeof(System.Action[_]).Name, h!!.PropertyType.GetGenericTypeDefinition().Name)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func NullableReturnArrowFunctionType_OnProperty_EmitsFuncDelegate() {
        const Source = `package Issue1399NullableReturnFunctionProperty

class C {
    prop H (int32) -> int32?

    func maybe(a int32) int32? { return a + 1 }

    func F() { H = maybe }
}
`
        let (asm, ctx) = CompileToAssembly(Source, "NullableReturnArrowFunctionType_OnProperty_EmitsFuncDelegate")
        try {
            let c = asm.GetTypes().Single((t Type) -> t.Name == "C")
            let h PropertyInfo? = c.GetProperty(
                "H",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(h)
            Assert.Equal(typeof(System.Func[_, _]).Name, h!!.PropertyType.GetGenericTypeDefinition().Name)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ParenthesizedNullableArrowFunctionType_NonVoid_OnProperty_AcceptsNil() {
        const Source = `package Issue1399NullableNonVoidFunctionProperty

class C {
    prop H ((int32) -> int32)?

    func G() { H = nil }
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "ParenthesizedNullableArrowFunctionType_NonVoid_OnProperty_AcceptsNil"
        )
        try {
            let c = asm.GetTypes().Single((t Type) -> t.Name == "C")
            let h PropertyInfo? = c.GetProperty(
                "H",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(h)
            Assert.Equal(typeof(System.Func[_, _]).Name, h!!.PropertyType.GetGenericTypeDefinition().Name)
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
