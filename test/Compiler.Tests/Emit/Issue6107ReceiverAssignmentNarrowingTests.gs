package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue6107ReceiverAssignmentNarrowingTests {
    @Theory
    @InlineData("nil", "", "RAE55", 1)
    @InlineData("\"prior\"", "", "AE55", 0)
    @InlineData("nil", ".Trim()", "RAE55", 1)
    @InlineData("\"prior\"", ".Trim()", "AE55", 0)
    func SourceExtension_PreservesReceiverAssignment(initial string, chain string, trace string, effects int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(
            SourceExtensions +
                ConsumerSource(initial, "(value ??= MakeReady())" + chain + ".KeepExtension(Argument(value.Length))"),
            "SourceReceiver6107",
            executable: true
        )
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes("5:1:${effects}:1:${trace}${Environment.NewLine}"),
            fixture.RunBytes(program)
        )
    }

    @Theory
    @InlineData(false, "nil", "RAE55", 1)
    @InlineData(false, "\"prior\"", "AE55", 0)
    @InlineData(true, "nil", "RAE55", 1)
    @InlineData(true, "\"prior\"", "AE55", 0)
    func FrozenImportedExtension_PreservesReceiverAssignment(
        conditional bool,
        initial string,
        trace string,
        effects int32
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(
            NativeLibrary.Replace(
                "CONDITIONAL",
                if conditional {
                    "[Conditional(\"ACTIVE_6107\")]"
                } else {
                    ""
                }
            ),
            "ReceiverLibrary6107"
        )
        let frozen = File.ReadAllBytes(library)
        let native = fixture.CompileCSharp(
            NativeConsumer.Replace("INITIAL", initial.Replace("nil", "null")),
            "NativeReceiverConsumer6107",
            library
        )
        let expected = Encoding.UTF8.GetBytes("5:1:${effects}:1:${trace}${Environment.NewLine}")
        let oracle = cast[string](EmittedFixture.Load(native).GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
        Assert.Equal(expected, Encoding.UTF8.GetBytes(oracle + Environment.NewLine))
        let source = "import System\nimport ReceiverFixture6107\n" +
            ConsumerSource(initial, "(value ??= MakeReady()).KeepExtension(Argument(value.Length))", imported: true)
        if conditional {
            using let references = ReferenceResolver.WithReferences([]string{library})
            let compilation = Compilation(
                references,
                SyntaxTree.Parse(SourceText.From(source.Replace("\nConsole.WriteLine(Consumer.Run())", "")))
            ){IsLibrary = true, PreprocessorSymbols = ImmutableHashSet.Create("ACTIVE_6107")}
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let program = Path.Combine(fixture.Directory, "ImportedReceiver6107.dll")
            File.WriteAllBytes(program, image.ToArray())
            IlVerifier.Verify(program, []string{library})
            let actual = cast[string](
                EmittedFixture
                    .Load(program)
                    .GetTypes()
                    .Single((t Type) -> t.Name == "Consumer")
                    .GetMethod("Run")!!.Invoke(nil, nil)
            )
            Assert.Equal(expected, Encoding.UTF8.GetBytes(actual + Environment.NewLine))
        } else {
            let program = fixture.Compile(source, "ImportedReceiver6107", executable: true, "/r:" + library)
            IlVerifier.Verify(program, []string{library})
            Assert.Equal(expected, fixture.RunBytes(program))
        }
        Assert.Equal(frozen, File.ReadAllBytes(library))
    }

    @Theory
    @InlineData(false, "(value ??= MakeReady()).KeepExtension(Clear(ref value))")
    @InlineData(false, "(value ??= MakeReady()).ClearExtension(ref value)")
    @InlineData(false, "(value ??= MakeReady()).KeepExtension((value = nil)?.Length ?? -1)")
    @InlineData(true, "(value ??= MakeReady()).KeepExtension(Clear(ref value))")
    @InlineData(true, "(value ??= MakeReady()).ClearExtension(ref value)")
    @InlineData(true, "(value ??= MakeReady()).KeepExtension((value = nil)?.Length ?? -1)")
    func LaterWrites_InvalidateReceiverAssignment(imported bool, call string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        var declarations = SourceExtensions
        var references = []string{}
        if imported {
            let library = fixture.CompileCSharp(NativeLibrary.Replace("CONDITIONAL", ""), "ReceiverLibrary6107")
            declarations = "import System\nimport ReceiverFixture6107\n"
            references = []string{"/r:" + library}
        }
        let source = declarations + ConsumerSource("nil", call)
        let (code, diagnostics) = fixture.TryCompile(source, "UnsafeReceiver6107", executable: true, references)
        Assert.NotEqual(0, code)
        let line = source
            .Substring(0, source.IndexOf("return value.Length", StringComparison.Ordinal))
            .Split('\n')
            .Length
        Assert.Contains("(${line},22,${line},28): error GS0158", diagnostics, StringComparison.Ordinal)
    }

    shared {
        private func ConsumerSource(initial string, call string, imported bool = false) string -> (`shared class Consumer {
    var Calls int32
    var Effects int32
    var Arguments int32
    var Trace string = ""
    func MakeReady() string {
        Effects++
        Trace += "R"
        return "ready"
    }
    func Argument(length int32) int32 {
        Arguments++
        Trace += "A"
        return length
    }
    func Clear(ref value string?) int32 {
        value = nil
        return 0
    }
    func Run() string {
        var value string? = nil
        value = ` + initial + `
        ` + call + `
        return value.Length.ToString() + ":" + CALLS.ToString() + ":" + Effects.ToString() + ":" + Arguments.ToString() + ":" + TRACE
    }
}
Console.WriteLine(Consumer.Run())`).Replace(
            "CALLS",
            if imported {
                "Extensions.Calls"
            } else {
                "Calls"
            }
        )
            .Replace(
            "TRACE",
            if imported {
                "Trace + Extensions.Trace"
            } else {
                "Trace"
            }
        )

        private const SourceExtensions string = `import System
func (self string?) KeepExtension(length int32) {
    Consumer.Calls++
    Consumer.Trace += "E" + (self?.Length ?? -1).ToString() + length.ToString()
}
func (self string?) ClearExtension(ref value string?) { value = nil }
`

        private const NativeLibrary string = `#nullable enable
using System.Diagnostics;
namespace ReceiverFixture6107 {
    public static class Extensions {
        public static int Calls;
        public static string Trace = "";
        CONDITIONAL
        public static void KeepExtension(this string? self, int length) { Calls++; Trace += "E" + (self?.Length ?? -1) + length; }
        public static void ClearExtension(this string? self, ref string? value) { value = null; }
    }
}`

        private const NativeConsumer string = `#define ACTIVE_6107
#nullable enable
using ReceiverFixture6107;
public static class Consumer {
    private static int Effects;
    private static int Arguments;
    private static string Trace = "";
    private static string MakeReady() { Effects++; Trace += "R"; return "ready"; }
    private static int Argument(int length) { Arguments++; Trace += "A"; return length; }
    public static string Run() {
        string? value = INITIAL;
        (value ??= MakeReady()).KeepExtension(Argument(value.Length));
        return value.Length + ":" + Extensions.Calls + ":" + Effects + ":" + Arguments + ":" + Trace + Extensions.Trace;
    }
}`
    }
}
