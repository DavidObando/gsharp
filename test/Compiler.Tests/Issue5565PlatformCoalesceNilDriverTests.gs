package GSharp.Compiler.Tests

import System
import System.IO
import System.Text
import Xunit

class Issue5565PlatformCoalesceNilDriverTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func InferredPlatformReferences_PreserveNilIdentityAndEvaluation(coalesce bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable disable
namespace Imports5565;
public sealed class Thing {
    public string M() => "ok";
}
public static class Ob {
    public static string Field;
    public static Thing T;
    public static System.Collections.Generic.List<string> Values;
    public static int Reads;
    public static string Trace;
    public static string Text { get { Reads++; Trace += "p"; return Field; } }
    public static Thing Next() { Reads++; Trace += "m"; return T; }
    public static void Reset(bool absent) {
        Field = absent ? null : "V";
        T = absent ? null : new Thing();
        Values = absent ? null : new() { null, "V" };
        Reads = 0;
        Trace = "";
    }
}`, "Imports5565")
        let source = `import Imports5565
import System

func Probe(absent bool) {
    Ob.Reset(absent)
    let field = Ob.Field COALESCE
    let thing = Ob.T COALESCE
    let text = Ob.Text COALESCE
    let node = Ob.Next() COALESCE
    let values = Ob.Values COALESCE
    Console.Write(object.ReferenceEquals(field, nil))
    Console.Write("|")
    Console.Write(object.ReferenceEquals(thing, nil))
    Console.Write("|")
    Console.Write(object.ReferenceEquals(text, nil))
    Console.Write("|")
    Console.Write(object.ReferenceEquals(node, nil))
    Console.Write("|")
    Console.Write(object.ReferenceEquals(values, Ob.Values))
    Console.Write("|")
    Console.Write(Ob.Reads)
    Console.Write("|")
    Console.Write(Ob.Trace)
    Console.Write("|")
    try { Console.Write(text.Length) }
    catch (NullReferenceException) { Console.Write("S") }
    Console.Write("|")
    try { Console.Write(node.M()) }
    catch (NullReferenceException) { Console.Write("T") }
}
Probe(true)
Console.Write(";")
Probe(false)
`.Replace(
            " COALESCE",
            if coalesce {
                " ?? nil"
            } else {
                ""
            }
        )
        let (code, diagnostics) = fixture.TryCompile(source, "Probe5565", true, "/r:" + library)
        Assert.True(code == 0, diagnostics)
        let app = Path.Combine(fixture.Directory, "Probe5565.dll")
        IlVerifier.Verify(app, []string{library})
        Assert.Equal(
            Encoding.UTF8.GetBytes("True|True|True|True|True|2|pm|S|T;False|False|False|False|True|2|pm|1|ok"),
            fixture.RunBytes(app)
        )
    }

    @Fact
    func ExistingNullableTargetAndPlatformFallbackBehavior_IsUnchanged() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable disable
namespace Controls5565;
public static class Ob { public static string Field; }
`, "Controls5565")
        let app = fixture.Compile(`import Controls5565
import System

let target string? = Ob.Field ?? nil
let nullable string? = nil
let inferred = nullable ?? nil
Console.Write(object.ReferenceEquals(target, nil))
Console.Write("|")
Console.Write(object.ReferenceEquals(inferred, nil))
Console.Write("|")
Console.Write(Ob.Field ?? "fallback")
Console.Write("|")
try {
    let general = nullable ?? Ob.Field
    Console.Write(object.ReferenceEquals(general, nil))
} catch (NullReferenceException) { Console.Write("checked") }
`, "Controls5565App", true, "/r:" + library)
        IlVerifier.Verify(app, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("True|True|fallback|checked"), fixture.RunBytes(app))
    }
}
