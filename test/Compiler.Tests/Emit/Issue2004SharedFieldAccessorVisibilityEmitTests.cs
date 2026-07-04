// <copyright file="Issue2004SharedFieldAccessorVisibilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2004: a static computed property whose accessor reads (or writes)
/// a backing field declared in the same <c>shared{}</c> block emitted IL that
/// ilverify rejected with <c>FieldAccess</c> / "Field is not visible".
///
/// Root cause: <c>ReflectionMetadataEmitter</c>'s package-function pass grouped
/// every non-instance <see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol"/>
/// not already recorded in <c>aggregateMethodHandles</c> into the entry-point
/// package's synthesized <c>&lt;Program&gt;</c> TypeDef. Plain static methods
/// on a struct/class are added to <c>aggregateMethodHandles</c>
/// (<c>PlanClassMethods</c>/<c>PlanStructMethods</c>), but a static property's
/// (or event's) accessor <see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol"/>
/// is tracked only via <c>cache.PropertyAccessorHandles</c>, keyed by the
/// property symbol — never added to <c>aggregateMethodHandles</c>. The
/// unchecked accessor function therefore fell through and was emitted a
/// SECOND time as an ordinary static method on <c>&lt;Program&gt;</c>, with a
/// body that still reads/writes the struct/class's static backing field.
/// <c>&lt;Program&gt;</c> is an unrelated type, so a private (or otherwise
/// restricted) field access from its duplicated method body is illegal IL —
/// exactly the "Field is not visible" ilverify error. Since
/// <c>StaticOwnerType</c> is set to the declaring struct/class for these
/// accessors (mirroring the existing interface static-virtual member check
/// immediately above it), the fix skips them the same way.
///
/// These tests compile and run real programs end-to-end AND ilverify the
/// emitted assembly, covering: a getter-only read, a getter+setter pair
/// (read and write), and a class that mixes an instance property/field with
/// a differently-named static property/field (the shape that most directly
/// reproduces the duplicate <c>&lt;Program&gt;</c> emission).
/// </summary>
public class Issue2004SharedFieldAccessorVisibilityEmitTests
{
    [Fact]
    public void StaticComputedProperty_ReadsPrivateSharedBlockField_VerifiesAndRuns()
    {
        var source = """
            package P
            import System

            class Issue2004ReadOnly {
                shared {
                    private var _name string = "hello"
                    prop Name string {
                        get { return _name }
                    }
                }
            }

            func Main() {
                Console.WriteLine(Issue2004ReadOnly.Name)
            }
            """;

        Assert.Equal("hello\n", CompileAndRun(source));
    }

    [Fact]
    public void StaticComputedProperty_GetterAndSetter_ReadWritePrivateSharedBlockField()
    {
        var source = """
            package P
            import System

            class Issue2004GetSet {
                shared {
                    private var _name string
                    prop Name string {
                        get { return _name }
                        set { _name = value }
                    }
                }
            }

            func Main() {
                Issue2004GetSet.Name = "world"
                Console.WriteLine(Issue2004GetSet.Name)
            }
            """;

        Assert.Equal("world\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceAndStaticComputedProperties_BothOverPrivateFields_VerifyAndRun()
    {
        // The exact shape that most directly reproduced the bug: a class with
        // BOTH an instance computed property over an instance field AND a
        // (differently-named) static computed property over a shared-block
        // field. Before the fix, the static get_Name/set_Name accessors were
        // duplicated onto the package's synthesized <Program> TypeDef.
        var source = """
            package P
            import System

            class Issue2004Mixed {
                private var _label string
                prop Label string {
                    get { return _label }
                    set { _label = value }
                }

                shared {
                    private var _name string
                    prop Name string {
                        get { return _name }
                        set { _name = value }
                    }
                }
            }

            func Main() {
                Issue2004Mixed.Name = "static-value"
                var m = Issue2004Mixed{}
                m.Label = "instance-value"
                Console.WriteLine(Issue2004Mixed.Name)
                Console.WriteLine(m.Label)
            }
            """;

        Assert.Equal("static-value\ninstance-value\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2004_").FullName;
        try
        {
            return CompileAndRunImpl(source, tempDir);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunImpl(string source, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
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
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = tempDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi);
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout.Replace("\r\n", "\n");
    }
}
