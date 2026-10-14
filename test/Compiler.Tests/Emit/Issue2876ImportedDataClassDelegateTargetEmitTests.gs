// <copyright file="Issue2876ImportedDataClassDelegateTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2876 — a lambda flowing into a non-`Func`/`Action` delegate
/// parameter (`Predicate[T]`, `Comparison[T]`) of a GENERIC method
/// closed over an IMPORTED `data class` materialised the natural
/// `Func`/`Action` shape instead of the requested delegate, producing
/// unverifiable IL (`ilverify StackUnexpected: [found ref System.Func`2<T,bool>]
/// [expected ref System.Predicate`1<T>]`) with no diagnostic.
///
/// `ReflectionMetadataEmitter.ArgIsSymbolicUserDefined` answered
/// `true` for ANY `StructSymbol`. An imported data type's
/// semantic aggregate is also a `StructSymbol` (see
/// `ImportedTypeSymbol.BuildSemanticAggregate`, which passes
/// `clrType: type`), so the lambda's whole function type looked symbolic
/// and `EmitFunctionToDelegateConversion` discarded the real target
/// delegate in favour of the natural `Func`/`Action` shape.
/// Symbolic encoding is only needed when there is no CLR type to reflect over,
/// i.e. `ClrType == null` — the same guard
/// `TypeSymbol.IsSameCompilationUserTypeTopLevel` already applies to these
/// four symbol kinds.
///
/// Every fact here runs `ilverify` over the produced assembly (see
/// `RunBuilt`), which is what actually catches the regression.
open class Issue2876ImportedDataClassDelegateTargetEmitTests {
    @Fact
    func LambdaToGenericPredicateParameter_OverImportedDataClass_Verifies() {
        const source = `package i2876a

import System
import System.Collections.Generic
import i2876lib

func Main() {
    let items = List[Item]()
    items.Add(Item("A1", "One"))
    items.Add(Item("A2", "Two"))
    Console.WriteLine(Filters.CountMatching(items, (i Item) -> i.Asin == "A1"))
}`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"))
    }

    @Fact
    func LambdaToGenericComparisonParameter_OverImportedDataClass_Verifies() {
        const source = `package i2876b

import System
import i2876lib

func Main() {
    Console.WriteLine(Filters.Order(Item("A1", "One"), Item("A2", "Two"), (x Item, y Item) -> String.Compare(x.Asin, y.Asin)))
}`
        Assert.Equal("-1${Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"))
    }

    @Fact
    func LambdaToGenericFuncParameter_OverImportedDataClass_StillVerifies() {
        // Control: `Func`/`Action` are the natural structural delegate shapes,
        // so this arm was never affected.
        const source = `package i2876c

import System
import System.Collections.Generic
import i2876lib

func Main() {
    let items = List[Item]()
    items.Add(Item("A1", "One"))
    items.Add(Item("A2", "Two"))
    Console.WriteLine(Filters.CountFunc(items, (i Item) -> i.Asin == "A2"))
}`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"))
    }

    @Fact
    func LambdaToGenericPredicateParameter_OverImportedPlainClass_StillVerifies() {
        // Control: a plain imported class is an ImportedTypeSymbol, never a
        // StructSymbol, so it never tripped the symbolic gate.
        const source = `package i2876d

import System
import System.Collections.Generic
import i2876lib

func Main() {
    let items = List[PlainItem]()
    items.Add(PlainItem("P1"))
    items.Add(PlainItem("P2"))
    Console.WriteLine(Filters.CountMatching(items, (p PlainItem) -> p.Asin == "P1"))
}`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"))
    }

    @Fact
    func LambdaToGenericPredicateParameter_OverLocalDataClass_StillVerifies() {
        // Control: a SAME-COMPILATION data class genuinely has no CLR type, so
        // it must keep taking the symbolic path.
        const source = `package i2876e

import System
import System.Collections.Generic
import i2876lib

data class Local(Key string)

func Main() {
    let items = List[Local]()
    items.Add(Local("L1"))
    items.Add(Local("L2"))
    Console.WriteLine(Filters.CountMatching(items, (l Local) -> l.Key == "L2"))
}`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"))
    }

    @Fact
    func MethodGroupToGenericPredicateParameter_OverImportedDataClass_Verifies() {
        // A method group materialises through the same
        // EmitFunctionToDelegateConversion entry point as a lambda.
        const source = `package i2876f

import System
import System.Collections.Generic
import i2876lib

func IsFirst(i Item) bool {
    return i.Asin == "A1"
}

func Main() {
    let items = List[Item]()
    items.Add(Item("A1", "One"))
    items.Add(Item("A2", "Two"))
    Console.WriteLine(Filters.CountMatching(items, IsFirst))
}`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"))
    }

    /// Issue #4358: a function type whose tuple return carries a
    /// reference-nullable element (`(string?, int32)`) is symbolic — its
    /// tuple's `ClrType` is null — so the SOURCE `Invoke` must be
    /// referenced through the symbolic `Func<…>` TypeSpec. That must
    /// not also replace a real, non-generic imported named delegate TARGET
    /// with the natural `Func<…>` shape: the method-group and
    /// function-value cases then constructed a `Func<…>` and passed
    /// it where `Splitter` was expected (ilverify StackUnexpected). The
    /// lambda is the control that stayed correct. `main` before the
    /// #4358 fix got the ctor right but referenced the variable's
    /// `Invoke` as the erased `Func<string, object>`.
    @Fact
    func NullableTupleFunctionToImportedNonGenericNamedDelegate_Verifies() {
        const source = `package i4358a

import System
import i4358lib

func split(s string) (string?, int32) { return (s, s.Length) }

func useSplitter(c Splitter) int32 {
    return c.Invoke("hello").Item2
}

func Main() {
    var f (string) -> (string?, int32) = split
    Console.WriteLine(useSplitter(split))
    Console.WriteLine(useSplitter((s string) -> (s, s.Length + 1)))
    Console.WriteLine(useSplitter(f))
}`
        Assert.Equal(
            "5${Environment.NewLine}6${Environment.NewLine}5${Environment.NewLine}",
            CompileAndRun(source, NullableTupleDelegatesLibrary, "i4358lib")
        )
    }

    /// Issue #4358, Copilot review follow-up: the named target being GENERIC
    /// does not make it the natural `Func`/`Action` shape. A
    /// concrete `GSplitter[string]` — written directly, or inferred
    /// through a generic method's `SyncConv[T]` parameter — has no
    /// substitutable type argument, so it reaches the same conversion path
    /// as the non-generic `Splitter`. Keying the natural-shape
    /// substitution on `IsGenericType` constructed a `Func<…>`
    /// for the method group and function value there (ilverify
    /// StackUnexpected); it now keys on the target actually being
    /// `Func`/`Action`.
    @Fact
    func NullableTupleFunctionToImportedGenericNamedDelegate_Verifies() {
        const source = `package i4358b

import System
import i4358lib

func split(s string) (string?, int32) { return (s, s.Length) }

func useG(c GSplitter[string]) int32 {
    return c.Invoke("hello").Item2
}

func Main() {
    var f (string) -> (string?, int32) = split
    Console.WriteLine(useG(split))
    Console.WriteLine(useG((s string) -> (s, s.Length + 1)))
    Console.WriteLine(useG(f))
    Console.WriteLine(Runner.RunSync("hello", split))
    Console.WriteLine(Runner.RunSync("hello", (s string) -> (s, s.Length + 2)))
}`
        Assert.Equal(
            "5${Environment.NewLine}6${Environment.NewLine}5${Environment.NewLine}5${Environment.NewLine}7${Environment.NewLine}",
            CompileAndRun(source, NullableTupleDelegatesLibrary, "i4358lib")
        )
    }

    /// Issue #4358, Copilot review follow-up: an async lambda whose result is
    /// `(string?, int32)` converted to an imported named delegate —
    /// non-generic `AsyncSplitter`, and generic `AsyncConv[T]`
    /// through a generic method. The symbolic async ctor
    /// (`TryGetSymbolicAsyncDelegateCtorRef`) is the natural
    /// `Func<…, Task<…>>` shape and is now only consulted for a
    /// natural target. NOTE: this is a guard, not a discrimination witness —
    /// every position tried (argument, local, return, field, generic-method
    /// argument) binds the async literal directly to the named delegate and
    /// never reaches that branch, so it is green with and without the gate.
    @Fact
    func NullableTupleAsyncLambdaToImportedNamedDelegate_Verifies() {
        const source = `package i4358c

import System
import System.Threading.Tasks
import i4358lib

func useA(c AsyncSplitter) int32 {
    return c.Invoke("hello").Result.Item2
}

func Main() {
    let a AsyncSplitter = async (s string) -> (s, s.Length + 1)
    Console.WriteLine(useA(a))
    Console.WriteLine(useA(async (s string) -> (s, s.Length + 2)))
    Console.WriteLine(Runner.RunAsync("hello", async (s string) -> (s, s.Length + 3)))
}`
        Assert.Equal(
            "6${Environment.NewLine}7${Environment.NewLine}8${Environment.NewLine}",
            CompileAndRun(source, NullableTupleDelegatesLibrary, "i4358lib")
        )
    }

    shared {
        /// The generic helpers reused by most facts. `Predicate[T]` and
        /// `Comparison[T]` are the broken shapes; `Func[T, bool]` is the
        /// natural shape that always worked.
        private const HelpersLibrary string = `package i2876lib

import System
import System.Collections.Generic

public data class Item(Asin string, Title string)

public class PlainItem {
    public var Asin string

    init(asin string) {
        this.Asin = asin
    }
}

public class Filters {
    shared {
        func CountMatching[T](items IEnumerable[T], p Predicate[T]) int32 {
            var n = 0
            for item in items {
                if p.Invoke(item) {
                    n = n + 1
                }
            }

            return n
        }

        func Order[T](a T, b T, c Comparison[T]) int32 {
            return c.Invoke(a, b)
        }

        func CountFunc[T](items IEnumerable[T], p Func[T, bool]) int32 {
            var n = 0
            for item in items {
                if p.Invoke(item) {
                    n = n + 1
                }
            }

            return n
        }
    }
}`

        /// Issue #4358: imported named delegates whose signatures carry a
        /// nullable-tuple element, non-generic and generic, sync and async.
        private const NullableTupleDelegatesLibrary string = `package i4358lib

import System.Threading.Tasks

public delegate Splitter(s string) (string?, int32);

public delegate GSplitter[T](s T) (string?, int32);

public delegate AsyncSplitter(s string) Task[(string?, int32)];

public delegate SyncConv[T](s T) (string?, int32);

public delegate AsyncConv[T](s T) Task[(string?, int32)];

public class Runner {
    shared {
        func RunSync[T](x T, f SyncConv[T]) int32 {
            return f.Invoke(x).Item2
        }

        func RunAsync[T](x T, f AsyncConv[T]) int32 {
            return f.Invoke(x).Result.Item2
        }
    }
}`

        private func CompileAndRun(source string, library string, libraryAssemblyName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2876_").FullName
            try {
                let dllPath = BuildExecutable(tempDir, source, library, libraryAssemblyName, out var libDll)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }

        private func BuildExecutable(
            tempDir string,
            source string,
            library string,
            libraryAssemblyName string,
            out libDll string
        ) string {
            // ilverify resolves `-r` references by FILE NAME, so the library must
            // be written out under its assembly identity.
            let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
            libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
            File.WriteAllText(libSrc, library)
            Compile([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
            IlVerifier.Verify(libDll)
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            Compile([]string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", "/r:" + libDll, srcPath})
            return dllPath
        }

        private func Compile(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
