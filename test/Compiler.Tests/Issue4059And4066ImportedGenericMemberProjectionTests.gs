// <copyright file="Issue4059And4066ImportedGenericMemberProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// Issues #4059/#4066: imported generic members project through the receiver's
/// symbolic arguments, including receiver-carried nullable flags.
open class Issue4059And4066ImportedGenericMemberProjectionTests {
    @Fact
    func ProjectionAcrossMemberAndIterationPaths_CompilesVerifiesAndRuns() {
        const Source = `package Projection
import System
import ProjectionLib

let non = Factory.NonNull()
non.Property = "property"
non.Field = "field"
non.Set("method")
non[0] = "indexer"
Console.WriteLine(non.Property)
Console.WriteLine(non.Field)
Console.WriteLine(non.Get())
Console.WriteLine(non[0])
Console.WriteLine(non.Nested[0])
if non.TryGet(out var nonOut) {
    Console.WriteLine(nonOut)
}
for value in non.Values {
    Console.WriteLine(value)
}
for value in non {
    Console.WriteLine(value)
}

let nullable = Factory.Nullable()
nullable.Property = nil
nullable.Set(nil)
nullable[0] = nil
nullable.Property = "n-property"
nullable.Field = "n-field"
nullable.Set("n-method")
nullable[0] = "n-indexer"

let np = nullable.Property
if np != nil { Console.WriteLine(np) }
let nf = nullable.Field
if nf != nil { Console.WriteLine(nf) }
let nm = nullable.Get()
if nm != nil { Console.WriteLine(nm) }
let ni = nullable[0]
if ni != nil { Console.WriteLine(ni) }
let nn = nullable.Nested[0]
if nn != nil { Console.WriteLine(nn) }
if nullable.TryGet(out var nullableOut) && nullableOut != nil {
    Console.WriteLine(nullableOut)
}
for value in nullable.Values {
    if value != nil { Console.WriteLine(value) }
}
for value in nullable {
    if value != nil { Console.WriteLine(value) }
}`
        RunCase(
            "projection-paths",
            Source,
            []string{
                "method",
                "field",
                "method",
                "indexer",
                "nonnull",
                "method",
                "indexer",
                "indexer",
                "n-method",
                "n-field",
                "n-method",
                "n-indexer",
                "nullable",
                "n-method",
                "n-indexer",
                "n-indexer"
            }
        )
    }

    @Fact
    func SameCompilationArguments_ProjectAcrossEveryMemberPath() {
        const Source = (`package Projection
import System
import ProjectionLib

class MyOptions : SchemeOptions {
}

let option = MyOptions()
option.Name = "source"
let h = Handler[MyOptions]()
h.Set(option)
h.Options = option
h.Field = option
h[0] = option
// Issue #4356: ` + "`" + `Handler<TOptions>.Options` + "`" + ` is declared ` + "`" + `TOptions?` + "`" + `,
// so reading through it asserts first; member lookup no longer
// waves a stated-nullable chain through. The projection this test
// is about is unaffected.
Console.WriteLine(h.Options!!.Name)
Console.WriteLine(h.Field.Name)
Console.WriteLine(h.Get().Name)
Console.WriteLine(h[0].Name)
Console.WriteLine(h.Nested[0].Name)
if h.TryGet(out var found) {
    Console.WriteLine(found.Name)
}
for value in h.Values {
    Console.WriteLine(value.Name)
}
for value in h {
    Console.WriteLine(value.Name)
}`)
        RunCase("same-compilation", Source, Enumerable.Repeat("source", 8).ToArray())
    }

    @Fact
    func AnnotatedImportedGenericReturn_KeepsSameCompilationArgumentForMethodLambda() {
        const Source = `package Projection
import System
import ProjectionLib

class Related {
}

class Entity {
    var Related Related
}

let builder = Factory.BuilderFor[Entity]()
Console.WriteLine(builder.HasOne((entity Entity) -> entity.Related))`
        RunCase("annotated-symbolic-method-parameter", Source, []string{"Entity/Related"})
    }

    @Theory
    @InlineData("Factory.Nullable().Property", "string?")
    @InlineData("Factory.NonNull().Property", "string")
    @InlineData("Factory.Nullable().Field", "string?")
    @InlineData("Factory.NonNull().Field", "string")
    @InlineData("Factory.Nullable().Get()", "string?")
    @InlineData("Factory.NonNull().Get()", "string")
    @InlineData("Factory.Nullable()[0]", "string?")
    @InlineData("Factory.NonNull()[0]", "string")
    @InlineData("Factory.Nullable().Nested[0]", "string?")
    @InlineData("Factory.NonNull().Nested[0]", "string")
    @InlineData("Factory.NullableRef()[0]", "string?")
    @InlineData("Factory.NonNullRef()[0]", "string")
    func DiagnosticNamesProjectedReceiverArgument(expression string, expectedType string) {
        let source = (`package Projection
import ProjectionLib

var bad int32 = ` + "$expression")
        let log = CompileDiagnostic(source)
        Assert.Contains("Cannot convert type '$expectedType' to 'int32'", log, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Factory.Nullable().TryGet(out var value)", "string?")
    @InlineData("Factory.NonNull().TryGet(out var value)", "string")
    func OutDiagnosticNamesProjectedReceiverArgument(call string, expectedType string) {
        let source = (`package Projection
import ProjectionLib

` + "$call" + `
var bad int32 = value`)
        let log = CompileDiagnostic(source)
        Assert.Contains("Cannot convert type '$expectedType' to 'int32'", log, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Factory.NullableDictionary()[\"a\"]", "string?")
    @InlineData("Factory.NonNullDictionary()[\"a\"]", "string")
    func DictionaryIndexerDiagnosticUsesValueArgumentPosition(expression string, expectedType string) {
        DiagnosticNamesProjectedReceiverArgument(expression, expectedType)
    }

    @Theory
    @InlineData("Factory.NullableDictionary()[\"a\"] = 1", "string?")
    @InlineData("Factory.NonNullDictionary()[\"a\"] = 1", "string")
    func DictionaryIndexerAssignmentDiagnosticUsesValueArgumentPosition(statement string, expectedType string) {
        let source = (`package Projection
import ProjectionLib

` + "$statement")
        let log = CompileDiagnostic(source)
        Assert.Contains("Cannot convert type 'int32' to '$expectedType'", log, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Factory.NullableDictionary()", "string?")
    @InlineData("Factory.NonNullDictionary()", "string")
    func DictionaryLoopDiagnosticUsesValueArgumentPosition(expression string, expectedType string) {
        let source = (`package Projection
import ProjectionLib

for key, value in ` + "$expression" + ` {
    var bad int32 = value
}`)
        let log = CompileDiagnostic(source)
        Assert.Contains("Cannot convert type '$expectedType' to 'int32'", log, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Factory.NullableDictionary().TryGetValue(\"a\", out var value)", "string?")
    @InlineData("Factory.NonNullDictionary().TryGetValue(\"a\", out var value)", "string")
    func DictionaryOutDiagnosticUsesValueArgumentPosition(call string, expectedType string) {
        OutDiagnosticNamesProjectedReceiverArgument(call, expectedType)
    }

    @Theory
    @InlineData("Factory.Nullable().Values", "string?")
    @InlineData("Factory.NonNull().Values", "string")
    @InlineData("Factory.Nullable()", "string?")
    @InlineData("Factory.NonNull()", "string")
    func ForeachDiagnosticNamesProjectedReceiverArgument(collection string, expectedType string) {
        let source = (`package Projection
import ProjectionLib

for value in ` + "$collection" + ` {
    var bad int32 = value
}`)
        let log = CompileDiagnostic(source)
        Assert.Contains("Cannot convert type '$expectedType' to 'int32'", log, StringComparison.Ordinal)
    }

    @Fact
    func NullableSettersAcceptNil_WhileNonNullSettersRejectIt() {
        let accepted = CompileDiagnostic(`package Projection
import ProjectionLib

func probe() {
    let value = Factory.Nullable()
    value.Property = nil
    value.Set(nil)
    value[0] = nil
}`)
        Assert.DoesNotContain("error GS", accepted, StringComparison.Ordinal)
        let rejected = CompileDiagnostic(`package Projection
import ProjectionLib

func probe() {
    let value = Factory.NonNull()
    value.Property = nil
    value.Set(nil)
    value[0] = nil
}`)
        Assert.Contains("error GS", rejected, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedNestedArguments_RoundTripNullableMetadata() {
        const Source = `package Projection
import System.Collections.Generic
import ProjectionLib

public func NullableNested() List[string?] {
    return Factory.Nullable().Nested
}

public func NonNullNested() List[string] {
    return Factory.NonNull().Nested
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_4059_4066_metadata_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Metadata.dll")
            let log = Compile(tempDir, "Metadata.gs", Source, appPath, "/target:library", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), log)
            let assembly = EmittedFixture.Load(appPath)
            let type = assembly.GetTypes().Single((t Type) -> t.GetMethod("NullableNested") != nil)
            Assert.Equal([]uint8{1, 2}, GetNullableFlags(type.GetMethod("NullableNested")!!.ReturnParameter))
            Assert.Equal([]uint8{1, 1}, GetNullableFlags(type.GetMethod("NonNullNested")!!.ReturnParameter))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 60_000

        private const LibrarySource string = `using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq.Expressions;

namespace ProjectionLib;

public sealed class Surface<T> : IEnumerable<T>
{
    private readonly List<T> items;

    public Surface(T value)
    {
        Property = value;
        Field = value;
        Nested = new List<T> { value };
        items = new List<T> { value };
    }

    public T Property { get; set; }

    public T Field;

    public List<T> Nested { get; }

    public IEnumerable<T> Values => items;

    public T this[int index]
    {
        get => items[index];
        set => items[index] = value;
    }

    public T Get() => Property;

    public void Set(T value) => Property = value;

    public bool TryGet(out T value)
    {
        value = Property;
        return true;
    }

    public IEnumerator<T> GetEnumerator() => items.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public class SchemeOptions
{
    public string Name { get; set; } = "";
}

public sealed class Handler<TOptions> : IEnumerable<TOptions>
    where TOptions : SchemeOptions
{
    private readonly List<TOptions> values = new();

    public TOptions? Options { get; set; }

    public TOptions Field = default!;

    public List<TOptions> Nested { get; } = new();

    public IEnumerable<TOptions> Values => values;

    public TOptions this[int index]
    {
        get => values[index];
        set
        {
            if (values.Count == 0)
                values.Add(value);
            else
                values[index] = value;
        }
    }

    public TOptions Get() => Field;

    public void Set(TOptions value)
    {
        Field = value;
        Options = value;
        if (values.Count == 0)
            values.Add(value);
        else
            values[0] = value;
        if (Nested.Count == 0)
            Nested.Add(value);
        else
            Nested[0] = value;
    }

    public bool TryGet(out TOptions value)
    {
        value = Field;
        return true;
    }

    public IEnumerator<TOptions> GetEnumerator() => values.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public sealed class RefSurface<T>
{
    private readonly T[] values = new T[1];

    public ref T this[int index] => ref values[index];
}

public sealed class Builder<TEntity>
    where TEntity : class
{
    public string HasOne<TRelated>(Expression<Func<TEntity, TRelated?>> navigation)
        where TRelated : class
        => navigation.Parameters[0].Type.Name + "/" + navigation.ReturnType.Name;
}

public static class Factory
{
    public static Surface<string> NonNull() => new("nonnull");

    public static Surface<string?> Nullable() => new("nullable");

    public static RefSurface<string?> NullableRef() => new();

    public static RefSurface<string> NonNullRef() => new();

    public static Builder<TEntity> BuilderFor<TEntity>()
        where TEntity : class
        => new();

    public static Dictionary<string, string> NonNullDictionary()
        => new() { ["a"] = "nonnull" };

    public static Dictionary<string, string?> NullableDictionary()
        => new() { ["a"] = "nullable" };
}`

        /// The flags a reader sees at a position: its own `[Nullable]`, or —
        /// when it repeats the context, which gsc then omits as csc does
        /// (issue #4988) — the enclosing `[NullableContext]`, expanded.
        private func GetNullableFlags(parameter ParameterInfo)[]uint8 -> ClrNullability.ExpandNullableFlags(
            parameter.ParameterType,
            ClrNullability.ReadNullableFlags(parameter, parameter.Member)
        )
            .ToArray()

        private func CompileDiagnostic(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_4059_4066_diag_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                return Compile(
                    tempDir,
                    "Diagnostic.gs",
                    source,
                    Path.Combine(tempDir, "Diagnostic.dll"),
                    "/target:library",
                    "/reference:" + libPath
                )
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func RunCase(name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4059_4066_run_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, name + ".dll")
                let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
                Assert.True(File.Exists(appPath), log)
                IlVerifier.Verify(appPath, []string{libPath})
                let (exit, output) = RunDotnet(appPath)
                Assert.Equal(0, exit)
                Assert.Equal(expectedLines, SplitLines(output))
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

        private func CompileCSharpLibrary(tempDir string) string {
            let compilation = CSharpCompilation.Create(
                "ProjectionLib",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                TrustedPlatformAssemblies().Select(
                    (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
                ),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "ProjectionLib.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                string.Join("\n", result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return stdout.ToString() + stderr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                process.Kill(entireProcessTree: true)
                return (-1, "timed out")
            }
            return (
                process.ExitCode,
                StringBuilder()
                    .Append(stdout.GetAwaiter().GetResult())
                    .Append(stderr.GetAwaiter().GetResult())
                    .ToString()
            )
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(tpa) {
                Enumerable.Empty[string]()
            } else {
                tpa!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
