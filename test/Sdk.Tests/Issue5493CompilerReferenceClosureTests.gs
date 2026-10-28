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
    func Build_TracksLooseAndRuntimeOnlyDependencies_WithoutReplacingCompileAssets(runtimePackage bool) {
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
        let producer = Run("build", Path.Combine(root, "Root.csproj"), "-c", "Release", "-nr:false", "-v:q")
        Assert.True(producer.ExitCode == 0, producer.Output)
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
        let control = Run("build", Path.Combine(consumer, "Control.csproj"), "-c", "Release", "-nr:false", "-v:q")
        Assert.True(control.ExitCode == 0, control.Output)
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
    <WarningsAsErrors>GS9100</WarningsAsErrors>
    <NuGetAudit>false</NuGetAudit>
    <RestorePackagesPath>../packages</RestorePackagesPath>
  </PropertyGroup>
  <ItemGroup><Compile Include="Consumer.gs" />__REFERENCE__</ItemGroup>
  <Target Name="RemoveFixtureDependency" BeforeTargets="_GsharpCreateCoreCompileInputsCache" Condition="'$(OmitFixtureDependency)' == 'true'">
    <ItemGroup>
      <ReferenceDependencyPaths Remove="@(ReferenceDependencyPaths)" Condition="'%(Filename)' == 'Leaf'" />
      <RuntimeCopyLocalItems Remove="@(RuntimeCopyLocalItems)" Condition="'%(Filename)' == 'Leaf'" />
    </ItemGroup>
  </Target>
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
        Assert.True(result.ExitCode == 0, result.Output)
        Assert.DoesNotContain("GS9100", result.Output)
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
        let image = Path.Combine(consumer, "bin", "Release", "net10.0", "Consumer.dll")
        Assert.True(File.Exists(image))
        let imageTime = File.GetLastWriteTimeUtc(image)
        let cache = Path.Combine(consumer, "obj", "Release", "net10.0", "Consumer.CoreCompileInputs.cache")
        let cacheBefore = File.ReadAllText(cache)
        let cacheTime = File.GetLastWriteTimeUtc(cache)
        let inputs = response
            .Where((argument string) -> argument.StartsWith("/r:", StringComparison.Ordinal))
            .Select((argument string) -> argument.Substring(3))
            .Concat(
            []string{
                Path.Combine(consumer, "Consumer.gs"),
                Path.Combine(consumer, "Consumer.gsproj"),
                Path.Combine(directory, "Directory.Build.props"),
                Path.Combine(directory, "Directory.Build.targets"),
                Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Current.Sdk.targets"),
                Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
            }
        )
            .ToArray()
        let inputTimes = inputs.Select((path string) -> File.GetLastWriteTimeUtc(path)).ToArray()
        let inputHashes = inputs.Select((path string) -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))))
            .ToArray()
        let unchanged = Run(
            "build",
            Path.Combine(consumer, "Consumer.gsproj"),
            "--no-restore",
            "-c",
            "Release",
            "-nr:false",
            "-v:n"
        )
        Assert.True(unchanged.ExitCode == 0, unchanged.Output)
        Assert.Equal(imageTime, File.GetLastWriteTimeUtc(image))
        Assert.Equal(cacheBefore, File.ReadAllText(cache))
        Assert.Equal(cacheTime, File.GetLastWriteTimeUtc(cache))

        let removed = Run(
            "build",
            Path.Combine(consumer, "Consumer.gsproj"),
            "--no-restore",
            "-p:OmitFixtureDependency=true",
            "-c",
            "Release",
            "-nr:false",
            "-v:n"
        )
        log.WriteLine("cache before removal: " + cacheBefore)
        log.WriteLine("cache after removal: " + File.ReadAllText(cache))
        log.WriteLine("output before removal: " + imageTime.ToString("O"))
        log.WriteLine("output after removal: " + File.GetLastWriteTimeUtc(image).ToString("O"))
        for var index = 0; index < inputs.Length; index++ {
            let time = File.GetLastWriteTimeUtc(inputs[index])
            let hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(inputs[index])))
            log.WriteLine("unchanged input: " + time.ToString("O") + " " + hash + " " + inputs[index])
            Assert.Equal(inputTimes[index], time)
            Assert.Equal(inputHashes[index], hash)
            Assert.True(time <= imageTime)
        }
        Assert.True(removed.ExitCode == 1, removed.Output)
        Assert.Contains("error GS9100:", removed.Output)
        Assert.Contains("not supplied via /r: (Leaf)", removed.Output)
        Assert.NotEqual(cacheBefore, File.ReadAllText(cache))
    }

    private func Run(arguments ...string)(ExitCode int32, Output string) {
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
        log.WriteLine("exit: " + process.ExitCode.ToString())
        log.WriteLine("stdout:\n" + stdout.Result)
        log.WriteLine("stderr:\n" + stderr.Result)
        return (process.ExitCode, stdout.Result + stderr.Result)
    }
}
