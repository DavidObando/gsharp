package GSharp.Sdk.Tests

import Gsharp.NET.Sdk.Tools
import System
import System.Diagnostics
import System.IO
import System.IO.Compression
import System.Linq
import System.Security
import System.Security.Cryptography
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

/// Checks dependency references through the real SDK build and compiler.
class Issue5493CompilerReferenceClosureTests : IDisposable {
    private let directory string = Path.Combine(
        RepoRoot.Path,
        "out",
        "5493",
        "tests with spaces",
        Guid.NewGuid().ToString("N")
    )
    private let log ITestOutputHelper

    init(log ITestOutputHelper) {
        this.log = log
        Directory.CreateDirectory(directory)
        File.WriteAllText(
            Path.Combine(directory, "Directory.Build.props"),
            "<Project><PropertyGroup><PathMap>" + SecurityElement.Escape(directory) +
                "=/fixture</PathMap></PropertyGroup></Project>"
        )
        File.WriteAllText(Path.Combine(directory, "Directory.Build.targets"), "<Project />")
        File.WriteAllText(Path.Combine(directory, "global.json"), "{}")
        File.WriteAllText(
            Path.Combine(directory, "nuget.config"),
            `<configuration><packageSources><clear /><add key="fixture" value="feed" /></packageSources></configuration>`
        )
    }

    func Dispose() -> Directory.Delete(directory, recursive: true)

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Build_SuppliesLooseAndRuntimeOnlyDependencies_WithoutReplacingCompileAssets(runtimePackage bool) {
        let leaf = Path.Combine(directory, "Leaf")
        let root = Path.Combine(directory, "Root")
        let consumer = Path.Combine(directory, "Consumer")
        Directory.CreateDirectory(leaf)
        Directory.CreateDirectory(root)
        Directory.CreateDirectory(consumer)
        File.WriteAllText(
            Path.Combine(leaf, "Leaf.csproj"),
            `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>`
        )
        File.WriteAllText(
            Path.Combine(leaf, "Leaf.cs"),
            "namespace ClosureFixture; public sealed class Leaf { public static string Value => \"closure\"; }"
        )
        File.WriteAllText(Path.Combine(root, "Root.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><ProduceReferenceAssembly>true</ProduceReferenceAssembly></PropertyGroup>
  <ItemGroup><ProjectReference Include="../Leaf/Leaf.csproj" /></ItemGroup>
</Project>`)
        File.WriteAllText(
            Path.Combine(root, "Root.cs"),
            "namespace ClosureFixture; public static class Root { public static string Value => Leaf.Value; public static Leaf Related => new Leaf(); }"
        )
        Run("build", Path.Combine(root, "Root.csproj"), "-c", "Release", "-nr:false", "-v:q")
        let output = Path.Combine(root, "bin", "Release", "net10.0")
        var reference = `<Reference Include="Root"><HintPath>../Root/bin/Release/net10.0/Root.dll</HintPath></Reference>`
        if runtimePackage {
            let feed = Path.Combine(directory, "feed")
            Directory.CreateDirectory(feed)
            using let archive = ZipFile.Open(Path.Combine(feed, "Closure.1.0.0.nupkg"), ZipArchiveMode.Create)
            archive.CreateEntryFromFile(
                Path.Combine(root, "obj", "Release", "net10.0", "ref", "Root.dll"),
                "ref/net10.0/Root.dll"
            )
            archive.CreateEntryFromFile(Path.Combine(output, "Root.dll"), "lib/net10.0/Root.dll")
            archive.CreateEntryFromFile(Path.Combine(output, "Leaf.dll"), "lib/net10.0/Leaf.dll")
            using let writer = StreamWriter(archive.CreateEntry("Closure.nuspec").Open())
            writer.Write(
                `<package><metadata><id>Closure</id><version>1.0.0</version><authors>Fixture</authors><description>Dependency closure fixture</description></metadata></package>`
            )
            reference = `<PackageReference Include="Closure" Version="1.0.0" />`
        }
        let targets = SecurityElement.Escape(
            Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Current.Sdk.targets")
        )
        let tool = SecurityElement.Escape(typeof(BuildTask).Assembly.Location)
        let compiler = SecurityElement.Escape(typeof(GSharp.Compiler.Program).Assembly.Location)
        File.WriteAllText(Path.Combine(consumer, "Control.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems><RestorePackagesPath>../packages</RestorePackagesPath></PropertyGroup>
  <ItemGroup><Compile Include="Control.cs" />__REFERENCE__</ItemGroup>
</Project>`.Replace("__REFERENCE__", reference))
        File.WriteAllText(
            Path.Combine(consumer, "Control.cs"),
            "public static class Control { public static string Read() => ClosureFixture.Root.Value; }"
        )
        Run("build", Path.Combine(consumer, "Control.csproj"), "-c", "Release", "-nr:false", "-v:q")
        File.WriteAllText(Path.Combine(consumer, "Consumer.gsproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <LanguageTargets>__TARGETS__</LanguageTargets>
    <GsharpToolFullPath>__TOOL__</GsharpToolFullPath>
    <GsharpCompilerFullPath>__COMPILER__</GsharpCompilerFullPath>
    <GSharpUseSharedCompilation>false</GSharpUseSharedCompilation>
    <GsharpRunSourceGenerators>false</GsharpRunSourceGenerators>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
    <GenerateTargetFrameworkAttribute>false</GenerateTargetFrameworkAttribute>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <NuGetAudit>false</NuGetAudit>
    <RestorePackagesPath>../packages</RestorePackagesPath>
  </PropertyGroup>
  <ItemGroup><Compile Include="Consumer.gs" />__REFERENCE__</ItemGroup>
</Project>`.Replace(
                "__TARGETS__",
                targets
            ).Replace("__TOOL__", tool).Replace("__COMPILER__", compiler).Replace("__REFERENCE__", reference))
        File.WriteAllText(
            Path.Combine(consumer, "Consumer.gs"),
            "import ClosureFixture\nclass Consumer { shared { func Read() string -> Root.Value } }"
        )
        for file in Directory
            .EnumerateFiles(directory, "*", SearchOption.AllDirectories)
            .Where(
            (path string) -> path.EndsWith(".cs", StringComparison.Ordinal) || path.EndsWith(
                ".gs",
                StringComparison.Ordinal
            ) ||
                path.EndsWith(".dll", StringComparison.Ordinal)
        )
            .OrderBy((path string) -> path, StringComparer.Ordinal) {
            log.WriteLine(
                "SHA256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))) + " " + Path.GetRelativePath(
                    directory,
                    file
                )
            )
        }
        let result = Run("build", Path.Combine(consumer, "Consumer.gsproj"), "-c", "Release", "-nr:false", "-v:q")
        Assert.DoesNotContain("GS9100", result)
        let responsePath = Path.Combine(consumer, "obj", "Release", "net10.0", "Consumer.rsp")
        log.WriteLine("response:\n" + File.ReadAllText(responsePath))
        let response = File
            .ReadAllLines(responsePath)
            .SelectMany((line string) -> GSharp.Compiler.Program.TokenizeResponseFileLine(line))
            .ToArray()
        let rootReferences = response.Where(
            (line string) -> line.StartsWith("/r:", StringComparison.Ordinal) && line.EndsWith(
                "Root.dll",
                StringComparison.Ordinal
            )
        )
            .ToArray()
        Assert.NotEmpty(rootReferences)
        if runtimePackage {
            Assert.Contains("/ref/net10.0/Root.dll", rootReferences[0].Replace('\\', '/'))
        }
        Assert.Contains(
            response,
            (line string) -> line.StartsWith("/r:", StringComparison.Ordinal) && line.EndsWith(
                "Leaf.dll",
                StringComparison.Ordinal
            )
        )
        Assert.True(File.Exists(Path.Combine(consumer, "bin", "Release", "net10.0", "Consumer.dll")))
    }

    private func Run(arguments ...string) string {
        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        for argument in arguments {
            start.ArgumentList.Add(argument)
        }
        log.WriteLine("argv: dotnet " + System.Text.Json.JsonSerializer.Serialize(arguments))
        start.Environment["TMPDIR"] = directory
        start.Environment["TMP"] = directory
        start.Environment["TEMP"] = directory
        using let process = Process.Start(start) ?? throw InvalidOperationException("Cannot start the SDK fixture.")
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(120000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("The SDK fixture did not finish.")
        }
        Task.WaitAll(stdout, stderr)
        log.WriteLine("stdout:\n" + stdout.Result)
        log.WriteLine("stderr:\n" + stderr.Result)
        let output = stdout.Result + stderr.Result
        Assert.True(process.ExitCode == 0, output)
        return output
    }
}
