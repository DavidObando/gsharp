// <copyright file="Issue2516SliceCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2516: a slice composes its exact CLR array-interface implementation
/// with declaration-site generic covariance. Mutable interfaces and arrays
/// remain invariant.
open class Issue2516SliceCovarianceEmitTests {
    @Fact
    func BareCovariantInterfaces_PreserveIdentityEnumerationAndExactMutableViews() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic

open class Animal { }
class Dog : Animal { }

func Count(items IEnumerable[Animal]?) int32 {
    if items == nil {
        return -1
    }

    var count = 0
    for _ in items {
        count = count + 1
    }

    return count
}

func Widen[T Animal](items []T) IEnumerable[Animal] -> items

func WidenNested(
    items []IReadOnlyList[Dog]
) IEnumerable[IReadOnlyList[Animal]] -> items

var dogs = []Dog{Dog(), Dog()}
var enumerable IEnumerable[Animal]? = dogs
var readOnlyList IReadOnlyList[Animal] = dogs
var readOnlyCollection IReadOnlyCollection[Animal] = dogs
var exactList IList[Dog] = dogs
var exactCollection ICollection[Dog] = dogs

Console.WriteLine(Object.ReferenceEquals(dogs, enumerable))
Console.WriteLine(Count(enumerable))
Console.WriteLine(readOnlyList.Count)
Console.WriteLine(readOnlyCollection.Count)
Console.WriteLine(exactList.Count)
Console.WriteLine(exactCollection.Count)
Console.WriteLine(Count(Widen[Dog](dogs)))

var nestedSource = []IReadOnlyList[Dog]{dogs}
var nested = WidenNested(nestedSource)
for item in nested {
    Console.WriteLine(item.Count)
}`)
        Assert.Equal(
            "True${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}",
            output
        )
    }

    @Fact
    func BareNullableSlice_ToNullableCovariantInterface_PropagatesNull() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic

open class Animal { }
class Dog : Animal { }

func Widen(items []?Dog) IEnumerable[Animal]? -> items

var dogs = []Dog{Dog()}
Console.WriteLine(Object.ReferenceEquals(dogs, Widen(dogs)))
Console.WriteLine(Widen(nil) == nil)`)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func ExpressionTree_BareSliceCovariance_MatchesCSharpParameterShape() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic
import System.Linq.Expressions

open class Animal { }
class Dog : Animal { }

func MakeTree() Expression[Func[[]Dog, IEnumerable[Animal]]] {
    return (items []Dog) -> items
}

Console.WriteLine(MakeTree().Body.NodeType)`)
        // C# omits representation-preserving reference conversions from an
        // expression tree; translator-generated `as` incorrectly produced TypeAs.
        Assert.Equal("Parameter${Environment.NewLine}", output)
    }

    @Fact
    func SourceAndMetadataElements_ToMetadataCovariantInterface_CompileRunAndIlVerify() {
        let sibling = `namespace Probe.CSharp
{
    public class Animal { }
    public sealed class MetadataDog : Animal { }

    public static class Factory
    {
        public static MetadataDog[] Create() => new[] { new MetadataDog() };
    }

    public static class Sink
    {
        public static int Count(
            System.Collections.Generic.IEnumerable<Animal> items)
        {
            int count = 0;
            foreach (var _ in items) count++;
            return count;
        }
    }
}`
        let gsource = `package Probe.Tests
import System
import System.Collections.Generic
import Probe.CSharp

class SourceDog : Animal { }

var sourceDogs = []SourceDog{SourceDog(), SourceDog()}
var metadataDogs = []MetadataDog{MetadataDog(), MetadataDog(), MetadataDog()}
var sourceView IEnumerable[Animal] = sourceDogs
var metadataView IEnumerable[Animal] = metadataDogs
var returnedView IEnumerable[Animal] = Factory.Create()

Console.WriteLine(Object.ReferenceEquals(sourceDogs, sourceView))
Console.WriteLine(Object.ReferenceEquals(metadataDogs, metadataView))
Console.WriteLine(Sink.Count(sourceDogs))
Console.WriteLine(Sink.Count(metadataDogs))
Console.WriteLine(Sink.Count(returnedView))`
        let output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp.Issue2516")
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}1${Environment.NewLine}",
            output
        )
    }

    // Issue #3685: every case here is still REJECTED — slice invariance is
    // unchanged. What differs per case is which diagnostic explains the
    // rejection. The reference-element slice → slice case now has an
    // EXPLICIT spelling (`cast[[]Animal](...)`), so the classifier reports
    // GS0156 ("an explicit conversion exists") and points the author at the
    // cast; the interface targets and the value-type element have no such
    // spelling and keep the dead-end GS0155. The expected id is a parameter
    // so an accidental slide into an IMPLICIT conversion still fails loudly
    // via the exit-code assertion below.
    @Theory
    @InlineData("[]Animal", "[]Dog{Dog()}", "GS0156")
    @InlineData("IList[Animal]", "[]Dog{Dog()}", "GS0155")
    @InlineData("ICollection[Animal]", "[]Dog{Dog()}", "GS0155")
    @InlineData("IEnumerable[object]", "[]int32{1}", "GS0155")
    func UnsafeOrValueTypeVariance_RemainsRejected(targetType string, value string, expectedDiagnostic string) {
        let source = (`package Probe
import System.Collections.Generic

open class Animal { }
class Dog : Animal { }

var rejected ` + "$targetType" + ` = ` + "$value")
        let (exitCode, diagnostics) = Compile(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains(expectedDiagnostic, diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func NullableElementAnnotation_CovariantInterfaceConversion_Compiles() {
        // The covariant element conversion composes with a nullable ELEMENT
        // envelope too (`[]Dog? -> IEnumerable[Animal?]`), not just a
        // nullable outer array/interface reference.
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic

open class Animal { }
class Dog : Animal { }

func Widen(items []Dog?) IEnumerable[Animal?] -> items

var dogs = []Dog?{Dog(), nil, Dog()}
var widened = Widen(dogs)
var count = 0
for item in widened {
    count = count + 1
}
Console.WriteLine(count)
Console.WriteLine(Object.ReferenceEquals(dogs, widened))`)
        Assert.Equal("3${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func CSharpConsumer_ObservesCompilerCovariantEnumerable_ReflectionAndIdentity() {
        // Interoperability / reflection coverage: a plain C# PROGRAM (no gsc
        // involved) references a G#-compiled library whose public API relies
        // ENTIRELY on the new native slice-to-covariant-interface conversion
        // (no translator-side cast, no compiler-side cast — a bare assignment),
        // then consumes it exactly like any other .NET IEnumerable<Animal>:
        // enumerating it, reading each element's runtime type via reflection,
        // and confirming the elements are the SAME references the library's
        // own array holds.
        let gsource = `package Probe.Issue2516Interop
import System.Collections.Generic

public open class Animal { }
public class Dog : Animal { }

public class Library {
    shared {
        public let dogs []Dog = []Dog{Dog(), Dog(), Dog()}
        public let animals IEnumerable[Animal] = Library.dogs

        public func GetDogAt(i int32) Dog {
            return Library.dogs[i]
        }
    }
}`
        const consumerSource = `using System.Collections.Generic;
using System.Linq;
using Probe.Issue2516Interop;

public static class Consumer
{
    public static string Run()
    {
        IEnumerable<Animal> animals = Library.animals;
        List<Animal> list = animals.ToList();
        bool allDogs = list.All(a => a.GetType().Name == "Dog");
        bool allSameRef = System.Object.ReferenceEquals(list[0], Library.GetDogAt(0))
            && System.Object.ReferenceEquals(list[1], Library.GetDogAt(1))
            && System.Object.ReferenceEquals(list[2], Library.GetDogAt(2));
        return list.Count + "," + allDogs + "," + allSameRef;
    }
}`
        let output string? = CompileGsharpLibraryAndRunCSharpConsumer(gsource, consumerSource)
        Assert.Equal("3,True,True", output)
    }

    shared {
        private func CompileGsharpLibraryAndRunCSharpConsumer(gSource string, consumerCsSource string) string? {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2516_interop_").FullName
            try {
                let gsSrcPath = Path.Combine(tempDir, "library.gs")
                let libraryDllPath = Path.Combine(tempDir, "library.dll")
                File.WriteAllText(gsSrcPath, gSource)
                let compileExit = RunCompiler(
                    []string{
                        "/out:" + libraryDllPath,
                        "/target:library",
                        "/targetframework:net10.0",
                        "/nowarn:GS9100",
                        gsSrcPath
                    },
                    out var diagnostics
                )
                Assert.True(compileExit == 0, (`gsc failed compiling the G# library:
` + "$diagnostics"))
                IlVerifier.Verify(libraryDllPath)
                let consumerTree = CSharpSyntaxTree.ParseText(
                    consumerCsSource,
                    CSharpParseOptions(LanguageVersion.Latest)
                )
                let references = List[MetadataReference](
                    TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path))
                ){MetadataReference.CreateFromFile(libraryDllPath)}
                let consumerCompilation = CSharpCompilation.Create(
                    "Issue2516.CSharpConsumer",
                    []SyntaxTree{consumerTree},
                    references,
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                let consumerDllPath = Path.Combine(tempDir, "consumer.dll")
                {
                    using let stream = File.Create(consumerDllPath)
                    let emitResult = consumerCompilation.Emit(stream)
                    Assert.True(
                        emitResult.Success,
                        "C# consumer failed to compile against the G# library:\n" + string.Join(
                            "\n",
                            emitResult.Diagnostics
                        )
                    )
                }
                let loadContext = AssemblyLoadContext("Issue2516Interop", isCollectible: true)
                try {
                    loadContext.LoadFromAssemblyPath(libraryDllPath)
                    let consumerAssembly = loadContext.LoadFromAssemblyPath(consumerDllPath)
                    let consumerType Type? = consumerAssembly.GetType("Consumer", throwOnError: true)
                    let runMethod MethodInfo? = consumerType!!.GetMethod("Run")
                    return cast[string](runMethod!!.Invoke(nil, nil))
                } finally {
                    loadContext.Unload()
                }
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func Compile(source string)(ExitCode int32, Diagnostics string) {
            let directory = Directory.CreateTempSubdirectory("gs_issue2516_compile_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    let exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                    return (exitCode, stdout.ToString() + Environment.NewLine + stderr.ToString())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2516_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = RunCompiler(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath},
                    out var diagnostics
                )
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outputPath)
                return RunAssembly(directory, outputPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2516_sibling_").FullName
            try {
                let csDirectory = Path.Combine(directory, "csref")
                Directory.CreateDirectory(csDirectory)
                File.WriteAllText(Path.Combine(csDirectory, "Lib.cs"), csSource)
                File.WriteAllText(Path.Combine(csDirectory, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$siblingName" + `</AssemblyName>
  </PropertyGroup>
</Project>`))
                RunDotnet(csDirectory, "restore")
                RunDotnet(csDirectory, "build", "-c", "Release", "--nologo", "--no-restore")
                let siblingPath = Path.Combine(csDirectory, "bin", "Release", "net10.0", siblingName + ".dll")
                Assert.True(File.Exists(siblingPath), "Missing sibling assembly: $siblingPath")
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, gSource)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + siblingPath
                }
                for reference in TrustedPlatformAssemblies() {
                    arguments.Add("/reference:" + reference)
                }
                arguments.Add("/nowarn:GS9100")
                arguments.Add(sourcePath)
                let exitCode = RunCompiler(arguments.ToArray(), out var diagnostics)
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outputPath, additionalReferences: []string{siblingPath})
                File.Copy(siblingPath, Path.Combine(directory, Path.GetFileName(siblingPath)), overwrite: true)
                return RunAssembly(directory, outputPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(arguments[]string, out diagnostics string) int32 {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                diagnostics = (`stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                return exitCode
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func RunAssembly(workingDirectory string, assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
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
            Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func RunDotnet(workingDirectory string, arguments ...string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet ${arguments[0]}.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(120_000), "dotnet ${arguments[0]} timed out.")
            Assert.True(
                process.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", arguments)}" + ` exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let trusted string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(trusted) {
                yield break
            }
            for path in trusted.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
