// <copyright file="Issue2735ConstructedGenericCoalesceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2735ConstructedGenericCoalesceEmitTests
{
    [Fact]
    public void OahuServiceProbe_PreservesUserFrameworkAndNestedCategoryTypesAtRuntime()
    {
        const string source = """
            package Issue2735
            import System
            import System.Collections.Generic
            import Microsoft.Extensions.Logging
            import Microsoft.Extensions.Logging.Abstractions

            class Store {}

            class Service {
                private let logger ILogger[Store]

                init(logger ILogger[Store]?) {
                    this.logger = logger ?? NullLogger[Store].Instance
                }

                func LoggerType() string -> logger!!.GetType().ToString()!!
            }

            func Main() {
                Console.WriteLine(Service(nil).LoggerType())
                let framework ILogger[string] = nil ?? NullLogger[string].Instance
                Console.WriteLine(framework!!.GetType().ToString())
                let nested ILogger[List[Store]] = nil ?? NullLogger[List[Store]].Instance
                Console.WriteLine(nested!!.GetType().ToString())
            }
            """;

        using var result = Compile(source, "exe");
        Assert.Equal(
            "Microsoft.Extensions.Logging.Abstractions.NullLogger`1[Issue2735.Store]\n"
                + "Microsoft.Extensions.Logging.Abstractions.NullLogger`1[System.String]\n"
                + "Microsoft.Extensions.Logging.Abstractions.NullLogger`1[System.Collections.Generic.List`1[Issue2735.Store]]\n",
            Run(result.OutputPath));
        IlVerifier.Verify(result.OutputPath, additionalReferences: result.References);
    }

    [Fact]
    public void DifferentUserCategory_DoesNotBindThroughObjectErasure()
    {
        const string source = """
            package Issue2735.UserNegative
            import Microsoft.Extensions.Logging
            import Microsoft.Extensions.Logging.Abstractions

            class Store {}
            class Other {}

            func Bad(logger ILogger[Store]?) ILogger[Store] {
                return logger ?? NullLogger[Other].Instance
            }
            """;

        using var result = Compile(source, "library", expectSuccess: false);
        Assert.Contains("GS0129", result.Diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void DifferentNestedCategory_DoesNotBindThroughObjectErasure()
    {
        const string source = """
            package Issue2735.NestedNegative
            import System.Collections.Generic
            import Microsoft.Extensions.Logging
            import Microsoft.Extensions.Logging.Abstractions

            class Store {}
            class Other {}

            func Bad(logger ILogger[List[Store]]?) ILogger[List[Store]] {
                return logger ?? NullLogger[List[Other]].Instance
            }
            """;

        using var result = Compile(source, "library", expectSuccess: false);
        Assert.Contains("GS0129", result.Diagnostics, StringComparison.Ordinal);
    }

    private static CompilationResult Compile(string source, string target, bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2735-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        var references = GetFrameworkReferences();
        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        args.AddRange(references.Select(path => "/reference:" + path));
        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        var diagnostics = stdout.ToString() + stderr;
        Assert.True(
            expectSuccess == (exitCode == 0),
            $"expected success: {expectSuccess}; exit code: {exitCode}\n{diagnostics}");
        return new CompilationResult(directory, outputPath, references, diagnostics);
    }

    private static string Run(string outputPath)
    {
        File.WriteAllText(
            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
            """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "frameworks": [
                  { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
                  { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
                ]
              }
            }
            """);

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(outputPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static string[] GetFrameworkReferences()
    {
        var coreDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var sharedDirectory = Directory.GetParent(coreDirectory)!.Parent!.FullName;
        var aspNetDirectory = Path.Combine(
            sharedDirectory,
            "Microsoft.AspNetCore.App",
            Path.GetFileName(coreDirectory));
        Assert.True(Directory.Exists(aspNetDirectory), $"Missing ASP.NET Core runtime: {aspNetDirectory}");
        return Directory.GetFiles(coreDirectory, "*.dll")
            .Concat(Directory.GetFiles(aspNetDirectory, "*.dll"))
            .ToArray();
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(
            string directory,
            string outputPath,
            string[] references,
            string diagnostics)
        {
            Directory = directory;
            OutputPath = outputPath;
            References = references;
            Diagnostics = diagnostics;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public string[] References { get; }

        public string Diagnostics { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
