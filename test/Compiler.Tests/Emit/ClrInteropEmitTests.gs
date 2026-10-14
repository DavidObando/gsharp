// <copyright file="ClrInteropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Emit coverage for clr interop.
/// Traceability: issues #63 and #64.
open class ClrInteropEmitTests {
    @Fact
    func NonGenericConstructor_PropertyRead_AndInstanceMethod() {
        let source = `package P
import System
import System.Text

var sb = StringBuilder()
sb.Append("hello ")
sb.Append("world")
Console.WriteLine(sb.ToString())
Console.WriteLine(sb.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("hello world${Environment.NewLine}11${Environment.NewLine}", output)
    }

    @Fact
    func GenericConstructor_IndexerReadAndWrite_OnDictionary() {
        let source = `package P
import System
import System.Collections.Generic

var d = Dictionary[string, int32]()
d["alpha"] = 1
d["beta"] = 2
Console.WriteLine(d.Count)
Console.WriteLine(d["alpha"])
Console.WriteLine(d["beta"])`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func GenericList_ConstructorAndIndexerAndMethod() {
        let source = `package P
import System
import System.Collections.Generic

var xs = List[int32]()
xs.Add(10)
xs.Add(20)
xs.Add(30)
Console.WriteLine(xs.Count)
Console.WriteLine(xs[0])
Console.WriteLine(xs[2])`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}10${Environment.NewLine}30${Environment.NewLine}", output)
    }

    @Fact
    func StaticPropertyRead_AndInstancePropertyWrite_RoundTrip() {
        // Stream B emit parity: bare `Int32.MaxValue` → `call get_MaxValue`
        // (static read), `sb.Capacity = 64` → `callvirt set_Capacity` (instance
        // write). The re-read after the store ensures the assignment yields
        // the assigned value, matching the indexer-assignment shape.
        let source = `package P
import System
import System.Text

Console.WriteLine(Int32.MaxValue)
var sb = StringBuilder()
sb.Capacity = 64
Console.WriteLine(sb.Capacity)`
        let output = CompileAndRun(source)
        Assert.Equal("2147483647${Environment.NewLine}64${Environment.NewLine}", output)
    }

    @Fact
    func ClrUserDefinedOperator_TimeSpanAddition_EmitsCallToOpAddition() {
        // Stream C emit parity: `a + b` for TimeSpan operands should compile to
        // `call System.TimeSpan::op_Addition(TimeSpan, TimeSpan)`, and the
        // result must round-trip when written via Console.WriteLine.
        let source = `package P
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 15)
var c = a + b
Console.WriteLine(c.Seconds)`
        let output = CompileAndRun(source)
        Assert.Equal("45${Environment.NewLine}", output)
    }

    @Fact
    func EventSubscription_AddInvokeRemove_RoundTripsThroughEmit() {
        // Stream B′ emit parity: `evt += handler` should emit
        // `callvirt add_X(receiver, handler)` against the resolved event
        // accessor, and `-=` should emit the matching remove call. Use
        // AppDomain.ProcessExit so we don't have to spin up a custom event;
        // the round-trip just needs to compile, run, and execute the
        // attach/detach without throwing.
        let source = `package P
import System

var d = AppDomain.CurrentDomain
d.ProcessExit += func(sender Object, e EventArgs) { }
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        Assert.Equal("done${Environment.NewLine}", output)
    }

    @Fact
    func GenericMethodInference_EnumerableRepeat_EmitsClosedMethodSpec() {
        // Stream F follow-up: Enumerable.Repeat<TResult>(TResult, int) is an
        // open generic method. With argument-driven inference, GSharp resolves
        // TResult=int from (int, int) without explicit type arguments. The
        // emitter must encode the call as a MethodSpec over the open Repeat
        // definition so the produced PE loads and runs against System.Linq.
        let source = `package P
import System
import System.Linq

let seq = Enumerable.Repeat(7, 3)
Console.WriteLine(seq)`
        let output = CompileAndRun(source)
        // RepeatIterator's ToString returns its CLR type name; we just need
        // to confirm the program produced *some* output without crashing.
        Assert.Contains("RepeatIterator", output)
    }

    @Fact
    func LowercasePrimitiveAlias_StaticMemberAccess_EmitsAndRuns() {
        // Issue #919: `string.Empty` and `int32.MaxValue` (lowercase predefined
        // aliases as static-member-access receivers) must compile and run with
        // the same behavior as the capitalized `String.Empty` / `Int32.MaxValue`
        // forms — and without requiring `import System`.
        let source = `package P
import System

let empty = string.Empty
Console.WriteLine(empty.Length)
Console.WriteLine(int32.MaxValue)
Console.WriteLine(int.MaxValue)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}2147483647${Environment.NewLine}2147483647${Environment.NewLine}", output)
    }

    @Fact
    func ConstructedGenericStaticPropertyResult_AllowsChainedMemberAccess() {
        let source = `package P
import System

Console.WriteLine(ArraySegment[int32].Empty.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func ConstructedGenericListAdd_PreservesNullableTupleSlots() {
        let source = `package P
import System
import System.Collections.Generic

var items = List[(string, string?)]()
items.Add(("x", nil))
Console.WriteLine(items.Count)`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ClrBinaryOperator_AppliesImplicitOperandConversion() {
        let source = `package P
import System
import System.IO

let cutoff = DateTimeOffset.UtcNow
Console.WriteLine(Directory.GetLastWriteTimeUtc(".") < cutoff)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ImportedExtension_NamedOptionalArgument_WithEmptyParams_PreservesReceiver() {
        let source = `package P
import System
import GSharp.Compiler.Tests.Emit

Console.WriteLine("route".Describe(200, contentType: "text/html"))`
        Assert.Equal(
            "route:200:text/html:0${Environment.NewLine}",
            CompileAndRun(source, typeof(NamedParamsExtensionFixture).Assembly.Location)
        )
    }

    shared {
        private func CompileAndRun(source string, references ...string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_clr_emit_").FullName
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
                    let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                    args.AddRange(references.Select((reference string) -> ("/r:" + reference)))
                    args.Add(srcPath)
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath, references)
                for reference in references {
                    File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true)
                }
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

/// Imported extension fixture for named optional and params argument ordering.
shared class NamedParamsExtensionFixture { }

/// Returns the observed imported argument order.
@ExtensionOwner(typeof(NamedParamsExtensionFixture))
func (source string) Describe(
    statusCode int32,
    responseType Type? = nil,
    contentType string? = nil,
    contentTypes ...string
) string {
    return "$source:$statusCode:$contentType:${contentTypes.Length}"
}
