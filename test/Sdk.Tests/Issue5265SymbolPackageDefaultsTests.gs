package GSharp.Sdk.Tests

import System
import System.Diagnostics
import System.IO
import System.Text.Json
import System.Threading.Tasks
import System.Xml.Linq
import Xunit

class Issue5265SymbolPackageDefaultsTests : IDisposable {
    private let directory string = Path.Combine(
        RepoRoot.Path,
        "out",
        "test",
        "Issue5265SymbolPackageDefaultsTests",
        Guid.NewGuid().ToString("N")
    )

    @Fact
    func SymbolDefaultsUseEvaluatedBuildOutputAndPreserveExplicitProperties() {
        Directory.CreateDirectory(directory)
        File.WriteAllText(Path.Combine(directory, "Directory.Build.props"), "<Project />")
        File.WriteAllText(Path.Combine(directory, "Directory.Build.targets"), "<Project />")
        AssertProperties("", "", "", "true", "true", "snupkg")
        AssertProperties("true", "false", "", "true", "false", "snupkg")
        AssertProperties("false", "true", "symbols.nupkg", "false", "true", "symbols.nupkg")
        AssertProperties("false", "false", "", "false", "false", "snupkg")
        AssertProperties("false", "", "", "false", "false", "snupkg")

        // Directory.Build.targets loads after the project body, before the SDK assigns its default.
        File.WriteAllText(
            Path.Combine(directory, "Directory.Build.targets"),
            "<Project><PropertyGroup><IncludeBuildOutput>false</IncludeBuildOutput></PropertyGroup></Project>"
        )
        AssertProperties("", "", "", "false", "false", "snupkg")
    }

    func Dispose() {
        if Directory.Exists(directory) {
            Directory.Delete(directory, recursive: true)
        }
    }

    private func AssertProperties(
        buildOutput string,
        symbols string,
        format string,
        expectedBuildOutput string,
        expectedSymbols string,
        expectedFormat string
    ) {
        let group = XElement(XName?("PropertyGroup")!!, XElement(XName?("TargetFramework")!!, "net10.0"))
        if buildOutput != "" {
            group.Add(XElement(XName?("IncludeBuildOutput")!!, buildOutput))
        }
        if symbols != "" {
            group.Add(XElement(XName?("IncludeSymbols")!!, symbols))
        }
        if format != "" {
            group.Add(XElement(XName?("SymbolPackageFormat")!!, format))
        }
        XDocument(
            XElement(
                XName?("Project")!!,
                XElement(
                    XName?("Import")!!,
                    XAttribute(XName?("Project")!!, Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props"))
                ),
                group,
                XElement(
                    XName?("Import")!!,
                    XAttribute(XName?("Project")!!, Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.targets"))
                )
            )
        ).Save(Path.Combine(directory, "Probe.gsproj"))
        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in[]string{
            "msbuild",
            "Probe.gsproj",
            "-nologo",
            "-nr:false",
            "-getProperty:IncludeBuildOutput,IncludeSymbols,SymbolPackageFormat"
        } {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Cannot evaluate SDK defaults.")
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(60_000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("SDK property evaluation timed out.")
        }
        Task.WaitAll(stdout, stderr)
        let exitCode = process.ExitCode
        Assert.True(
            exitCode == 0,
            "SDK property evaluation exited $exitCode.\nstdout:\n${stdout.Result}\nstderr:\n${stderr.Result}"
        )
        using let result = JsonDocument.Parse(stdout.Result)
        let properties = result.RootElement.GetProperty("Properties")
        Assert.Equal(expectedBuildOutput, properties.GetProperty("IncludeBuildOutput").GetString())
        Assert.Equal(expectedSymbols, properties.GetProperty("IncludeSymbols").GetString())
        Assert.Equal(expectedFormat, properties.GetProperty("SymbolPackageFormat").GetString())
    }
}
