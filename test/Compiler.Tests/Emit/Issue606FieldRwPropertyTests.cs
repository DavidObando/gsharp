// <copyright file="Issue606FieldRwPropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #606: extend field-satisfies-property contract to read-write properties.
/// A public mutable G# field should satisfy a CLR interface property with both
/// getter and setter (previously only getter-only was supported per #573).
/// </summary>
public class Issue606FieldRwPropertyTests
{
    [Fact]
    public void MutableField_SatisfiesReadWritePropertyContract_BothAccessorsWork()
    {
        var sibling = """
            namespace ProbeRef606
            {
                public interface IReadWrite
                {
                    string Value { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type Impl class : IReadWrite {
                Value string
            }

            var impl = Impl{Value: "hello"}
            var iface IReadWrite = impl
            Console.WriteLine(iface.Value)
            iface.Value = "world"
            Console.WriteLine(iface.Value)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Equal("hello\nworld\n", output);
    }

    [Fact]
    public void MutableField_SatisfiesReadWritePropertyContract_SetterModifiesField()
    {
        var sibling = """
            namespace ProbeRef606
            {
                public interface ICounter
                {
                    int Count { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type Counter class : ICounter {
                Count int32
            }

            var c = Counter{Count: 0}
            var iface ICounter = c
            iface.Count = 42
            Console.WriteLine(c.Count)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void MutableField_SatisfiesReadWritePropertyContract_GetterReadsField()
    {
        var sibling = """
            namespace ProbeRef606
            {
                public interface IReadWrite
                {
                    string Name { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type Named class : IReadWrite {
                Name string
            }

            var n = Named{Name: "initial"}
            n.Name = "direct"
            var iface IReadWrite = n
            Console.WriteLine(iface.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Equal("direct\n", output);
    }

    [Fact]
    public void Field_StillSatisfiesGetterOnlyContract()
    {
        // Regression: #573 behavior is preserved.
        var sibling = """
            namespace ProbeRef606
            {
                public interface IGetOnly
                {
                    string Name { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type GetImpl class : IGetOnly {
                Name string
            }

            var impl = GetImpl{Name: "getter-only"}
            var iface IGetOnly = impl
            Console.WriteLine(iface.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Equal("getter-only\n", output);
    }

    [Fact]
    public void PrivateField_DoesNotSatisfyReadWriteContract_ErrorsGS0187()
    {
        // A non-public field cannot satisfy a public interface property contract.
        var sibling = """
            namespace ProbeRef606
            {
                public interface IReadWrite
                {
                    string Value { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type BadImpl class : IReadWrite {
                private Value string
            }
            """;

        var errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Contains(errors, e => e.Contains("GS0187"));
    }

    [Fact]
    public void WrongTypeField_DoesNotSatisfyReadWriteContract_ErrorsGS0187()
    {
        // A field with mismatched type cannot satisfy the property contract.
        var sibling = """
            namespace ProbeRef606
            {
                public interface IReadWrite
                {
                    string Value { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type BadImpl class : IReadWrite {
                Value int32
            }
            """;

        var errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Contains(errors, e => e.Contains("GS0187"));
    }

    [Fact]
    public void ClassOmittingFieldEntirely_StillReportsGS0187()
    {
        var sibling = """
            namespace ProbeRef606
            {
                public interface IReadWrite
                {
                    string Value { get; set; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef606

            type Empty class : IReadWrite {
            }
            """;

        var errors = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "ProbeRef606");
        Assert.Contains(errors, e => e.Contains("GS0187"));
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue606_sib_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);
            IlVerifier.Verify(outPath, additionalReferences: new[] { siblingDll });

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

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue606_err_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static void RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
