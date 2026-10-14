// <copyright file="Issue2370ExplicitInterfaceStaticMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// ADR-0149 follow-up (issue #2362/PR #2370, "final completion pass"):
/// extends the explicit-interface `(IFoo)` qualifier clause to STATIC
/// methods and properties — C# 11 `static abstract`/`static
/// virtual` interface members (ADR-0089/#755/#1019) can now be explicitly
/// implemented (`func (IFoo) M() T` / `prop (IFoo) P T` inside a
/// `shared { }` block), exactly like their instance counterparts.
///
/// The binder-side machinery mirrors the existing instance-member resolvers
/// exactly: `DeclarationBinder.TryResolveExplicitInterfaceStaticImplementation`
/// / `TryResolveExplicitInterfaceStaticPropertyImplementation` are
/// consulted (as a short-circuit) by `VerifyStaticVirtualInterfaceImplementations`
/// / `VerifyStaticVirtualInterfacePropertyImplementations` before falling
/// back to the pre-existing name-based match, and
/// `ResolveExplicitInterfaceClauses` links the clause the same way it
/// already does for instance methods/properties/events.
///
/// The key new capability these tests prove: because the clause
/// disambiguates by INTERFACE IDENTITY rather than by name, a single struct
/// or class can now implement two SAME-NAMED static-virtual members from two
/// DIFFERENT interfaces — previously impossible (both would collide as an
/// exact-signature GS0264 duplicate under the old name-only static-virtual
/// scheme), exactly mirroring the instance "diamond" case ADR-0149 already
/// solved for instance members.
///
/// There is no static indexer or static event form in C#/the CLR at all
/// (indexers always require an instance receiver; interfaces cannot declare
/// `static abstract`/`static virtual` events) — see
/// `DeclarationBinder.ResolveExplicitInterfaceClauses`'s doc comment and
/// the parser's `ParseInterfaceSharedBlock` (GS0330 already rejects an
/// `event` inside an interface `shared` block, and a `shared`
/// indexer on any type — interface included — is already rejected via
/// `ReportIndexerRequiresAccessorBody`), so only methods and properties
/// are covered here.
open class Issue2370ExplicitInterfaceStaticMemberEmitTests {
    @Fact
    func StaticExplicitMethod_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected() {
        let source = `package Probe2370StaticA
import System

interface IData2370A[TData IData2370A[TData]] {
    shared {
        func Size() int32;
    }
}

struct TrackNumber2370A : IData2370A[TrackNumber2370A] {
    shared {
        func (IData2370A[TrackNumber2370A]) Size() int32 { return 11 }
    }
}

func Use[T IData2370A[T]](w T) int32 {
    return T.Size()
}

func Main() {
    Console.WriteLine(Use(TrackNumber2370A{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.Use$$")
        Assert.Equal("11${Environment.NewLine}", output)
    }

    @Fact
    func StaticExplicitGetOnlyProperty_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected() {
        let source = `package Probe2370StaticB
import System

interface IData2370B[TData IData2370B[TData]] {
    shared {
        prop SizeInBytes int32 { get; }
    }
}

struct TrackNumber2370B : IData2370B[TrackNumber2370B] {
    shared {
        prop (IData2370B[TrackNumber2370B]) SizeInBytes int32 { get { return 7 } }
    }
}

func Use[T IData2370B[T]](w T) int32 {
    return T.SizeInBytes
}

func Main() {
    Console.WriteLine(Use(TrackNumber2370B{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.Use$$")
        Assert.Equal("7${Environment.NewLine}", output)
    }

    /// The headline new capability: two DIFFERENT interfaces each declare a
    /// same-named, same-signature static-virtual method (`Make() int32`)
    /// — impossible to implement both under the pre-#2370 name-only
    /// static-virtual scheme (an exact-signature GS0264 duplicate), but fully
    /// supported via two clause-disambiguated slots. Each is dispatched
    /// independently through its own generic constraint.
    @Fact
    func StaticExplicitMethod_DiamondSameNameTwoInterfaces_DispatchesIndependently() {
        let source = `package Probe2370StaticC
import System

interface IFoo2370C {
    shared {
        func Make() int32;
    }
}

interface IBar2370C {
    shared {
        func Make() int32;
    }
}

struct Widget2370C : IFoo2370C, IBar2370C {
    shared {
        func (IFoo2370C) Make() int32 { return 1 }
        func (IBar2370C) Make() int32 { return 2 }
    }
}

func UseFoo[T IFoo2370C](w T) int32 {
    return T.Make()
}

func UseBar[T IBar2370C](w T) int32 {
    return T.Make()
}

func Main() {
    Console.WriteLine(UseFoo(Widget2370C{}))
    Console.WriteLine(UseBar(Widget2370C{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.(UseFoo|UseBar)$$")
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    /// Same "diamond" proof for static PROPERTIES: two interfaces each
    /// declare a same-named get-only static-virtual property, disambiguated
    /// by two clause-qualified property slots.
    @Fact
    func StaticExplicitProperty_DiamondSameNameTwoInterfaces_DispatchesIndependently() {
        let source = `package Probe2370StaticD
import System

interface IFoo2370D {
    shared {
        prop Tag int32 { get; }
    }
}

interface IBar2370D {
    shared {
        prop Tag int32 { get; }
    }
}

struct Widget2370D : IFoo2370D, IBar2370D {
    shared {
        prop (IFoo2370D) Tag int32 { get { return 10 } }
        prop (IBar2370D) Tag int32 { get { return 20 } }
    }
}

func UseFoo[T IFoo2370D](w T) int32 {
    return T.Tag
}

func UseBar[T IBar2370D](w T) int32 {
    return T.Tag
}

func Main() {
    Console.WriteLine(UseFoo(Widget2370D{}))
    Console.WriteLine(UseBar(Widget2370D{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.(UseFoo|UseBar)$$")
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}", output)
    }

    /// Control: an ordinary (non-explicit, plain-name) static method still
    /// satisfies a static-virtual interface method requirement exactly as
    /// before #2370 — the new clause-based short-circuit in
    /// `VerifyStaticVirtualInterfaceImplementations` must not regress
    /// the pre-existing name-based path when no clause is present.
    @Fact
    func OrdinaryStaticMethod_StillSatisfiesInterfaceByName_Control() {
        let source = `package Probe2370StaticE
import System

interface ICounter2370E {
    shared {
        func Next() int32;
    }
}

struct Sequence2370E : ICounter2370E {
    shared {
        func Next() int32 { return 5 }
    }
}

func Use[T ICounter2370E](w T) int32 {
    return T.Next()
}

func Main() {
    Console.WriteLine(Use(Sequence2370E{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.Use$$")
        Assert.Equal("5${Environment.NewLine}", output)
    }

    /// GS0494 control: a static explicit clause naming a real implemented
    /// interface, but with no matching member of that name/signature on the
    /// interface, is reported exactly like the instance-member equivalent.
    @Fact
    func StaticExplicitMethod_ClauseNamesRealInterface_ButNoMatchingMember_ReportsGS0494() {
        let source = `package Probe2370StaticF

interface IFoo2370F {
    shared {
        func Make() int32;
    }
}

struct Widget2370F : IFoo2370F {
    shared {
        func (IFoo2370F) Make() int32 { return 1 }
        func (IFoo2370F) Typo() int32 { return 2 }
    }
}

func Main() { }`
        let (exitCode, output) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0494", output, StringComparison.Ordinal)
    }

    /// GS0495 control: two static members both carry a clause targeting the
    /// same interface member — a duplicate slot claim, exactly like the
    /// instance-member equivalent (`Adr0149ExplicitInterfaceClauseBinderTests
    /// .TwoMembersClaimSameInterfaceSlot_ReportsGS0495`). ADR-0149's
    /// design intentionally allows two same-named/same-signature explicit-
    /// clause members to coexist at the plain-declaration level (their real
    /// identity is the clause-qualified slot, not the bare name) — so this is
    /// NOT rejected as an ordinary GS0264 duplicate; it is caught by the
    /// slot-identity check instead.
    @Fact
    func StaticExplicitMethod_TwoMembersClaimSameSlot_ReportsGS0495() {
        let source = `package Probe2370StaticG

interface IFoo2370G {
    shared {
        func Make() int32;
    }
}

struct Widget2370G : IFoo2370G {
    shared {
        private func (IFoo2370G) Make() int32 { return 1 }

        private func (IFoo2370G) Make() int32 { return 2 }
    }
}

func Main() { }`
        let (exitCode, output) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0495", output, StringComparison.Ordinal)
    }

    /// GS0495 control for static PROPERTIES: mirrors the method case above.
    @Fact
    func StaticExplicitProperty_TwoMembersClaimSameSlot_ReportsGS0495() {
        let source = `package Probe2370StaticH

interface IFoo2370H {
    shared {
        prop Tag int32 { get; }
    }
}

struct Widget2370H : IFoo2370H {
    shared {
        private prop (IFoo2370H) Tag int32 { get { return 1 } }

        private prop (IFoo2370H) Tag int32 { get { return 2 } }
    }
}

func Main() { }`
        let (exitCode, output) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0495", output, StringComparison.Ordinal)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_static_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileExpectingFailure(source string)(ExitCode int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_static_fail_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString())
        }

        private func CompileAndRun(source string, ignoredErrorScope string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_static_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                IlVerifier.Verify(
                    dllPath,
                    ignoredErrorCodes: if ignoredErrorScope == nil {
                        default([]?string)
                    } else {
                        IlVerifier.KnownIssues.StaticVirtualInterface
                    },
                    ignoredErrorScope: ignoredErrorScope
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "10.0.0"
    }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
                psi.ArgumentList.Add(dllPath)
                using let process Process? = Process.Start(psi)
                let output = process!!.StandardOutput.ReadToEnd()
                let errorOutput = process!!.StandardError.ReadToEnd()
                process!!.WaitForExit()
                Assert.True(process!!.ExitCode == 0, (`Execution failed:
stdout:
` + "$output" + `
stderr:
` + "$errorOutput"))
                return output
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // best-effort cleanup

                }
            }
        }
    }
}
