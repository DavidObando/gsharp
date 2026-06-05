// <copyright file="SampleConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.LanguageConformance;

/// <summary>
/// End-to-end conformance harness: every `.gs` file under `samples/` that has a
/// sibling `.golden` file is compiled through `gsc.dll`, executed under `dotnet`,
/// and its stdout is compared bit-for-bit against the golden.
/// </summary>
/// <remarks>
/// This is the executable spec for the parseable subset of GSharp. Per
/// `docs/adr/0010-aspirational-samples.md`, every sample under `samples/` MUST
/// build, run, and produce its golden output on every PR. Aspirational samples
/// belong under `samples/aspirational/` (excluded from discovery) and are not
/// covered by this harness.
/// </remarks>
public class SampleConformanceTests
{
    public static IEnumerable<object[]> Samples()
    {
        var samplesDir = LocateSamplesDirectory();
        if (samplesDir is null)
        {
            yield break;
        }

        // Single-file samples: <name>.gs paired with <name>.golden in samples/.
        foreach (var gs in Directory.EnumerateFiles(samplesDir, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(p => p))
        {
            var golden = Path.ChangeExtension(gs, ".golden");
            if (File.Exists(golden))
            {
                yield return new object[] { Path.GetFileName(gs) };
            }
        }

        // Multi-file samples: subdirectories of samples/ that contain *.gs and a
        // single <DirName>.golden. All .gs files in the directory are compiled
        // into one assembly per ADR-0028.
        foreach (var sub in Directory.EnumerateDirectories(samplesDir).OrderBy(p => p))
        {
            var dirName = Path.GetFileName(sub);
            if (string.Equals(dirName, "aspirational", StringComparison.Ordinal))
            {
                continue;
            }

            var golden = Path.Combine(sub, dirName + ".golden");
            if (File.Exists(golden) && Directory.EnumerateFiles(sub, "*.gs").Any())
            {
                yield return new object[] { dirName + "/" };
            }
        }
    }

    [Theory]
    [MemberData(nameof(Samples))]
    public void Sample_BuildsAndMatchesGolden(string sampleName)
    {
        var samplesDir = LocateSamplesDirectory();
        Assert.NotNull(samplesDir);

        string[] sourceFiles;
        string goldenPath;
        string baseName;
        if (sampleName.EndsWith("/", StringComparison.Ordinal))
        {
            var dirName = sampleName.TrimEnd('/');
            var sampleDir = Path.Combine(samplesDir, dirName);
            sourceFiles = Directory.EnumerateFiles(sampleDir, "*.gs").OrderBy(p => p).ToArray();
            goldenPath = Path.Combine(sampleDir, dirName + ".golden");
            baseName = dirName;
        }
        else
        {
            var samplePath = Path.Combine(samplesDir, sampleName);
            sourceFiles = new[] { samplePath };
            goldenPath = Path.ChangeExtension(samplePath, ".golden");
            baseName = Path.GetFileNameWithoutExtension(sampleName);
        }

        var expected = File.ReadAllText(goldenPath).Replace("\r\n", "\n");

        var tempDir = Directory.CreateTempSubdirectory($"gs_conformance_{baseName}_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, baseName + ".dll");

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                var args = new List<string>
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                };
                args.AddRange(sourceFiles);
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed for {sampleName}:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.GetKnownIssuesForSample(baseName));
            Assert.True(File.Exists(outPath), $"expected emitted assembly at {outPath}");

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
            Assert.True(proc.WaitForExit(30_000), $"dotnet exec timed out for {sampleName}");
            Assert.True(
                proc.ExitCode == 0,
                $"sample {sampleName} exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            var actual = stdout.Replace("\r\n", "\n");
            Assert.Equal(expected, actual);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string LocateSamplesDirectory()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(SampleConformanceTests).Assembly.Location));
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "samples");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
