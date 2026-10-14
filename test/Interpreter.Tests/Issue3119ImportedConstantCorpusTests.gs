// <copyright file="Issue3119ImportedConstantCorpusTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import System
import System.IO
import System.Reflection
import Xunit

/// Issue #3119: imported constants preserve type and value across every driver.
@Collection("ConsoleIo")
open class Issue3119ImportedConstantCorpusTests {
    @Theory
    @MemberData("CrossEvaluationCases")
    func CrossAssemblyImportedConstant_EvaluatesWithExactValue(condition string) {
        let root = CreateEmptyTestDirectory()
        try {
            let sourcePath = WriteSource(root, "evaluate.gs", CreateAssertionSource(condition))
            let result = RunCompiler(root, "/nowarn:GS9100", "/r:" + GetCrossFixturePath(), sourcePath)
            AssertSucceeded(result, "cross-assembly gsc evaluation")
            Assert.Equal(string.Empty, ProgramOutput(result))
        } finally {
            DeleteDirectory(root)
        }
    }

    @Theory
    @MemberData("CrossEmissionCases")
    func CrossAssemblyImportedConstant_EmitsWithExactValue(expression string, expectedOutput string) {
        let root = CreateEmptyTestDirectory()
        try {
            let fixturePath = GetCrossFixturePath()
            let sourcePath = WriteSource(root, "emit.gs", CreateValueSource("GSharp.Issue3119.Cross", expression))
            let assemblyPath = Path.Combine(root, "cross-constant.dll")
            let result = RunCompiler(
                root,
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + fixturePath,
                sourcePath
            )
            AssertSucceeded(result, "cross-assembly gsc emit")
            CopyRuntimeDependency(fixturePath, root)
            Assert.Equal(
                expectedOutput.Replace("\n", Environment.NewLine, StringComparison.Ordinal),
                RunAssembly(root, assemblyPath)
            )
        } finally {
            DeleteDirectory(root)
        }
    }

    @Theory
    @MemberData("NullableNarrowingCases")
    func NullableImportedField_CannotNarrowToString(driver string, fieldName string) {
        let root = CreateEmptyTestDirectory()
        try {
            let sourcePath = WriteSource(root, "narrow.gs", CreateNarrowingSource(fieldName))
            let arguments = if driver == "gsc-emit" {
                []string{
                    "/target:exe",
                    "/out:" + Path.Combine(root, "narrow.dll"),
                    "/r:" + GetCrossFixturePath(),
                    sourcePath
                }
            } else {
                []string{"/r:" + GetCrossFixturePath(), sourcePath}
            }
            let result = RunCompiler(root, arguments)
            // Issue #3246: `string? -> string` used to classify as an
            // existing-but-explicit conversion (GS0156) only because the
            // retired builtin to-string arm accepted it; with that arm gone
            // the reference-nullable narrowing reports the standard GS0155,
            // matching every other reference type's `S? -> S` per #1627
            // (the caller must write `!!`).
            Assert.Equal(1, result.ExitCode)
            Assert.Contains("GS0155", result.Combined, StringComparison.Ordinal)
            Assert.Contains("'string?' to 'string'", result.Combined, StringComparison.Ordinal)
        } finally {
            DeleteDirectory(root)
        }
    }

    @Theory
    @MemberData("NoReferenceDrivers")
    func CrossAssemblyFixture_IsUnavailableWithoutReference(driver string) {
        let root = CreateEmptyTestDirectory()
        try {
            let sourcePath = WriteSource(
                root,
                "no-reference.gs",
                CreateValueSource("GSharp.Issue3119.Cross", "Constants.PositiveControl")
            )
            let result = switch driver {
                case "bare-gsc": RunCompiler(root, sourcePath)
                case "gsc-emit": RunCompiler(
                    root,
                    "/target:exe",
                    "/out:" + Path.Combine(root, "no-reference.dll"),
                    sourcePath
                )
                case "gsi": RunGsi(root, sourcePath)
                default: throw InvalidOperationException(driver)
            }
            Assert.Contains("GS0157", result.Combined, StringComparison.Ordinal)
        } finally {
            DeleteDirectory(root)
        }
    }

    @Theory
    @MemberData("RuntimeDrivers")
    func RuntimeImportedConstants_PreserveExactValuesAcrossDrivers(driver string) {
        let Expected = "2147483647${Environment.NewLine}" +
            "-2147483648${Environment.NewLine}" +
            "3.141592653589793${Environment.NewLine}"
        let root = CreateEmptyTestDirectory()
        try {
            let sourcePath = WriteSource(root, "runtime.gs", CreateRuntimeValueSource())
            var result Issue3119ImportedConstantCorpusTests.DriverResult
            if driver == "gsc-emit" {
                let assemblyPath = Path.Combine(root, "runtime-constants.dll")
                result = RunCompiler(root, "/target:exe", "/nowarn:GS9100", "/out:" + assemblyPath, sourcePath)
                AssertSucceeded(result, driver)
                Assert.Equal(Expected, RunAssembly(root, assemblyPath))
                return
            }
            result = switch driver {
                case "bare-gsc": RunCompiler(root, "/nowarn:GS9100", sourcePath)
                case "gsi": RunGsi(root, sourcePath)
                default: throw InvalidOperationException(driver)
            }
            AssertSucceeded(result, driver)
            Assert.Equal(Expected, ProgramOutput(result))
        } finally {
            DeleteDirectory(root)
        }
    }

    @Fact
    func CrossAssemblyFixture_HasExpectedIdentity() {
        let fixturePath = GetCrossFixturePath()
        Assert.True(File.Exists(fixturePath), fixturePath)
        Assert.True(FileInfo(fixturePath).Length > int64(0))
        Assert.Equal("GSharp.Issue3119.Cross", AssemblyName.GetAssemblyName(fixturePath).Name)
    }

    private data class DriverResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        Issue3119ImportedConstantCorpusTests.DriverResult
    ] {
        prop Combined string -> StandardOutput + StandardError
    }

    shared {
        prop CrossEvaluationCases TheoryData[string] -> TheoryData[string]{
            "Constants.Empty == \"\"",
            "Constants.Escaped == \"A\\n\\\"B\\\"\\\\C\"",
            "Constants.Character == 'Q'",
            "Constants.Boolean",
            "int32(Constants.TopLevelEnumValue) == 406",
            "int32(Constants.NestedEnumValue) == 407",
            "GenericOuter[int32].Depth2.Value == 408",
            "GenericOuter[int32].Depth2.Depth3.Value == \"depth3-409\"",
            "Constants.NullableConst == \"nullable-const-414\"",
            "Constants.PositiveControl == 499"
        }

        prop CrossEmissionCases TheoryData[string, string] -> TheoryData[string, string]{
            "Constants.Empty": "\n",
            "Constants.Escaped": `A
"B"\C
`,
            "Constants.Character": "Q\n",
            "Constants.Boolean": "True\n",
            "Constants.Decimal.ToString(CultureInfo.InvariantCulture)": "405.5\n",
            "Constants.EnabledText": "enabled-text-410\n",
            "Constants.EnabledInt": "411\n",
            "Constants.DisabledText": "disabled-text-412\n",
            "Constants.DisabledInt": "413\n",
            "int32(Constants.TopLevelEnumValue)": "406\n",
            "int32(Constants.NestedEnumValue)": "407\n",
            "GenericOuter[int32].Depth2.Value": "408\n",
            "GenericOuter[int32].Depth2.Depth3.Value": "depth3-409\n",
            "Constants.NullableConst": "nullable-const-414\n",
            "Constants.PositiveControl": "499\n"
        }

        prop NullableNarrowingCases TheoryData[string, string] -> TheoryData[string, string]{
            "bare-gsc": "EnabledText",
            "gsc-emit": "EnabledText",
            "bare-gsc": "DisabledText",
            "gsc-emit": "DisabledText",
            "bare-gsc": "NullableConst",
            "gsc-emit": "NullableConst"
        }
        prop NoReferenceDrivers TheoryData[string] -> TheoryData[string]{"bare-gsc", "gsc-emit", "gsi"}
        prop RuntimeDrivers TheoryData[string] -> TheoryData[string]{"bare-gsc", "gsc-emit", "gsi"}

        private func CreateValueSource(fixtureNamespace string, expression string) string -> (`package Issue3119Corpus
import System
import System.Globalization
import ` + "$fixtureNamespace" + `

Console.WriteLine(` + "$expression" + `)`)

        private func CreateNarrowingSource(fieldName string) string -> (`package Issue3119Corpus
import GSharp.Issue3119.Cross

var narrowed string = Constants.` + "$fieldName")

        private func CreateAssertionSource(condition string) string -> (`package Issue3119Corpus
import System
import GSharp.Issue3119.Cross

if !(` + "$condition" + `) { throw Exception("wrong imported constant value") }`)

        private func CreateRuntimeValueSource() string -> `package Issue3119Corpus
import System
import System.Globalization

Console.WriteLine(int32.MaxValue)
Console.WriteLine(int32.MinValue)
Console.WriteLine(Math.PI.ToString("R", CultureInfo.InvariantCulture))`

        private func RunCompiler(
            workingDirectory string,
            arguments ...string
        ) Issue3119ImportedConstantCorpusTests.DriverResult -> Capture(
            workingDirectory,
            () -> GSharp.Compiler.Program.Main(arguments)
        )

        private func RunGsi(
            workingDirectory string,
            sourcePath string
        ) Issue3119ImportedConstantCorpusTests.DriverResult -> Capture(
            workingDirectory,
            () -> GSharp.Repl.Program.Main([]string{sourcePath})
        )

        private func Capture(workingDirectory string, action() -> int32) Issue3119ImportedConstantCorpusTests
            .DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            let previousDirectory = Environment.CurrentDirectory
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                Environment.CurrentDirectory = workingDirectory
                return Issue3119ImportedConstantCorpusTests.DriverResult(action(), stdout.ToString(), stderr.ToString())
            } finally {
                Environment.CurrentDirectory = previousDirectory
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func AssertSucceeded(result Issue3119ImportedConstantCorpusTests.DriverResult, name string) {
            Assert.True(result.ExitCode == 0, ("$name" + ` exited ` + "${result.ExitCode}" + `
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            Assert.DoesNotContain("error GS", result.Combined, StringComparison.Ordinal)
        }

        private func RunAssembly(directory string, assemblyPath string) string {
            let runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let result = DotnetProcess.Run(directory, "exec", "--runtimeconfig", runtimeConfigPath, assemblyPath)
            Assert.True(result.ExitCode == 0, (`Emitted assembly exited ` + "${result.ExitCode}" + `
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            Assert.Equal(string.Empty, result.StandardError)
            return Normalize(result.StandardOutput)
        }

        private func CopyRuntimeDependency(sourcePath string, directory string) {
            let destination = Path.Combine(directory, Path.GetFileName(sourcePath))
            if !string.Equals(sourcePath, destination, StringComparison.Ordinal) {
                File.Copy(sourcePath, destination, overwrite: true)
            }
        }

        private func ProgramOutput(result Issue3119ImportedConstantCorpusTests.DriverResult) string {
            let success = "Success.${Environment.NewLine}"
            let output = Normalize(result.StandardOutput)
            return if output.EndsWith(success, StringComparison.Ordinal) {
                output[.. ^success.Length]
            } else {
                output
            }
        }

        private func CreateEmptyTestDirectory() string {
            let artifacts = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(artifacts)
            let directory = Path.Combine(artifacts, "${"Issue3119ImportedConstantCorpusTests"}-${Guid.NewGuid():N}")
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.GetFileSystemEntries(directory))
            return directory
        }

        private func WriteSource(directory string, name string, source string) string {
            let path = Path.Combine(directory, name)
            File.WriteAllText(path, source)
            return path
        }

        private func GetCrossFixturePath() string {
            let configurationRoot = Directory.GetParent(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))
                ?.FullName ??
                throw InvalidOperationException("Cannot resolve test output root")
            return Path.Combine(configurationRoot, "Issue3119.CrossConstants", "GSharp.Issue3119.Cross.dll")
        }

        private func DeleteDirectory(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch { }
        }

        private func Normalize(text string) string -> text.ReplaceLineEndings(Environment.NewLine)
    }
}
