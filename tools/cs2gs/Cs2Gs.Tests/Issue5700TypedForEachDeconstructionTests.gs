package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

class Issue5700TypedForEachDeconstructionTests {
    @Theory
    @InlineData("numeric", "10000000000")
    @InlineData("user conversion", "100007,W100000,")
    @InlineData("nested", "50000000014,W2,W4,")
    @InlineData("deconstruct method", "50000000000,D100000,")
    @InlineData("extraction order", "50000000005,D100000,W5,")
    @InlineData("reference", "object")
    @InlineData("boxing", "object")
    @InlineData("nullable", "nullable")
    @InlineData("nullable reference", "ok")
    @InlineData("captured inferred", "3,30,")
    @InlineData("captured typed", "10000000000,40000000000,")
    @InlineData("await", "10000000000")
    func ConvertedBindings_MatchCSharpOutput(shape string, expected string) {
        let statement = switch shape {
            case "numeric":
            `long total = 0;
             foreach ((long a, int b) in new[] { (100000, 0) }) total += a * a;
             return total.ToString();`
            case "user conversion":
            `long total = 0;
             foreach ((Wrapper w, int n) in new[] { (100000, 7) }) total += w.Value + n;
             return total + "," + Events;`
            case "nested":
            `long total = 0;
             foreach (((long a, Wrapper w), int b) in new[] { ((100000, 2), 3), ((200000, 4), 5) })
                 total += a * a + w.Value + b;
             return total + "," + Events;`
            case "deconstruct method":
            `long total = 0;
             var items = new[] { new Pair { X = 100000, Y = 200000 } };
             foreach ((long a, long b) in items)
                 total += a * a + b * b;
             return total + "," + Events;`
            case "extraction order":
            `long total = 0;
             var items = new[] { (5, new Pair { X = 100000, Y = 200000 }) };
             foreach ((Wrapper w, (long a, long b)) in items)
                 total += w.Value + a * a + b * b;
             return total + "," + Events;`
            case "reference":
            `foreach ((object a, int b) in new[] { ("text", 0) }) return Pick(a);
             return "missing";`
            case "boxing":
            `foreach ((object a, int b) in new[] { (1, 0) }) return Pick(a);
             return "missing";`
            case "nullable":
            `foreach ((long? a, int b) in new[] { (1, 0) }) return Pick(a);
             return "missing";`
            case "nullable reference":
            `foreach ((string? a, int b) in new[] { ("text", 0) }) return a == null ? "nil" : "ok";
             return "missing";`
            case "captured inferred":
            `var callbacks = new List<Func<long>>();
             foreach (var (a, b) in new[] { (1, 2), (10, 20), (-1, 0) }) {
                 if (a < 0) continue;
                 callbacks.Add(() => a + b);
             }
             string result = "";
             foreach (var callback in callbacks) result += callback() + ",";
             return result;`
            case "captured typed":
            `var callbacks = new List<Func<long>>();
             foreach ((long a, int b) in new[] { (100000, 0), (200000, 0), (-1, 0) }) {
                 if (a < 0) continue;
                 callbacks.Add(() => a * a);
             }
             string result = "";
             foreach (var callback in callbacks) result += callback() + ",";
             return result;`
            default:
            `long total = 0;
             await foreach ((long a, int b) in AsyncPairs()) total += a * a;
             return total.ToString();`
        }
        let source = (`
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
namespace TypedForEach {
    public struct Wrapper {
        public int Value;
        public static implicit operator Wrapper(int value) {
            Probe.Events += "W" + value + ",";
            return new Wrapper { Value = value };
        }
    }
    public class Pair {
        public int X, Y;
        public void Deconstruct(out int x, out int y) {
            Probe.Events += "D" + X + ",";
            x = X; y = Y;
        }
    }
    public static class Probe {
        public static string Events = "";
        private static string Pick(object value) => "object";
        private static string Pick(string value) => "string";
        private static string Pick(int value) => "int";
        private static string Pick(long value) => "long";
        private static string Pick(long? value) => "nullable";
        private static async IAsyncEnumerable<(int, int)> AsyncPairs() {
            await Task.Yield();
            yield return (100000, 0);
        }
        public static ASYNCRESULT Run() { STATEMENT }
    }
}`).Replace("STATEMENT", statement).Replace(
            "ASYNCRESULT",
            if shape == "await" {
                "async Task<string>"
            } else {
                "string"
            }
        )
        let printed = Verify(source, expected, shape == "await")
        Assert.DoesNotContain("__", printed)
        if shape == "await" {
            Assert.Contains("await for aItem", printed)
            Assert.Contains("let a int64 = int64(aValue)", printed)
        }
        if shape == "captured inferred" {
            Assert.Contains("let a int32 = aValue", printed)
            Assert.Contains("let b int32 = bValue", printed)
        }
        if shape == "nullable reference" {
            Assert.Contains("let a string? = aValue", printed)
        }
    }

    @Theory
    @InlineData("var (a, b)")
    @InlineData("(int a, int b)")
    func IdentityBindings_KeepDirectReadableLoop(target string) {
        let printed = Verify((`
namespace TypedForEach {
    public static class Probe {
        public static string Run() {
            var pairs = new[] { (2, 3) };
            int total = 0;
            foreach (TARGET in pairs) total += a + b;
            return total.ToString();
        }
    }
}`).Replace("TARGET", target), "5")
        Assert.Contains("for (a, b) in pairs {", printed)
        Assert.DoesNotContain("aValue", printed)
    }

    shared {
        private func Verify(source string, expected string, isAsync bool = false) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            using let image = MemoryStream()
            let emitted = project.Compilation.WithAssemblyName("Baseline" + Guid.NewGuid().ToString("N")).Emit(image)
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
            let value = Assembly.Load(image.ToArray()).GetType("TypedForEach.Probe")!!.GetMethod("Run")!!.Invoke(
                nil,
                nil
            )
            let oracle = if isAsync {
                cast[System.Threading.Tasks.Task[string]](value).GetAwaiter().GetResult()
            } else {
                cast[string](value)
            }
            Assert.Equal(expected, oracle)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                if isAsync {
                    "System.Console.WriteLine(Probe.Run().GetAwaiter().GetResult())"
                } else {
                    "System.Console.WriteLine(Probe.Run())"
                },
                oracle,
                rejectRedundantAssertions: true
            )
            return printed
        }
    }
}
