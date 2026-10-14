// <copyright file="Issue2403MethodCallVsImportedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2403: compiled (gsc emit + IL verify + execute) coverage for the
/// call-vs-imported-type precedence fix in
/// (cref:OverloadResolver.BindCallExpression).
/// A user/same-compilation method (or implicit-`this` instance method)
/// whose name collides with an imported CLR type (e.g.
/// `System.Net.Http.HttpClient`) must be preferred over that type's
/// constructor/conversion fallbacks — both at bind time and in the emitted IL
/// that actually runs.
open class Issue2403MethodCallVsImportedTypeEmitTests {
    @Fact
    func PrivateInstanceMethod_ClassArgument_ImportedClrTypeCollision_CompilesAndRuns() {
        let source = `package p
import System
import System.Text

class Profile { var Name string }

class Service {
    private func StringBuilder(profile Profile) string {
        return "user:" + profile.Name
    }

    func Run(profile Profile) string {
        return StringBuilder(profile)
    }
}

var svc = Service{}
Console.WriteLine(svc.Run(Profile{Name: "abc"}))`
        let output = CompileAndRun(source)
        Assert.Equal("user:abc${Environment.NewLine}", output)
    }

    @Fact
    func MultiArgument_ImportedClrTypeCollision_CompilesAndRuns() {
        // Control: StringBuilder also has a two-argument constructor
        // (`StringBuilder(string, int32)`); a two-argument user method with
        // the same name must still win at the emitted-IL level.
        let source = `package p
import System
import System.Text

class Profile { var Name string }

class Service {
    private func StringBuilder(a Profile, b Profile) string {
        return a.Name + "-" + b.Name
    }

    func Run(a Profile, b Profile) string {
        return StringBuilder(a, b)
    }
}

var svc = Service{}
Console.WriteLine(svc.Run(Profile{Name: "x"}, Profile{Name: "y"}))`
        let output = CompileAndRun(source)
        Assert.Equal("x-y${Environment.NewLine}", output)
    }

    @Fact
    func ExactOahuCoreShape_AuthorizeHttpClient_CompilesAndRuns() {
        // The exact Oahu.Core Authorize shape: `import System.Net.Http`
        // brings the CLR `HttpClient` type into scope; `Authorize` declares a
        // private instance method named `HttpClient` taking an `IProfile` and
        // returning a nullable `IProfile`, invoked across four call sites
        // through implicit `this`.
        let source = `package p
import System
import System.Net.Http

interface IProfile {
    prop Authorization string { get; }
}

class Profile : IProfile {
    prop Authorization string { get; set; }
}

class Authorize {
    private func HttpClient(profile IProfile) IProfile? {
        return profile
    }

    func Run(a IProfile, b IProfile, c IProfile, d IProfile) IProfile? {
        let x = HttpClient(a)
        let y = HttpClient(b)
        let z = HttpClient(c)
        return HttpClient(d)
    }
}

var auth = Authorize{}
var p = Profile{Authorization: "tok"}
var result = auth.Run(p, p, p, p)
Console.WriteLine(result?.Authorization)`
        let output = CompileAndRun(source)
        Assert.Equal("tok${Environment.NewLine}", output)
    }

    @Fact
    func GenuineConstructorControl_NoUserMethod_StillConstructsClrTypeAndRuns() {
        // Guardrail: with no colliding user method, `StringBuilder(16)` must
        // still emit and run as the real CLR constructor call.
        let source = `package p
import System
import System.Text

var sb = StringBuilder(16)
Console.WriteLine(sb.Capacity)`
        let output = CompileAndRun(source)
        Assert.Equal("16${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2403_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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
                } catch { }
            }
        }
    }
}
