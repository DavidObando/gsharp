package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5430MapTypeTokenDriverTests {
    @Theory
    @InlineData("map[K,V]")
    @InlineData("Dictionary[K,V]")
    @InlineData("map[string,int32]")
    func CountParameter_HasDictionaryIdentityAndReadsLiveInput(parameterType string) {
        Check(`import System
import System.Collections.Generic
import System.Linq.Expressions
func Read[K,V]() Expression[Func[` + parameterType + `,int32]] -> value -> value.Count
let tree = Read[string,int32]()
Console.WriteLine(tree.Parameters[0].Type == typeof(Dictionary[string,int32]))
let read = tree.Compile()
let first = map[string,int32]{"key":7}
let second = map[string,int32]{"a":1,"b":2,"c":3}
Console.WriteLine(read(first))
Console.WriteLine(read(second))
first["another"] = 9
Console.WriteLine(read(first))
`, "True\n1\n3\n2\n")
    }

    @Fact
    func ReportedProgram_PrintsExactCount() {
        Check(`import System
import System.Linq.Expressions
func Read[K,V]() Expression[Func[map[K,V],int32]] -> value -> value.Count
let tree = Read[string,int32]()
Console.WriteLine(tree.Compile()(map[string,int32]{"key":7}))
`, "1\n")
    }

    @Fact
    func IdentityParameters_PreserveMethodAndTypeOwnersAndNestedArguments() {
        Check(`import System
import System.Collections.Generic
import System.Linq.Expressions
class Owner[K] {
    func Read[V]() Expression[Func[map[K,V],map[K,V]]] -> value -> value
}
func Nested[V]() Expression[Func[map[string,List[V]],map[string,List[V]]]] -> value -> value
func NullableValue[K,V struct]() Expression[Func[map[K,V?],map[K,V?]]] -> value -> value
func NullableReference[K,V class]() Expression[Func[map[K,V?]?,map[K,V?]?]] -> value -> value
let owned = Owner[string]{}.Read[int32]()
Console.WriteLine(owned.Parameters[0].Type == typeof(Dictionary[string,int32]))
let input = map[string,int32]{"key":7}
Console.WriteLine(Object.ReferenceEquals(input, owned.Compile()(input)))
let nested = Nested[int64]()
Console.WriteLine(nested.Parameters[0].Type == typeof(Dictionary[string,List[int64]]))
let nestedInput = map[string,List[int64]]{}
Console.WriteLine(Object.ReferenceEquals(nestedInput, nested.Compile()(nestedInput)))
let nullableValue = NullableValue[string,int32]()
Console.WriteLine(nullableValue.Parameters[0].Type == typeof(Dictionary[string,int32?]))
let nullableInput = map[string,int32?]{"key":nil}
Console.WriteLine(Object.ReferenceEquals(nullableInput, nullableValue.Compile()(nullableInput)))
let nullableReference = NullableReference[int32,string]()
Console.WriteLine(nullableReference.Parameters[0].Type == typeof(Dictionary[int32,string]))
Console.WriteLine(nullableReference.Compile()(nil) == nil)
`, "True\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\n")
    }

    @Fact
    func MapLiteralInsideTree_IsRejectedWithoutOutputs() {
        Check(`import System
import System.Linq.Expressions
let tree Expression[Func[map[string,int32]]] = () -> map[string,int32]{"key":7}
`, "", rejected: true)
    }

    shared {
        private func Check(sourceText string, expected string, rejected bool = false) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let source = Path.Combine(fixture.Directory, "Parameter.gs")
            let image = Path.Combine(fixture.Directory, "Parameter.dll")
            let reference = Path.Combine(fixture.Directory, "Parameter.ref.dll")
            let pdb = Path.ChangeExtension(image, ".pdb")
            File.WriteAllText(source, sourceText)
            let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Where((path string) -> Path.GetDirectoryName(path) == runtimeDirectory)
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToArray()
            Assert.NotEmpty(references)
            let arguments = List[string]{
                typeof(Program).Assembly.Location,
                source,
                "/target:exe",
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:portable",
                "/out:" + image,
                "/refout:" + reference
            }
            arguments.AddRange(references.Select((path string) -> "/r:" + path))
            let result = Run(arguments)
            let diagnostics = Encoding.UTF8.GetString(result.Output)
            if rejected {
                Assert.Equal(1, result.Code)
                Assert.Equal("Failed.\n", result.Error.ReplaceLineEndings("\n"))
                let located = Assert.Single(
                    Regex.Matches(diagnostics, `(?m)^([^\r\n]+)\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
                )
                Assert.Equal(source, located.Groups[1].Value)
                Assert.Equal("3,54,3,80", located.Groups[2].Value)
                Assert.Equal("GS0473", located.Groups[3].Value)
                Assert.False(File.Exists(image))
                Assert.False(File.Exists(reference))
                Assert.False(File.Exists(pdb))
                Assert.False(File.Exists(Path.ChangeExtension(image, ".runtimeconfig.json")))
                return
            }
            Assert.True(result.Code == 0, diagnostics + result.Error)
            Assert.Empty(result.Error)
            Assert.DoesNotContain("GS9998", diagnostics)
            let bytes = File.ReadAllBytes(image)
            let refBytes = File.ReadAllBytes(reference)
            let pdbBytes = File.ReadAllBytes(pdb)
            Assert.NotEmpty(bytes)
            Assert.NotEmpty(refBytes)
            Assert.NotEmpty(pdbBytes)
            let verify = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
            for path in references {
                verify.Add("-r")
                verify.Add(path)
            }
            let verified = Run(verify)
            Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
            Assert.Empty(verified.Error)
            let executed = Run([]string{image})
            Assert.Equal(0, executed.Code)
            Assert.Empty(executed.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected.ReplaceLineEndings(Environment.NewLine)), executed.Output)
            let repeated = Run(arguments)
            Assert.Equal(0, repeated.Code)
            Assert.Equal(result.Output, repeated.Output)
            Assert.Equal(result.Error, repeated.Error)
            Assert.Equal(bytes, File.ReadAllBytes(image))
            Assert.Equal(refBytes, File.ReadAllBytes(reference))
            Assert.Equal(pdbBytes, File.ReadAllBytes(pdb))
        }

        private func Run(arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Map type-token driver exceeded 30 seconds.")
            }
            read.GetAwaiter().GetResult()
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
