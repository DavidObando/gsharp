// <copyright file="Issue2735ConstructedGenericCoalesceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

class Issue2735ConstructedGenericCoalesceEmitTests {
    @Fact
    func OahuServiceProbe_PreservesUserFrameworkAndNestedCategoryTypesAtRuntime() {
        const source = `package Issue2735
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
}`
        using let result = Compile(source, "exe")
        Assert.Equal(
            "Microsoft.Extensions.Logging.Abstractions.NullLogger`1[Issue2735.Store]${Environment.NewLine}" +
                "Microsoft.Extensions.Logging.Abstractions.NullLogger`1[System.String]${Environment.NewLine}" +
                "Microsoft.Extensions.Logging.Abstractions.NullLogger`1[System.Collections.Generic.List`1[Issue2735.Store]]${Environment.NewLine}",
            Run(result.OutputPath)
        )
        IlVerifier.Verify(result.OutputPath, additionalReferences: result.References)
    }

    @Fact
    func DifferentUserCategory_DoesNotBindThroughObjectErasure() {
        const source = `package Issue2735.UserNegative
import Microsoft.Extensions.Logging
import Microsoft.Extensions.Logging.Abstractions

class Store {}
class Other {}

func Bad(logger ILogger[Store]?) ILogger[Store] {
    return logger ?? NullLogger[Other].Instance
}`
        using let result = Compile(source, "library", expectSuccess: false)
        Assert.Contains("GS0129", result.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func DifferentNestedCategory_DoesNotBindThroughObjectErasure() {
        const source = `package Issue2735.NestedNegative
import System.Collections.Generic
import Microsoft.Extensions.Logging
import Microsoft.Extensions.Logging.Abstractions

class Store {}
class Other {}

func Bad(logger ILogger[List[Store]]?) ILogger[List[Store]] {
    return logger ?? NullLogger[List[Other]].Instance
}`
        using let result = Compile(source, "library", expectSuccess: false)
        Assert.Contains("GS0129", result.Diagnostics, StringComparison.Ordinal)
    }

    private class CompilationResult : IDisposable {
        init(directory string, outputPath string, references[]string, diagnostics string) {
            Directory = directory
            OutputPath = outputPath
            References = references
            Diagnostics = diagnostics
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop References[]string {
            get;
        }

        prop Diagnostics string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func Compile(
            source string,
            target string,
            expectSuccess bool = true
        ) Issue2735ConstructedGenericCoalesceEmitTests
            .CompilationResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2735-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            let references = GetFrameworkReferences()
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            args.AddRange(references.Select((path string) -> ("/reference:" + path)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            let diagnostics = stdout.ToString() + stderr.ToString()
            Assert.True(
                expectSuccess == (exitCode == 0),
                (`expected success: ` + "$expectSuccess" + `; exit code: ` + "$exitCode" + `
` + "$diagnostics")
            )
            return Issue2735ConstructedGenericCoalesceEmitTests.CompilationResult(
                directory,
                outputPath,
                references,
                diagnostics
            )
        }

        private func Run(outputPath string) string {
            File.WriteAllText(Path.ChangeExtension(outputPath, ".runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}`)
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(outputPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(outputPath)
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

        private func GetFrameworkReferences()[]string {
            let coreDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let sharedDirectory = Directory.GetParent(coreDirectory)!!.Parent!!.FullName
            let aspNetDirectory = Path.Combine(
                sharedDirectory,
                "Microsoft.AspNetCore.App",
                Path.GetFileName(coreDirectory)
            )
            Assert.True(Directory.Exists(aspNetDirectory), "Missing ASP.NET Core runtime: $aspNetDirectory")
            return Directory
                .GetFiles(coreDirectory, "*.dll")
                .Concat(Directory.GetFiles(aspNetDirectory, "*.dll"))
                .ToArray()
        }
    }
}
