// <copyright file="Adr0176RethrowEmitTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// ADR-0176 (issue #3897): `rethrow` re-raises the exception the enclosing
/// `catch` handler is processing, emitting `ILOpCode.Rethrow` and
/// preserving the original throw site.
/// @remarks The evidence these tests are built to produce is a <b>stack trace</b>,
/// not a successful compile. Both `throw` and `rethrow` are valid,
/// ILVerify-clean IL that raise the same exception object — the only observable
/// difference is whether (cref:Exception.StackTrace) still names the
/// frame that originally threw. So every behavioural test here has a paired
/// anti-vacuity test asserting that `throw e` in the same position still
/// <i>loses</i> that frame, plus an opcode assertion so a behavioural
/// coincidence cannot pass.
open class Adr0176RethrowEmitTests {
    /// The load-bearing test: after a `rethrow`, the exception's stack
    /// trace still names `deepThrow`, the frame that originally threw.
    @Fact
    func Rethrow_PreservesTheOriginalThrowSite() {
        const Source = `package RethrowPreserves
import System

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException("boom")
}

func middle() {
    try {
        deepThrow(3)
    } catch (e Exception) {
        rethrow
    }
}

try {
    middle()
} catch (outer Exception) {
    Console.WriteLine(outer.StackTrace)
}
`
        let output = CompileAndRun(Source, "RethrowPreserves")
        Assert.Contains("deepThrow", output)
        Assert.Contains("middle", output)
    }

    /// Anti-vacuity guard for (cref:Rethrow_PreservesTheOriginalThrowSite):
    /// the identical program written with `throw e` must still <i>reset</i>
    /// the trace, or "the fix" could be some unrelated reason both forms keep
    /// their frames.
    @Fact
    func ThrowOfCaughtVariable_StillResetsTheStackTrace() {
        const Source = `package RethrowAntiVacuity
import System

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException("boom")
}

func middle() {
    try {
        deepThrow(3)
    } catch (e Exception) {
        throw e
    }
}

try {
    middle()
} catch (outer Exception) {
    Console.WriteLine(outer.StackTrace)
}
`
        let output = CompileAndRun(Source, "RethrowAntiVacuity")
        Assert.DoesNotContain("deepThrow", output)
        Assert.Contains("middle", output)
    }

    /// The opcode assertion: `rethrow` must emit `ILOpCode.Rethrow`,
    /// not a `throw` of the caught variable that happens to behave the same
    /// way for some other reason. ILVerify cannot make this distinction — both
    /// forms are valid IL.
    @Fact
    func Rethrow_EmitsTheRethrowOpCode() {
        const Source = `package RethrowOpCode
import System

func middle() {
    try {
        throw InvalidOperationException("boom")
    } catch (e Exception) {
        rethrow
    }
}

middle()
`
        let il = EmitAndGetMethodIl(Source, "middle")
        Assert.True(ContainsRethrow(il), "the emitted body must contain the two-byte `rethrow` opcode 0xFE 0x1A.")
    }

    /// Anti-vacuity guard for the opcode assertion: `throw e` in the same
    /// position emits the single-byte `throw` and no `rethrow`.
    @Fact
    func ThrowOfCaughtVariable_EmitsTheThrowOpCodeAndNoRethrow() {
        const Source = `package ThrowOpCode
import System

func middle() {
    try {
        throw InvalidOperationException("boom")
    } catch (e Exception) {
        throw e
    }
}

middle()
`
        let il = EmitAndGetMethodIl(Source, "middle")
        Assert.False(ContainsRethrow(il), "`throw e` must not emit `rethrow`.")
        Assert.Contains(ThrowOpCode, il)
    }

    /// Nesting rule (matching the CLR and C#): a `rethrow` re-raises the
    /// exception of the <i>lexically innermost</i> enclosing catch.
    @Fact
    func Rethrow_InNestedCatch_RaisesTheInnerException() {
        const Source = `package RethrowNestedCatch
import System

func run() {
    try {
        throw InvalidOperationException("outer")
    } catch (e Exception) {
        try {
            throw ArgumentException("inner")
        } catch (inner Exception) {
            rethrow
        }
    }
}

try {
    run()
} catch (caught Exception) {
    Console.WriteLine(caught.Message)
}
`
        let output = CompileAndRun(Source, "RethrowNestedCatch")
        Assert.Contains("inner", output)
        Assert.DoesNotContain("outer", output)
    }

    /// A nested `try` <i>block</i> (not handler) inside a catch does not
    /// introduce a new handler, so a `rethrow` in it still re-raises the
    /// enclosing catch's exception — and still preserves its throw site.
    @Fact
    func Rethrow_InsideNestedTryBlockWithinCatch_RaisesTheEnclosingCatchException() {
        const Source = `package RethrowNestedTryBlock
import System

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException("boom")
}

func run() {
    try {
        deepThrow(3)
    } catch (e Exception) {
        try {
            rethrow
        } finally {
            Console.WriteLine("finally-ran")
        }
    }
}

try {
    run()
} catch (caught Exception) {
    Console.WriteLine(caught.Message)
    Console.WriteLine(caught.StackTrace)
}
`
        let output = CompileAndRun(Source, "RethrowNestedTryBlock")
        Assert.Contains("finally-ran", output)
        Assert.Contains("boom", output)
        Assert.Contains("deepThrow", output)
    }

    /// A catch handler containing an `await` is lifted out of the CLR
    /// protected region by `AsyncExceptionHandlerRewriter`, so its
    /// `rethrow` becomes `ExceptionDispatchInfo.Capture(e).Throw()` —
    /// which must still preserve the original throw site.
    @Fact
    func Rethrow_InAnAwaitingCatchHandler_StillPreservesTheOriginalThrowSite() {
        const Source = `package RethrowAsyncCatch
import System
import System.Threading.Tasks

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException("boom")
}

async func middle() int32 {
    try {
        deepThrow(3)
    } catch (e Exception) {
        let _ = await Task.FromResult(1)
        rethrow
    }
    return 0
}

let t = middle()
try {
    t.Wait()
} catch (agg Exception) {
    Console.WriteLine(agg.InnerException!!.StackTrace)
}
`
        let output = CompileAndRun(Source, "RethrowAsyncCatch")
        Assert.Contains("deepThrow", output)
    }

    /// GS0570: a `rethrow` with no enclosing catch handler.
    @Fact
    func Rethrow_OutsideAnyCatchHandler_ReportsGS0570() {
        const Source = `package RethrowNoHandler
import System

func run() {
    rethrow
}

run()
`
        Assert.Contains("GS0570", CompileForDiagnostics(Source))
    }

    /// GS0570 in a lambda declared inside a catch: the lambda is emitted as its
    /// own method, so at run time it is not inside any handler.
    @Fact
    func Rethrow_InLambdaInsideCatch_ReportsGS0570() {
        const Source = `package RethrowInLambda
import System

func run() {
    try {
        throw InvalidOperationException("boom")
    } catch (e Exception) {
        let f = () -> {
            rethrow
        }
        f()
    }
}

run()
`
        Assert.Contains("GS0570", CompileForDiagnostics(Source))
    }

    /// GS0571: a `finally` nested inside the catch has already left the
    /// handler, so `rethrow` there would be unverifiable IL.
    @Fact
    func Rethrow_InFinallyNestedInsideCatch_ReportsGS0571() {
        const Source = `package RethrowInNestedFinally
import System

func run() {
    try {
        throw InvalidOperationException("boom")
    } catch (e Exception) {
        try {
            Console.WriteLine("work")
        } finally {
            rethrow
        }
    }
}

run()
`
        Assert.Contains("GS0571", CompileForDiagnostics(Source))
    }

    /// A `finally` with no enclosing catch at all gets the plainer GS0570,
    /// because there is no exception being handled anywhere.
    @Fact
    func Rethrow_InFinallyWithNoEnclosingCatch_ReportsGS0570() {
        const Source = `package RethrowBareFinally
import System

func run() {
    try {
        Console.WriteLine("work")
    } finally {
        rethrow
    }
}

run()
`
        Assert.Contains("GS0570", CompileForDiagnostics(Source))
    }

    shared {
        // ECMA-335 III.4.24: `rethrow` is the two-byte prefixed opcode 0xFE 0x1A.
        private const RethrowPrefix uint8 = uint8(0xFE)

        private const RethrowSuffix uint8 = uint8(0x1A)

        // ECMA-335 III.4.31: `throw` is the single-byte opcode 0x7A.
        private const ThrowOpCode uint8 = uint8(0x7A)

        private func ContainsRethrow(il[]uint8) bool {
            for var i = 0; i + 1 < il.Length; i++ {
                if il[i] == RethrowPrefix && il[i + 1] == RethrowSuffix {
                    return true
                }
            }
            return false
        }

        private func CompileForDiagnostics(source string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> "${d.Id} ${d.Message}"))
        }

        private func EmitAndGetMethodIl(source string, methodName string)[]uint8 {
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
            using let pe = PEReader(peStream)
            let md = pe.GetMetadataReader()
            for th in md.TypeDefinitions {
                let type = md.GetTypeDefinition(th)
                for mh in type.GetMethods() {
                    let method = md.GetMethodDefinition(mh)
                    if md.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0 {
                        continue
                    }
                    let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                    return body.GetILBytes() ?? Array.Empty[uint8]()
                }
            }
            Assert.Fail("method '$methodName' not found in emitted assembly")
            return Array.Empty[uint8]()
        }

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
                } catch (tie TargetInvocationException) {
                    Console.SetOut(stdout)
                    throw InvalidOperationException(
                        "Entry point threw: ${tie.InnerException?.GetType().Name}: ${tie.InnerException?.Message}",
                        tie.InnerException
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
