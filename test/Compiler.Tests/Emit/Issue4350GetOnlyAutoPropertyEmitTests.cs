// <copyright file="Issue4350GetOnlyAutoPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4350: a get-only auto-property assigned in its declaring
/// constructor stores the backing field directly, so the emitted property
/// keeps C#'s get-only ABI — no setter or init accessor in metadata.
/// </summary>
public class Issue4350GetOnlyAutoPropertyEmitTests
{
    [Fact]
    public void ConstructorStores_EmitNoSetter()
    {
        var source = """
            package P
            import System

            struct Window[T] {
                init(items []T, length int32) {
                    Items = items
                    Length = length
                    this.Capacity = items.Length
                    Length += 0
                }
                prop Items []T { get; }
                prop Length int32 { get; }
                prop Capacity int32 { get; }
            }

            class Named {
                init(name string) {
                    Name = name
                    Count++
                }
                prop Name string { get; }
                prop Count int32 { get; }
            }

            let window = Window[string]([]string{"a", "b", "c"}, 2)
            Console.WriteLine(window.Length)
            Console.WriteLine(window.Capacity)
            let named = Named("n")
            Console.WriteLine(named.Name + named.Count.ToString())
            Console.WriteLine(typeof(Window[string]).GetProperty("Length")!!.SetMethod == nil)
            Console.WriteLine(typeof(Window[string]).GetProperty("Capacity")!!.SetMethod == nil)
            Console.WriteLine(typeof(Named).GetProperty("Name")!!.SetMethod == nil)
            Console.WriteLine(typeof(Named).GetProperty("Count")!!.CanWrite)
            """;

        Assert.Equal(Lines("2", "3", "n1", "True", "True", "True", "False"), CompileAndRun(source));
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_getonly_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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

            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
