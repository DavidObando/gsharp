// <copyright file="Issue4057ImportedGenericIndexerLiteralTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #4057: integer literals at imported generic indexers use the
/// substituted key type for conversion and report overload failures rather
/// than falsely claiming the receiver has no indexer.
open class Issue4057ImportedGenericIndexerLiteralTests {
    @Fact
    func DictionaryReadWriteAndInitializer_LiteralsAtEveryNarrowBoundary_CompileVerifyAndRun() {
        const Source = `package P
import System
import System.Collections.Generic

let bytes = Dictionary[uint8, string]()
bytes[0] = "b0"
bytes[255] = "b255"
Console.WriteLine(bytes[0])
Console.WriteLine(bytes[255])

let sbytes = Dictionary[int8, string]()
sbytes[-128] = "sbmin"
sbytes[127] = "sbmax"
Console.WriteLine(sbytes[-128])
Console.WriteLine(sbytes[127])

let shorts = Dictionary[int16, string]()
shorts[-32768] = "smin"
shorts[32767] = "smax"
Console.WriteLine(shorts[-32768])
Console.WriteLine(shorts[32767])

let ushorts = Dictionary[uint16, string]()
ushorts[0] = "us0"
ushorts[65535] = "usmax"
Console.WriteLine(ushorts[0])
Console.WriteLine(ushorts[65535])

let initializedBytes = Dictionary[uint8, string]{[0x00] = "init-byte"}
let initializedSBytes = Dictionary[int8, string]{[-128] = "init-sbyte"}
let initializedShorts = Dictionary[int16, string]{[-32768] = "init-short"}
let initializedUShorts = Dictionary[uint16, string]{[65535] = "init-ushort"}
Console.WriteLine(initializedBytes[0])
Console.WriteLine(initializedSBytes[-128])
Console.WriteLine(initializedShorts[-32768])
Console.WriteLine(initializedUShorts[65535])`
        AssertCompilesVerifiesAndRuns(
            Source,
            nil,
            "b0",
            "b255",
            "sbmin",
            "sbmax",
            "smin",
            "smax",
            "us0",
            "usmax",
            "init-byte",
            "init-sbyte",
            "init-short",
            "init-ushort"
        )
    }

    @Fact
    func TypedVariables_SourceGenericAndImportedNonGenericIndexers_RemainControls() {
        const Source = `package P
import System
import System.Collections.Generic
import HelperLib4057

class SourceBox[T] {
    var Stored string
    prop this[key T] string {
        get { return Stored }
        set { Stored = value }
    }
}

let byteKey uint8 = 255
let sbyteKey int8 = -128
let shortKey int16 = -32768
let ushortKey uint16 = 65535

let bytesByVariable = Dictionary[uint8, string]()
bytesByVariable[byteKey] = "typed-byte"
Console.WriteLine(bytesByVariable[byteKey])
let sbytesByVariable = Dictionary[int8, string]()
sbytesByVariable[sbyteKey] = "typed-sbyte"
Console.WriteLine(sbytesByVariable[sbyteKey])
let shortsByVariable = Dictionary[int16, string]()
shortsByVariable[shortKey] = "typed-short"
Console.WriteLine(shortsByVariable[shortKey])
let ushortsByVariable = Dictionary[uint16, string]()
ushortsByVariable[ushortKey] = "typed-ushort"
Console.WriteLine(ushortsByVariable[ushortKey])

let sourceByte = SourceBox[uint8]()
sourceByte[255] = "source-byte"
Console.WriteLine(sourceByte[255])
let sourceSByte = SourceBox[int8]()
sourceSByte[-128] = "source-sbyte"
Console.WriteLine(sourceSByte[-128])
let sourceShort = SourceBox[int16]()
sourceShort[-32768] = "source-short"
Console.WriteLine(sourceShort[-32768])
let sourceUShort = SourceBox[uint16]()
sourceUShort[65535] = "source-ushort"
Console.WriteLine(sourceUShort[65535])

let bytes = ByteIndexer()
bytes[255] = "non-generic-byte"
Console.WriteLine(bytes[255])
let sbytes = SByteIndexer()
sbytes[-128] = "non-generic-sbyte"
Console.WriteLine(sbytes[-128])
let shorts = Int16Indexer()
shorts[-32768] = "non-generic-short"
Console.WriteLine(shorts[-32768])
let ushorts = UInt16Indexer()
ushorts[65535] = "non-generic-ushort"
Console.WriteLine(ushorts[65535])`
        AssertCompilesVerifiesAndRuns(
            Source,
            LibrarySource,
            "typed-byte",
            "typed-sbyte",
            "typed-short",
            "typed-ushort",
            "source-byte",
            "source-sbyte",
            "source-short",
            "source-ushort",
            "non-generic-byte",
            "non-generic-sbyte",
            "non-generic-short",
            "non-generic-ushort"
        )
    }

    @Fact
    func ImportedGenericGetterAndSetterOverloads_UseTheSubstitutedNarrowType() {
        const Source = `package P
import System
import HelperLib4057

Console.WriteLine(GenericGetter[uint8]()[255])
Console.WriteLine(GenericGetter[int8]()[-128])
Console.WriteLine(GenericGetter[int16]()[-32768])
Console.WriteLine(GenericGetter[uint16]()[65535])
Console.WriteLine(GenericGetter[uint8]()["key"])

let byteSetter = GenericSetter[uint8]()
byteSetter[255] = "b"
Console.WriteLine(byteSetter.Last)
let sbyteSetter = GenericSetter[int8]()
sbyteSetter[-128] = "sb"
Console.WriteLine(sbyteSetter.Last)
let shortSetter = GenericSetter[int16]()
shortSetter[-32768] = "s"
Console.WriteLine(shortSetter.Last)
let ushortSetter = GenericSetter[uint16]()
ushortSetter[65535] = "us"
Console.WriteLine(ushortSetter.Last)
byteSetter["key"] = "text"
Console.WriteLine(byteSetter.Last)`
        AssertCompilesVerifiesAndRuns(
            Source,
            LibrarySource,
            "generic:255",
            "generic:-128",
            "generic:-32768",
            "generic:65535",
            "string:key",
            "generic:255:b",
            "generic:-128:sb",
            "generic:-32768:s",
            "generic:65535:us",
            "string:key:text"
        )
    }

    @Theory
    @MemberData("OutOfRangeLiterals")
    func OutOfRangeLiteral_ReportsNoApplicableOverload_NotNotIndexable(
        name string,
        keyType string,
        literal string,
        access string
    ) {
        let operation = if access == "read" {
            "return values[$literal]"
        } else {
            "values[$literal] = \"value\""
        }
        let returnType = if access == "read" {
            " string"
        } else {
            string.Empty
        }
        let source = (`package P
import System.Collections.Generic

func Probe()` + "$returnType" + ` {
    let values = Dictionary[` + "$keyType" + `, string]()
    ` + "$operation" + `
}`)
        let log = CompileExpectingFailure(name, source)
        Assert.Equal([]string{"GS0267"}, ErrorIds(log))
        Assert.DoesNotContain("GS0116", log, StringComparison.Ordinal)
        Assert.Contains("No overload", log, StringComparison.Ordinal)
    }

    @Fact
    func OutOfRangeInitializerLiteral_ReportsNoApplicableOverload_NotNotIndexable() {
        const Source = `package P
import System.Collections.Generic

func Probe() {
    let values = Dictionary[uint8, string]{[256] = "value"}
}`
        let log = CompileExpectingFailure("initializer", Source)
        Assert.Equal([]string{"GS0267"}, ErrorIds(log))
        Assert.DoesNotContain("GS0116", log, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("read")
    @InlineData("write")
    func EquallyApplicableImportedIndexerOverloads_ReportAmbiguous_NotNotIndexable(access string) {
        let operation = if access == "read" {
            "return values[key]"
        } else {
            "values[key] = \"value\""
        }
        let returnType = if access == "read" {
            " string"
        } else {
            string.Empty
        }
        let source = (`package P
import HelperLib4057

func Probe(values AmbiguousIndexer, key int32)` + "$returnType" + ` {
    ` + "$operation" + `
}`)
        let log = CompileExpectingFailure("ambiguous-" + access, source, LibrarySource)
        Assert.Equal([]string{"GS0266"}, ErrorIds(log))
        Assert.DoesNotContain("GS0116", log, StringComparison.Ordinal)
        Assert.Contains("ambiguous", log, StringComparison.OrdinalIgnoreCase)
    }

    @Fact
    func ATypeWithoutAnIndexer_StillReportsNotIndexable() {
        const Source = `package P

func Probe() {
    var value = 1
    value[0] = 2
}`
        let log = CompileExpectingFailure("not-indexable-control", Source)
        Assert.Equal([]string{"GS0116"}, ErrorIds(log))
    }

    shared {
        private const RunTimeout int32 = 60_000

        private const LibrarySource string = `using System.Collections.Generic;

namespace HelperLib4057;

public sealed class GenericGetter<T>
    where T : notnull
{
    public string this[T key] => "generic:" + key;

    public string this[string key] => "string:" + key;
}

public sealed class GenericSetter<T>
    where T : notnull
{
    public string Last { get; private set; } = "";

    public string this[T key]
    {
        set => Last = "generic:" + key + ":" + value;
    }

    public string this[string key]
    {
        set => Last = "string:" + key + ":" + value;
    }
}

public sealed class ByteIndexer
{
    private readonly Dictionary<byte, string> values = new();
    public string this[byte key]
    {
        get => values[key];
        set => values[key] = value;
    }
}

public sealed class SByteIndexer
{
    private readonly Dictionary<sbyte, string> values = new();
    public string this[sbyte key]
    {
        get => values[key];
        set => values[key] = value;
    }
}

public sealed class Int16Indexer
{
    private readonly Dictionary<short, string> values = new();
    public string this[short key]
    {
        get => values[key];
        set => values[key] = value;
    }
}

public sealed class UInt16Indexer
{
    private readonly Dictionary<ushort, string> values = new();
    public string this[ushort key]
    {
        get => values[key];
        set => values[key] = value;
    }
}

public sealed class AmbiguousIndexer
{
    public string this[System.IComparable key]
    {
        get => "comparable";
        set { }
    }

    public string this[System.IFormattable key]
    {
        get => "formattable";
        set { }
    }
}`

        func OutOfRangeLiterals() sequence[[]object] {
            for access in[]string{"read", "write"} {
                yield[]object{"uint8-negative-" + access, "uint8", "-1", access}
                yield[]object{"uint8-positive-" + access, "uint8", "256", access}
                yield[]object{"int8-negative-" + access, "int8", "-129", access}
                yield[]object{"int8-positive-" + access, "int8", "128", access}
                yield[]object{"int16-negative-" + access, "int16", "-32769", access}
                yield[]object{"int16-positive-" + access, "int16", "32768", access}
                yield[]object{"uint16-negative-" + access, "uint16", "-1", access}
                yield[]object{"uint16-positive-" + access, "uint16", "65536", access}
            }
        }

        private func AssertCompilesVerifiesAndRuns(source string, csharpSource string?, expectedLines ...string) {
            let workDir = Directory.CreateTempSubdirectory("gs_4057_").FullName
            try {
                let references = if csharpSource == nil {
                    Array.Empty[string]()
                } else {
                    []string{CompileCSharpLibrary(workDir, csharpSource)}
                }
                let appPath = Path.Combine(workDir, "App.dll")
                let log = Compile(workDir, source, appPath, "exe", references)
                Assert.True(File.Exists(appPath), (`gsc failed:
` + "$log"))
                IlVerifier.Verify(appPath, references)
                let (exitCode, output) = RunDotnet(appPath)
                Assert.True(exitCode == 0, (`dotnet exec failed (` + "$exitCode" + `):
` + "$output"))
                Assert.Equal(
                    expectedLines,
                    output
                        .Split('\n')
                        .Select((line string) -> line.TrimEnd('\r'))
                        .Where((line string) -> line.Length != 0)
                        .ToArray()
                )
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func CompileExpectingFailure(name string, source string, csharpSource string? = nil) string {
            let workDir = Directory.CreateTempSubdirectory("gs_4057_error_").FullName
            try {
                let references = if csharpSource == nil {
                    Array.Empty[string]()
                } else {
                    []string{CompileCSharpLibrary(workDir, csharpSource)}
                }
                let appPath = Path.Combine(workDir, name + ".dll")
                let log = Compile(workDir, source, appPath, "library", references)
                Assert.False(File.Exists(appPath), (`'` + "$name" + `' unexpectedly compiled:
` + "$log"))
                return log
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func Compile(
            workDir string,
            source string,
            outputPath string,
            target string,
            references IReadOnlyList[string]
        ) string {
            let sourcePath = Path.Combine(workDir, "App.gs")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            args.AddRange(references.Select((reference string) -> ("/reference:" + reference)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let _ = Program.Main(args.ToArray())
                return stdout.ToString() + stderr.ToString()
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func CompileCSharpLibrary(workDir string, source string) string {
            let outputPath = Path.Combine(workDir, "HelperLib4057.dll")
            let references = TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "HelperLib4057",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            Assert.False(string.IsNullOrWhiteSpace(value))
            return value!!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        }

        private func RunDotnet(assemblyPath string)(ExitCode int32, Output string) {
            let runtimeConfig = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            if !File.Exists(runtimeConfig) {
                File.WriteAllText(runtimeConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            }
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(runtimeConfig)
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("dotnet exec timed out.")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            return (process.ExitCode, stdout + stderr)
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()
    }
}
