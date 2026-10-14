// <copyright file="Issue2717ImportedNullableInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import Spectre.Console

class Issue2717ImportedNullableInitializerEmitTests {
    @Fact
    func ExactOahuRuleStyleInitializer_CompilesWithoutGS9998() {
        const tokens = `package Oahu.Cli.Tui.Tokens
import Spectre.Console

data struct SemanticColor(Value Color) {
    func operator implicit(c SemanticColor) Color -> c.Value
    func operator implicit(c SemanticColor) Style -> Style(c.Value)
}

class Tokens {
    shared {
        prop BorderNeutral SemanticColor -> SemanticColor(Color.Red)
    }
}`
        const appShell = `package Oahu.Cli.Tui
import Spectre.Console
import Spectre.Console.Rendering
import Oahu.Cli.Tui.Tokens

func Build() Spectre.Console.Rule ->
    Spectre.Console.Rule{Style: Style(Tokens.BorderNeutral)}`
        let directory = NewDirectory()
        try {
            let spectrePath = typeof(Style).Assembly.Location
            let references = []string{
                spectrePath,
                Path.Combine(Path.GetDirectoryName(spectrePath)!!, "Spectre.Console.Ansi.dll")
            }
            let result = Compile(directory, "Oahu.Cli.Tui", []string{tokens, appShell}, references)
            Assert.True(result.ExitCode == 0, result.Diagnostics)
            Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedReferenceAndValueNullableProperties_RunAndVerifyWithoutBoxing() {
        let directory = NewDirectory()
        try {
            let fixturePath = Path.Combine(directory, "Issue2717.Metadata.dll")
            EmitFixture(fixturePath)
            const source = `package Issue2717.App
import Issue2717.Metadata

func Build() Holder2717 -> Holder2717{
    Reference: ReferenceValue2717("oahu"),
    Value: ValueValue2717(2717)
}`
            let result = Compile(directory, "Issue2717.App", []string{source}, []string{fixturePath})
            Assert.True(result.ExitCode == 0, result.Diagnostics)
            IlVerifier.Verify(result.OutputPath, []string{fixturePath})
            // One context for the reference fixture and the emitted
            // assembly that imports it, so the emitted code binds the
            // same fixture types the test reflects over.
            let emitted = EmittedFixture.LoadTogether(fixturePath, result.OutputPath)[1]
            let build = emitted
                .GetTypes()
                .Single((type Type) -> type.Name == "<Program>")
                .GetMethod("Build", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!!
            let holder = build.Invoke(nil, nil)!!
            let reference = holder.GetType().GetProperty("Reference")!!.GetValue(holder)!!
            let value = holder.GetType().GetProperty("Value")!!.GetValue(holder)!!
            Assert.Equal("oahu", reference.GetType().GetProperty("Text")!!.GetValue(reference))
            Assert.Equal(2717, value.GetType().GetProperty("Value")!!.GetValue(value))
            Assert.DoesNotContain(uint8(0x8C), build.GetMethodBody()!!.GetILAsByteArray()!!)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func IncompatibleImportedNullableProperty_RemainsATypeError() {
        let directory = NewDirectory()
        try {
            let fixturePath = Path.Combine(directory, "Issue2717.Metadata.dll")
            EmitFixture(fixturePath)
            const source = `package Issue2717.Negative
import Issue2717.Metadata

func Bad() Holder2717 ->
    Holder2717{Value: ReferenceValue2717("not a value struct")}`
            let result = Compile(directory, "Issue2717.Negative", []string{source}, []string{fixturePath})
            Assert.NotEqual(0, result.ExitCode)
            Assert.Contains("GS0155", result.Diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    private data class CompileResult(ExitCode int32, Diagnostics string, OutputPath string) : IEquatable[
        Issue2717ImportedNullableInitializerEmitTests.CompileResult
    ] { }

    shared {
        private func EmitFixture(outputPath string) {
            const source = `#nullable enable
namespace Issue2717.Metadata;

public sealed class ReferenceValue2717
{
    public ReferenceValue2717(string text) => Text = text;
    public string Text { get; }
}

public readonly struct ValueValue2717
{
    public ValueValue2717(int value) => Value = value;
    public int Value { get; }
}

public sealed class Holder2717
{
    public ReferenceValue2717? Reference { get; set; }
    public ValueValue2717? Value { get; set; }
}`
            let compilation = CSharpCompilation.Create(
                "Issue2717.Metadata",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            using let pe = File.Create(outputPath)
            let result = compilation.Emit(pe)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Compile(
            directory string,
            assemblyName string,
            sources[]string,
            references[]string
        ) Issue2717ImportedNullableInitializerEmitTests
            .CompileResult {
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            let args = List[string]{
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            args.AddRange(TrustedPlatformAssemblies().Select((path string) -> ("/reference:" + path)))
            args.AddRange(references.Where(File.Exists).Select((path string) -> ("/reference:" + path)))
            for var i = 0; i < sources.Length; i++ {
                let sourcePath = Path.Combine(directory, "Source$i.gs")
                File.WriteAllText(sourcePath, sources[i])
                args.Add(sourcePath)
            }
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(args.ToArray())
                return Issue2717ImportedNullableInitializerEmitTests.CompileResult(
                    exitCode,
                    stdout.ToString() + stderr.ToString(),
                    outputPath
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func NewDirectory() string {
            let directory = Path.Combine(
                Environment.CurrentDirectory,
                "TestArtifacts",
                "Issue2717",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let assemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(assemblies) {
                cast[IEnumerable[string]](Array.Empty[string]())
            } else {
                assemblies!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
