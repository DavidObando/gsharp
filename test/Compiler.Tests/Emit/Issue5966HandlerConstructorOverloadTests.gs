package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Tests
import System
import System.Text
import Xunit

class Issue5966HandlerConstructorOverloadTests {
    @Theory
    @InlineData("true", "true", "p", false, "E;A;C1/2/True/True;Lp;Hx;Fx;Hy;Fy;WTrue/True;|2/2/3/0/1")
    @InlineData("false", "true", "p", false, "E;A;C1/2/False/True;WFalse/True;|2/0/0/0/1")
    @InlineData("true", "false", "p", false, "E;A;C1/2/True/False;Lp;WTrue/False;|2/0/1/0/1")
    @InlineData("false", "false", "p", false, "E;A;C1/2/False/False;WFalse/False;|2/0/0/0/1")
    @InlineData("true", "false", "", false, "E;A;C0/2/True/False;Hx;Fx;WTrue/False;|2/1/1/0/1")
    @InlineData("true", "true", "p", true, "R;E;A;C1/2/True/True;I;Lp;Hx;Fx;Hy;Fy;WTrue/True;|2/2/3/1/1")
    @InlineData("true", "false", "p", true, "R;E;A;C1/2/True/False;I;Lp;WTrue/False;|2/0/1/1/1")
    func ForwardedValues_SelectActualConstructor_AndPreserveGating(
        enabled string,
        append string,
        prefix string,
        instance bool,
        expected string
    ) {
        let target = if instance {
            "Effects.Receiver().Write"
        } else {
            "Api.Write"
        }
        let arguments = `Effects.Flag("E", ` + enabled + `), Effects.Flag("A", ` + append + `), `
        let gsharp = target + "(" + arguments + `"` + prefix + `${Effects.Hole("x")}${Effects.Hole("y")}")`
        let csharp = target + "(" + arguments + `$"` + prefix + `{Effects.Hole("x")}{Effects.Hole("y")}")`
        AssertParity(gsharp, csharp, expected)
    }

    @Fact
    func OneForwardedValue_SelectsOriginalDelegatingOverload() {
        AssertParity(
            `Api.Write(Effects.Flag("E", true), "p${Effects.Hole("x")}${Effects.Hole("y")}")`,
            `Api.Write(Effects.Flag("E", true), $"p{Effects.Hole("x")}{Effects.Hole("y")}")`,
            "E;C1/2/True/True;S;Lp;Hx;Fx;Hy;Fy;WTrue;|1/2/3/0/1"
        )
    }

    shared {
        private func AssertParity(gsharp string, csharp string, expected string) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let library = fixture.CompileCSharp(Library, "HandlerLibrary5966")
            let oracle = fixture.CompileCSharp(`using HandlerLibrary;
public static class Consumer {
    public static string Run() {
        ` + csharp + `;
        return Effects.Snapshot();
    }
}`, "HandlerOracle5966", library)
            IlVerifier.Verify(oracle, []string{library})
            let assemblies = EmittedFixture.LoadTogether(library, oracle)
            let native = cast[string](assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
            Assert.Equal(expected, native)
            let program = fixture.Compile(`import System
import HandlerLibrary
` + gsharp + `
Console.Write(Effects.Snapshot())`, "HandlerConsumer5966", executable: true, "/r:" + library)
            Assert.Equal(Encoding.UTF8.GetBytes(native), fixture.RunBytes(program))
            IlVerifier.Verify(program, []string{library})
        }

        private const Library string = `using System.Runtime.CompilerServices;
namespace HandlerLibrary;
[InterpolatedStringHandler]
public struct Handler {
    private readonly bool append;
    public Handler(int literalLength, int formattedCount, bool enabled, out bool shouldAppend)
        : this(literalLength, formattedCount, enabled, true, out shouldAppend) { Effects.Trace += "S;"; }
    public Handler(int literalLength, int formattedCount, bool enabled, bool append, out bool shouldAppend) {
        this.append = append;
        shouldAppend = enabled;
        Effects.Constructors++;
        Effects.Trace += $"C{literalLength}/{formattedCount}/{enabled}/{append};";
    }
    public Handler(int literalLength, int formattedCount, Log receiver, bool enabled, out bool shouldAppend)
        : this(literalLength, formattedCount, receiver, enabled, true, out shouldAppend) { Effects.Trace += "S;"; }
    public Handler(int literalLength, int formattedCount, Log receiver, bool enabled, bool append, out bool shouldAppend)
        : this(literalLength, formattedCount, enabled, append, out shouldAppend) { Effects.Trace += receiver.Marker; }
    public bool AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; return append; }
    public bool AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; return append; }
}
public static class Api {
    public static void Write(bool enabled, bool append,
        [InterpolatedStringHandlerArgument("enabled", "append")] Handler handler) {
        Effects.Trace += $"W{enabled}/{append};";
    }
    public static void Write(bool enabled,
        [InterpolatedStringHandlerArgument("enabled")] Handler handler) {
        Effects.Trace += $"W{enabled};";
    }
}
public sealed class Log {
    public string Marker => "I;";
    public void Write(bool enabled, bool append,
        [InterpolatedStringHandlerArgument("", "enabled", "append")] Handler handler) {
        Effects.Trace += $"W{enabled}/{append};";
    }
}
public static class Effects {
    public static string Trace = "";
    public static int Flags, Holes, Appends, Receivers, Constructors;
    public static bool Flag(string name, bool value) { Flags++; Trace += name + ";"; return value; }
    public static string Hole(string value) { Holes++; Trace += "H" + value + ";"; return value; }
    public static Log Receiver() { Receivers++; Trace += "R;"; return new Log(); }
    public static string Snapshot() => Trace + $"|{Flags}/{Holes}/{Appends}/{Receivers}/{Constructors}";
}`
    }
}
