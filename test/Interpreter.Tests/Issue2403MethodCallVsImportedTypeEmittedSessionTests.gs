// <copyright file="Issue2403MethodCallVsImportedTypeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #2403: Emitted-session coverage for method call vs imported type.
open class Issue2403MethodCallVsImportedTypeEmittedSessionTests {
    @Fact
    func PrivateInstanceMethod_ClassArgument_ImportedClrTypeCollision_ExecutesUserMethod() {
        let source = `import System.Text

class Profile {
    var Name string
}

class Service {
    private func StringBuilder(profile Profile) string {
        return "user:" + profile.Name
    }

    func Run(profile Profile) string {
        return StringBuilder(profile)
    }
}

var svc = Service{}
svc.Run(Profile{Name: "abc"})`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("user:abc", output)
    }

    @Fact
    func ZeroArgument_ImportedClrTypeCollision_ExecutesUserMethod() {
        let source = `import System.Text

class Service {
    func StringBuilder() string {
        return "user-zero-arg"
    }

    func Run() string {
        return StringBuilder()
    }
}

var svc = Service{}
svc.Run()`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("user-zero-arg", output)
    }

    @Fact
    func MultiArgument_ImportedClrTypeCollision_ExecutesUserMethod() {
        let source = `import System.Text

class Profile {
    var Name string
}

class Service {
    private func StringBuilder(a Profile, b Profile) string {
        return a.Name + "-" + b.Name
    }

    func Run(a Profile, b Profile) string {
        return StringBuilder(a, b)
    }
}

var svc = Service{}
svc.Run(Profile{Name: "x"}, Profile{Name: "y"})`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("x-y", output)
    }

    @Fact
    func GenuineConstructorControl_NoUserMethod_StillConstructsClrTypeAtRuntime() {
        // Guardrail: with no colliding user method, `StringBuilder(16)` must
        // still construct the real CLR StringBuilder at runtime.
        let source = `import System.Text

let sb = StringBuilder(16)
sb.Capacity`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("16", output)
    }

    @Fact
    func ExactOahuCoreShape_AuthorizeHttpClient_ExecutesUserMethodAtRuntime() {
        // The exact Oahu.Core Authorize shape: a private instance method named
        // `HttpClient` colliding with the imported `System.Net.Http.HttpClient`
        // CLR type, invoked through implicit `this` across four call sites,
        // returning a nullable `IProfile`.
        let source = `import System.Net.Http

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
result?.Authorization`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("tok", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}
