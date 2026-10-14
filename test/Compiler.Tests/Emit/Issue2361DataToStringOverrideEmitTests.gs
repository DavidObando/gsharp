// <copyright file="Issue2361DataToStringOverrideEmitTests.cs" company="GSharp">
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
import System.Collections.Generic
import Xunit.Sdk

/// Issue #2361 / ADR-0029 follow-up: a data class/struct's hand-written
/// `ToString` — when its shape exactly matches
/// `public ToString() string` — suppresses/replaces the synthesized
/// ToString instead of being rejected with GS0232. This means:
/// - `DataStructSynthesizer.EmitDataStructSynthesizedMembers` skips `EmitDataStructToString` and the
/// user's own method (already present in `structSymbol.Methods`) is emitted instead — so exactly ONE
/// `ToString()` MethodDef exists on the type, not two.
/// - `ReflectionMetadataEmitter`'s method-row planner reserves 6 synthesized rows (not 7) when a
/// compatible user ToString is present.
/// - The user ToString gets the SAME Virtual/NewSlot/Final CLR attribute treatment as the other
/// synthesized members — no NewSlot (so it reuses/participates in the correct vtable slot for TRUE
/// polymorphic override dispatch through a base-typed reference, unlike a plain non-data class's
/// hand-written ToString), and no redundant Final bit when the containing TypeDef already prevents
/// derivation.
/// These tests exercise the real-world `Oahu.Core.ProfileKey` /
/// `Oahu.Core.ProfileKeyEx` (open data class, derived class chaining
/// `base.ToString()`) and `Oahu.Cli.Tui.Tokens.SemanticColor`
/// (data struct, expression-bodied ToString) shapes verbatim (field names,
/// types, and ToString bodies translated 1:1 from the C# source) plus
/// negative/ambiguity controls for incompatible shapes and the other five
/// still-forbidden synthesized names.
open class Issue2361DataToStringOverrideEmitTests {
    @Fact
    func DataClass_CompatibleToString_EmitsExactlyOneToStringMethod() {
        let source = `package MyLib
import System

open data class Point(X int32, Y int32) {
    func ToString() string -> "custom"
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let toStringMethods = point
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where((m MethodInfo) -> m.Name == "ToString" && m.GetParameters().Length == 0)
            .ToArray()
        Assert.Single(toStringMethods)
        let instance object? = Activator.CreateInstance(point, 1, 2)
        Assert.Equal("custom", instance!!.ToString())
    }

    @Fact
    func DataStruct_CompatibleToString_EmitsExactlyOneToStringMethod() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32

    func ToString() string -> "custom"
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let toStringMethods = point
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where((m MethodInfo) -> m.Name == "ToString" && m.GetParameters().Length == 0)
            .ToArray()
        Assert.Single(toStringMethods)
        let instance object? = Activator.CreateInstance(point)
        Assert.Equal("custom", instance!!.ToString())
    }

    @Fact
    func DataClass_Open_CompatibleToString_IsVirtualNotFinalNotNewSlot() {
        // ADR-0029's own synthesized ToString never sets NewSlot (ReuseSlot
        // is the CLR default) and is Final only when the type is NOT open —
        // the user override must get identical treatment so a derived open
        // data class can re-override it.
        let source = `package MyLib
import System

open data class Point(X int32, Y int32) {
    func ToString() string -> "custom"
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let toString MethodInfo? = point.GetMethod(
            "ToString",
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
            nil,
            Type.EmptyTypes,
            nil
        )
        Assert.NotNull(toString)
        Assert.True(toString!!.IsVirtual)
        Assert.False(toString!!.IsFinal)
        Assert.False((toString!!.Attributes & MethodAttributes.NewSlot) == MethodAttributes.NewSlot)
    }

    @Fact
    func DataClass_NotOpen_CompatibleToString_OmitsRedundantFinal() {
        let source = `package MyLib
import System

data class Point(X int32, Y int32) {
    func ToString() string -> "custom"
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let toString MethodInfo? = point.GetMethod(
            "ToString",
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
            nil,
            Type.EmptyTypes,
            nil
        )
        Assert.NotNull(toString)
        Assert.True(toString!!.IsVirtual)
        Assert.False(toString!!.IsFinal)
    }

    @Fact
    func DataStruct_CompatibleToString_IsVirtualWithoutRedundantFinal() {
        // Structs are never open, so the containing TypeDef already prevents
        // derivation and the override does not need a redundant Final flag.
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32

    func ToString() string -> "custom"
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let toString MethodInfo? = point.GetMethod(
            "ToString",
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
            nil,
            Type.EmptyTypes,
            nil
        )
        Assert.NotNull(toString)
        Assert.True(toString!!.IsVirtual)
        Assert.False(toString!!.IsFinal)
    }

    @Fact
    func DataClass_DerivedOverridesToStringAgain_TrulyPolymorphicThroughBaseReference() {
        // Confirms REAL CLR override dispatch (not merely direct-call
        // precedence): a base-typed reference to a derived instance must
        // invoke the derived ToString via callvirt, and the derived
        // ToString's `base.ToString()` call must reach the base's (also
        // user-declared) ToString.
        let source = `package P
import System

open data class Base2361(Name string) {
    func ToString() string -> "base:" + Name
}
open data class Derived2361(Name string, Extra string) : Base2361(Name) {
    func ToString() string -> base.ToString() + ":" + Extra
}

func Main() {
    let d = Derived2361("n", "x")
    Console.WriteLine(d.ToString())

    let baseRef Base2361 = d
    Console.WriteLine(baseRef.ToString())
}`
        let output = CompileAndRun(source)
        Assert.Equal("base:n:x${Environment.NewLine}base:n:x${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_ExactOahuProfileKeyProfileKeyEx_Shape_Compiles_Runs_And_Verifies() {
        // Verbatim translation of Oahu.Core.Records.ProfileKey /
        // ProfileKeyEx (Oahu.Core/Records.cs):
        //   public record ProfileKey(uint Id, ERegion Region, string AccountId) : IProfileKey
        //   {
        //       public override string ToString() =>
        //           $"{GetType().Name} {nameof(Id)}={Id}, {nameof(Region)}={Region}, {nameof(AccountId)}=#<...>";
        //   }
        //   public record ProfileKeyEx(uint Id, ERegion Region, string AccountName, string AccountId, string DeviceName) :
        //       ProfileKey(Id, Region, AccountId), IProfileKeyEx
        //   {
        //       public override string ToString() =>
        //           $"{base.ToString()}, {nameof(AccountName)}=..., {nameof(DeviceName)}=...";
        //   }
        // (Checksum32 calls dropped — irrelevant to the ToString-override
        // mechanism under test; field names/nesting/base-chaining kept 1:1.)
        let source = `package Oahu.Core
import System

enum ERegion {
    Us,
    Eu
}

open data class ProfileKey(Id uint32, Region ERegion, AccountId string) {
    func ToString() string -> "ProfileKey Id=" + Id.ToString() + ", Region=" + Region.ToString() + ", AccountId=" + AccountId
}

open data class ProfileKeyEx(Id uint32, Region ERegion, AccountName string, AccountId string, DeviceName string) : ProfileKey(Id, Region, AccountId) {
    func ToString() string -> base.ToString() + ", AccountName=" + AccountName + ", DeviceName=" + DeviceName
}

func Main() {
    let key = ProfileKeyEx(1, ERegion.Us, "acct-name", "acct-id", "device-1")
    Console.WriteLine(key.ToString())

    let baseKey ProfileKey = key
    Console.WriteLine(baseKey.ToString())
}`
        let output = CompileAndRun(source)
        const expected = "ProfileKey Id=1, Region=Us, AccountId=acct-id, AccountName=acct-name, DeviceName=device-1"
        Assert.Equal(expected + Environment.NewLine + expected + Environment.NewLine, output)
    }

    @Fact
    func DataStruct_ExactOahuSemanticColor_Shape_Compiles_Runs_And_Verifies() {
        // Verbatim translation of Oahu.Cli.Tui.Tokens.SemanticColor
        // (Oahu.Cli.Tui/Tokens/SemanticColor.cs):
        //   public readonly record struct SemanticColor(Color Value)
        //   {
        //       public override string ToString() => Value.ToMarkup();
        //   }
        // (`Color`/`ToMarkup` are third-party Spectre.Console types not
        // available here — substituted with an int32 `Value` field and a
        // trivial formatting expression; the ToString-override SHAPE
        // (data struct, single-field primary ctor, expression-bodied
        // override) is preserved exactly.)
        let source = `package Oahu.Cli.Tui.Tokens
import System

data struct SemanticColor(Value int32) {
    func ToString() string -> "#" + Value.ToString()
}

func Main() {
    let c = SemanticColor(7)
    Console.WriteLine(c.ToString())
    Console.WriteLine(c)
}`
        let output = CompileAndRun(source)
        Assert.Equal("#7${Environment.NewLine}#7${Environment.NewLine}", output)
    }

    @Fact
    func DataClass_IncompatibleToStringShape_WrongReturnType_CompileFails_ReportsGS0487() {
        let source = `package MyLib

open data class Point(X int32, Y int32) {
    func ToString() int32 {
        return 0
    }
}`
        let (exitCode, stdout, stderr) = TryCompile(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0487", stdout + stderr, StringComparison.Ordinal)
    }

    @Fact
    func DataClass_ExplicitEqualsObject_CompileFails_ReportsGS0232_RegressionControl() {
        let source = `package MyLib

open data class Point(X int32, Y int32) {
    func Equals(other any) bool {
        return false
    }
}`
        let (exitCode, stdout, stderr) = TryCompile(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0232", stdout + stderr, StringComparison.Ordinal)
    }

    @Fact
    func DataStruct_EmitsSixSynthesizedMethods_WhenUserToStringPresent() {
        // Row-planner regression: with a compatible user ToString, ONLY 6
        // synthesized rows are reserved/emitted (Equals(object), Equals(Name),
        // GetHashCode, op_Equality, op_Inequality, Deconstruct) — NOT 7 — and
        // the user's own ToString fills the 7th MethodDef slot. If the row
        // count/emission order ever drift apart, the assembly fails to load
        // or ILVerify fails (already exercised implicitly by every other
        // test in this file via IlVerifier.Verify in CompileToAssembly).
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32

    func ToString() string -> "custom"
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        Assert.NotNull(point.GetMethod("Equals", []Type{typeof(object)}))
        Assert.NotNull(point.GetMethod("Equals", []Type{point}))
        Assert.NotNull(point.GetMethod("GetHashCode", Type.EmptyTypes))
        Assert.NotNull(point.GetMethod("op_Equality", []Type{point, point}))
        Assert.NotNull(point.GetMethod("op_Inequality", []Type{point, point}))
        Assert.NotNull(point.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance))
        let equalsTyped MethodInfo? = point.GetMethod("Equals", []Type{point})
        let a object? = Activator.CreateInstance(point)
        let b object? = Activator.CreateInstance(point)
        point.GetField("X")!!.SetValue(a, 1)
        point.GetField("Y")!!.SetValue(a, 2)
        point.GetField("X")!!.SetValue(b, 1)
        point.GetField("Y")!!.SetValue(b, 2)
        Assert.Equal(true, equalsTyped!!.Invoke(a, []object{b}))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2361_emit_").FullName
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

        private func TryCompile(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2361_negemit_").FullName
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
                        []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (compileExit, compileOut.ToString(), compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2361_synth_").FullName
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
