// <copyright file="Issue3523FunctionPointerMemberInvocationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3523 end-to-end coverage for function-pointer-valued member calls.
/// </summary>
public class Issue3523FunctionPointerMemberInvocationEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public void ExactUnmanagedFieldRepro_BuildsAndContainsCalli_WithoutExecution()
    {
        const string source = """
            package FindingFunctionPointerFieldInvocation

            unsafe struct Dispatch {
                var Apply unmanaged[Cdecl] (int32) -> int32
            }

            unsafe func Main() int32 {
                let dispatch = Dispatch{}
                return dispatch.Apply(41)
            }
            """;

        var outputDirectory = Compile(source, out var outputPath);
        try
        {
            VerifyFunctionPointerAssembly(outputPath);
            Assert.True(ContainsCalli(outputPath), "expected field invocation to emit calli");
        }
        finally
        {
            DeleteDirectory(outputDirectory);
        }
    }

    [Fact]
    public void ManagedFieldPropertyIndexerConditionalStaticAndRefCalls_Run()
    {
        const string source = """
            package Issue3523Managed
            import System

            class Tracker {
                shared {
                    var OwnerCalls int32
                }
            }

            unsafe func increment(value int32) int32 -> value + 1

            unsafe struct Dispatch {
                var Apply *func(int32) int32
                prop Handler *func(int32) int32 -> Apply

                func InvokeField(value int32) int32 -> Apply(value)
                func InvokeProperty(value int32) int32 -> Handler(value)

                shared {
                    var SharedApply *func(int32) int32
                    prop SharedHandler *func(int32) int32 -> SharedApply
                    func InvokeShared(value int32) int32 -> SharedApply(value)
                }
            }

            unsafe class Box {
                let Apply *func(int32) int32
                init(apply *func(int32) int32) {
                    Apply = apply
                }
            }

            unsafe func makeDispatch() Dispatch {
                Tracker.OwnerCalls += 1
                Console.Write("R")
                return Dispatch{Apply: &increment}
            }

            func nextArgument() int32 {
                Console.Write("A")
                return 41
            }

            unsafe func invokeRef(ref pointer *func(int32) int32, value int32) int32 {
                return pointer(value)
            }

            unsafe func Main() {
                let dispatch = Dispatch{Apply: &increment}
                Dispatch.SharedApply = &increment

                Console.WriteLine(dispatch.Apply(41))
                Console.WriteLine(dispatch.Handler(40))
                Console.WriteLine(dispatch.InvokeField(39))
                Console.WriteLine(dispatch.InvokeProperty(38))
                Console.WriteLine(Dispatch.SharedApply(37))
                Console.WriteLine(Dispatch.SharedHandler(36))
                Console.WriteLine(Dispatch.InvokeShared(35))

                let pointers = []*func(int32) int32{&increment}
                Console.WriteLine(pointers[0](34))
                Console.WriteLine((true ? dispatch.Apply : dispatch.Handler)(33))
                Console.WriteLine((dispatch.Apply)(32))

                var pointer = &increment
                Console.WriteLine(invokeRef(ref pointer, 31))

                let present Box? = Box(&increment)
                let absent Box? = nil
                Console.WriteLine(present?.Apply(30))
                Console.WriteLine(absent?.Apply(30) == nil)

                Console.WriteLine(makeDispatch().Apply(nextArgument()))
                Console.WriteLine(Tracker.OwnerCalls)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "42",
                "41",
                "40",
                "39",
                "38",
                "37",
                "36",
                "35",
                "34",
                "33",
                "32",
                "31",
                "True",
                "RA42",
                "1",
                string.Empty),
            output);
    }

    [Fact]
    public void UnmanagedCdeclField_RealNativeAddress_Runs()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var defaultSymbolHandle = RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
            ? "-2"
            : "0";
        var source = $$"""
            package Issue3523Unmanaged
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "dlsym")
            func native_dlsym(handle nint, name string) unmanaged[Cdecl] (int32) -> int32;

            unsafe struct NativeDispatch {
                var Apply unmanaged[Cdecl] (int32) -> int32
            }

            unsafe func Main() {
                let dispatch = NativeDispatch{
                    Apply: native_dlsym(nint({{defaultSymbolHandle}}), "abs")
                }
                Console.WriteLine(dispatch.Apply(-41))
            }
            """;

        Assert.Equal($"41{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Compile(source, out var outputPath);
        try
        {
            VerifyFunctionPointerAssembly(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = outputDirectory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var standardOutput = process.StandardOutput.ReadToEnd();
            var standardError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{standardOutput}\nstderr:\n{standardError}");
            return standardOutput.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            DeleteDirectory(outputDirectory);
        }
    }

    private static string Compile(string source, out string outputPath)
    {
        var outputDirectory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3523",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);

        var sourcePath = Path.Combine(outputDirectory, "Program.gs");
        outputPath = Path.Combine(outputDirectory, "Issue3523.dll");
        File.WriteAllText(sourcePath, source);

        using var standardOut = new StringWriter();
        using var standardError = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(standardOut);
        Console.SetError(standardError);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{standardOut}\nstderr:\n{standardError}");
        return outputDirectory;
    }

    private static void VerifyFunctionPointerAssembly(string outputPath)
    {
        try
        {
            IlVerifier.Verify(outputPath, null, UnsafeIlVerifyIgnored);
        }
        catch (Exception exception)
            when (exception.Message.Contains(
                "ImportCalli not implemented",
                StringComparison.Ordinal))
        {
        }
    }

    private static bool ContainsCalli(string outputPath)
    {
        using var peReader = new PEReader(File.OpenRead(outputPath));
        var metadata = peReader.GetMetadataReader();
        foreach (var methodHandle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(methodHandle);
            if (method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var instructions = IlInstructionReader.Read(body.GetILBytes() ?? Array.Empty<byte>());
            if (instructions.Any(instruction => instruction.OpCode == OpCodes.Calli))
            {
                return true;
            }
        }

        return false;
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch
        {
        }
    }
}
