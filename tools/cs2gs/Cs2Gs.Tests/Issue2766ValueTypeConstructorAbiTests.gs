// <copyright file="Issue2766ValueTypeConstructorAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

class Issue2766ValueTypeConstructorAbiTests {
    @Fact
    func Translation_PreservesPlainStructConstructorsAndMemberKinds() {
        let unit = Translate()
        let policy = FindType(unit, "ValuePolicy")
        Assert.True(policy.PrimaryConstructorParameters == nil || policy.PrimaryConstructorParameters!!.Count == 0)
        Assert.Equal("level", Assert.Single(policy.Members.OfType[ConstructorDeclaration]()).Parameters.Single().Name)
        Assert.Equal(Visibility.Private, Assert.Single(policy.Members.OfType[FieldDeclaration]()).Visibility)
        Assert.Equal("Level", Assert.Single(policy.Members.OfType[PropertyDeclaration]()).Name)
        let mixed = FindType(unit, "MixedValue")
        Assert.True(mixed.PrimaryConstructorParameters == nil || mixed.PrimaryConstructorParameters!!.Count == 0)
        Assert.Equal(
            []string{"publicValue", "privateValue", "propertyValue"},
            mixed.Members.OfType[ConstructorDeclaration]().First().Parameters.Select((p Parameter) -> p.Name)
        )
        Assert.Equal("all", mixed.Members.OfType[ConstructorDeclaration]().Last().Parameters.Single().Name)
        Assert.Equal(
            []Visibility{Visibility.Default, Visibility.Private},
            mixed.Members.OfType[FieldDeclaration]().Select((f FieldDeclaration) -> f.Visibility)
        )
        Assert.Equal(
            []string{"PrivateValue", "Property"},
            mixed.Members.OfType[PropertyDeclaration]().Select((p PropertyDeclaration) -> p.Name)
        )
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("init(level int32)", printed, StringComparison.Ordinal)
        Assert.Contains(
            "init(publicValue int32, privateValue int32, propertyValue int32)",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("convenience init(all int32)", printed, StringComparison.Ordinal)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(roundTrip!!.Success, string.Join(Environment.NewLine, roundTrip!!.Errors))
    }

    @Fact
    func Translation_LeavesClassRecordAndNativePrimaryShapesOnTheirOwnPaths() {
        let unit = Translate()
        let classControl = FindType(unit, "ClassControl")
        Assert.True(
            classControl.PrimaryConstructorParameters == nil || classControl.PrimaryConstructorParameters!!.Count == 0
        )
        Assert.Equal(
            "value",
            Assert.Single(classControl.Members.OfType[ConstructorDeclaration]()).Parameters.Single().Name
        )
        let recordControl = FindType(unit, "RecordControl")
        Assert.Equal("Value", Assert.Single(recordControl.PrimaryConstructorParameters!!).Name)
        Assert.Empty(recordControl.Members.OfType[ConstructorDeclaration]())
        let primaryControl = FindType(unit, "PrimaryControl")
        Assert.Equal("value", Assert.Single(primaryControl.PrimaryConstructorParameters!!).Name)
        Assert.Empty(primaryControl.Members.OfType[ConstructorDeclaration]())
    }

    @Fact
    func TranslatedLibrary_RealCSharpConsumerUsesNamedArgumentsGettersAndFieldAbi() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2766-csharp-consumer", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "Abi.gs")
        let dllPath = Path.Combine(workDir, "Abi.dll")
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
    <Reference Include="Abi">
      <HintPath>` + "$dllPath" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
        File.WriteAllText(Path.Combine(consumerDir, "Program.cs"), `using System;
using System.Linq;
using System.Reflection;
using Abi;

var policy = new ValuePolicy(level: 3);
var mixed = new MixedValue(publicValue: 7, privateValue: 8, propertyValue: 9);
var overloaded = new MixedValue(all: 5);

Console.WriteLine(policy.Level);
Console.WriteLine($"{mixed.PublicField}:{mixed.PrivateValue}:{mixed.Property}");
Console.WriteLine($"{overloaded.PublicField}:{overloaded.PrivateValue}:{overloaded.Property}");
Console.WriteLine(string.Join(",", typeof(MixedValue).GetConstructors()
    .OrderBy(c => c.GetParameters().Length)
    .Select(c => string.Join("+", c.GetParameters().Select(p => p.Name)))));
Console.WriteLine(string.Join(",", typeof(MixedValue).GetFields(
    BindingFlags.Public | BindingFlags.Instance).Select(f => f.Name)));
Console.WriteLine(string.Join(",", typeof(MixedValue).GetProperties(
    BindingFlags.Public | BindingFlags.Instance).Select(p => p.Name).OrderBy(n => n)));`)
        AssertProcessSucceeds("dotnet", consumerDir, "restore", "--nologo")
        let output = AssertProcessSucceeds("dotnet", consumerDir, "run", "--no-restore", "--nologo", "-c", "Release")
        Assert.StartsWith("3" + Environment.NewLine, output, StringComparison.Ordinal)
        Assert.Contains("7:8:9", output, StringComparison.Ordinal)
        Assert.Contains("5:6:7", output, StringComparison.Ordinal)
        Assert.Contains("all,publicValue+privateValue+propertyValue", output, StringComparison.Ordinal)
        Assert.Contains(Environment.NewLine + "PublicField" + Environment.NewLine, output, StringComparison.Ordinal)
        Assert.Contains("PrivateValue,Property", output, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `namespace Abi;

public readonly struct ValuePolicy
{
    private readonly int _level;

    public ValuePolicy(int level) => _level = level;

    public int Level => _level;
}

public struct MixedValue
{
    public readonly int PublicField;
    private readonly int _privateField;

    public MixedValue(int publicValue, int privateValue, int propertyValue)
    {
        PublicField = publicValue;
        _privateField = privateValue;
        Property = propertyValue;
    }

    public MixedValue(int all) : this(all, all + 1, all + 2)
    {
    }

    public int PrivateValue => _privateField;

    public int Property { get; }
}

public sealed class ClassControl
{
    public ClassControl(int value) => Value = value;

    public int Value { get; }
}

public readonly record struct RecordControl(int Value);

public struct PrimaryControl(int value)
{
    public int Read() => value;
}`

        private func FindType(unit CompilationUnit, name string) TypeDeclaration -> unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == name)

        private func Translate() CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Abi.cs", Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return unit
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
