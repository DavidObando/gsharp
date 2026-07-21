// <copyright file="Issue2579NullableReferenceFidelityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2579NullableReferenceFidelityEmitTests
{
    [Fact]
    public void GuardedNullableReferences_ExecuteAcrossMemberArgumentIndexAndForeachBoundaries()
    {
        string output = CompileAndRun("""
            package Issue2579
            import System
            import System.Collections.Generic

            func Length(value string) int32 -> value.Length

            var value string? = "key"
            var list = List[string]()
            list.Add("a")
            list.Add("b")
            var values IEnumerable[string]? = list
            var dict = Dictionary[string, int32]()
            var total = 0

            if value != nil {
                var assigned string = value
                total += Length(value)
                dict[value] = assigned.Length
            }

            if !String.IsNullOrEmpty(value) {
                total += Length(value)
            }

            if values != nil {
                for item in values {
                    total += item.Length
                }
            }

            total += Length(value!!)
            Console.WriteLine(total)
            """);

        Assert.Equal("11\n", output);
    }

    private static string CompileAndRun(string source)
    {
        string directory = Directory.CreateTempSubdirectory("gs_issue2579_").FullName;
        try
        {
            string sourcePath = Path.Combine(directory, "test.gs");
            string outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var args = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            foreach (string reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
            args.Add(sourcePath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            TextWriter previousOut = Console.Out;
            TextWriter previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\n{compileOut}\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using Process process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start emitted program.");
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "Emitted program timed out.");
            Assert.True(process.ExitCode == 0, stderr);
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        string assemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(assemblies))
        {
            yield break;
        }

        foreach (string path in assemblies.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
