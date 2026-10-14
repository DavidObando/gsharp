// <copyright file="Issue1410NullableDelegatePropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit
import Xunit.Sdk

/// Issues #1410 and #2772: null-conditional delegate invocation must capture
/// the receiver once and skip both argument evaluation and Invoke when null.
open class Issue1410NullableDelegatePropertyEmitTests {
    @Fact
    func NullableVoidDelegateProperty_NullConditionalInvoke_LoadsGetterAndExecutesWhenPresent() {
        let source = `package P
import System

class C {
    prop H ((int32)->void)? { get; set }

    func Set() {
        H = (x int32) -> Console.WriteLine(x + 1)
    }

    func Raise(x int32) {
        H?(x)
    }
}

let c = C()
c.Raise(100)
c.Set()
c.Raise(41)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableValueReturningDelegateProperty_NullConditionalInvoke_ReturnsNullableValue() {
        let source = `package P
import System

class C {
    prop H ((int32)->int32)? { get; set }

    func Set() {
        H = (x int32) -> x * 2
    }

    func Run(x int32) int32? {
        return H?(x)
    }
}

let empty = C()
Console.WriteLine(empty.Run(21) == nil)

let c = C()
c.Set()
Console.WriteLine(c.Run(21))`
        Assert.Equal("True${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func QualifiedDelegateProperty_NullConditionalInvoke_EvaluatesGetterAndArgumentsExactlyOnce() {
        let source = `package P
import System

var argumentCalls = 0
func Argument() int32 {
    argumentCalls = argumentCalls + 1
    return 21
}

class Box {
    var reads int32
    var calls int32
    var stored ((int32) -> int32)?

    prop Transform ((int32) -> int32)? {
        get {
            reads = reads + 1
            return stored
        }
        set { stored = value }
    }

    func Install() {
        Transform = (x int32) -> {
            calls = calls + 1
            return x * 2
        }
    }
}

let box = Box()
Console.WriteLine(box.Transform?(Argument()) ?? -1)
Console.WriteLine("${box.reads}:${argumentCalls}:${box.calls}")

box.Install()
Console.WriteLine(box.Transform?(Argument()) ?? -1)
Console.WriteLine("${box.reads}:${argumentCalls}:${box.calls}")`
        Assert.Equal(
            "-1${Environment.NewLine}1:0:0${Environment.NewLine}42${Environment.NewLine}2:1:1${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableStructuralNamedAndImportedDelegateLocals_ShortCircuitAndInvoke() {
        let source = `package P
import System

delegate Getter() string;

func NamedValue() string -> "named"

class Box {
    prop Named Getter? { get; set; }
    prop Imported Func[int32]? { get; set; }
}

let structuralMissing (() -> int32)? = nil
let structuralPresent (() -> int32)? = () -> 7
Console.WriteLine(structuralMissing?() ?? -1)
Console.WriteLine(structuralPresent?() ?? -1)

let namedMissing Getter? = nil
let namedValue Getter = NamedValue
let namedPresent Getter? = namedValue
Console.WriteLine(namedMissing?() ?? "missing")
Console.WriteLine(namedPresent?() ?? "missing")

let importedMissing Func[int32]? = nil
let importedPresent Func[int32]? = () -> 9
Console.WriteLine(importedMissing?() ?? -1)
Console.WriteLine(importedPresent?() ?? -1)

let box = Box()
Console.WriteLine(box.Named?() ?? "property-missing")
Console.WriteLine(box.Imported?() ?? -1)
box.Named = namedValue
box.Imported = () -> 11
Console.WriteLine(box.Named?() ?? "property-missing")
Console.WriteLine(box.Imported?() ?? -1)`
        Assert.Equal(
            "-1${Environment.NewLine}7${Environment.NewLine}missing${Environment.NewLine}named${Environment.NewLine}-1${Environment.NewLine}9${Environment.NewLine}property-missing${Environment.NewLine}-1${Environment.NewLine}named${Environment.NewLine}11${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableVoidAndReferenceReturningDelegateProperties_ShortCircuit() {
        let source = `package P
import System

class Box {
    prop Notify ((string) -> void)? { get; set }
    prop Text (() -> string)? { get; set }
}

let empty = Box()
empty.Notify?("skipped")
Console.WriteLine(empty.Text?() ?? "fallback")

let full = Box()
full.Notify = (value string) -> Console.WriteLine(value)
full.Text = () -> "value"
full.Notify?("called")
Console.WriteLine(full.Text?() ?? "fallback")`
        Assert.Equal(
            "fallback${Environment.NewLine}called${Environment.NewLine}value${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableReferenceReturningDelegateProperty_PlainCallReportsNullableReceiver() {
        const source = `package P

class Box {
    prop Text (() -> string)? { get; set }
}

func Main() {
    let empty = Box()
    empty.Text()
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let diagnostic = Assert.Single(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0503", diagnostic.Id)
        Assert.Equal("Text", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NullableDelegateProperty_InAsyncContext_ShortCircuitsAndInvokes() {
        let source = `package P
import System
import System.Threading.Tasks

class Options {
    prop ActivityVerb (() -> string)? { get; set; }
}

async func Read(options Options) string {
    await Task.Delay(1)
    return options.ActivityVerb?() ?? "idle"
}

let empty = Options()
let full = Options()
full.ActivityVerb = () -> "busy"
Console.WriteLine(Read(empty).GetAwaiter().GetResult())
Console.WriteLine(Read(full).GetAwaiter().GetResult())`
        Assert.Equal("idle${Environment.NewLine}busy${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue1410_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
