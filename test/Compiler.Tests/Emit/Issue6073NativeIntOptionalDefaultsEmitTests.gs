// <copyright file="Issue6073NativeIntOptionalDefaultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import MetadataParameter = System.Reflection.Metadata.Parameter

/// Regression coverage for issue #6073.
class Issue6073NativeIntOptionalDefaultsEmitTests {
    @Fact
    func NativeIntOptionalDefaults_EmitMetadataAndRoundTripAcrossAssemblies() {
        WithDirectory(
            (directory string) -> {
                let libraryPath = Path.Combine(directory, "Issue6073.Library.dll")
                let refPath = Path.Combine(directory, "ref", "Issue6073.Library.dll")
                let gsharpConsumerPath = Path.Combine(directory, "Issue6073.GSharpConsumer.dll")
                let csharpConsumerPath = Path.Combine(directory, "Issue6073.CSharpConsumer.dll")
                const librarySource = `package Issue6073

import System

func TopNInt(
    h nint = 0,
    neg nint = -1,
    max nint = 2147483647,
    min nint = -2147483648,
    castVal nint = nint(42),
    sumVal nint = 1 + 2,
    defVal nint = default(nint),
    ch nint = 'A'
) string -> "${int64(h)}:${int64(neg)}:${int64(max)}:${int64(min)}:${int64(castVal)}:${int64(sumVal)}:${int64(defVal)}:${int64(ch)}"

func FloatFromNInt(v float64 = nint(1)) float64 -> v

func TopNUInt(
    u nuint = 0,
    maxU nuint = 4294967295,
    castVal nuint = nuint(7),
    defVal nuint = default(nuint),
    ch nuint = 'B'
) string -> "${uint64(u)}:${uint64(maxU)}:${uint64(castVal)}:${uint64(defVal)}:${uint64(ch)}"

func TopNullable(
    a nint? = 0,
    b nint? = default(nint),
    c nint? = nil,
    d nint? = default(nint?),
    e nuint? = 4294967295,
    f nuint? = default(nuint),
    g nuint? = nil
) string {
    let aStr = if a.HasValue { "${int64(a.Value)}" } else { "nil" }
    let bStr = if b.HasValue { "${int64(b.Value)}" } else { "nil" }
    let cStr = if c.HasValue { "${int64(c.Value)}" } else { "nil" }
    let dStr = if d.HasValue { "${int64(d.Value)}" } else { "nil" }
    let eStr = if e.HasValue { "${uint64(e.Value)}" } else { "nil" }
    let fStr = if f.HasValue { "${uint64(f.Value)}" } else { "nil" }
    let gStr = if g.HasValue { "${uint64(g.Value)}" } else { "nil" }
    return "$aStr:$bStr:$cStr:$dStr:$eStr:$fStr:$gStr"
}

interface IHandleApi {
    func Compute(h nint = 12, u nuint = 34) string;
}

class HandleApi : IHandleApi {
    func Compute(h nint = 12, u nuint = 34) string -> "${int64(h)}:${uint64(u)}"
}

delegate Callback(h nint = 5, u nuint = 6) string;

class Holder {
    var Text string

    init(h nint = -1, u nuint = 4294967295) {
        Text = "${int64(h)}:${uint64(u)}"
    }

    func Call(h nint = 0, u nuint = 4294967295) string -> "${int64(h)}:${uint64(u)}"

    shared {
        func StaticCall(h nint = nint(9), u nuint = nuint(10)) string -> "${int64(h)}:${uint64(u)}"
        func MaxNUInt(u nuint = 4294967295) nuint -> u
    }
}

class Primary(h nint = -5, u nuint = 4294967295) {
    func Read() string -> "${int64(h)}:${uint64(u)}"
}

class SameAssemblyCalls {
    shared {
        func Run() string {
            let cb Callback = (h nint = 5, u nuint = 6) -> "${int64(h)}:${uint64(u)}"
            let lam = (h nint = -2, u nuint = 4294967295) -> "${int64(h)}:${uint64(u)}"
            let expr System.Linq.Expressions.Expression[Func[nuint]] = () -> Holder.MaxNUInt()
            let exprVal = expr.Compile()()
            let explicit = TopNInt(h: nint(3000000000L), neg: nint(-3000000000L)) + "|" +
                TopNUInt(u: nuint(5000000000UL))
            return TopNInt() + "|" +
                TopNUInt() + "|" +
                TopNullable() + "|" +
                Holder().Text + "|" +
                Holder().Call() + "|" +
                Holder.StaticCall() + "|" +
                Primary().Read() + "|" +
                HandleApi().Compute() + "|" +
                cb() + "|" +
                lam() + "|" +
                "${FloatFromNInt().ToString(System.Globalization.CultureInfo.InvariantCulture)}:${uint64(exprVal)}|" +
                explicit
        }
    }
}`
                EmitGSharp(librarySource, libraryPath, "Issue6073.Library", Array.Empty[string]())
                AssertLibraryMetadata(libraryPath)
                AssertLibraryReflection(libraryPath)
                Assert.Equal(
                    "0:-1:2147483647:-2147483648:42:3:0:65|0:4294967295:7:0:66|0:0:nil:nil:4294967295:0:nil|-1:4294967295|0:4294967295|9:10|-5:4294967295|12:34|5:6|-2:4294967295|1:4294967295|3000000000:-3000000000:2147483647:-2147483648:42:3:0:65|5000000000:4294967295:7:0:66",
                    Invoke(libraryPath, libraryPath, "Issue6073.SameAssemblyCalls")
                )

                const gsharpConsumerSource = `package Issue6073Consumer

import Issue6073

class Calls {
    shared {
        func Run() string {
            let api IHandleApi = HandleApi()
            return TopNInt() + "|" +
                TopNUInt() + "|" +
                TopNullable() + "|" +
                Holder().Text + "|" +
                Holder().Call() + "|" +
                Holder.StaticCall() + "|" +
                Primary().Read() + "|" +
                api.Compute() + "|" +
                Holder(nint(3000000000L), nuint(5000000000UL)).Text
        }
    }
}`
                EmitGSharp(gsharpConsumerSource, gsharpConsumerPath, "Issue6073.GSharpConsumer", []string{refPath})
                Assert.Equal(
                    "0:-1:2147483647:-2147483648:42:3:0:65|0:4294967295:7:0:66|0:0:nil:nil:4294967295:0:nil|-1:4294967295|0:4294967295|9:10|-5:4294967295|12:34|3000000000:5000000000",
                    Invoke(libraryPath, gsharpConsumerPath, "Issue6073Consumer.Calls")
                )

                const csharpConsumerSource = `using Issue6073;
public static class CSharpCalls
{
    public static string Run()
    {
        var holder = new Holder();
        var primary = new Primary();
        IHandleApi api = new HandleApi();
        return $"{holder.Text}|{holder.Call()}|{Holder.StaticCall()}|{primary.Read()}|{api.Compute()}|{new Holder((nint)3000000000L, (nuint)5000000000UL).Text}";
    }
}`
                EmitCSharp(csharpConsumerSource, csharpConsumerPath, refPath)
                IlVerifier.Verify(csharpConsumerPath, additionalReferences: []string{refPath})
                Assert.Equal(
                    "-1:4294967295|0:4294967295|9:10|-5:4294967295|12:34|3000000000:5000000000",
                    Invoke(libraryPath, csharpConsumerPath, "CSharpCalls")
                )
            }
        )
    }

    @Fact
    func GSharpConsumer_CanOmitCSharpNativeIntOptionalDefaults() {
        WithDirectory(
            (directory string) -> {
                let csharpLibraryPath = Path.Combine(directory, "Issue6073.CSharpLib.dll")
                let gsharpConsumerPath = Path.Combine(directory, "Issue6073.FromCSharp.dll")
                const csharpLibrary = `namespace Issue6073CSharp
{
    public static class CSharpDefaults
    {
        public static string Echo(nint a = -1, nuint b = uint.MaxValue, nint? c = 0, nuint? d = 7, nint? e = null)
            => $"{a}:{b}:{(c.HasValue ? c.Value.ToString() : "nil")}:{(d.HasValue ? d.Value.ToString() : "nil")}:{(e.HasValue ? e.Value.ToString() : "nil")}";
    }
}`
                EmitCSharp(csharpLibrary, csharpLibraryPath, nil)
                const gsharpConsumer = `package Issue6073FromCSharp

import Issue6073CSharp

class Calls {
    shared {
        func Run() string -> CSharpDefaults.Echo() + "|" +
            CSharpDefaults.Echo(nint(3000000000L), nuint(5000000000UL), nint(42), nuint(99), nint(-7))
    }
}`
                EmitGSharp(gsharpConsumer, gsharpConsumerPath, "Issue6073.FromCSharp", []string{csharpLibraryPath})
                Assert.Equal(
                    "-1:4294967295:0:7:nil|3000000000:5000000000:42:99:-7",
                    Invoke(csharpLibraryPath, gsharpConsumerPath, "Issue6073FromCSharp.Calls")
                )
            }
        )
    }

    @Fact
    func Driver_MinimalRepro_CompilesVerifiesAndRuns() {
        WithDirectory(
            (directory string) -> {
                let srcPath = Path.Combine(directory, "Program.gs")
                let outPath = Path.Combine(directory, "repro.dll")
                File.WriteAllText(srcPath, `import System
func f(handle nint = 0) nint -> handle
Console.WriteLine(f())
`)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(exitCode == 0, "gsc failed:\nstdout:\n" + "$compileOut" + "\nstderr:\n" + "$compileErr")
                IlVerifier.Verify(outPath)
                let context = AssemblyLoadContext("Issue6073Driver", isCollectible: true)
                using let runOut = StringWriter()
                let prevRunOut = Console.Out
                Console.SetOut(runOut)
                try {
                    using let stream = MemoryStream(File.ReadAllBytes(outPath))
                    let assembly = context.LoadFromStream(stream)
                    let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
                    let entry = program.GetMethod(
                        "<Main>$$",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                    )!!
                    entry.Invoke(
                        nil,
                        if entry.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(prevRunOut)
                    context.Unload()
                }
                Assert.Equal("0", runOut.ToString().Trim())
            }
        )
    }

    @Fact
    func OutOfRangeAndInvalidNativeIntDefaults_ReportGS0265WithoutGS9998() {
        const source = `package InvalidNativeDefaults

func OutOfRangeNIntHigh(x nint = 2147483648) {}
func OutOfRangeNIntLow(x nint = -2147483649L) {}
func OutOfRangeNIntCast(x nint = nint(3000000000L)) {}
func OutOfRangeNUIntHigh(x nuint = 4294967296) {}
func NegativeNUInt(x nuint = -1) {}
func NilToNInt(x nint = nil) {}
func DefaultNullableToNInt(x nint = default(nint?)) {}
func BareDefaultToNInt(x nint = default) {}
func FloatToNInt(x nint = 1.5) {}
func ObjectNIntDefault(x object = nint(0)) {}`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue6073.Invalid")
        Assert.False(result.Success)
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
        let errors = result
            .Diagnostics
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.Equal(10, errors.Length)
        Assert.All(errors, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> Assert.Equal("GS0265", diagnostic.Id))
        Assert.Equal(
            []int32{2, 3, 4, 5, 6, 7, 8, 9, 10, 11},
            errors
                .Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Location.StartLine)
                .OrderBy((line int32) -> line)
                .ToArray()
        )
    }

    shared {
        private func WithDirectory(action(string) -> void) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue6073", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                action(directory)
            } finally {
                if Directory.Exists(directory) {
                    Directory.Delete(directory, recursive: true)
                }
            }
        }

        private func EmitGSharp(source string, outputPath string, assemblyName string, references[]string) {
            using let resolver = ReferenceResolver.WithReferences(references)
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            let referenceDirectory = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(outputPath)!!, "ref"))
            {
                using let output = File.Create(outputPath)
                using let reference = File.Create(Path.Combine(referenceDirectory.FullName, assemblyName + ".dll"))
                let result = compilation.Emit(output, pdbStream: nil, refStream: reference, assemblyName: assemblyName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(outputPath, additionalReferences: references)
        }

        private func EmitCSharp(source string, outputPath string, reference string?) {
            var references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            if reference != nil {
                references = references.Append(MetadataReference.CreateFromFile(reference))
            }
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(outputPath),
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func AssertLibraryMetadata(libraryPath string) {
            using let stream = File.OpenRead(libraryPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let holderType = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((type TypeDefinition) -> reader.GetString(type.Name) == "Holder")
            let holderCtor = holderType
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single((method MethodDefinition) -> reader.GetString(method.Name) == ".ctor")
            let holderParams = holderCtor.GetParameters().Select(reader.GetParameter).ToArray()
            Assert.Equal(2, holderParams.Length)
            Assert.Equal(ConstantTypeCode.Int32, reader.GetConstant(holderParams[0].GetDefaultValue()).TypeCode)
            Assert.Equal(ConstantTypeCode.UInt32, reader.GetConstant(holderParams[1].GetDefaultValue()).TypeCode)
            Assert.All(
                holderParams,
                (parameter MetadataParameter) -> {
                    Assert.True((parameter.Attributes & ParameterAttributes.Optional) != 0)
                    Assert.True((parameter.Attributes & ParameterAttributes.HasDefault) != 0)
                }
            )
        }

        private func AssertLibraryReflection(libraryPath string) {
            let context = AssemblyLoadContext("Issue6073Reflect", isCollectible: true)
            try {
                using let stream = MemoryStream(File.ReadAllBytes(libraryPath))
                let library = context.LoadFromStream(stream)
                let holder = library.GetType("Issue6073.Holder", throwOnError: true)!!
                let ctorParams = holder.GetConstructors().Single().GetParameters()
                Assert.Equal(2, ctorParams.Length)
                Assert.True(ctorParams[0].IsOptional)
                Assert.True(ctorParams[0].HasDefaultValue)
                Assert.Equal(-1, ctorParams[0].RawDefaultValue)
                Assert.True(ctorParams[1].IsOptional)
                Assert.True(ctorParams[1].HasDefaultValue)
                Assert.Equal(4294967295u, ctorParams[1].RawDefaultValue)
            } finally {
                context.Unload()
            }
        }

        private func Invoke(dependency string, entry string, typeName string) string {
            let context = AssemblyLoadContext("Issue6073Run", isCollectible: true)
            let culture = CultureInfo.CurrentCulture
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture
            try {
                if !string.Equals(dependency, entry, StringComparison.OrdinalIgnoreCase) {
                    using let dependencyStream = MemoryStream(File.ReadAllBytes(dependency))
                    context.LoadFromStream(dependencyStream)
                }
                using let entryStream = MemoryStream(File.ReadAllBytes(entry))
                let assembly = context.LoadFromStream(entryStream)
                return cast[string](
                    assembly.GetType(typeName, throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)!!
                )
            } finally {
                CultureInfo.CurrentCulture = culture
                context.Unload()
            }
        }
    }
}
