// <copyright file="Issue1103ExtensionInstanceCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1103: a receiver-clause extension function (ADR-0019) whose receiver
/// type is an imported/BCL or primitive CLR type must be invokable with
/// instance/member syntax (`receiver.Ext(args)`), not only as a free
/// function (`Ext(receiver, args)`).
///
/// The defect had two causes. (1) Extension functions are flattened into
/// `BoundGlobalScope.Functions` so free-call syntax resolves them, but the
/// follow-up body-binding pass rebuilt its lookup scope without re-registering
/// them as extensions, so `BoundScope.TryLookupExtensionFunction` found
/// nothing inside function/method bodies. (2) Even when present, the receiver
/// match used reference equality on the receiver type symbol, which fails for
/// imported CLR types because the declaration-site and call-site symbols are
/// distinct `ImportedTypeSymbol` instances wrapping the same CLR type. Both
/// made member-syntax calls report `GS0159 Cannot find function` while the
/// equivalent free-call form bound fine.
///
/// These tests prove that instance-syntax extension calls on a BCL type
/// (`System.Text.StringBuilder`) and on a primitive (`int32`) compile,
/// IL-verify, and produce the correct runtime results from inside class methods,
/// free functions, and top-level statements.
open class Issue1103ExtensionInstanceCallEmitTests {
    @Fact
    func Int32Extension_InstanceSyntax_InsideClassMethod() {
        let source = `package P
import System

func (n int32) Doubled() int32 {
    return n * 2
}

class Calc {
    func Run(x int32) int32 {
        return x.Doubled()
    }
}

let c = Calc()
Console.WriteLine(c.Run(21))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func BclExtension_InstanceSyntax_InsideFreeFunction() {
        // StringBuilder is an imported BCL type: the declaration-site and
        // call-site receiver symbols are distinct ImportedTypeSymbol instances,
        // so the receiver match must be structural (CLR-type identity).
        let source = `package P
import System
import System.Text

func (sb StringBuilder) AppendBang() StringBuilder {
    return sb.Append("!")
}

func buildShout(word string) string {
    let sb = StringBuilder()
    sb.Append(word)
    sb.AppendBang()
    sb.AppendBang()
    return sb.ToString()
}

Console.WriteLine(buildShout("hi"))`
        let output = CompileAndRun(source)
        Assert.Equal("hi!!${Environment.NewLine}", output)
    }

    @Fact
    func Int32Extension_InstanceSyntax_AtTopLevel() {
        let source = `package P
import System

func (n int32) Tripled() int32 {
    return n * 3
}

let x int32 = 14
Console.WriteLine(x.Tripled())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Extension_FreeCallForm_Control_StillCompiles() {
        // Control: the same extension invoked as a free function must keep
        // working (this path always bound; it must not regress).
        let source = `package P
import System

func (n int32) Doubled() int32 {
    return n * 2
}

func compute(x int32) int32 {
    return Doubled(x)
}

Console.WriteLine(compute(21))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func BclAndPrimitiveExtensions_InstanceSyntax_InOneProgram() {
        // Instance-call forms of imported and primitive receiver extensions all
        // bind and run within the same compilation, from class-method bodies.
        let source = `package P
import System
import System.Text

func (sb StringBuilder) AppendBang() StringBuilder {
    return sb.Append("!")
}

func (n int32) Doubled() int32 {
    return n * 2
}

class Worker {
    func Shout(word string) string {
        let sb = StringBuilder()
        sb.Append(word)
        return sb.AppendBang().ToString()
    }

    func Twice(n int32) int32 {
        return n.Doubled()
    }
}

let w = Worker()
Console.WriteLine(w.Shout("go"))
Console.WriteLine(w.Twice(50))`
        let output = CompileAndRun(source)
        Assert.Equal("go!${Environment.NewLine}100${Environment.NewLine}", output)
    }

    @Fact
    func OwnedAndEnumReceivers_BindAsExtensions_Run() {
        let source = `package P
import System

enum Color { Red, Green }

class Box {
    var Value int32
}

func (color Color) Describe() string {
    return color.ToString()
}

func (color Color) Echo[T](value T) T {
    return value
}

func (box Box) Describe() string {
    return box.Value.ToString()
}

func (box Box) Describe(prefix string) string {
    return prefix + box.Value.ToString()
}

func (box Box) Echo[T](value T) T {
    return value
}

var pickCount = 0

func PickColor(pick bool) Color? {
    pickCount++
    if pick {
        return Color.Green
    }

    return nil
}

let color = Color.Red
let describe () -> string = color.Describe
let echo (string) -> string = color.Echo
let box = Box{Value: 7}
var current = box
let ownedDescribe () -> string = current.Describe
current = Box{Value: 9}
Console.WriteLine(PickColor(true)?.Describe())
Console.WriteLine(pickCount)
Console.WriteLine(describe())
Console.WriteLine(box.Describe())
Console.WriteLine(box.Describe("v="))
Console.WriteLine(box.Echo("generic"))
Console.WriteLine(echo("method-group"))
Console.WriteLine(ownedDescribe())`
        let output = CompileAndRun(source)
        Assert.Equal(
            "Green${Environment.NewLine}1${Environment.NewLine}Red${Environment.NewLine}7${Environment.NewLine}v=7${Environment.NewLine}generic${Environment.NewLine}method-group${Environment.NewLine}7${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1103_emit_").FullName
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
