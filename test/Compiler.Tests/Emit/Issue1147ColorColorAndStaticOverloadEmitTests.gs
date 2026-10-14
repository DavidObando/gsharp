// <copyright file="Issue1147ColorColorAndStaticOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1147: end-to-end emit + runtime validation that unified instance +
/// static (`shared`) overload resolution selects — and runs — the correct
/// overload for both facets:
/// - Facet A — the "Color Color" rule: a member-access receiver naming both a value and a same-named
/// type binds the INSTANCE overload when applicable.
/// - Facet B — a bare unqualified call inside an instance method resolves against the combined instance
/// + static overload set and dispatches the STATIC overload when that is the applicable one.
/// Each body returns a distinguishable sentinel so the runtime result proves
/// which overload was selected.
open class Issue1147ColorColorAndStaticOverloadEmitTests {
    @Fact
    func FacetA_ColorColor_SelectsInstanceOverload_AtRuntime() {
        let source = `package p
import System
class Tag { }
class AppleListBox {
    func GetTagString(name string) string? { return "instance:" + name }
    shared {
        func GetTagString(tagBox Tag?) string? { return "static" }
    }
}
class Owner {
    prop AppleListBox AppleListBox {
        get { return AppleListBox() }
    }
    func Title() string? {
        return AppleListBox.GetTagString("title")
    }
}
var o = Owner()
Console.WriteLine(o.Title())`
        Assert.Equal("instance:title${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FacetA_ColorColor_SelectsStaticOverload_AtRuntime() {
        // Passing a `Tag?` makes the static overload the only applicable one, so
        // the static body must run even though the receiver is the property value.
        let source = `package p
import System
class Tag { }
class AppleListBox {
    func GetTagString(name string) string? { return "instance:" + name }
    shared {
        func GetTagString(tagBox Tag?) string? { return "static" }
    }
}
class Owner {
    prop AppleListBox AppleListBox {
        get { return AppleListBox() }
    }
    func MakeTag() Tag? { return nil }
    func Title() string? {
        return AppleListBox.GetTagString(MakeTag())
    }
}
var o = Owner()
Console.WriteLine(o.Title())`
        Assert.Equal("static${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FacetB_UnqualifiedCall_SelectsStaticOverload_AtRuntime() {
        // The instance `GetTagString(string)` body calls the bare unqualified
        // `GetTagString(...)` with a `Tag?`; unified resolution must pick the
        // static overload, so the static sentinel is returned at runtime.
        let source = `package p
import System
class Tag { }
class Box {
    func GetTagString(name string) string? {
        return GetTagString(GetTagBox(name))
    }
    func GetTagBox(name string) Tag? { return nil }
    shared {
        func GetTagString(tagBox Tag?) string? { return "static-overload" }
    }
}
var b = Box()
Console.WriteLine(b.GetTagString("x"))`
        Assert.Equal("static-overload${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FacetB_UnqualifiedCall_SelectsInstanceOverload_AtRuntime() {
        // The same combined group with a `string` argument must run the INSTANCE
        // overload.
        let source = `package p
import System
class Tag { }
class Box {
    func Probe() string? {
        return GetTagString("name")
    }
    func GetTagString(name string) string? { return "instance:" + name }
    shared {
        func GetTagString(tagBox Tag?) string? { return "static" }
    }
}
var b = Box()
Console.WriteLine(b.Probe())`
        Assert.Equal("instance:name${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1147_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
