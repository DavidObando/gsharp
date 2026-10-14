// <copyright file="Issue3110And3113ConstantPatternEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import System
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issues #3110 and #3113: constant-pattern equality must agree across all three drivers.
@Collection("ConsoleIo")
open class Issue3110And3113ConstantPatternEqualityTests {
    @Fact
    async func TwentyRowCorpus_AgreesAcrossDrivers() {
        const Expected = `11
11
11
11
11
11
11
11
11
11
11
11
11
11
11
11
11
11
11
11`
        await AssertDriverMatrixAsync(SourceForTwentyRowCorpus(), Expected, "TwentyRowCorpus_AgreesAcrossDrivers")
    }

    @Fact
    async func FloatingAndNullableWidthControls_AgreeAcrossDrivers() {
        const Expected = `33
33
11
11
11
11
11
11
11
11
11
33
33
33
33
11
11
11`
        await AssertDriverMatrixAsync(
            SourceForFloatingAndNullableWidthControls(),
            Expected,
            "FloatingAndNullableWidthControls_AgreeAcrossDrivers"
        )
    }

    @Fact
    async func NonLiteralNaNConstants_AgreeAcrossDrivers() {
        const Expected = `33
33
33
33
33
11`
        await AssertDriverMatrixAsync(
            SourceForNonLiteralNaNConstants(),
            Expected,
            "NonLiteralNaNConstants_AgreeAcrossDrivers"
        )
    }

    shared {
        private async func AssertDriverMatrixAsync(source string, expected string, testName string) {
            let root = CreateEmptyDirectory(testName)
            try {
                let bare = RunBareGsc(source, CreateEmptyDirectory(root, "bare"))
                let emitted = await RunEmittedAsync(source, CreateEmptyDirectory(root, "emit"))
                let gsi = RunGsi(source, CreateEmptyDirectory(root, "gsi"))
                Assert.True(expected == bare && expected == emitted && expected == gsi, (`driver mismatch
expected:
` + "$expected" + `
bare gsc:
` + "$bare" + `
emitted:
` + "$emitted" + `
gsi:
` + "$gsi"))
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private func RunBareGsc(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, source)
            let (exitCode, stdout, stderr) = CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
            Assert.True(exitCode == 0, (`bare gsc failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return NormalizeValues(stdout)
        }

        private func RunGsi(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, source)
            let (exitCode, stdout, stderr) = CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
            Assert.True(exitCode == 0, (`gsi failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return NormalizeValues(stdout)
        }

        private async func RunEmittedAsync(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "Issue3110And3113${Guid.NewGuid():N}.dll")
            File.WriteAllText(sourcePath, source)
            let (compileExit, stdout, stderr) = CaptureConsole(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            Assert.True(compileExit == 0, (`emit failed (` + "$compileExit" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            CollectibleAssembly.Inspect(outputPath, (assembly Assembly) -> Assert.NotEmpty(assembly.GetTypes()))
            let result = await DotnetProcess.RunAsync(directory, []string{outputPath})
            Assert.True(result.ExitCode == 0, (`emitted program failed (` + "${result.ExitCode}" + `)
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            return NormalizeValues(result.StandardOutput)
        }

        private func CaptureConsole(action() -> int32)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (action(), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func NormalizeValues(output string) string -> string.Join(
            "\n",
            output
                .ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
                .Where((line string) -> line != "Success.")
        )

        private func CreateEmptyDirectory(name string) string {
            let parent = Path.Combine(AppContext.BaseDirectory, "issue3110-3113-probes")
            return CreateEmptyDirectory(parent, "$name-${Guid.NewGuid():N}")
        }

        private func CreateEmptyDirectory(parent string, name string) string {
            let path = Path.Combine(parent, name)
            Directory.CreateDirectory(path)
            Assert.Empty(Directory.EnumerateFileSystemEntries(path))
            return path
        }

        private func SourceForTwentyRowCorpus() string -> `package Issue3110And3113.Corpus
import System

enum Shade { Light, Dark }

var i32 int32 = 1
switch i32 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var i64 int64 = int64(2)
switch i64 { case 2 { Console.WriteLine(11) } case 3 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var u32 uint32 = uint32(3)
switch u32 { case 3 { Console.WriteLine(11) } case 4 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var u64 uint64 = uint64(4)
switch u64 { case 4 { Console.WriteLine(11) } case 5 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var dec decimal = 1.5m
switch dec { case 1.5m { Console.WriteLine(11) } case 2.5m { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var text string = "s"
switch text { case "s" { Console.WriteLine(11) } case "t" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var empty string = ""
switch empty { case "" { Console.WriteLine(11) } case "x" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nilText string? = nil
switch nilText { case nil { Console.WriteLine(11) } case "x" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var truth bool = true
switch truth { case true { Console.WriteLine(11) } case false { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var letter char = 'x'
switch letter { case 'x' { Console.WriteLine(11) } case 'y' { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var shade Shade = Shade.Dark
switch shade { case Shade.Dark { Console.WriteLine(11) } case Shade.Light { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedInt object = 1
switch boxedInt { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedBool object = true
switch boxedBool { case true { Console.WriteLine(11) } case false { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedString object = "s"
switch boxedString { case "s" { Console.WriteLine(11) } case "t" { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableInt32 int32? = 1
switch nullableInt32 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableChar char? = 'x'
switch nullableChar { case 'x' { Console.WriteLine(11) } case 'y' { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableBool bool? = true
switch nullableBool { case true { Console.WriteLine(11) } case false { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableInt64 int64? = int64(3)
switch nullableInt64 { case 3 { Console.WriteLine(11) } case 4 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableFloat64 float64? = 1.5
switch nullableFloat64 { case 1.5 { Console.WriteLine(11) } case 2.5 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nilFloat64 float64? = nil
switch nilFloat64 { case nil { Console.WriteLine(11) } case 1.5 { Console.WriteLine(22) } default { Console.WriteLine(33) } }`

        private func SourceForFloatingAndNullableWidthControls() string -> `package Issue3110And3113.Controls
import System

enum ControlShade { Light, Dark }

var nan32 float32 = Single.NaN
switch nan32 { case Single.NaN { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nan64 float64 = Double.NaN
switch nan64 { case Double.NaN { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var negativeZero float64 = -0.0
switch negativeZero { case 0.0 { Console.WriteLine(11) } case 1.0 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var epsilon32 float32 = Single.Epsilon
switch epsilon32 { case Single.Epsilon { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var positiveInfinity float64 = Double.PositiveInfinity
switch positiveInfinity { case Double.PositiveInfinity { Console.WriteLine(11) } case Double.NegativeInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var negativeInfinity float64 = Double.NegativeInfinity
switch negativeInfinity { case Double.NegativeInfinity { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableInt8 int8? = int8(1)
switch nullableInt8 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableInt16 int16? = int16(1)
switch nullableInt16 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableUInt32 uint32? = uint32(1)
switch nullableUInt32 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableUInt64 uint64? = uint64(1)
switch nullableUInt64 { case 1 { Console.WriteLine(11) } case 2 { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableFloat32 float32? = Single.Epsilon
switch nullableFloat32 { case Single.Epsilon { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableNaN32 float32? = Single.NaN
switch nullableNaN32 { case Single.NaN { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var nullableNaN64 float64? = Double.NaN
switch nullableNaN64 { case Double.NaN { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedNaN32 object = Single.NaN
switch boxedNaN32 { case Single.NaN { Console.WriteLine(11) } case Single.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedNaN64 object = Double.NaN
switch boxedNaN64 { case Double.NaN { Console.WriteLine(11) } case Double.PositiveInfinity { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedDecimal object = 1.5m
switch boxedDecimal { case 1.5m { Console.WriteLine(11) } case 2.5m { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedChar object = 'x'
switch boxedChar { case 'x' { Console.WriteLine(11) } case 'y' { Console.WriteLine(22) } default { Console.WriteLine(33) } }

var boxedEnum object = ControlShade.Dark
switch boxedEnum { case ControlShade.Dark { Console.WriteLine(11) } case ControlShade.Light { Console.WriteLine(22) } default { Console.WriteLine(33) } }`

        private func SourceForNonLiteralNaNConstants() string -> `package Issue3110And3113.NonLiteralNaN
import System

var divided object = Double.NaN
switch divided { case 0.0 / 0.0 { Console.WriteLine(11) } default { Console.WriteLine(33) } }

var multiplied object = Double.NaN
switch multiplied { case Double.NaN * 1.0 { Console.WriteLine(11) } default { Console.WriteLine(33) } }

var negated object = Double.NaN
switch negated { case -Double.NaN { Console.WriteLine(11) } default { Console.WriteLine(33) } }

var nullable float64? = Double.NaN
switch nullable { case 0.0 / 0.0 { Console.WriteLine(11) } default { Console.WriteLine(33) } }

var chainedNaN object = float64(float32(Single.NaN))
switch chainedNaN { case (float64(float32(Single.NaN))) { Console.WriteLine(11) } default { Console.WriteLine(33) } }

var chainedControl object = float64(float32(1.00000001))
switch chainedControl { case (float64(float32(1.00000001))) { Console.WriteLine(11) } default { Console.WriteLine(33) } }`
    }
}
