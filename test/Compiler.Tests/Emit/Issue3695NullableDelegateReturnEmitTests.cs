// <copyright file="Issue3695NullableDelegateReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3695: an arrow lambda subscribed to a CLR event whose delegate
/// returns a NULLABLE reference type (<c>AssemblyLoadContext.Resolving</c> is
/// <c>Func&lt;AssemblyLoadContext, AssemblyName, Assembly?&gt;?</c>) inferred
/// its return type from the body's first <c>return</c> (<c>Assembly</c>) and
/// then rejected the other branch's <c>return nil</c> with GS0155. The event's
/// declared <c>[Nullable]</c> metadata never reached lambda target typing:
/// <c>MemberLookup.GetClrEventHandlerTypeSymbol</c> dropped the declaration
/// flags when substituting the handler type symbolically, and
/// <c>TryGetDelegateFunctionType</c> read nullability for the delegate's
/// parameter positions but not for its return position.
///
/// These tests compile AND RUN the emitted program so the fix is verified at
/// runtime, not merely at bind time: the installed handler must actually
/// return <see langword="null"/> to the runtime's resolution machinery.
/// </summary>
public class Issue3695NullableDelegateReturnEmitTests
{
    [Fact]
    public void ArrowLambda_ReturningNil_OnGenericFuncEvent_CompilesRunsAndIlVerifies()
    {
        // AssemblyLoadContext.Resolving: a CLOSED GENERIC Func<> event whose
        // last type argument is annotated nullable. The program installs the
        // exact two-branch shape from the issue, then forces a resolution
        // failure so the `return nil` branch runs for real — the load throws
        // only because the handler's null actually reached the runtime.
        const string source = """
            package Issue3695.App

            import System
            import System.Reflection
            import System.Runtime.Loader

            func Main() {
                var seen = ""
                let ctx = AssemblyLoadContext.Default
                ctx.Resolving += (c AssemblyLoadContext, name AssemblyName) -> {
                    seen = name.Name!!
                    if name.Name == "Issue3695.Present" {
                        return typeof(string).Assembly
                    }

                    return nil
                }

                try {
                    ctx.LoadFromAssemblyName(AssemblyName("Issue3695.Absent"))
                    Console.WriteLine("loaded")
                } catch (e Exception) {
                    Console.WriteLine("nil-honoured")
                }

                Console.WriteLine(seen)
            }
            """;

        using var artifacts = Compile(source);
        IlVerifier.Verify(artifacts.OutputPath);
        Assert.Equal(
            $"nil-honoured{Environment.NewLine}Issue3695.Absent{Environment.NewLine}",
            Run(artifacts.OutputPath));
    }

    [Fact]
    public void ArrowLambda_ReturningNil_OnNamedDelegateEvent_CompilesAndIlVerifies()
    {
        // AppDomain.AssemblyResolve is a NON-generic named delegate
        // (ResolveEventHandler) whose Invoke returns `Assembly?`. That
        // nullability lives on the delegate's own Invoke return parameter, so
        // it exercises the second half of the fix (the return position in
        // MemberLookup.TryGetDelegateFunctionType).
        const string source = """
            package Issue3695.Named

            import System
            import System.Reflection

            func Main() {
                AppDomain.CurrentDomain.AssemblyResolve += (sender object, args ResolveEventArgs) -> {
                    if args.Name == "Issue3695.Present" {
                        return typeof(string).Assembly
                    }

                    return nil
                }

                Console.WriteLine("subscribed")
            }
            """;

        using var artifacts = Compile(source);
        IlVerifier.Verify(artifacts.OutputPath);
        Assert.Equal($"subscribed{Environment.NewLine}", Run(artifacts.OutputPath));
    }

    [Fact]
    public void ArrowLambda_ReturningNil_OnNonNullDelegateEvent_StillRejected()
    {
        // Conservatism control: only an EXPLICIT nullable annotation widens the
        // target return type. A source-declared event whose handler returns a
        // non-null `string` must keep rejecting `return nil`, so the fix cannot
        // be mistaken for "every delegate return became nullable".
        const string source = """
            package Issue3695.Strict

            import System

            class Box {
                event Transform (int32) -> string
            }

            func Main() {
                let b = Box()
                b.Transform += (x int32) -> {
                    if x > 0 {
                        return "positive"
                    }

                    return nil
                }
            }
            """;

        using var artifacts = Compile(source, expectSuccess: false);
        Assert.NotEqual(0, artifacts.ExitCode);
        var output = artifacts.Stdout + artifacts.Stderr;
        Assert.True(output.Contains("GS0155", StringComparison.Ordinal), output);
    }

    private static CompilationArtifacts Compile(string source, bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3695-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "Issue3695.App.dll");
        File.WriteAllText(sourcePath, source);

        var result = RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
            sourcePath,
        });

        if (expectSuccess)
        {
            Assert.True(
                result.ExitCode == 0,
                $"compile failed\n{result.Stdout}\n{result.Stderr}");
        }

        return new CompilationArtifacts(
            directory,
            outputPath,
            result.ExitCode,
            result.Stdout,
            result.Stderr);
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private sealed class CompilationArtifacts : IDisposable
    {
        public CompilationArtifacts(
            string directory,
            string outputPath,
            int exitCode,
            string stdout,
            string stderr)
        {
            this.Directory = directory;
            this.OutputPath = outputPath;
            this.ExitCode = exitCode;
            this.Stdout = stdout;
            this.Stderr = stderr;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public int ExitCode { get; }

        public string Stdout { get; }

        public string Stderr { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(this.Directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
