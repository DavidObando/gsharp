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
    @InlineData("by-reference conversion", "3,W5,")
    @InlineData("by-reference numeric", "3,")
    @InlineData("by-reference conversion oblivious", "3,W5,")
    @InlineData("by-reference numeric oblivious", "3,")
    @InlineData("captured widened record", "7,")
    @InlineData("mutating struct", "6,W5,")
    @InlineData("captured tainted list", "3,")
    @InlineData("captured tainted list inferred", "3,")
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
            case "mutating struct":
            `int total = 0;
             foreach ((Wrapper w, int n) in new[] { (5, 0) }) {
                 w.Increment();
                 total += w.Value;
             }
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
            case "captured widened record":
            `var widened = new Entry(null!, 0);
             var items = new[] { new Entry(new Node { Value = 7 }, 1) };
             var callbacks = new List<Func<int>>();
             foreach ((Node item, int id) in items) callbacks.Add(() => item.Value);
             string result = "";
             foreach (var callback in callbacks) result += callback() + ",";
             return result;`
            case "captured tainted list" or "captured tainted list inferred":
            (`var items = new List<(string, int)>();
              Try(out var missing);
              items.Add((missing, 0));
              items.Add(("abc", 1));
              var callbacks = new List<Func<int>>();
              foreach (TARGET in items) {
                  if (IsMissing(a)) continue;
                  callbacks.Add(() => a.Length);
              }
              string result = "";
              foreach (var callback in callbacks) result += callback() + ",";
              return result;`).Replace(
                "TARGET",
                if shape.EndsWith("inferred", StringComparison.Ordinal) {
                    "var (a, b)"
                } else {
                    "(string a, int b)"
                }
            )
            case "by-reference conversion" or
                "by-reference numeric" or
                "by-reference conversion oblivious" or
                "by-reference numeric oblivious":
            `string? text = "abc";
             return Read(ref text, new[] { (5, 0) }) + "," + Events;`
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
    EXTRATYPES
    public struct Wrapper {
        public int Value;
        public void Increment() { Value++; }
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
        EXTRAMEMBER
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
}`).Replace(
            "EXTRATYPES",
            if shape == "captured widened record" {
                "public class Node { public int Value; } public record Entry(Node Item, int Id);"
            } else {
                string.Empty
            }
        ).Replace(
            "EXTRAMEMBER",
            if shape.StartsWith("captured tainted list", StringComparison.Ordinal) {
                "public static bool Try(out string value) { value = null; return false; } " +
                    "private static bool IsMissing(string value) => value == null;"
            } else if shape.StartsWith("by-reference", StringComparison.Ordinal) {
                (`public static int Read(ref string? s, (int, int)[] pairs) {
                    if (s == null) return 0;
                    foreach ((TYPE value, int other) in pairs) { }
                    return s.Length;
                }`).Replace(
                    "TYPE",
                    if shape.Contains("numeric", StringComparison.Ordinal) {
                        "long"
                    } else {
                        "Wrapper"
                    }
                )
            } else {
                string.Empty
            }
        ).Replace(
            "STATEMENT",
            statement
        ).Replace(
            "ASYNCRESULT",
            if shape == "await" {
                "async Task<string>"
            } else {
                "string"
            }
        )
        let printed = Verify(
            if shape.StartsWith("by-reference", StringComparison.Ordinal) && !shape.EndsWith(
                "oblivious",
                StringComparison.Ordinal
            ) {
                "#nullable enable\n" + source
            } else {
                source
            },
            expected,
            shape == "await"
        )
        Assert.DoesNotContain("__", printed)
        if shape == "await" {
            Assert.Contains("await for aItem", printed)
            Assert.Contains("let a int64 = int64(aValue)", printed)
        }
        if shape == "captured inferred" {
            Assert.Contains("let a = aValue", printed)
            Assert.Contains("let b = bValue", printed)
        }
        if shape == "nullable reference" {
            Assert.Contains("let a string? = aValue", printed)
        }
        if shape.StartsWith("by-reference", StringComparison.Ordinal) {
            Assert.Contains("return s!!.Length", printed)
        }
        if shape == "captured widened record" {
            Assert.Contains("let item Node? = itemValue", printed)
            Assert.DoesNotContain("itemValue!!", printed)
        }
        if shape == "captured tainted list" {
            Assert.Contains("let a string? = aValue", printed)
            Assert.DoesNotContain("aValue!!", printed)
        }
        if shape == "captured tainted list inferred" {
            Assert.Contains("let a = aValue", printed)
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

    @Theory
    @InlineData("deconstructed inferred parenthesized lambda", "3,")
    @InlineData("deconstructed typed parenthesized lambda", "3,")
    @InlineData("deconstructed simple lambda", "4,")
    @InlineData("deconstructed anonymous method", "4,")
    @InlineData("deconstructed local function", "4,")
    @InlineData("deconstructed switch guard", "4,")
    @InlineData("deconstructed lambda return and argument", "abc,")
    @InlineData("deconstructed nested tuple capture", "6,")
    @InlineData("deconstructed nested closure capture", "3,")
    @InlineData("deconstructed direct body guard", "3")
    @InlineData("deconstructed query select", "4")
    @InlineData("primary constructor initializer capture", "3,")
    @InlineData("promoted parameter closure argument", "123,")
    @InlineData("hoisted local function after guard", "4,")
    @InlineData("single foreach capture", "3,")
    @InlineData("single foreach query select", "3")
    @InlineData("single foreach query let", "3")
    @InlineData("single foreach query select into", "3")
    @InlineData("single foreach switch query let", "3")
    @InlineData("primary constructor method capture", "3,")
    @InlineData("reassigned in loop body", "2,")
    @InlineData("reassigned in closure", "3,")
    @InlineData("in-closure local reassignment", "3,")
    @InlineData("query clause assignment invalidates guard", "3")
    @InlineData("hoisted local function before guard", "3,")
    @InlineData("transitively hoisted local function", "3,")
    @InlineData("hoisted local function preserving index", "3,")
    func NullGuardedForEachCaptures_MatchNarrowingAndCSharpOutput(shape string, expected string) {
        let loopBody = switch shape {
            case "deconstructed inferred parenthesized lambda":
            `foreach (var (a, b) in items) {
                 if (a is null) continue;
                 callbacks.Add(() => a.Length);
             }`
            case "deconstructed typed parenthesized lambda":
            `foreach ((string a, int b) in items) {
                 if (a is null) continue;
                 callbacks.Add(() => a.Length);
             }`
            case "deconstructed simple lambda":
            `foreach (var (a, b) in items) {
                 if (a == null) continue;
                 Func<int, int> add = x => a.Length + x;
                 callbacks.Add(() => add(b));
             }`
            case "deconstructed anonymous method":
            `foreach (var (a, b) in items) {
                 if (a is not null) {
                     callbacks.Add(delegate { return a.Length + b; });
                 }
             }`
            case "deconstructed local function":
            `foreach (var (a, b) in items) {
                 if (a is null) continue;
                 int Read() => a.Length + b;
                 callbacks.Add(Read);
             }`
            case "deconstructed switch guard":
            `foreach (var (a, b) in items) {
                 switch (a) {
                     case "abc":
                         callbacks.Add(() => a.Length + b);
                         break;
                 }
             }`
            case "deconstructed lambda return and argument":
            `var textCallbacks = new List<Func<string>>();
             foreach (var (a, b) in items) {
                 if (a is null) continue;
                 textCallbacks.Add(() => a);
                 callbacks.Add(() => int.Parse(a));
             }
             string textResult = "";
             foreach (var textCallback in textCallbacks) {
                 textResult += textCallback() + ",";
             }
             return textResult;`
            case "deconstructed nested tuple capture":
            `var nested = new List<((string, int), int)>();
             nested.Add(((missing, 0), 1));
             nested.Add((("abc", 1), 2));
             foreach (var ((a, b), c) in nested) {
                 if (a is null) continue;
                 callbacks.Add(() => a.Length + b + c);
             }`
            case "deconstructed nested closure capture":
            `foreach (var (a, b) in items) {
                 if (a is null) continue;
                 Func<Func<int>> outer = () => () => a.Length;
                 callbacks.Add(outer());
             }`
            case "deconstructed direct body guard":
            `int total = 0;
             foreach (var (a, b) in items) {
                 if (a is null) continue;
                 total += a.Length;
             }
             return total.ToString();`
            case "deconstructed query select":
            `int total = 0;
             foreach (var (a, b) in items) {
                 if (a is null) continue;
                 var q = from n in new[] { b } select a.Length + n;
                 foreach (var v in q) total += v;
             }
             return total.ToString();`
            case "primary constructor initializer capture":
            `callbacks.Add(new PrimaryInitBox("abc").Callback);`
            case "promoted parameter closure argument":
            `_ = Make(null);
             callbacks.Add(Make("123"));`
            case "hoisted local function after guard":
            `foreach (var (a, b) in items) {
                 if (a is null) continue;
                 int offset = b;
                 callbacks.Add(Read);
                 int Read() => a.Length + offset;
             }`
            case "single foreach capture":
            `var names = new string[] { null, "abc" };
             foreach (var a in names) {
                 if (a is null) continue;
                 callbacks.Add(() => a.Length);
             }`
            case "single foreach query select":
            `int total = 0;
             var names = new string[] { null, "abc" };
             foreach (var a in names) {
                 if (a is null) continue;
                 var q = from n in new[] { 0 } select a.Length + n;
                 foreach (var v in q) total += v;
             }
             return total.ToString();`
            case "single foreach query let":
            `int total = 0;
             var names = new string[2];
             names[0] = null;
             names[1] = "abc";
             foreach (var a in names) {
                 if (a is null) continue;
                 var q = from n in new[] { 0 } let text = a select text.Length + n;
                 foreach (var v in q) total += v;
             }
             return total.ToString();`
            case "single foreach query select into":
            `int total = 0;
             var names = new string[2];
             names[0] = null;
             names[1] = "abc";
             foreach (var a in names) {
                 if (a is null) continue;
                 var q = from n in new[] { 0 } select a into text select text.Length;
                 foreach (var v in q) total += v;
             }
             return total.ToString();`
            case "single foreach switch query let":
            `int total = 0;
             var names = new string[2];
             names[0] = null;
             names[1] = "abc";
             foreach (var a in names) {
                 switch (a) {
                     case "abc":
                         var q = from n in new[] { 0 } let text = a select text.Length + n;
                         foreach (var v in q) total += v;
                         break;
                 }
             }
             return total.ToString();`
            case "primary constructor method capture":
            `var box = new PrimaryMethodBox("abc");
             var fn = box.Read();
             if (fn != null) callbacks.Add(fn);`
            case "reassigned in loop body":
            `foreach (var (item, b) in items) {
                 var a = item;
                 if (a is null) continue;
                 callbacks.Add(() => a.Length);
                 a = "xy";
             }`
            case "reassigned in closure":
            `foreach ((string item, int b) in items) {
                 string a = item;
                 if (a is null) continue;
                 callbacks.Add(() => {
                     int len = a.Length;
                     a = "xy";
                     return len;
                 });
             }`
            case "in-closure local reassignment":
            `callbacks.Add(() => {
                 string? a = GetMaybe(true);
                 if (a is null) return 0;
                 a = GetMaybe(true);
                 return a.Length;
             });`
            case "query clause assignment invalidates guard":
            `string? a = GetMaybe(true);
             var q = from n in new[] { 0 } let unused = a = GetMaybe(true) select n;
             if (a is null) return "0";
             _ = q.ToArray();
             return a.Length.ToString();`
            case "transitively hoisted local function":
            `foreach (var (a, b) in items) {
                 _ = Wrapper(false);
                 if (a is null) continue;
                 int Read() => a.Length;
                 int Wrapper(bool run) => run ? Read() : 0;
                 callbacks.Add(() => Wrapper(true));
             }`
            case "hoisted local function preserving index":
            `foreach (var (a, b) in items) {
                 if (a is null) continue;
                 callbacks.Add(Read);
                 int Read() => a.Length + Z1<int>() + Z2<int>();
                 int Z1<T>() => 0;
                 int Z2<T>() => 0;
             }`
            default:
            `foreach (var (a, b) in items) {
                 if (a is null) continue;
                 callbacks.Add(ReadBeforeDecl);
                 int ReadBeforeDecl() => a.Length;
             }`
        }
        let extraTypes = switch shape {
            case "primary constructor method capture":
            `public class PrimaryMethodBox(string? a) {
                 public Func<int>? Read() {
                     if (a is null) return null;
                     return () => a.Length;
                 }
             }`
            case "primary constructor initializer capture":
            `public class PrimaryInitBox(string? a) {
                 public Func<int> Callback = a is null ? (() => 0) : (() => a.Length);
             }`
            default:
            string.Empty
        }
        let extraMembers = switch shape {
            case "promoted parameter closure argument":
            `private static Func<int> Make(string a) {
                 if (a is null) return () => 0;
                 return () => int.Parse(a);
             }`
            case "in-closure local reassignment" or "query clause assignment invalidates guard":
            `private static string GetMaybe(bool present) => present ? "abc" : null;`
            default:
            string.Empty
        }
        let source = (`
using System;
using System.Collections.Generic;
using System.Linq;
namespace TypedForEach {
    EXTRA_TYPES
    public static class Probe {
        public static bool Try(out string value) { value = null; return false; }
        EXTRA_MEMBERS
        public static string Run() {
            var items = new List<(string, int)>();
            Try(out var missing);
            items.Add((missing, 0));
            items.Add(("abc", 1));
            var callbacks = new List<Func<int>>();
            LOOP_BODY
            string result = "";
            foreach (var callback in callbacks) result += callback() + ",";
            return result;
        }
    }
}`).Replace("EXTRA_TYPES", extraTypes).Replace("EXTRA_MEMBERS", extraMembers).Replace("LOOP_BODY", loopBody)
        let printed = Verify(source, expected)
        if shape == "single foreach query let" ||
            shape == "single foreach query select into" ||
            shape == "single foreach switch query let" {
            Assert.Contains("text!!.Length", printed)
        } else if shape.StartsWith("reassigned", StringComparison.Ordinal) || shape.StartsWith(
            "single foreach",
            StringComparison.Ordinal
        ) ||
            shape == "primary constructor method capture" ||
            shape == "in-closure local reassignment" ||
            shape == "query clause assignment invalidates guard" ||
            shape == "hoisted local function before guard" ||
            shape == "hoisted local function preserving index" ||
            shape == "transitively hoisted local function" {
            Assert.Contains("a!!.Length", printed)
        } else {
            Assert.DoesNotContain("a!!", printed)
        }
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
