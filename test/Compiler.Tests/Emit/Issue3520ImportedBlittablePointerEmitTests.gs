// <copyright file="Issue3520ImportedBlittablePointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

class Issue3520ImportedBlittablePointerEmitTests {
    @Fact
    func ImportedSequentialNestedAndExplicitStructPointers_RunAndVerify() {
        using let artifacts = Issue3520ImportedBlittablePointerEmitTests.TestArtifacts()
        const source = `package Issue3520.Consumer
import System
import Issue3520.Library

unsafe func ReadPair(value *BlittablePair) int32 {
    return value->X + value->Y
}

unsafe func ReadNested(value *NestedBlittablePair) int64 {
    return int64(value->Pair.X + value->Pair.Y) + value->Z
}

unsafe func ReadExplicit(value *ExplicitBlittablePair) int32 {
    return value->X + value->Y
}

unsafe func Main() {
    var pair = BlittablePair()
    pair.X = 20
    pair.Y = 22
    var pairs = []BlittablePair{pair}
    Console.WriteLine(ReadPair(&pairs[0]))

    var nested = NestedBlittablePair()
    nested.Pair = pair
    nested.Z = 8L
    var nestedValues = []NestedBlittablePair{nested}
    Console.WriteLine(ReadNested(&nestedValues[0]))

    var explicitPair = ExplicitBlittablePair()
    explicitPair.X = 7
    explicitPair.Y = 9
    var explicitValues = []ExplicitBlittablePair{explicitPair}
    Console.WriteLine(ReadExplicit(&explicitValues[0]))
}`
        let compilation = Compile(artifacts, source, target: "exe")
        Assert.True(compilation.ExitCode == 0, (`gsc failed:
` + "${compilation.Diagnostics}"))
        IlVerifier.Verify(
            compilation.OutputPath,
            additionalReferences: []string{artifacts.FixturePath},
            ignoredErrorCodes: UnsafeIlVerifyIgnored
        )
        Assert.Equal(
            "42${Environment.NewLine}50${Environment.NewLine}16${Environment.NewLine}",
            Run(compilation.OutputPath)
        )
    }

    @Fact
    func ImportedNonBlittableStructPointers_ReportGS0398() {
        using let artifacts = Issue3520ImportedBlittablePointerEmitTests.TestArtifacts()
        const source = `package Issue3520.Consumer
import Issue3520.Library

unsafe func ReadManaged(value *ManagedPair) int32 -> 0
unsafe func ReadAuto(value *AutoLayoutPair) int32 -> 0
unsafe func ReadRef(value *RefPair) int32 -> 0
unsafe func ReadNullable(value *NullablePair) int32 -> 0
unsafe func ReadBool(value *BoolPair) int32 -> 0
unsafe func ReadGeneric(value *GenericPair[string]) int32 -> 0`
        let compilation = Compile(artifacts, source, target: "library")
        Assert.NotEqual(0, compilation.ExitCode)
        Assert.Equal(6, Regex.Matches(compilation.Diagnostics, "\\berror GS0398:").Count)
        Assert.DoesNotContain("GS9998", compilation.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func ImportedMetadataClassifier_HandlesLayoutFieldsAndGenerics() {
        using let artifacts = Issue3520ImportedBlittablePointerEmitTests.TestArtifacts()
        using let resolver = ReferenceResolver.WithReferences([]string{artifacts.FixturePath})
        let detector = BlittableDetector()
        let AssertClassification = func (name string, expected bool) {
            Assert.True(resolver.TryResolveType("Issue3520.Library." + name, out var type))
            if expected {
                let nullableType = NullableTypeSymbol.Get(TypeSymbol.FromClrType(type))
                Assert.False(detector.IsBlittable(nullableType))
                Assert.False(detector.IsUnmanaged(nullableType))
                Assert.False(BlittableDetector.IsBlittableValueStructPointee(nullableType))
            }
            Assert.Equal(expected, BlittableDetector.IsBlittableValueStructPointee(TypeSymbol.FromClrType(type)))
        }
        let nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(detector.IsBlittable(nullableInt))
        Assert.False(detector.IsUnmanaged(nullableInt))
        Assert.False(BlittableDetector.IsBlittableValueStructPointee(nullableInt))
        AssertClassification("BlittablePair", expected: true)
        AssertClassification("NestedBlittablePair", expected: true)
        AssertClassification("ExplicitBlittablePair", expected: true)
        AssertClassification("PointerNode", expected: true)
        AssertClassification("ManagedPair", expected: false)
        AssertClassification("AutoLayoutPair", expected: false)
        AssertClassification("RefPair", expected: false)
        AssertClassification("NullablePair", expected: false)
        AssertClassification("BoolPair", expected: false)
        Assert.True(resolver.TryResolveType("Issue3520.Library.GenericPair`1", out var openGeneric))
        Assert.False(BlittableDetector.IsBlittableValueStructPointee(TypeSymbol.FromClrType(openGeneric)))
        let intType = resolver.MapClrTypeToReferences(typeof(int32))
        let stringType = resolver.MapClrTypeToReferences(typeof(string))
        Assert.True(
            BlittableDetector.IsBlittableValueStructPointee(
                TypeSymbol.FromClrType(openGeneric.MakeGenericType(intType))
            )
        )
        Assert.False(
            BlittableDetector.IsBlittableValueStructPointee(
                TypeSymbol.FromClrType(openGeneric.MakeGenericType(stringType))
            )
        )
    }

    private class TestArtifacts : IDisposable {
        init() {
            Directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3520ImportedBlittablePointerEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(Directory)
            FixturePath = Path.Combine(Directory, "Issue3520.Library.dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Issue3520.Library",
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        Issue3520ImportedBlittablePointerEmitTests.FixtureSource,
                        CSharpParseOptions(LanguageVersion.Latest)
                    )
                },
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true)
            )
            let result = compilation.Emit(FixturePath)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        prop Directory string {
            get;
        }

        prop FixturePath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private const FixtureSource string = `using System.Runtime.InteropServices;

namespace Issue3520.Library;

[StructLayout(LayoutKind.Sequential)]
public struct BlittablePair
{
    public int X;
    public int Y;
}

[StructLayout(LayoutKind.Sequential)]
public struct NestedBlittablePair
{
    public BlittablePair Pair;
    public long Z;
}

[StructLayout(LayoutKind.Explicit)]
public struct ExplicitBlittablePair
{
    [FieldOffset(0)]
    public int X;

    [FieldOffset(4)]
    public int Y;
}

[StructLayout(LayoutKind.Sequential)]
public struct ManagedPair
{
    public string Text;
    public int Value;
}

[StructLayout(LayoutKind.Auto)]
public struct AutoLayoutPair
{
    public int Value;
}

public ref struct RefPair
{
    public int Value;
}

public struct NullablePair
{
    public int? Value;
}

public struct BoolPair
{
    public bool Value;
}

public struct GenericPair<T>
{
    public T Value;
}

public unsafe struct PointerNode
{
    public int Value;
    public PointerNode* Next;
}`

        private func Compile(
            artifacts Issue3520ImportedBlittablePointerEmitTests.TestArtifacts,
            source string,
            target string
        )(ExitCode int32, Diagnostics string, OutputPath string) {
            let sourcePath = Path.Combine(artifacts.Directory, "Consumer.gs")
            let outputPath = Path.Combine(artifacts.Directory, "Issue3520.Consumer.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{
                        "/out:" + outputPath,
                        "/target:" + target,
                        "/targetframework:net10.0",
                        "/reference:" + artifacts.FixturePath,
                        sourcePath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, stdout.ToString() + stderr.ToString(), outputPath)
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
