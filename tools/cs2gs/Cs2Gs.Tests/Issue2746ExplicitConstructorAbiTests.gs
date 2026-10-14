// <copyright file="Issue2746ExplicitConstructorAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

class Issue2746ExplicitConstructorAbiTests {
    @Fact
    func ExplicitConstructorsAndGetOnlyProperties_KeepDeclaredShape() {
        let unit = Translate()
        AssertClassShape(
            unit,
            "OutputContext",
            []string{"format", "quiet", "useColor", "useAscii"},
            []string{"Format", "Quiet", "UseColor", "UseAscii"}
        )
        AssertClassShape(
            unit,
            "CapabilityPolicy",
            []string{"transport", "unattended"},
            []string{"Transport", "Unattended"}
        )
        let fieldBacked = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == "FieldBackedPolicy")
        AssertClassShape(unit, "FieldBackedPolicy", []string{"route", "enabled"}, []string{"Route", "Enabled"})
        Assert.All(
            fieldBacked.Members.OfType[FieldDeclaration](),
            (field FieldDeclaration) -> Assert.Equal(Visibility.Private, field.Visibility)
        )
    }

    @Fact
    func TranslatedLibrary_RealCSharpConsumerUsesNamedArgumentsAndProperties() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2746-csharp-consumer", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "Oahu.Cli.gs")
        let dllPath = Path.Combine(workDir, "Oahu.Cli.dll")
        File.WriteAllText(Path.Combine(workDir, "Directory.Build.props"), "<Project></Project>")
        File.WriteAllText(gsPath, GSharpPrinter.Print(Translate()))
        AssertProcessSucceeds(
            "dotnet",
            workDir,
            compiler,
            "/target:library",
            "/targetframework:net10.0",
            "/out:" + dllPath,
            gsPath
        )
        let consumerDir = Path.Combine(workDir, "Consumer")
        Directory.CreateDirectory(consumerDir)
        File.WriteAllText(Path.Combine(consumerDir, "Consumer.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Oahu.Cli">
      <HintPath>` + "$dllPath" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
        File.WriteAllText(Path.Combine(consumerDir, "Program.cs"), `using System;
using Oahu.Cli;

var output = new OutputContext(
    format: OutputFormat.Json,
    quiet: true,
    useColor: false,
    useAscii: true);
var policy = new CapabilityPolicy(
    transport: ServerTransport.Stdio,
    unattended: true);
var fieldBacked = new FieldBackedPolicy(route: "build", enabled: true);

Console.WriteLine($"{output.Format}:{output.Quiet}:{output.UseColor}:{output.UseAscii}");
Console.WriteLine($"{policy.Transport}:{policy.Unattended}");
Console.WriteLine($"{fieldBacked.Route}:{fieldBacked.Enabled}");
Console.WriteLine(typeof(FieldBackedPolicy).GetFields(
    System.Reflection.BindingFlags.Public |
    System.Reflection.BindingFlags.Instance).Length);`)
        AssertProcessSucceeds("dotnet", consumerDir, "restore", "--nologo")
        let output = AssertProcessSucceeds("dotnet", consumerDir, "run", "--no-restore", "--nologo", "-c", "Release")
        Assert.Contains("Json:True:False:True", output, StringComparison.Ordinal)
        Assert.Contains("Stdio:True", output, StringComparison.Ordinal)
        Assert.Contains("build:True", output, StringComparison.Ordinal)
        Assert.Contains(Environment.NewLine + "0" + Environment.NewLine, output, StringComparison.Ordinal)
    }

    @Fact
    func NativePrimaryConstructor_RemainsPrimaryConstructor() {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                ("Native.cs", "namespace Demo; public class Native(string value) { public string Value() => value; }")
            }
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let native = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Native")
        Assert.Equal("value", Assert.Single(native.PrimaryConstructorParameters!!).Name)
    }

    shared {
        private const Source string = `namespace Oahu.Cli;

public enum OutputFormat
{
    Text,
    Json,
}

public enum ServerTransport
{
    Stdio,
    Http,
}

public sealed class OutputContext
{
    public OutputContext(OutputFormat format, bool quiet, bool useColor, bool useAscii)
    {
        Format = format;
        Quiet = quiet;
        UseColor = useColor;
        UseAscii = useAscii;
    }

    public OutputFormat Format { get; }

    public bool Quiet { get; }

    public bool UseColor { get; }

    public bool UseAscii { get; }
}

public sealed class CapabilityPolicy
{
    public CapabilityPolicy(ServerTransport transport, bool unattended)
    {
        Transport = transport;
        Unattended = unattended;
    }

    public ServerTransport Transport { get; }

    public bool Unattended { get; }
}

public sealed class FieldBackedPolicy
{
    private readonly string _route;
    private readonly bool _enabled;

    public FieldBackedPolicy(string route, bool enabled)
    {
        _route = route;
        _enabled = enabled;
    }

    public string Route => _route;

    public bool Enabled => _enabled;
}
`

        private func AssertClassShape(
            unit CompilationUnit,
            className string,
            parameterNames[]string,
            propertyNames[]string
        ) {
            let type = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == className)
            Assert.True(type.PrimaryConstructorParameters == nil || type.PrimaryConstructorParameters!!.Count == 0)
            Assert.Equal(
                parameterNames,
                Assert.Single(type.Members.OfType[ConstructorDeclaration]()).Parameters.Select((p Parameter) -> p.Name)
            )
            Assert.Equal(
                propertyNames,
                type.Members.OfType[PropertyDeclaration]().Select((p PropertyDeclaration) -> p.Name)
            )
        }

        private func Translate() CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Oahu.Cli.cs", Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return CSharpToGSharpTranslator().TranslateDocument(document, context)
        }

        private func AssertProcessSucceeds(fileName string, workingDirectory string, arguments ...string?) string {
            let startInfo = ProcessStartInfo(fileName){
                WorkingDirectory = workingDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            let output = process!!.StandardOutput.ReadToEnd() + process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, output)
            return output
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
