// <copyright file="Issue2403MethodCallVsImportedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2403: compiled (gsc emit + IL verify + execute) coverage for the
/// call-vs-imported-type precedence fix in
/// <see cref="GSharp.Core.CodeAnalysis.Binding.OverloadResolver.BindCallExpression"/>.
/// A user/same-compilation method (or implicit-<c>this</c> instance method)
/// whose name collides with an imported CLR type (e.g.
/// <c>System.Net.Http.HttpClient</c>) must be preferred over that type's
/// constructor/conversion fallbacks — both at bind time and in the emitted IL
/// that actually runs.
/// </summary>
public class Issue2403MethodCallVsImportedTypeEmitTests
{
    [Fact]
    public void PrivateInstanceMethod_ClassArgument_ImportedClrTypeCollision_CompilesAndRuns()
    {
        var source = """
            package p
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
            Console.WriteLine(svc.Run(Profile{Name: "abc"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("user:abc\n", output);
    }

    [Fact]
    public void MultiArgument_ImportedClrTypeCollision_CompilesAndRuns()
    {
        // Control: StringBuilder also has a two-argument constructor
        // (`StringBuilder(string, int32)`); a two-argument user method with
        // the same name must still win at the emitted-IL level.
        var source = """
            package p
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
            Console.WriteLine(svc.Run(Profile{Name: "x"}, Profile{Name: "y"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("x-y\n", output);
    }

    [Fact]
    public void ExactOahuCoreShape_AuthorizeHttpClient_CompilesAndRuns()
    {
        // The exact Oahu.Core Authorize shape: `import System.Net.Http`
        // brings the CLR `HttpClient` type into scope; `Authorize` declares a
        // private instance method named `HttpClient` taking an `IProfile` and
        // returning a nullable `IProfile`, invoked across four call sites
        // through implicit `this`.
        var source = """
            package p
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
            Console.WriteLine(result?.Authorization)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("tok\n", output);
    }

    [Fact]
    public void GenuineConstructorControl_NoUserMethod_StillConstructsClrTypeAndRuns()
    {
        // Guardrail: with no colliding user method, `StringBuilder(16)` must
        // still emit and run as the real CLR constructor call.
        var source = """
            package p
            import System
            import System.Text

            var sb = StringBuilder(16)
            Console.WriteLine(sb.Capacity)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("16\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2403_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
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
                compileExit = Program.Main(args);
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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
