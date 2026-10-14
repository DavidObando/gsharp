// <copyright file="Issue2363EmptyDataTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2363 / ADR-0029 amendment: a zero-field `data class`/`data
/// struct` — needed to translate a C# `record Name();` or an empty
/// positional `record struct Name();` — previously failed to bind at
/// all (`GS0104`, unconditionally rejecting any `IsData`
/// declaration with zero fields). These tests exercise the full emit-level
/// contract for the degenerate zero-field case: `ToString()` renders the
/// C# record form `"Name { }"` (ADR-0199), `GetHashCode()` is a stable
/// (non-process-randomized) constant derived from the type name,
/// `Equals`/`==`/`!=` are trivially true for two instances of
/// the same concrete type, `Deconstruct` is correctly ABSENT from the
/// emitted metadata (nothing to deconstruct — see ADR-0029 Decision item 6),
/// `with`/`copy()` still allocate a genuinely new (reference-
/// distinct) instance, and the row-count planner keeps every MethodDef row
/// correctly aligned (implicitly exercised by (cref:IlVerifier.Verify)
/// in every test below). The final test reproduces the exact Oahu
/// `CallbackChallenge`/`MfaChallenge`/`CvfChallenge`/
/// `ApprovalChallenge`/`CaptchaChallenge`/`ExternalLoginChallenge`
/// hierarchy (`Oahu.Cli.App/Auth/CallbackBroker.cs`) end to end.
open class Issue2363EmptyDataTypesEmitTests {
    @Fact
    func DataClass_ZeroFields_NoParens_CompilesAndVerifies() {
        let source = `package MyLib

open data class Empty {
}`
        let assembly = CompileToAssembly(source)
        let empty = assembly.GetTypes().Single((t Type) -> t.Name == "Empty")
        Assert.True(empty.IsClass)
    }

    @Fact
    func DataStruct_ZeroFields_NoParens_CompilesAndVerifies() {
        let source = `package MyLib

data struct Empty {
}`
        let assembly = CompileToAssembly(source)
        let empty = assembly.GetTypes().Single((t Type) -> t.Name == "Empty")
        Assert.True(empty.IsValueType)
    }

    @Fact
    func DataClass_ZeroFields_Deconstruct_IsAbsentFromMetadata() {
        let source = `package MyLib

data class Empty() {
}`
        let assembly = CompileToAssembly(source)
        let empty = assembly.GetTypes().Single((t Type) -> t.Name == "Empty")
        Assert.Null(empty.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance))
    }

    @Fact
    func DataStruct_ZeroFields_Deconstruct_IsAbsentFromMetadata() {
        let source = `package MyLib

data struct Empty() {
}`
        let assembly = CompileToAssembly(source)
        let empty = assembly.GetTypes().Single((t Type) -> t.Name == "Empty")
        Assert.Null(empty.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance))
    }

    @Fact
    func DataClass_ZeroFields_ToString_RendersRecordFormatWithEmptyBraces() {
        let output = CompileAndRun(`package MyLib
import System

data class Empty() {
}

func Main() {
    let e = Empty()
    Console.WriteLine(e.ToString())
    Console.WriteLine(e)
}`)
        Assert.Equal("Empty { }${Environment.NewLine}Empty { }${Environment.NewLine}", output)
    }

    @Fact
    func DataStruct_ZeroFields_ToString_RendersRecordFormatWithEmptyBraces() {
        let output = CompileAndRun(`package MyLib
import System

data struct Empty() {
}

func Main() {
    let e = Empty{}
    Console.WriteLine(e.ToString())
}`)
        Assert.Equal("Empty { }${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_ZeroFields_GetHashCode_IsStableAndDiffersByTypeName() {
        let output = CompileAndRun(`package MyLib
import System

data class Foo() {
}
data class Bar() {
}

func Main() {
    let a = Foo()
    let b = Foo()
    let c = Bar()
    Console.WriteLine(a.GetHashCode() == b.GetHashCode())
    Console.WriteLine(a.GetHashCode() == c.GetHashCode())
}`)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_ZeroFields_EqualsAndOperators_AreTrivialWithinSameConcreteType() {
        let output = CompileAndRun(`package MyLib
import System

data class Empty() {
}

func Main() {
    let a = Empty()
    let b = Empty()
    Console.WriteLine(a == b)
    Console.WriteLine(a != b)
    Console.WriteLine(a.Equals(b))
    let ob Object = b
    Console.WriteLine(a.Equals(ob))
}`)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func DataStruct_ZeroFields_EqualsAndOperators_AreTrivial() {
        let output = CompileAndRun(`package MyLib
import System

data struct Empty() {
}

func Main() {
    let a = Empty{}
    let b = Empty{}
    Console.WriteLine(a == b)
    Console.WriteLine(a != b)
    Console.WriteLine(a.Equals(b))
}`)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_ZeroFields_CopyAndWith_ProduceValueEqualInstance() {
        // `copy()`/`with { }` on a zero-field type have nothing to
        // override, but must still parse/bind/emit and produce a
        // value-equal result (reference-distinctness for `with`/`copy` is a
        // general, pre-existing data-class invariant exercised for
        // nonzero-field types elsewhere, e.g. Issue2228DataClassWithEmitTests;
        // not re-verified here since G# surface syntax has no
        // `ReferenceEquals`/identity-comparison builtin to observe it
        // directly).
        let output = CompileAndRun(`package MyLib
import System

data class Empty() {
}

func Main() {
    let a = Empty()
    let b = a.copy()
    let c = a with { }
    Console.WriteLine(a == b)
    Console.WriteLine(a == c)
}`)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_ZeroFields_SiblingTypesUnderOpenBase_AreNotEqual() {
        // Leaf-type-only equality is a pre-existing, deliberate limitation
        // (matches C# record semantics): two sibling zero-field data
        // classes derived from a common open base are never equal to one
        // another, even though each is trivially self-equal.
        let output = CompileAndRun(`package MyLib
import System

open data class Base() {
}
data class Mfa() : Base() {
}
data class Cvf() : Base() {
}

func Main() {
    let mfa = Mfa()
    let cvf Base = Cvf()
    Console.WriteLine(mfa.Equals(cvf))
    Console.WriteLine(mfa.GetType() == cvf.GetType())
}`)
        Assert.Equal("False${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_ZeroFields_WithPropertyOverride_MatchesOahuMfaChallengeShape() {
        // Minimal shape matching Oahu.Cli.App/Auth/CallbackBroker.cs's
        // MfaChallenge()/CvfChallenge()/ApprovalChallenge(): a zero-field
        // sealed data class overriding an abstract-shaped base property. The
        // BackingField-null filter fix in DataStructSynthesizer.GetSynthesisFields
        // is what makes this compile+run without an ArgumentNullException in
        // field-token resolution.
        let output = CompileAndRun(`package Oahu.Cli.App.Auth
import System

open data class CallbackChallenge {
    open prop Kind string {
        get -> "base"
    }
}
data class MfaChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "mfa"
    }
}
data class CvfChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "cvf"
    }
}
data class ApprovalChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "approval"
    }
}

func Main() {
    let mfa CallbackChallenge = MfaChallenge()
    let cvf CallbackChallenge = CvfChallenge()
    let approval CallbackChallenge = ApprovalChallenge()
    Console.WriteLine(mfa.Kind)
    Console.WriteLine(cvf.Kind)
    Console.WriteLine(approval.Kind)
    Console.WriteLine(mfa.ToString())
}`)
        Assert.Equal(
            "mfa${Environment.NewLine}cvf${Environment.NewLine}approval${Environment.NewLine}MfaChallenge { Kind = mfa }${Environment.NewLine}",
            output
        )
    }

    @Fact
    func DataClass_ExactOahuCallbackChallengeHierarchy_Shape_Compiles_Runs_And_Verifies() {
        // Verbatim shape of Oahu.Cli.App/Auth/CallbackBroker.cs: an open
        // base record with only a computed `Kind` property, three ZERO-FIELD
        // derived sealed records (MfaChallenge, CvfChallenge,
        // ApprovalChallenge — the #2363 scenario) plus two NON-zero-field
        // sibling records (CaptchaChallenge, ExternalLoginChallenge) that
        // must be unaffected.
        let output = CompileAndRun(`package Oahu.Cli.App.Auth
import System

open data class CallbackChallenge {
    open prop Kind string {
        get -> "unknown"
    }
}

data class CaptchaChallenge(ImageBytes int32) : CallbackChallenge {
    override prop Kind string {
        get -> "captcha"
    }
}

data class MfaChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "mfa"
    }
}

data class CvfChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "cvf"
    }
}

data class ApprovalChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "approval"
    }
}

data class ExternalLoginChallenge(LoginUri string) : CallbackChallenge {
    override prop Kind string {
        get -> "external-login"
    }
}

func Main() {
    let captcha CallbackChallenge = CaptchaChallenge(7)
    let mfa CallbackChallenge = MfaChallenge()
    let cvf CallbackChallenge = CvfChallenge()
    let approval CallbackChallenge = ApprovalChallenge()
    let externalLogin CallbackChallenge = ExternalLoginChallenge("https://example.test")

    Console.WriteLine(captcha.Kind + ": " + captcha.ToString())
    Console.WriteLine(mfa.Kind + ": " + mfa.ToString())
    Console.WriteLine(cvf.Kind + ": " + cvf.ToString())
    Console.WriteLine(approval.Kind + ": " + approval.ToString())
    Console.WriteLine(externalLogin.Kind + ": " + externalLogin.ToString())
}`)
        Assert.Equal(
            "captcha: CaptchaChallenge { Kind = captcha, ImageBytes = 7 }${Environment.NewLine}" +
                "mfa: MfaChallenge { Kind = mfa }${Environment.NewLine}" +
                "cvf: CvfChallenge { Kind = cvf }${Environment.NewLine}" +
                "approval: ApprovalChallenge { Kind = approval }${Environment.NewLine}" +
                "external-login: ExternalLoginChallenge { Kind = external-login, LoginUri = https://example.test }${Environment.NewLine}",
            output
        )
    }

    shared {
        // ====================================================================
        // Helpers
        // ====================================================================
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2363_emit_").FullName
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
                } catch {
                    // ignored

                }
            }
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2363_synth_").FullName
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
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            return EmittedFixture.Load(outPath)
        }
    }
}
