// <copyright file="Issue5805ConstantEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import CSharpCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation
import CSharpCompilationOptions = Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions
import CSharpSyntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree
import GSharp.Compiler
import GSharp.Compiler.Tests
import MetadataReference = Microsoft.CodeAnalysis.MetadataReference
import OutputKind = Microsoft.CodeAnalysis.OutputKind
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import System.Runtime.Loader
import Xunit

class Issue5805ConstantEmitTests {
    @Fact
    func ImportedDecimalAttributes_FoldWithoutRunningFieldInitializers() {
        let directory = System
            .IO
            .Path
            .Combine(AppContext.BaseDirectory, "decimal-fixture-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let path = System.IO.Path.Combine(directory, "Foreign.dll")
            let references = Assert
                .IsType[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
                .Split(System.IO.Path.PathSeparator)
                .Select((p string) -> MetadataReference.CreateFromFile(p))
            let fixture = CSharpCompilation.Create(
                "Foreign",
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(`
using System.Runtime.CompilerServices;
namespace ConstantImports;
public static class Foreign {
    [DecimalConstant(2, 128, 0, 0, 75)] public static readonly decimal Signed;
    [DecimalConstant(2, 0, 0u, 0u, 75u)] public static readonly decimal Unsigned;
    [DecimalConstant(2, 0, 0u, 0u, 100u)] public static readonly decimal Scaled;
    [DecimalConstant(2, 128, 0, 0, 0)] public static readonly decimal SignedZero;
    public static readonly decimal NotConstant = 2m;
    public const decimal Wide = 79228162514264337593543950335m;
    static Foreign() { throw new System.Exception("must not initialize"); }
}
`)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = MemoryStream()
            let emitted = fixture.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            File.WriteAllBytes(path, stream.ToArray())
            using let program = Compile(`
import System
import System.Globalization
import ConstantImports
const Signed decimal = Foreign.Signed
const Unsigned decimal = Foreign.Unsigned
const Wide decimal = Foreign.Wide
const Scaled decimal = Foreign.Scaled
const SignedZero decimal = Foreign.SignedZero
Console.WriteLine(Signed == -0.75m && Unsigned == 0.75m && Wide == decimal.MaxValue)
Console.WriteLine(Scaled.ToString(CultureInfo.InvariantCulture))
Console.WriteLine(decimal.GetBits(SignedZero)[3])
`, references: []string{path})
            Assert.Equal("True|1.00|-2147352576", program.Run())
            let rejected = Assert.ThrowsAny[Exception](
                () -> {
                    using let invalid = Compile(
                        "import ConstantImports\nconst Bad decimal = Foreign.NotConstant",
                        library: true,
                        references: []string{path}
                    )
                }
            )
            Assert.Contains("GS0376", rejected.Message)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ExplicitBoxedNaN_PreservesEqualityAfterAwaitSpills() {
        using let program = Compile(`
import System
import System.Threading.Tasks

class Pretender {
    override func Equals(other object?) bool {
        Console.WriteLine("Equals")
        return true
    }
    override func GetHashCode() int32 { return 0 }
}
async func Match(v object?) Task[bool] {
    return v is (cast[object?]({
        await Task.Yield()
        cast[object?](float64.NaN)
    }))
}
async func Primitive(v object?) Task[bool] {
    return v is (cast[float64]({
        await Task.Yield()
        float64.NaN
    }))
}
let d object = float64.NaN
let f object? = float32.NaN
Console.WriteLine(d is (cast[object](float64.NaN)))
Console.WriteLine(f is (cast[object?](float32.NaN)))
Console.WriteLine(d is float64.NaN)
Console.WriteLine(Primitive(d).Result)
Console.WriteLine(Match(d).Result)
Console.WriteLine(Match(nil).Result)
Console.WriteLine(Match(Pretender()).Result)
`)
        Assert.Equal("True|True|False|False|True|False|Equals|True", program.Run())
    }

    @Fact
    func DecimalConstants_RoundTripMetadataAndInlineAcrossCompilations() {
        using let constants = Compile(`
package DecimalValues
class Values {
    public const Max decimal = decimal.MaxValue
    public const Min decimal = decimal.MinValue
    public const Fraction decimal = 0.1234567890123456789012345678m
    public const Copy decimal = Fraction
}
`, library: true)
        let load = AssemblyLoadContext("decimal-constants", isCollectible: true)
        let assembly = load.LoadFromAssemblyPath(constants.Path)
        let fields = assembly.GetType("DecimalValues.Values", throwOnError: true)!!.GetFields(
            BindingFlags.Public | BindingFlags.Static
        )
        Assert.Equal(4, fields.Length)
        for field in fields {
            Assert.True(field.IsInitOnly)
            let attribute = Assert.IsType[DecimalConstantAttribute](
                field.GetCustomAttribute[DecimalConstantAttribute]()
            )
            Assert.Equal(field.GetValue(nil), attribute.Value)
        }
        using let consumer = Compile(`
import System
import DecimalValues
const Max decimal = Values.Max
const Min decimal = Values.Min
const Fraction decimal = Values.Copy
func Read() decimal {
    const Local decimal = Fraction + decimal.One
    return Local
}
Console.WriteLine(Max == decimal.MaxValue)
Console.WriteLine(Min == decimal.MinValue)
Console.WriteLine(Read() == 1.1234567890123456789012345678m)
`, references: []string{constants.Path})
        Assert.Equal("True|True|True", consumer.Run())
        load.Unload()
    }

    @Fact
    func ReferenceNullConstants_EmitNullMetadataAndRunAtReadSites() {
        using let program = Compile(`
package NullValues
import System
class C {}
interface I {}
delegate D() void;
class P {
    public const ClassNil C? = nil
    public const DefaultNil C? = default(C?)
    public const InterfaceNil I? = nil
    public const DelegateNil D? = nil
    public const ArrayNil []?C = nil
    public const ObjectNil object? = default(object?)
    public const StringNil string? = default(string?)
    shared {
        func Read() bool {
            const Local C? = ClassNil
            const DefaultLocal C? = default
            return Local == nil && DefaultLocal == nil
        }
    }
}
Console.WriteLine(P.Read())
Console.WriteLine(P.ClassNil == nil && P.DefaultNil == nil && P.InterfaceNil == nil &&
    P.DelegateNil == nil && P.ArrayNil == nil && P.ObjectNil == nil && P.StringNil == nil)
`)
        Assert.Equal("True|True", program.Run())
        let load = AssemblyLoadContext("reference-constants", isCollectible: true)
        try {
            let fields = load.LoadFromAssemblyPath(program.Path).GetType(
                "NullValues.P",
                throwOnError: true
            )!!.GetFields(BindingFlags.Public | BindingFlags.Static)
            Assert.Equal(7, fields.Length)
            for field in fields {
                Assert.True(field.IsLiteral)
                Assert.Null(field.GetRawConstantValue())
            }
            let read = load.LoadFromAssemblyPath(program.Path).GetType("NullValues.P", throwOnError: true)!!.GetMethod(
                "Read",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let instructions = IlInstructionReader.Read(read.GetMethodBody()!!.GetILAsByteArray()!!)
            Assert.NotEmpty(instructions)
            Assert.Contains(instructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldnull)
            Assert.DoesNotContain(instructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldloc_0)
        } finally {
            load.Unload()
        }
    }

    shared {
        private func Compile(source string, library bool = false, references[]string? = nil) CompiledProgram {
            let assemblyReferences = references ?? []string{}
            let directory = System
                .IO
                .Path
                .Combine(AppContext.BaseDirectory, "issue5805-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = System.IO.Path.Combine(directory, "input.gs")
                let outputPath = System.IO.Path.Combine(directory, "input.dll")
                File.WriteAllText(sourcePath, source)
                let args = System
                    .Collections
                    .Generic
                    .List[string]{
                    "/out:$outputPath",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    if library {
                        "/target:library"
                    } else {
                        "/target:exe"
                    }
                }
                for reference in assemblyReferences {
                    args.Add("/r:$reference")
                }
                args.Add(sourcePath)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                var exitCode int32
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    exitCode = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "$stdout\n$stderr")
                IlVerifier.Verify(outputPath, additionalReferences: assemblyReferences)
                return CompiledProgram(directory, outputPath)
            } catch {
                Directory.Delete(directory, recursive: true)
                rethrow
            }
        }
    }

    private class CompiledProgram : IDisposable {
        private let directory string
        prop Path string {
            get;
        }

        init(directory string, path string) {
            this.directory = directory
            Path = path
        }

        func Run() string {
            using let process = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {Path},
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )!!
            let output = process.StandardOutput.ReadToEnd()
            let error = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet timed out")
            Assert.True(process.ExitCode == 0, error)
            return string.Join("|", output.ReplaceLineEndings("\n").TrimEnd('\n').Split('\n'))
        }

        func Dispose() {
            Directory.Delete(directory, recursive: true)
        }
    }
}
