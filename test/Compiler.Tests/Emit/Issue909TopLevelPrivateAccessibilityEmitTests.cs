// <copyright file="Issue909TopLevelPrivateAccessibilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #909 — a top-level <c>private func</c> lives on the synthetic
/// <c>&lt;Program&gt;</c> type. The binder permits sibling top-level types in
/// the same assembly to call it (its accessibility model treats top-level
/// <c>private</c> as assembly-visible), but emission used to map source
/// <c>private</c> to IL <see cref="MethodAttributes.Private"/>, which the CLR
/// enforces as private-to-the-declaring-type (<c>&lt;Program&gt;</c>). The
/// binder and the emitted IL therefore disagreed: clean compile, runtime
/// <see cref="MethodAccessException"/>.
///
/// The fix (ADR-0109, option 1) emits top-level <c>private</c> members of the
/// synthetic <c>&lt;Program&gt;</c> type as IL <c>assembly</c> (internal) so the
/// IL accessibility matches what the binder already permits. Both the direct
/// call <c>Helper()</c> and the method-group delegate <c>return Helper</c> must
/// execute without <see cref="MethodAccessException"/>.
///
/// This remapping is scoped to <c>&lt;Program&gt;</c> members ONLY — a
/// <c>private</c> method on a user-defined <c>class</c>/<c>struct</c> stays IL
/// <c>private</c>.
/// </summary>
public class Issue909TopLevelPrivateAccessibilityEmitTests
{
    [Fact]
    public void TopLevelPrivateFunc_DirectCallFromSiblingType_Runs()
    {
        CompileVerifyAndRun("""
            package Oahu.Cli.Tests

            import System

            private func Helper() string {
                return "hello"
            }

            class Greeter {
                func CallIt() string {
                    return Helper()
                }
            }

            func Main() {
                let g = Greeter()
                Console.WriteLine(g.CallIt())
            }
            """, "hello\n");
    }

    [Fact]
    public void TopLevelPrivateFunc_MethodGroupDelegateFromSiblingType_Runs()
    {
        CompileVerifyAndRun("""
            package Oahu.Cli.Tests

            import System

            private func Helper() string {
                return "hello"
            }

            class Greeter {
                func MakeDelegate() Func[string] {
                    return Helper
                }
            }

            func Main() {
                let g = Greeter()
                let d = g.MakeDelegate()
                Console.WriteLine(d())
            }
            """, "hello\n");
    }

    [Fact]
    public void TopLevelPrivateFunc_BothFormsTogether_Runs()
    {
        CompileVerifyAndRun("""
            package Oahu.Cli.Tests

            import System

            private func Helper() string {
                return "hello"
            }

            class Greeter {
                func CallIt() string {
                    return Helper()
                }
                func MakeDelegate() Func[string] {
                    return Helper
                }
            }

            func Main() {
                let g = Greeter()
                Console.WriteLine(g.CallIt())
                let d = g.MakeDelegate()
                Console.WriteLine(d())
            }
            """, "hello\nhello\n");
    }

    /// <summary>
    /// Guard: a top-level <c>private func</c> must be emitted IL
    /// <c>assembly</c> (internal), NOT IL <c>private</c>.
    /// </summary>
    [Fact]
    public void TopLevelPrivateFunc_IsEmittedAssemblyVisible()
    {
        var dll = CompileToDll("""
            package Oahu.Cli.Tests

            import System

            private func Helper() string {
                return "hello"
            }

            func Main() {
                Console.WriteLine(Helper())
            }
            """);
        try
        {
            var attrs = GetMethodAttributes(dll, "<Program>", "Helper");
            Assert.Equal(MethodAttributes.Assembly, attrs & MethodAttributes.MemberAccessMask);
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    /// <summary>
    /// Guard: a <c>private</c> method on a USER class must remain IL
    /// <c>private</c> — the remapping is scoped to <c>&lt;Program&gt;</c> only
    /// and must NOT weaken real user-type <c>private</c>.
    /// </summary>
    [Fact]
    public void UserClassPrivateMethod_RemainsIlPrivate()
    {
        var dll = CompileToDll("""
            package Oahu.Cli.Tests

            import System

            class Greeter {
                private func Secret() string {
                    return "secret"
                }
                func Reveal() string {
                    return Secret()
                }
            }

            func Main() {
                let g = Greeter()
                Console.WriteLine(g.Reveal())
            }
            """);
        try
        {
            var attrs = GetMethodAttributes(dll, "Greeter", "Secret");
            Assert.Equal(MethodAttributes.Private, attrs & MethodAttributes.MemberAccessMask);
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    private static MethodAttributes GetMethodAttributes(string dllPath, string typeName, string methodName)
    {
        using var fs = File.OpenRead(dllPath);
        using var pe = new PEReader(fs);
        var mr = pe.GetMetadataReader();
        foreach (var typeHandle in mr.TypeDefinitions)
        {
            var type = mr.GetTypeDefinition(typeHandle);
            if (mr.GetString(type.Name) != typeName)
            {
                continue;
            }

            foreach (var methodHandle in type.GetMethods())
            {
                var method = mr.GetMethodDefinition(methodHandle);
                if (mr.GetString(method.Name) == methodName)
                {
                    return method.Attributes;
                }
            }
        }

        throw new Xunit.Sdk.XunitException($"method {typeName}.{methodName} not found in {dllPath}");
    }

    private static void CompileVerifyAndRun(string source, string expected)
    {
        var dll = CompileToDll(source);
        try
        {
            IlVerifier.Verify(dll);

            var runtimeConfigPath = Path.ChangeExtension(dll, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + dll + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            Assert.Equal(expected, stdout.Replace("\r\n", "\n"));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    private static string CompileToDll(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue909_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
            srcPath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
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

        Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
        return outPath;
    }

    private static void TryDeleteDir(string dir)
    {
        try
        {
            if (dir != null)
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
