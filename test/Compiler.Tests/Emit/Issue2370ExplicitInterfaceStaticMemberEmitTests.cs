// <copyright file="Issue2370ExplicitInterfaceStaticMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0149 follow-up (issue #2362/PR #2370, "final completion pass"):
/// extends the explicit-interface <c>(IFoo)</c> qualifier clause to STATIC
/// methods and properties — C# 11 <c>static abstract</c>/<c>static
/// virtual</c> interface members (ADR-0089/#755/#1019) can now be explicitly
/// implemented (<c>func (IFoo) M() T</c> / <c>prop (IFoo) P T</c> inside a
/// <c>shared { }</c> block), exactly like their instance counterparts.
/// <para>
/// The binder-side machinery mirrors the existing instance-member resolvers
/// exactly: <c>DeclarationBinder.TryResolveExplicitInterfaceStaticImplementation</c>
/// / <c>TryResolveExplicitInterfaceStaticPropertyImplementation</c> are
/// consulted (as a short-circuit) by <c>VerifyStaticVirtualInterfaceImplementations</c>
/// / <c>VerifyStaticVirtualInterfacePropertyImplementations</c> before falling
/// back to the pre-existing name-based match, and
/// <c>ResolveExplicitInterfaceClauses</c> links the clause the same way it
/// already does for instance methods/properties/events.
/// </para>
/// <para>
/// The key new capability these tests prove: because the clause
/// disambiguates by INTERFACE IDENTITY rather than by name, a single struct
/// or class can now implement two SAME-NAMED static-virtual members from two
/// DIFFERENT interfaces — previously impossible (both would collide as an
/// exact-signature GS0264 duplicate under the old name-only static-virtual
/// scheme), exactly mirroring the instance "diamond" case ADR-0149 already
/// solved for instance members.
/// </para>
/// <para>
/// There is no static indexer or static event form in C#/the CLR at all
/// (indexers always require an instance receiver; interfaces cannot declare
/// <c>static abstract</c>/<c>static virtual</c> events) — see
/// <c>DeclarationBinder.ResolveExplicitInterfaceClauses</c>'s doc comment and
/// the parser's <c>ParseInterfaceSharedBlock</c> (GS0330 already rejects an
/// <c>event</c> inside an interface <c>shared</c> block, and a <c>shared</c>
/// indexer on any type — interface included — is already rejected via
/// <c>ReportIndexerRequiresAccessorBody</c>), so only methods and properties
/// are covered here.
/// </para>
/// </summary>
public class Issue2370ExplicitInterfaceStaticMemberEmitTests
{
    [Fact]
    public void StaticExplicitMethod_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected()
    {
        var source = """
            package Probe2370StaticA
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    [Fact]
    public void StaticExplicitGetOnlyProperty_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected()
    {
        var source = """
            package Probe2370StaticB
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    /// <summary>
    /// The headline new capability: two DIFFERENT interfaces each declare a
    /// same-named, same-signature static-virtual method (<c>Make() int32</c>)
    /// — impossible to implement both under the pre-#2370 name-only
    /// static-virtual scheme (an exact-signature GS0264 duplicate), but fully
    /// supported via two clause-disambiguated slots. Each is dispatched
    /// independently through its own generic constraint.
    /// </summary>
    [Fact]
    public void StaticExplicitMethod_DiamondSameNameTwoInterfaces_DispatchesIndependently()
    {
        var source = """
            package Probe2370StaticC
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    /// <summary>
    /// Same "diamond" proof for static PROPERTIES: two interfaces each
    /// declare a same-named get-only static-virtual property, disambiguated
    /// by two clause-qualified property slots.
    /// </summary>
    [Fact]
    public void StaticExplicitProperty_DiamondSameNameTwoInterfaces_DispatchesIndependently()
    {
        var source = """
            package Probe2370StaticD
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n", output);
    }

    /// <summary>
    /// Control: an ordinary (non-explicit, plain-name) static method still
    /// satisfies a static-virtual interface method requirement exactly as
    /// before #2370 — the new clause-based short-circuit in
    /// <c>VerifyStaticVirtualInterfaceImplementations</c> must not regress
    /// the pre-existing name-based path when no clause is present.
    /// </summary>
    [Fact]
    public void OrdinaryStaticMethod_StillSatisfiesInterfaceByName_Control()
    {
        var source = """
            package Probe2370StaticE
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    /// <summary>
    /// GS0494 control: a static explicit clause naming a real implemented
    /// interface, but with no matching member of that name/signature on the
    /// interface, is reported exactly like the instance-member equivalent.
    /// </summary>
    [Fact]
    public void StaticExplicitMethod_ClauseNamesRealInterface_ButNoMatchingMember_ReportsGS0494()
    {
        var source = """
            package Probe2370StaticF

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

            func Main() { }
            """;

        var (exitCode, output) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0494", output, StringComparison.Ordinal);
    }

    /// <summary>
    /// GS0495 control: two static members both carry a clause targeting the
    /// same interface member — a duplicate slot claim, exactly like the
    /// instance-member equivalent (<c>Adr0149ExplicitInterfaceClauseBinderTests
    /// .TwoMembersClaimSameInterfaceSlot_ReportsGS0495</c>). ADR-0149's
    /// design intentionally allows two same-named/same-signature explicit-
    /// clause members to coexist at the plain-declaration level (their real
    /// identity is the clause-qualified slot, not the bare name) — so this is
    /// NOT rejected as an ordinary GS0264 duplicate; it is caught by the
    /// slot-identity check instead.
    /// </summary>
    [Fact]
    public void StaticExplicitMethod_TwoMembersClaimSameSlot_ReportsGS0495()
    {
        var source = """
            package Probe2370StaticG

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

            func Main() { }
            """;

        var (exitCode, output) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0495", output, StringComparison.Ordinal);
    }

    /// <summary>
    /// GS0495 control for static PROPERTIES: mirrors the method case above.
    /// </summary>
    [Fact]
    public void StaticExplicitProperty_TwoMembersClaimSameSlot_ReportsGS0495()
    {
        var source = """
            package Probe2370StaticH

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

            func Main() { }
            """;

        var (exitCode, output) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0495", output, StringComparison.Ordinal);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_static_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

        IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);
        return outPath;
    }

    private static (int ExitCode, string Output) CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_static_fail_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString());
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_static_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": {
                          "name": "Microsoft.NETCore.App",
                          "version": "10.0.0"
                        }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add(dllPath);

            using var process = Process.Start(psi);
            var output = process!.StandardOutput.ReadToEnd();
            var errorOutput = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(
                process.ExitCode == 0,
                $"Execution failed:\nstdout:\n{output}\nstderr:\n{errorOutput}");

            return output;
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // best-effort cleanup
            }
        }
    }
}
