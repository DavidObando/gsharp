package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Compiler.Tests.LanguageConformance
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5971GenericInlineOutDriverTests {
    @Fact
    func ClosedGenericOutVariables_UseInstantiatedLocalTypes() {
        const source = `private func Make[T](out result T) {
    result = default(T)
}

Make[string](out var text)
Make[int32](out var number)
System.Console.WriteLine(text == nil)
System.Console.WriteLine(number)
`
        const csharp = `using System;
class Program {
    static void Make<T>(out T result) { result = default(T); }
    static void Main() {
        Make<string>(out var text);
        Make<int>(out var number);
        Console.WriteLine(text == null);
        Console.WriteLine(number);
    }
}`
        let dump = Check(source, csharp, "True${Environment.NewLine}0${Environment.NewLine}")
        Assert.Contains(".locals (String, Int32)", dump, StringComparison.Ordinal)
        Assert.Contains("Make`1(!!0&) : Void<String>", dump, StringComparison.Ordinal)
        Assert.Contains("Make`1(!!0&) : Void<Int32>", dump, StringComparison.Ordinal)
    }

    @Fact
    func GenericCaller_DeclaredOutAndSingleEvaluation_PreserveStorage() {
        const source = `import System
func Make[T](out result T) { result = default(T) }
func Relay[A, B](seed A) B {
    Make[B](out var value)
    return value
}
func Next() int32 {
    Console.Write("N")
    return 37
}
func Copy[T](value T, out result T) { result = value }

Console.Write(Relay[int32, string](1) == nil)
Console.Write(Relay[string, int32]("seed"))
var declaredText string = "seed"
var declaredNumber int32 = 41
Make[string](out declaredText)
Make[int32](out declaredNumber)
Console.Write(declaredText == nil)
Console.Write(declaredNumber)
Copy(Next(), out var copied)
Console.Write(copied)
`
        const csharp = `using System;
class Program {
    static void Make<T>(out T result) { result = default(T); }
    static B Relay<A, B>(A seed) {
        Make<B>(out var value);
        return value;
    }
    static int Next() { Console.Write("N"); return 37; }
    static void Copy<T>(T value, out T result) { result = value; }
    static void Main() {
        Console.Write(Relay<int, string>(1) == null);
        Console.Write(Relay<string, int>("seed"));
        string declaredText = "seed";
        int declaredNumber = 41;
        Make<string>(out declaredText);
        Make<int>(out declaredNumber);
        Console.Write(declaredText == null);
        Console.Write(declaredNumber);
        Copy(Next(), out var copied);
        Console.Write(copied);
    }
}`
        let dump = Check(source, csharp, "True0True0N37")
        Assert.Contains(".locals (!!1)", dump, StringComparison.Ordinal)
        Assert.Contains("Make`1(!!0&) : Void<!!1>", dump, StringComparison.Ordinal)
        Assert.Contains("Copy`1(!!0, !!0&) : Void<Int32>", dump, StringComparison.Ordinal)
    }

    shared {
        private func Check(source string, csharp string, expected string) string {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let sourcePath = Path.Combine(fixture.Directory, "Witness.gs")
            let image = Path.Combine(fixture.Directory, "Witness.dll")
            File.WriteAllText(sourcePath, source)
            let compiled = Run(
                []string{
                    typeof(Program).Assembly.Location,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "--nullability=platform-types",
                    "/out:" + image,
                    sourcePath
                }
            )
            Assert.True(compiled.Code == 0, Encoding.UTF8.GetString(compiled.Output) + compiled.Error)
            Assert.Empty(compiled.Error)
            Assert.DoesNotContain("warning ", Encoding.UTF8.GetString(compiled.Output), StringComparison.Ordinal)
            let dump = NormalizedIlDump.Create(image)
            let executed = Run([]string{image})
            Assert.True(executed.Code == 0, executed.Error + Environment.NewLine + dump)
            Assert.Empty(executed.Error)
            let bytes = Encoding.UTF8.GetBytes(expected)
            Assert.Equal(bytes, executed.Output)
            IlVerifier.Verify(image)

            let native = Path.Combine(fixture.Directory, "Native.dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .ToArray()
            Assert.NotEmpty(references)
            let compilation = CSharpCompilation.Create(
                "Native",
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(csharp)},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            let emitted = compilation.Emit(native)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            File.Copy(
                Path.ChangeExtension(image, ".runtimeconfig.json"),
                Path.ChangeExtension(native, ".runtimeconfig.json")
            )
            let nativeResult = Run([]string{native})
            Assert.True(nativeResult.Code == 0, nativeResult.Error)
            Assert.Empty(nativeResult.Error)
            Assert.Equal(bytes, nativeResult.Output)
            Assert.Equal(nativeResult.Output, executed.Output)
            IlVerifier.Verify(native)
            let nativeDump = NormalizedIlDump.Create(native)
            Assert.Contains("Make`1(!!0&) : Void<String>", nativeDump, StringComparison.Ordinal)
            Assert.Contains("Make`1(!!0&) : Void<Int32>", nativeDump, StringComparison.Ordinal)
            return dump
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
            var exited bool
            try {
                exited = process.WaitForExit(30_000)
            } finally {
                if !process.HasExited {
                    process.Kill(entireProcessTree: true)
                }
                process.WaitForExit()
                try {
                    read.GetAwaiter().GetResult()
                } finally {
                    error.GetAwaiter().GetResult()
                }
            }
            Assert.True(exited, "Generic out-variable driver exceeded 30 seconds.")
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
