// <copyright file="Issue3695NullableDelegateReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3695: an arrow lambda subscribed to a CLR event whose delegate
/// returns a NULLABLE reference type (`AssemblyLoadContext.Resolving` is
/// `Func<AssemblyLoadContext, AssemblyName, Assembly?>?`) inferred
/// its return type from the body's first `return` (`Assembly`) and
/// then rejected the other branch's `return nil` with GS0155. The event's
/// declared `[Nullable]` metadata never reached lambda target typing:
/// `MemberLookup.GetClrEventHandlerTypeSymbol` dropped the declaration
/// flags when substituting the handler type symbolically, and
/// `TryGetDelegateFunctionType` read nullability for the delegate's
/// parameter positions but not for its return position.
///
/// These tests compile AND RUN the emitted program so the fix is verified at
/// runtime, not merely at bind time: the installed handler must actually
/// return `null` to the runtime's resolution machinery.
open class Issue3695NullableDelegateReturnEmitTests {
    @Fact
    func ArrowLambda_ReturningNil_OnGenericFuncEvent_CompilesRunsAndIlVerifies() {
        // AssemblyLoadContext.Resolving: a CLOSED GENERIC Func<> event whose
        // last type argument is annotated nullable. The program installs the
        // exact two-branch shape from the issue, then forces a resolution
        // failure so the `return nil` branch runs for real — the load throws
        // only because the handler's null actually reached the runtime.
        const source = `package Issue3695.App

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
}`
        using let artifacts = Compile(source)
        IlVerifier.Verify(artifacts.OutputPath)
        Assert.Equal(
            "nil-honoured${Environment.NewLine}Issue3695.Absent${Environment.NewLine}",
            Run(artifacts.OutputPath)
        )
    }

    @Fact
    func ArrowLambda_ReturningNil_OnNamedDelegateEvent_CompilesAndIlVerifies() {
        // AppDomain.AssemblyResolve is a NON-generic named delegate
        // (ResolveEventHandler) whose Invoke returns `Assembly?`. That
        // nullability lives on the delegate's own Invoke return parameter, so
        // it exercises the second half of the fix (the return position in
        // MemberLookup.TryGetDelegateFunctionType).
        const source = `package Issue3695.Named

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
}`
        using let artifacts = Compile(source)
        IlVerifier.Verify(artifacts.OutputPath)
        Assert.Equal("subscribed${Environment.NewLine}", Run(artifacts.OutputPath))
    }

    @Fact
    func ArrowLambda_ReturningNil_OnNonNullDelegateEvent_StillRejected() {
        // Conservatism control: only an EXPLICIT nullable annotation widens the
        // target return type. A source-declared event whose handler returns a
        // non-null `string` must keep rejecting `return nil`, so the fix cannot
        // be mistaken for "every delegate return became nullable".
        const source = `package Issue3695.Strict

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
}`
        using let artifacts = Compile(source, expectSuccess: false)
        Assert.NotEqual(0, artifacts.ExitCode)
        let output = artifacts.Stdout + artifacts.Stderr
        Assert.True(output.Contains("GS0155", StringComparison.Ordinal), output)
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, outputPath string, exitCode int32, stdout string, stderr string) {
            this.Directory = directory
            this.OutputPath = outputPath
            this.ExitCode = exitCode
            this.Stdout = stdout
            this.Stderr = stderr
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ExitCode int32 {
            get;
        }

        prop Stdout string {
            get;
        }

        prop Stderr string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(this.Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func Compile(source string, expectSuccess bool = true) Issue3695NullableDelegateReturnEmitTests
            .CompilationArtifacts {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue3695-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "Issue3695.App.dll")
            File.WriteAllText(sourcePath, source)
            let result = RunCompiler(
                []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
            )
            if expectSuccess {
                Assert.True(result.ExitCode == 0, (`compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            }
            return Issue3695NullableDelegateReturnEmitTests.CompilationArtifacts(
                directory,
                outputPath,
                result.ExitCode,
                result.Stdout,
                result.Stderr
            )
        }

        private func RunCompiler(args[]string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
