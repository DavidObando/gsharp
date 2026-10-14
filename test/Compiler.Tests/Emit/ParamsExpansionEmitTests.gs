// <copyright file="ParamsExpansionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #506: C#-style `params T[]` expansion. Calls to CLR methods
/// whose final parameter is a `params` array must auto-collect trailing
/// positional arguments into a synthesised array when no fixed-arity overload
/// matches, while still honoring the normal form when a pre-built
/// `[]T{...}` is passed directly.
open class ParamsExpansionEmitTests {
    @Fact
    func PathCombine_SevenStringsExpandsToParamsStringArray() {
        // No fixed-arity Path.Combine overload accepts seven strings; this must
        // bind to Combine(params string[]) by packing the trailing args.
        let source = `package P
import System
import System.IO

let combined = Path.Combine("a", "b", "..", "..", "src", "lib", "out.dll")
Console.WriteLine(combined)`
        let output = CompileAndRun(source)
        let expected = Path.Combine("a", "b", "..", "..", "src", "lib", "out.dll")
        Assert.Equal(expected + Environment.NewLine, output)
    }

    @Fact
    func StringFormat_FourHolesExpandsToParamsObjectArray() {
        // String.Format(string, params object[]) — four object-typed trailing
        // args must pack into an object[] (each string element reference-converts
        // into the object element type).
        let source = `package P
import System

let s = String.Format("{0} {1} {2} {3}", "a", "b", "c", "d")
Console.WriteLine(s)`
        let output = CompileAndRun(source)
        Assert.Equal("a b c d${Environment.NewLine}", output)
    }

    @Fact
    func ConsoleWriteLine_FormatPlusFourTrailingArgs() {
        // Console.WriteLine has fixed overloads up to (string, object, object,
        // object); 4 trailing positional args force selection of the
        // (string, params object[]) overload and exercise expansion at a
        // void-returning CLR static. Strings reference-convert into the
        // object element slot so the test does not depend on value-type
        // boxing in callee-side parameter conversions.
        let source = `package P
import System

Console.WriteLine("{0}-{1}-{2}-{3}", "a", "b", "c", "d")`
        let output = CompileAndRun(source)
        Assert.Equal("a-b-c-d${Environment.NewLine}", output)
    }

    @Fact
    func StringJoin_ZeroTrailingArgsAllocatesEmptyArray() {
        // String.Join(string, params string[]) with zero trailing args must
        // still bind in expanded form and allocate an empty array.
        let source = `package P
import System

let s = String.Join(",")
Console.WriteLine("[" + s + "]")
Console.WriteLine(s.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("[]${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func PathCombine_PrebuiltStringSliceStillBindsNormalForm() {
        // Regression guard: passing an explicit []string slice as a single
        // argument must still bind via the normal (non-expanded) form.
        let source = `package P
import System
import System.IO

let parts = []string{"a", "b", "..", "..", "src", "x.dll"}
let combined = Path.Combine(parts)
Console.WriteLine(combined)`
        let output = CompileAndRun(source)
        let expected = Path.Combine([]string{"a", "b", "..", "..", "src", "x.dll"})
        Assert.Equal(expected + Environment.NewLine, output)
    }

    @Fact
    func StringConcat_PrebuiltObjectSliceBindsNormalFormOverloads() {
        // Regression guard: a fixed-arity Concat(string,string) overload must
        // still beat the expanded params form when arg count matches a fixed
        // overload.
        let source = `package P
import System

let s = String.Concat("hello", " world")
Console.WriteLine(s)`
        let output = CompileAndRun(source)
        Assert.Equal("hello world${Environment.NewLine}", output)
    }

    @Fact
    func TaskWhenAll_ParamsTaskArrayExpansion() {
        // Task.WhenAll(params Task[]) with multiple trailing task args expands.
        let source = `package P
import System
import System.Threading.Tasks

func makeTask(value int32) Task {
    return Task.CompletedTask
}

let t = Task.WhenAll(makeTask(1), makeTask(2), makeTask(3))
t.Wait()
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        Assert.Equal("done${Environment.NewLine}", output)
    }

    @Fact
    func StringFormat_FixedArityBoxesInt32IntoObjectSlot() {
        // Issue #506 follow-up: fixed-arity `String.Format(string, object)`
        // selected for `("{0}", 42)` must emit a `box int32` so the call to
        // a method expecting `object` produces valid IL. Without the boxing
        // wiring the generated IL fails ilverify.
        let source = `package P
import System

let one = String.Format("{0}", 42)
let two = String.Format("{0} {1}", 1, "x")
Console.WriteLine(one)
Console.WriteLine(two)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}1 x${Environment.NewLine}", output)
    }

    @Fact
    func StringFormat_NamedFormatAndProviderExpandsWithEmptyTail() {
        // Issue #506 follow-up: named arguments + expanded params. With both
        // `provider` and `format` supplied by name and no positional args,
        // no fixed-arity overload matches; overload resolution must fall back
        // to `String.Format(IFormatProvider, string, params object[])` in
        // expanded form, allocating an empty object[]. The call format string
        // intentionally has no holes so the empty array is sufficient.
        let source = `package P
import System
import System.Globalization

let s = String.Format(provider: CultureInfo.InvariantCulture, format: "no holes")
Console.WriteLine(s)`
        let output = CompileAndRun(source)
        Assert.Equal("no holes${Environment.NewLine}", output)
    }

    @Fact
    func ImmutableArrayCreate_OpenGenericParamsInfersElementType() {
        // Issue #506 follow-up: open-generic params. ImmutableArray.Create<T>(
        // params T[] items) is a generic params definition; expanded-form
        // overload resolution must infer T from the trailing argument types
        // before closing the candidate. With three int32 arguments the binder
        // should select ImmutableArray.Create<int>(params int[]).
        let source = `package P
import System
import System.Collections.Immutable

let arr = ImmutableArray.Create(10, 20, 30)
Console.WriteLine(arr.Length)
Console.WriteLine(arr[0])
Console.WriteLine(arr[1])
Console.WriteLine(arr[2])`
        let output = CompileAndRun(source)
        Assert.Equal(
            "3${Environment.NewLine}10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}",
            output
        )
    }

    @Fact
    func BaseConstructorInitializer_ParamsArrayExpansion() {
        // Issue #506 follow-up: `init() : base(...)` must use the same
        // two-pass overload resolution / params expansion as other CLR call
        // sites. AggregateException(params Exception[]) is the canonical BCL
        // ctor of this shape; the derived class supplies three exceptions
        // positionally so the params tail must be packed.
        let source = `package P
import System

class MyAgg : AggregateException {
    init(a Exception, b Exception, c Exception) : base(a, b, c) {
    }
}

let e1 = Exception("first")
let e2 = Exception("second")
let e3 = Exception("third")
let agg = MyAgg(e1, e2, e3)
Console.WriteLine(agg.InnerExceptions.Count)
for inner in agg.InnerExceptions {
    Console.WriteLine(inner.Message)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "3${Environment.NewLine}first${Environment.NewLine}second${Environment.NewLine}third${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_params_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
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
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
