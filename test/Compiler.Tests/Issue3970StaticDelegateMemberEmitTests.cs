// <copyright file="Issue3970StaticDelegateMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3970: a static delegate-typed field/property on an imported type
/// was not invocable (<c>Reg.Cb()</c>) even though the same member on a
/// source-declared (same-compilation) type and the instance/imported case
/// (<c>bag.OnAsk()</c>, issue #527) both worked. Static method lookup on the
/// imported static branch never fell back to a delegate-typed field/property
/// after missing on name, so the call reported GS0159 "Cannot find function".
/// </summary>
public class Issue3970StaticDelegateMemberEmitTests
{
    private const string Library = """
        package LibFour
        import System

        class Reg {
            shared {
                let Cb Func[string] = func() string { return "static-delegate" }
            }
        }
        """;

    [Fact]
    public void StaticDelegateField_OnImportedType_IsInvocable()
    {
        // The exact issue-body repro.
        var (exit, output, compileLog) = CompileAndRun("""
            package Consumer
            import System
            import LibFour

            func Main() {
                Console.WriteLine(Reg.Cb())
            }
            """);

        Assert.True(exit == 0, compileLog);
        Assert.DoesNotContain("GS0159", compileLog);
        Assert.Equal("static-delegate", output.Trim());
    }

    [Fact]
    public void StaticDelegateField_OnImportedType_ReadThroughLocal_StillInvocable()
    {
        // Regression guard: reading the static delegate into a local and
        // invoking through the local already worked before the fix (it goes
        // through the ordinary static-member-read + bare-delegate-call
        // paths); this must keep working alongside the direct-call fix.
        var (exit, output, compileLog) = CompileAndRun("""
            package Consumer
            import System
            import LibFour

            func Main() {
                var f = Reg.Cb
                Console.WriteLine(f())
            }
            """);

        Assert.True(exit == 0, compileLog);
        Assert.Equal("static-delegate", output.Trim());
    }

    [Fact]
    public void StaticDelegateField_WithArguments_OnImportedType_IsInvocable()
    {
        // The fallback must route through the same Invoke-overload-resolution
        // path as the instance case, so arguments flow correctly (not just
        // the zero-arity shape from the issue body).
        const string AdderLibrary = """
            package LibFour
            import System

            class Adder {
                shared {
                    let Add Func[int32, int32, int32] = func(a int32, b int32) int32 { return a + b }
                }
            }
            """;

        var (exit, output, compileLog) = CompileAndRun("""
            package Consumer
            import System
            import LibFour

            func Main() {
                Console.WriteLine(Adder.Add(3, 4))
            }
            """, AdderLibrary);

        Assert.True(exit == 0, compileLog);
        Assert.DoesNotContain("GS0159", compileLog);
        Assert.Equal("7", output.Trim());
    }

    private static (int Exit, string Output, string CompileLog) CompileAndRun(string appSource)
        => CompileAndRun(appSource, Library);

    private static (int Exit, string Output, string CompileLog) CompileAndRun(string appSource, string library)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3970_static_delegate_").FullName;
        try
        {
            // The emitted assembly name is the source's package clause (not
            // the /out file name), so the reference must be named to match
            // (package LibFour) or the consumer's AssemblyRef won't resolve
            // at load time.
            var libPath = Path.Combine(tempDir, "LibFour.dll");
            var libLog = Compile(tempDir, "Lib.gs", library, libPath, "/target:library");
            Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog);

            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", appSource, appPath, "/target:exe", "/reference:" + libPath);
            if (!File.Exists(appPath))
            {
                return (-1, string.Empty, appLog);
            }

            var (exit, output) = RunDotnet(appPath);
            return (exit, output, appLog);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
