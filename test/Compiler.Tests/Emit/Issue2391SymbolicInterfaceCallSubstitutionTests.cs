// <copyright file="Issue2391SymbolicInterfaceCallSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2391: calls through an imported generic interface closed over a
/// same-compilation source type must substitute parameter and return positions
/// from the same symbolic receiver mapping.
/// </summary>
public class Issue2391SymbolicInterfaceCallSubstitutionTests
{
    private const string CSharpContracts = """
        namespace Issue2391.Contracts
        {
            public interface IRepo<T>
                where T : struct
            {
                T? Find();

                T? Echo(T? value);
            }
        }
        """;

    [Fact]
    public void SourceEnum_NullableParameterAndReturnThroughInterface_CompilesRunsAndVerifies()
    {
        var source = """
            package Issue2391Enum
            import System
            import Issue2391.Contracts

            enum Color { Red, Green, Blue }

            class ColorRepo : IRepo[Color] {
                func Find() Color? { return Color.Green }
                func Echo(value Color?) Color? { return value }
            }

            func Read(repo IRepo[Color]) Color? {
                return repo.Find()
            }

            func Main() {
                var repo IRepo[Color] = ColorRepo()
                var found Color? = Read(repo)
                var input Color? = Color.Blue
                var echoed Color? = repo.Echo(input)
                Console.WriteLine(found == Color.Green)
                Console.WriteLine(echoed == Color.Blue)
            }
            """;

        Assert.Equal("True\nTrue\n", CompileAndRunWithContracts(source));
    }

    [Fact]
    public void SourceStruct_NullableParameterAndReturnThroughInterface_CompilesRunsAndVerifies()
    {
        var source = """
            package Issue2391Struct
            import System
            import Issue2391.Contracts

            struct Token {
                var Value int32
            }

            class TokenRepo : IRepo[Token] {
                func Find() Token? { return Token{ Value: 41 } }
                func Echo(value Token?) Token? { return value }
            }

            func Main() {
                var repo IRepo[Token] = TokenRepo()
                var input Token? = Token{ Value: 42 }
                var found Token? = repo.Find()
                var echoed Token? = repo.Echo(input)
                Console.WriteLine((found!!).Value)
                Console.WriteLine((echoed!!).Value)
            }
            """;

        Assert.Equal("41\n42\n", CompileAndRunWithContracts(source));
    }

    [Fact]
    public void SymbolicInterfaceReturn_DoesNotConvertToUnrelatedSourceType()
    {
        var source = """
            package Issue2391Negative
            import Issue2391.Contracts

            enum Color { Red, Green }
            enum Other { A, B }

            class ColorRepo : IRepo[Color] {
                func Find() Color? { return Color.Green }
                func Echo(value Color?) Color? { return value }
            }

            func Bad(repo IRepo[Color]) Other? {
                return repo.Find()
            }
            """;

        var (exitCode, stdout, stderr) = CompileWithContracts(source, run: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0155", stdout + stderr, StringComparison.Ordinal);
    }

    [Fact]
    public void SymbolicInterfaceParameter_DoesNotAcceptUnrelatedSourceType()
    {
        var source = """
            package Issue2391ParameterNegative
            import Issue2391.Contracts

            enum Color { Red, Green }
            enum Other { A, B }

            class ColorRepo : IRepo[Color] {
                func Find() Color? { return Color.Green }
                func Echo(value Color?) Color? { return value }
            }

            func Bad(repo IRepo[Color], value Other?) Color? {
                return repo.Echo(value)
            }
            """;

        var (exitCode, stdout, stderr) = CompileWithContracts(source, run: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0155", stdout + stderr, StringComparison.Ordinal);
    }

    [Fact]
    public void ClosedBclTypeArgument_ControlStillRuns()
    {
        var source = """
            package Issue2391Control
            import System
            import Issue2391.Contracts

            class GuidRepo : IRepo[Guid] {
                func Find() Guid? { return nil }
                func Echo(value Guid?) Guid? { return value }
            }

            func Main() {
                var value Guid = Guid.NewGuid()
                var repo IRepo[Guid] = GuidRepo()
                Console.WriteLine(repo.Echo(value) == value)
            }
            """;

        Assert.Equal("True\n", CompileAndRunWithContracts(source));
    }

    private static string CompileAndRunWithContracts(string source)
    {
        var (exitCode, stdout, stderr) = CompileWithContracts(source, run: true);
        Assert.True(exitCode == 0, $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileWithContracts(string source, bool run)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2391_").FullName;
        try
        {
            var contractPath = EmitCSharpContracts(tempDir);
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                run ? "/target:exe" : "/target:library",
                "/targetframework:net10.0",
                "/reference:" + contractPath,
                "/nowarn:GS9100",
            };
            foreach (var reference in BclReferences.Value)
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
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

            if (compileExit != 0 || !run)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

            IlVerifier.Verify(outPath, additionalReferences: new[] { contractPath });

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            return (process.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
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

    private static string EmitCSharpContracts(string outputDirectory)
    {
        var outputPath = Path.Combine(outputDirectory, "Issue2391.Contracts.dll");
        var syntaxTree = CSharpSyntaxTree.ParseText(CSharpContracts, new CSharpParseOptions(LanguageVersion.Latest));
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2391.Contracts",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator).Where(File.Exists);
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        return string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory)
            ? Array.Empty<string>()
            : Directory.EnumerateFiles(runtimeDirectory, "*.dll", SearchOption.TopDirectoryOnly).ToList();
    });
}
