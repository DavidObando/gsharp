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

    @Theory
    @InlineData("ReadForRef", "in value")
    @InlineData("ReadForRef", "in (choose ? value : other)")
    @InlineData("ReadForRef", "in alias")
    @InlineData("ReadForOut", "in value")
    func ReadOnlyForwardedStorage_CannotFillWritableConstructorSlots(method string, argument string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(Library + ReferenceLibrary, "HandlerLibrary5966")
        let call = "RefApi." + method + "(" + argument + `, "p${"x"}")`
        let (code, output) = fixture.TryCompile(`import HandlerLibrary
func Reject(in value bool, in other bool, choose bool) {
    let ref readonly alias bool = value
    ` + call + `
}`, "HandlerReadOnly5966", executable: false, "/r:" + library)
        Assert.Equal(1, code)
        Assert.Contains(
            "(4,12,4," + (5 + call.Length).ToString() + "): error GS0221:",
            output,
            StringComparison.Ordinal
        )
    }

    @Fact
    func WritableRefAndReadOnlyIn_ForwardOriginalStorage_AndPreserveOutGate() {
        AssertParity(`var value = true
RefApi.WriteRef(ref value, "p${Effects.Hole("x")}")
RefApi.WriteIn(in value, "p${Effects.Hole("y")}")`, `bool value = true;
RefApi.WriteRef(ref value, $"p{Effects.Hole("x")}");
RefApi.WriteIn(in value, $"p{Effects.Hole("y")}")`, "CRef;Lp;Hx;Fx;WRefFalse;CInFalse;WInFalse;|0/1/2/0/0", ReferenceLibrary)
    }

    @Theory
    @InlineData(false, false, "I0;CRef;Lp;Hx;Fx;WRefFalse;AFalse/True/True/True;N1;R0;BTrue/True;|0/1/2/0/0")
    @InlineData(true, false, "R0;CRef;Lp;Hx;Fx;WRefFalse;ATrue/True/True/True;N0;R1;BFalse/True;|0/1/2/0/0")
    @InlineData(false, true, "I0;T;CRef;Lp;Hx;Fx;WTag7/False;AFalse/True/True/True;N1;R0;BTrue/True;|0/1/2/0/0")
    @InlineData(true, true, "R0;T;CRef;Lp;Hx;Fx;WTag7/False;ATrue/True/True/True;N0;R1;BFalse/True;|0/1/2/0/0")
    func ForwardedRefAddress_UsesCapturedInputs_OnceInSourceOrder(field bool, named bool, expected string) {
        let target = if field {
            "AddressEffects.NextCell().Value"
        } else {
            "values[AddressEffects.NextIndex()]"
        }
        let call = if named {
            "AddressEffects.WriteTagged(value: ref " + target + ", tag: AddressEffects.Tag(), handler: "
        } else {
            "RefApi.WriteRef(ref " + target + ", "
        }
        AssertParity("var values = AddressEffects.Values\n" + call + `"p${Effects.Hole("x")}")
AddressEffects.Dump()`, "var values = AddressEffects.Values;\n" + call + `$"p{Effects.Hole("x")}");
AddressEffects.Dump()`, expected, ReferenceLibrary + AddressLibrary)
    }

    @Fact
    func DistinctRefArguments_WithIdenticalSyntax_KeepDistinctCapturedAddresses() {
        AssertParity(`var values = AddressEffects.Values
AddressEffects.WritePair(ref values[AddressEffects.NextIndex()], ref values[AddressEffects.NextIndex()], "p${Effects.Hole("x")}")
AddressEffects.Dump()`, `var values = AddressEffects.Values;
AddressEffects.WritePair(ref values[AddressEffects.NextIndex()], ref values[AddressEffects.NextIndex()], $"p{Effects.Hole("x")}");
AddressEffects.Dump()`, "I0;I1;CPair;Lp;Hx;Fx;WPairFalse/True;AFalse/True/True/True;N2;R0;BTrue/True;|0/1/2/0/0", ReferenceLibrary +
                AddressLibrary)
    }

    @Fact
    func ImplicitInValue_ForwardsTheCapturedReadOnlyAddress_NotItsValue() {
        AssertParity(
            `RefApi.WriteIn(Effects.Flag("E", true), "p${Effects.Hole("x")}")`,
            `RefApi.WriteIn(Effects.Flag("E", true), $"p{Effects.Hole("x")}")`,
            "E;CInTrue;Lp;Hx;Fx;WInTrue;|1/1/2/0/0",
            ReferenceLibrary
        )
    }

    @Theory
    @InlineData(false, "E;VTrue;Lp;Hx;Fx;WValueTrue;|1/1/2/0/0")
    @InlineData(true, "N;V7;Lp;Hx;Fx;WValue7;|0/1/2/0/0")
    func InArguments_ForwardValuesAndConversions_ToSelectedConstructor(widen bool, expected string) {
        let value = if widen {
            "BoundaryEffects.Number()"
        } else {
            `Effects.Flag("E", true)`
        }
        let method = if widen {
            "WriteWide"
        } else {
            "WriteValue"
        }
        let handler = if widen {
            "WideHandler"
        } else {
            "ValueHandler"
        }
        AssertParity(
            "BoundaryEffects." + method + "(" + value + `, "p${Effects.Hole("x")}")`,
            "var value = " + value + ";\nvar handler = new " + handler + `(1, 1, value, out bool gate);
if (gate) { handler.AppendLiteral("p"); handler.AppendFormatted(Effects.Hole("x")); }
BoundaryEffects.` + method + "(in value, handler)",
            expected,
            ReferenceLibrary + AddressLibrary + BoundaryLibrary
        )
    }

    @Theory
    @InlineData("values[99]", "AddressEffects.WriteTagged", "IndexOutOfRangeException")
    @InlineData("BoundaryEffects.NullValues[0]", "AddressEffects.WriteTagged", "NullReferenceException")
    @InlineData("BoundaryEffects.CovariantValues[0]", "BoundaryEffects.WriteObject", "ArrayTypeMismatchException")
    func CapturedAddresses_ValidateBeforeFollowingArgumentEffects(target string, method string, exception string) {
        let arguments = "(value: ref " + target + `, tag: AddressEffects.Tag(), handler: `
        AssertParity("var values = AddressEffects.Values\ntry {\n" + method + arguments + `"p${Effects.Hole("x")}")
} catch (ex Exception) { Effects.Trace += ex.GetType().Name + ";" }
BoundaryEffects.DumpTags()
AddressEffects.Dump()`, "var values = AddressEffects.Values;\ntry {\n" + method + arguments + `$"p{Effects.Hole("x")}");
} catch (System.Exception ex) { Effects.Trace += ex.GetType().Name + ";"; }
BoundaryEffects.DumpTags();
AddressEffects.Dump()`, exception +
                ";Tags0;ATrue/True/True/True;N0;R0;BTrue/True;|0/0/0/0/0", ReferenceLibrary +
                AddressLibrary +
                BoundaryLibrary)
    }

    @Theory
    @InlineData("false", "LongFalse/False;WriteFalse/False;CallerFalse;|0/0/0/0/0")
    @InlineData("true", "LongTrue/False;Lp;Hx;Fx;WriteTrue/False;CallerFalse;|0/1/2/0/0")
    func ForwardedRefKind_SelectsRefOverload_NotCompetingOutGate(enabled string, expected string) {
        AssertParity("var append = true\nBoundaryEffects.WriteChoice(" + enabled + `, ref append, "p${Effects.Hole("x")}")
BoundaryEffects.DumpCaller(append)`, "bool append = true;\nBoundaryEffects.WriteChoice(" + enabled + `, ref append, $"p{Effects.Hole("x")}");
BoundaryEffects.DumpCaller(append)`, expected, ReferenceLibrary + AddressLibrary + BoundaryLibrary)
    }

    @Fact
    func CapturedReadOnlyRefReturn_KeepsCallerAlias_WhenHoleChangesStorage() {
        AssertParity(
            `RefApi.WriteIn(in BoundaryEffects.Borrow(), "p${BoundaryEffects.Flip()}")`,
            `RefApi.WriteIn(in BoundaryEffects.Borrow(), $"p{BoundaryEffects.Flip()}")`,
            "CInTrue;Lp;M;Hx;Fx;WInFalse;|0/1/2/0/0",
            ReferenceLibrary + AddressLibrary + BoundaryLibrary
        )
    }

    @Theory
    @InlineData(false, "E;CInTrue;Lp;Hx;Fx;WValueTrue;|1/1/2/0/0")
    @InlineData(true, "N;IW7;Lp;Hx;Fx;WValue7;|0/1/2/0/0")
    func ValueArguments_UseSelectedConstructorImplicitInConversion(widen bool, expected string) {
        let value = if widen {
            "BoundaryEffects.Number()"
        } else {
            `Effects.Flag("E", true)`
        }
        let method = if widen {
            "WriteInWide"
        } else {
            "WriteInValue"
        }
        AssertParity(
            "BoundaryEffects." + method + "(" + value + `, "p${Effects.Hole("x")}")`,
            "BoundaryEffects." + method + "(" + value + `, $"p{Effects.Hole("x")}")`,
            expected,
            ReferenceLibrary + AddressLibrary + BoundaryLibrary
        )
    }

    @Fact
    func FixedInStorage_IsForwardedAsTheOriginalAddress() {
        AssertParity(`var value = true
RefApi.WriteIn(value, "p${(value = false).ToString()}")`, `bool value = true;
RefApi.WriteIn(value, $"p{(value = false).ToString()}")`, "CInTrue;Lp;FFalse;WInFalse;|0/0/2/0/0", ReferenceLibrary)
    }

    @Fact
    func CapturedInSource_ConvertsToDifferentSelectedInPointee_Once() {
        AssertParity(`BoundaryEffects.WriteInWideSource(BoundaryEffects.Number(), "p${Effects.Hole("x")}")`, `var value = BoundaryEffects.Number();
long converted = value;
var handler = new WideInHandler(1, 1, in converted, out bool gate);
if (gate) { handler.AppendLiteral("p"); handler.AppendFormatted(Effects.Hole("x")); }
BoundaryEffects.WriteInWideSource(in value, handler)`, "N;IW7;Lp;Hx;Fx;WValue7;|0/1/2/0/0", ReferenceLibrary +
                AddressLibrary +
                BoundaryLibrary)
    }

    @Theory
    @InlineData(true, false, "QTrue;L;P;SFalse;G;C7/11;D11;1/1/0/1;|0/0/0/0/0")
    @InlineData(false, false, "QFalse;R;P;SFalse;G;C7/22;D22;1/0/1/1;|0/0/0/0/0")
    @InlineData(true, true, "QTrue;L;FTrue;NullReferenceException;D-1;1/1/0/0;|0/0/0/0/0")
    func ConditionalInCapture_PreservesSelectedStorage_AcrossRealSuspension(choose bool, fault bool, expected string) {
        let selection = if choose {
            "true"
        } else {
            "false"
        }
        let holder = if fault {
            "SuspensionEffects.Missing"
        } else {
            "SuspensionEffects.Original"
        }
        let finish = if fault {
            `SuspensionEffects.RecordFault(pending.IsCompleted)
try { pending.GetAwaiter().GetResult() } catch (ex Exception) { Effects.Trace += ex.GetType().Name + ";" }
SuspensionEffects.Dump(-1)`
        } else {
            `SuspensionEffects.RecordPending(pending.IsCompleted)
holder = SuspensionEffects.Replacement
choose = !choose
SuspensionEffects.Release()
SuspensionEffects.Dump(pending.GetAwaiter().GetResult())`
        }
        let nativeFinish = if fault {
            `SuspensionEffects.RecordFault(pending.IsCompleted);
try { pending.GetAwaiter().GetResult(); } catch (System.Exception ex) { Effects.Trace += ex.GetType().Name + ";"; }
SuspensionEffects.Dump(-1)`
        } else {
            `SuspensionEffects.RecordPending(pending.IsCompleted);
holder = SuspensionEffects.Replacement;
choose = !choose;
SuspensionEffects.Release();
SuspensionEffects.Dump(pending.GetAwaiter().GetResult())`
        }
        AssertParity("var holder = " + holder + "\nvar choose = " + selection + `
async func Run() int32 {
    return SuspensionEffects.Consume(
        value: in (SuspensionEffects.Choose(choose) ? SuspensionEffects.Left(holder).A : SuspensionEffects.Right(holder).B),
        tag: await SuspensionEffects.Pause())
}
let pending = Run()
` + finish, "var holder = " + holder + ";\nbool choose = " + selection + `;
async System.Threading.Tasks.Task<int> Run() {
    bool selected = SuspensionEffects.Choose(choose);
    var captured = selected ? SuspensionEffects.Left(holder) : SuspensionEffects.Right(holder);
    if (selected) SuspensionEffects.Validate(in captured.A);
    else SuspensionEffects.Validate(in captured.B);
    int tag = await SuspensionEffects.Pause();
    return SuspensionEffects.Consume(tag, in (selected ? ref captured.A : ref captured.B));
}
var pending = Run();
` + nativeFinish, expected, SuspensionLibrary)
    }

    shared {
        private func AssertParity(gsharp string, csharp string, expected string, additionalLibrary string = "") {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let library = fixture.CompileCSharp(Library + additionalLibrary, "HandlerLibrary5966")
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

        private const ReferenceLibrary string = `
[InterpolatedStringHandler]
public struct RefHandler {
    public RefHandler(int literalLength, int formattedCount, ref bool value, out bool shouldAppend) {
        value = false; shouldAppend = true; Effects.Trace += "CRef;";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
[InterpolatedStringHandler]
public struct OutHandler {
    public OutHandler(int literalLength, int formattedCount, out bool value, out bool shouldAppend) {
        value = false; shouldAppend = true;
    }
    public void AppendLiteral(string value) { }
    public void AppendFormatted(string value) { }
}
[InterpolatedStringHandler]
public struct InHandler {
    public InHandler(int literalLength, int formattedCount, in bool value, out bool shouldAppend) {
        shouldAppend = value; Effects.Trace += $"CIn{value};";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
public static class RefApi {
    public static void ReadForRef(in bool value,
        [InterpolatedStringHandlerArgument("value")] RefHandler handler) { }
    public static void ReadForOut(in bool value,
        [InterpolatedStringHandlerArgument("value")] OutHandler handler) { }
    public static void WriteRef(ref bool value,
        [InterpolatedStringHandlerArgument("value")] RefHandler handler) { Effects.Trace += $"WRef{value};"; }
    public static void WriteIn(in bool value,
        [InterpolatedStringHandlerArgument("value")] InHandler handler) { Effects.Trace += $"WIn{value};"; }
}`

        private const AddressLibrary string = `
public sealed class AddressCell { public bool Value = true; }
[InterpolatedStringHandler]
public struct PairRefHandler {
    public PairRefHandler(int literalLength, int formattedCount, ref bool first, ref bool second, out bool shouldAppend) {
        first = false; second = true; shouldAppend = true; Effects.Trace += "CPair;";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
public static class AddressEffects {
    public static bool[] Values = { true, true, true, true };
    public static AddressCell[] Cells = { new AddressCell(), new AddressCell() };
    public static int Indices, Receivers, Tags;
    public static int NextIndex() { Effects.Trace += $"I{Indices};"; return Indices++; }
    public static AddressCell NextCell() { Effects.Trace += $"R{Receivers};"; return Cells[Receivers++]; }
    public static int Tag() { Tags++; Effects.Trace += "T;"; return 7; }
    public static void WriteTagged(int tag, ref bool value,
        [InterpolatedStringHandlerArgument("value")] RefHandler handler) { Effects.Trace += $"WTag{tag}/{value};"; }
    public static void WritePair(ref bool first, ref bool second,
        [InterpolatedStringHandlerArgument("first", "second")] PairRefHandler handler) {
        Effects.Trace += $"WPair{first}/{second};";
    }
    public static void Dump() {
        Effects.Trace += $"A{Values[0]}/{Values[1]}/{Values[2]}/{Values[3]};N{Indices};R{Receivers};B{Cells[0].Value}/{Cells[1].Value};";
    }
}`

        private const BoundaryLibrary string = `
[InterpolatedStringHandler]
public struct ValueHandler {
    public ValueHandler(int literalLength, int formattedCount, bool value, out bool shouldAppend) {
        shouldAppend = value; Effects.Trace += $"V{value};";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
[InterpolatedStringHandler]
public struct WideHandler {
    public WideHandler(int literalLength, int formattedCount, long value, out bool shouldAppend) {
        shouldAppend = true; Effects.Trace += $"V{value};";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
[InterpolatedStringHandler]
public struct WideInHandler {
    public WideInHandler(int literalLength, int formattedCount, in long value, out bool shouldAppend) {
        shouldAppend = true; Effects.Trace += $"IW{value};";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
[InterpolatedStringHandler]
public struct ObjectRefHandler {
    public ObjectRefHandler(int literalLength, int formattedCount, ref object value, out bool shouldAppend) {
        value = new object(); shouldAppend = true;
    }
    public void AppendLiteral(string value) { }
    public void AppendFormatted(string value) { }
}
[InterpolatedStringHandler]
public struct ChoiceHandler {
    public ChoiceHandler(int literalLength, int formattedCount, bool enabled, out bool shouldAppend) {
        shouldAppend = true; Effects.Trace += "Short;";
    }
    public ChoiceHandler(int literalLength, int formattedCount, bool enabled, ref bool append, out bool shouldAppend) {
        append = false; shouldAppend = enabled; Effects.Trace += $"Long{enabled}/{append};";
    }
    public void AppendLiteral(string value) { Effects.Appends++; Effects.Trace += "L" + value + ";"; }
    public void AppendFormatted(string value) { Effects.Appends++; Effects.Trace += "F" + value + ";"; }
}
public static class BoundaryEffects {
    public static bool Shared = true;
    public static ref readonly bool Borrow() => ref Shared;
    public static string Flip() { Shared = false; Effects.Trace += "M;"; return Effects.Hole("x"); }
    public static bool[] NullValues => null!;
    public static object[] CovariantValues = new string[] { "x" };
    public static int Number() { Effects.Trace += "N;"; return 7; }
    public static void WriteValue(in bool value,
        [InterpolatedStringHandlerArgument("value")] ValueHandler handler) { Effects.Trace += $"WValue{value};"; }
    public static void WriteWide(in int value,
        [InterpolatedStringHandlerArgument("value")] WideHandler handler) { Effects.Trace += $"WValue{value};"; }
    public static void WriteInValue(bool value,
        [InterpolatedStringHandlerArgument("value")] InHandler handler) { Effects.Trace += $"WValue{value};"; }
    public static void WriteInWide(int value,
        [InterpolatedStringHandlerArgument("value")] WideInHandler handler) { Effects.Trace += $"WValue{value};"; }
    public static void WriteInWideSource(in int value,
        [InterpolatedStringHandlerArgument("value")] WideInHandler handler) { Effects.Trace += $"WValue{value};"; }
    public static void WriteObject(int tag, ref object value,
        [InterpolatedStringHandlerArgument("value")] ObjectRefHandler handler) { }
    public static void WriteChoice(bool enabled, ref bool append,
        [InterpolatedStringHandlerArgument("enabled", "append")] ChoiceHandler handler) {
        Effects.Trace += $"Write{enabled}/{append};";
    }
    public static void DumpCaller(bool append) { Effects.Trace += $"Caller{append};"; }
    public static void DumpTags() { Effects.Trace += $"Tags{AddressEffects.Tags};"; }
}`

        private const SuspensionLibrary string = `
public sealed class SuspensionCell {
    public readonly int A, B;
    public SuspensionCell(int a, int b) { A = a; B = b; }
}
public static class SuspensionEffects {
    private static readonly System.Threading.Tasks.TaskCompletionSource<int> Gate =
        new(System.Threading.Tasks.TaskCreationOptions.RunContinuationsAsynchronously);
    public static SuspensionCell Original = new(11, 22);
    public static SuspensionCell Replacement = new(91, 92);
    public static SuspensionCell Missing => null!;
    public static int Choices, Lefts, Rights, Pauses;
    public static bool Choose(bool value) { Choices++; Effects.Trace += $"Q{value};"; return value; }
    public static SuspensionCell Left(SuspensionCell value) { Lefts++; Effects.Trace += "L;"; return value; }
    public static SuspensionCell Right(SuspensionCell value) { Rights++; Effects.Trace += "R;"; return value; }
    public static System.Threading.Tasks.Task<int> Pause() { Pauses++; Effects.Trace += "P;"; return Gate.Task; }
    public static void Release() { Effects.Trace += "G;"; Gate.SetResult(7); }
    public static void RecordPending(bool completed) {
        Effects.Trace += $"S{completed};";
        if (completed) throw new System.InvalidOperationException("The await must suspend.");
    }
    public static void RecordFault(bool completed) {
        Effects.Trace += $"F{completed};";
        if (!completed) Release();
    }
    public static void Validate(in int value) { }
    public static int Consume(int tag, in int value) { Effects.Trace += $"C{tag}/{value};"; return value; }
    public static void Dump(int value) { Effects.Trace += $"D{value};{Choices}/{Lefts}/{Rights}/{Pauses};"; }
}`
    }
}
