// <copyright file="Issue2381AsyncGenericCollectionReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2381: an async G# method returning a closed generic collection over
/// a same-compilation type (e.g. `List[UserClass]`,
/// `Dictionary[string,UserClass]`) was emitted as
/// `Task<Collection<object>>` /
/// `AsyncTaskMethodBuilder<Collection<object>>` even though
/// locals and the declared source return type use the real class, producing
/// unverifiable IL at any caller that observes the real element type.
///
/// Root cause and fix span TWO independent sites, both trusting an
/// object-erased (cref:GSharp.Core.CodeAnalysis.Symbols.ImportedTypeSymbol.ClrType)
/// instead of reconstructing the true closed shape from the OPEN generic
/// definition plus the symbolic type arguments:
/// 1. `AsyncStateMachineTypeBuilder.ResolveAsyncReturnClrType` (and its `builderFieldType` computation
/// in `Build()`) drove the async state machine's `Task<T>` / `AsyncTaskMethodBuilder<T>` / `SetResult`
/// / kickoff-return metadata off the erased `kickoff.Type?.ClrType`. Generalized to route through the
/// SAME symbolic-encoding gate `ReflectionMetadataEmitter.ArgIsSymbolicUserDefined` already used by
/// `EncodeAsyncReturnType`'s Task-construction path for #1785/#2030's gap1 (bare
/// struct/interface/enum/type-parameter shapes) — widened here to also recognize an
/// `ImportedTypeSymbol` closed over a same-compilation argument (recursively, so
/// `List[List[UserClass]]`, `Dictionary[string,UserClass]`, arrays and nullables of a same-compilation
/// element all match).
/// 2. `LambdaBinder.WrapAsTask` — which computes the async function/lambda's OBSERVABLE `Task<T>`
/// return type used for binder-side call/delegate-target-typing (e.g. inferring
/// `Task.Run<TResult>(Func<Task<TResult>>)`'s `TResult` for the `() -> RunAsync()` lambda) — only
/// recognized a null `element.ClrType` (the bare struct/enum/tuple/type-parameter shapes from
/// #1785/#2026/#2232) as "not really closed yet". An imported generic like `List<>` closed over a
/// same-compilation argument reports a NON-null but object-erased `ClrType` (`List<object>`), so it
/// fell through to the ordinary reflection-based `Task<T>` construction and silently produced an erased
/// `Task<List<object>>` observable type. Generalized the same-compilation detection to
/// `TypeSymbol.ContainsSameCompilationUserType` (which already recurses through
/// array/slice/nullable/tuple/imported-generic wrappers) OR'd with the emitter's
/// `ArgIsSymbolicUserDefined`, checked BEFORE the null-ClrType branch so it also catches the
/// erased-but-non-null shape. This also generalizes the pre-existing null-ClrType branch to
/// arrays/slices of a same-compilation element (`[]UserClass`), which had the SAME gap (an
/// array/slice's ClrType is computed once, at construction, as `elementType.ClrType?.MakeArrayType()`,
/// and previously matched none of the hand-listed wrapper kinds).
/// A third, narrower gap was found and fixed along the way:
/// `LambdaBinder.CreateErasedFunctionLiteralAdapter` (the adapter
/// synthesized when a lambda's own bound function type doesn't match its
/// target delegate shape — here, the `() -> RunAsync()` lambda passed to
/// `Task.Run`) never propagated the original literal's
/// `LexicalEnclosingType` onto the adapter's synthesized
/// (cref:GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol). Per the
/// #1335 closure-nesting rule, a capturing closure must be nested inside its
/// lexically enclosing user type to share its CLR accessibility domain; an
/// adapter with a null `LexicalEnclosingType` fell back to a top-level
/// placement, so an adapter closure that reads a `private`/`protected`
/// member of the enclosing type (as this repro's implicit `this.RunAsync()`
/// call does) produced an unverifiable `MethodAccess` IL site.
open class Issue2381AsyncGenericCollectionReturnEmitTests {
    @Fact
    func ListOfUserClass_ExactIssueRepro_CompilesAndRuns() {
        // Exact minimal repro from the issue body.
        let source = `package issue2381list
import System
import System.Collections.Generic
import System.Threading.Tasks

class DiagnosticCheck2381 {}

class ExportCheck2381 {
    private async func RunAsync() List[DiagnosticCheck2381] {
        let results = List[DiagnosticCheck2381]()
        results.Add(DiagnosticCheck2381())
        await Task.Delay(1)
        return results
    }

    func Run() List[DiagnosticCheck2381] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
}

var c = ExportCheck2381()
var r = c.Run()
Console.WriteLine(r.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func NestedListOfUserClass_CompilesAndRuns() {
        // Coverage: nested imported generics — List[List[UserClass]] — must
        // recurse the symbolic reconstruction through both generic layers.
        let source = `package issue2381nested
import System
import System.Collections.Generic
import System.Threading.Tasks

class DiagnosticCheckNested {}

class ExportCheckNested {
    private async func RunAsync() List[List[DiagnosticCheckNested]] {
        let inner = List[DiagnosticCheckNested]()
        inner.Add(DiagnosticCheckNested())
        let outer = List[List[DiagnosticCheckNested]]()
        outer.Add(inner)
        await Task.Delay(1)
        return outer
    }

    func Run() List[List[DiagnosticCheckNested]] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
}

var c = ExportCheckNested()
var r = c.Run()
Console.WriteLine(r.Count)
Console.WriteLine(r[0].Count)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func DictionaryOfStringToUserClass_CompilesAndRuns() {
        // Coverage: Dictionary<string, UserClass> — a two-argument imported
        // generic where only the SECOND argument is same-compilation.
        let source = `package issue2381dict
import System
import System.Collections.Generic
import System.Threading.Tasks

class DiagnosticCheckDict {}

class ExportCheckDict {
    private async func RunAsync() Dictionary[string, DiagnosticCheckDict] {
        let results = Dictionary[string, DiagnosticCheckDict]()
        results["a"] = DiagnosticCheckDict()
        await Task.Delay(1)
        return results
    }

    func Run() Dictionary[string, DiagnosticCheckDict] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
}

var c = ExportCheckDict()
var r = c.Run()
Console.WriteLine(r.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func ArrayOfUserClass_CompilesAndRuns() {
        // Coverage: a slice/array of a same-compilation class. Unlike
        // List<>/Dictionary<> (imported generics whose erasure surfaces as a
        // non-null but object-erased ClrType), a slice/array's ClrType is
        // computed ONCE at construction as `elementType.ClrType?.
        // MakeArrayType()` and stays genuinely null forever once captured
        // before the element's TypeBuilder closes — a distinct shape that
        // needed its own generalization in the null-ClrType branch.
        let source = `package issue2381arr
import System
import System.Threading.Tasks

class DiagnosticCheckArr {}

class ExportCheckArr {
    private async func RunAsync() []DiagnosticCheckArr {
        let results = []DiagnosticCheckArr{DiagnosticCheckArr(), DiagnosticCheckArr()}
        await Task.Delay(1)
        return results
    }

    func Run() []DiagnosticCheckArr -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
}

var c = ExportCheckArr()
var r = c.Run()
Console.WriteLine(r.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func ListOfValueTypeStruct_CompilesAndRuns() {
        // Coverage: a same-compilation VALUE type (struct) element, not a
        // class — ArgIsSymbolicUserDefined/ContainsSameCompilationUserType
        // must recognize StructSymbol arguments identically to class
        // (StructSymbol-backed) arguments.
        let source = `package issue2381vt
import System
import System.Collections.Generic
import System.Threading.Tasks

struct Point2381(X int32, Y int32) { }

class ExportCheckVt {
    private async func RunAsync() List[Point2381] {
        let results = List[Point2381]()
        results.Add(Point2381(1, 2))
        results.Add(Point2381(3, 4))
        await Task.Delay(1)
        return results
    }

    func Run() List[Point2381] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
}

var c = ExportCheckVt()
var r = c.Run()
Console.WriteLine(r.Count)
Console.WriteLine(r[0].X)
Console.WriteLine(r[1].Y)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}1${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func GenericAsyncMethodReturningListOfInferredUserType_CompilesAndRuns() {
        // Control: a GENERIC async method (its own method type parameter,
        // #2030's shape) whose return is ALSO an imported generic collection
        // over that type parameter (#2381's shape) — both generalizations
        // must compose when T is inferred as a same-compilation class at the
        // call site.
        let source = `package issue2381generic
import System
import System.Collections.Generic
import System.Threading.Tasks

class DiagnosticCheckGeneric {}

async func WrapAsync2381[T](v T) List[T] {
    let results = List[T]()
    results.Add(v)
    await Task.Delay(1)
    return results
}

func RunGeneric() List[DiagnosticCheckGeneric] -> Task.Run(() -> WrapAsync2381(DiagnosticCheckGeneric())).GetAwaiter().GetResult()

var r = RunGeneric()
Console.WriteLine(r.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func ListOfPrimitive_ControlUnaffected() {
        // Negative control: a collection over a BUILT-IN (non-same-compilation)
        // element type must keep taking the ordinary reflection-based Task<T>
        // path unaffected by the new same-compilation detection — no
        // behavior change for the common case.
        let source = `package issue2381prim
import System
import System.Collections.Generic
import System.Threading.Tasks

class ExportCheckPrim {
    private async func RunAsync() List[int32] {
        let results = List[int32]()
        results.Add(1)
        results.Add(2)
        await Task.Delay(1)
        return results
    }

    func Run() List[int32] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
}

var c = ExportCheckPrim()
var r = c.Run()
Console.WriteLine(r.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func ListOfUserClass_MetadataReturnTypeIsClosedOverRealClass() {
        // Metadata assertion: reflect over the emitted kickoff method and
        // async state machine builder field to confirm the CLR signature is
        // truly closed over the real user class (List<DiagnosticCheckMeta>),
        // not List<object>.
        let source = `package issue2381meta
import System
import System.Collections.Generic
import System.Threading.Tasks

class DiagnosticCheckMeta {}

class ExportCheckMeta {
    async func RunAsync() List[DiagnosticCheckMeta] {
        let results = List[DiagnosticCheckMeta]()
        results.Add(DiagnosticCheckMeta())
        await Task.Delay(1)
        return results
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue2381_meta_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let compileExit = CompileQuiet(srcPath, outPath, out var stdout, out var stderr)
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            IlVerifier.Verify(outPath)
            let asm = EmittedFixture.Load(outPath)
            let exportType = asm.GetType("issue2381meta.ExportCheckMeta", throwOnError: true)!!
            let runAsync = exportType.GetMethod("RunAsync", BindingFlags.Public | BindingFlags.Instance)!!
            let returnType = runAsync.ReturnType
            Assert.True(returnType.IsGenericType)
            Assert.Equal("Task`1", returnType.Name)
            let taskArg = returnType.GetGenericArguments()[0]
            Assert.True(taskArg.IsGenericType)
            Assert.Equal("List`1", taskArg.Name)
            let listArg = taskArg.GetGenericArguments()[0]
            Assert.Equal("DiagnosticCheckMeta", listArg.Name)
            Assert.NotEqual(typeof(object), listArg)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func CompileQuiet(srcPath string, outPath string, out stdout string, out stderr string) int32 {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            stdout = compileOut.ToString()
            stderr = compileErr.ToString()
            return compileExit
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2381_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let compileExit = CompileQuiet(srcPath, outPath, out var stdout, out var stderr)
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                IlVerifier.Verify(outPath)
                Assert.True(File.Exists(outPath), "expected emitted assembly at $outPath")
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdoutRun = proc!!.StandardOutput.ReadToEnd()
                let stderrRun = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdoutRun" + `
stderr:
` + "$stderrRun"))
                return stdoutRun.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
