package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Threading.Tasks
import Xunit

class Issue6033ConditionalCallTests {
    @Fact
    func Driver_ElidesSourceMember_WhenSymbolIsAbsent() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`import System
import System.Diagnostics
shared class Demo {
    private var calls int32
    @Conditional("ABSENT_5952")
    private func Keep() { calls++ }
    func Run() int32 {
        Keep()
        return calls
    }
}
Console.WriteLine(Demo.Run())`, "ConditionalDriver6033", executable: true)
        Assert.Equal(Encoding.UTF8.GetBytes("0" + Environment.NewLine), fixture.RunBytes(program))
        IlVerifier.Verify(program)
    }

    @Theory
    @InlineData("Keep(channel)", "", false)
    @InlineData("Probe().Keep(channel)", "", false)
    @InlineData("Derived().Send(channel)", "", false)
    @InlineData("Keep(channel)", "suspend ", false)
    @InlineData("Probe().Keep(channel)", "suspend ", false)
    @InlineData("Derived().Send(channel)", "suspend ", false)
    @InlineData("Keep(channel)", "suspend ", true)
    func ElidedSuspendingCalls_DoNotWrapCompletionsOrColorCallers(call string, modifier string, asyncCaller bool) {
        var source = `import System.Diagnostics
open class Probe {
    @Conditional("ACTIVE_6033")
    func Keep(channel chan[int32]) { channel <- 7 }
}
class Derived : Probe {
    func Send(channel chan[int32]) { base.Keep(channel) }
}
shared class Consumer {
    private var result int32 = -1
    @Conditional("ACTIVE_6033")
    func Keep(channel chan[int32]) { channel <- 7 }
    func Run() {
        let channel = chan[int32](1)
        ` + call + `
        channel.Reader.TryRead(out var value)
        result = value
    }
    func ReadResult() int32 -> result
}
Consumer.Run()`
        source = source.Replace("func Keep(", modifier + "func Keep(")
        if asyncCaller {
            source = source.Replace("func Run()", "async func Run()").Replace(
                "Consumer.Run()",
                "Consumer.Run().GetAwaiter().GetResult()"
            )
        }
        for enabled in[]bool{false, true} {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){
                PreprocessorSymbols = if enabled {
                    ImmutableHashSet.Create("ACTIVE_6033")
                } else {
                    ImmutableHashSet[string].Empty
                }
            }
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let assembly = EmittedFixture.Load(image.ToArray())
            let consumer = assembly.GetTypes().Single((t Type) -> t.Name == "Consumer")
            Assert.Equal(
                if asyncCaller {
                    typeof(Task)
                } else if enabled {
                    typeof(ValueTask)
                } else {
                    typeof(void)
                },
                consumer.GetMethod("Run")!!.ReturnType
            )
            let entry = assembly.EntryPoint!!
            entry.Invoke(
                nil,
                if entry.GetParameters().Length == 0 {
                    nil
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            Assert.Equal(
                if enabled {
                    7
                } else {
                    0
                },
                cast[int32](consumer.GetMethod("ReadResult")!!.Invoke(nil, nil))
            )
        }
    }

    @Theory
    @InlineData("Keep(Argument())", "Keep(Argument())", "AL7O")
    @InlineData("Probe.SharedKeep(Argument())", "Probe.SharedKeep(Argument())", "AS7O")
    @InlineData("Receiver().Keep(Argument())", "Receiver().Keep(Argument())", "RAK7O")
    @InlineData("OptionalReceiver()?.Keep(Argument())", "OptionalReceiver()?.Keep(Argument())", "RAK7O")
    @InlineData("Receiver().KeepExtension(Argument())", "Receiver().KeepExtension(Argument())", "RAE7O")
    @InlineData("Probe().Implicit()", "new Probe().Implicit()", "AK7O")
    @InlineData("Derived().FromBase()", "new Derived().FromBase()", "AK7O")
    @InlineData("Generic[int32].Keep(Argument())", "Generic<int>.Keep(Argument())", "AG7O")
    @InlineData("Receiver().KeepGeneric[int32](Argument())", "Receiver().KeepGeneric<int>(Argument())", "RAT7O")
    @InlineData("Overrider().Keep(Argument())", "new Overrider().Keep(Argument())", "AV7O")
    func SourceCalls_MatchNativeConditionalSymbols_AndKeepMetadata(
        gsharpCall string,
        csharpCall string,
        enabledOutput string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        for enabled in[]bool{false, true} {
            // C# owns the #define state; G# exposes compilation-wide symbols through its existing embedding API.
            let nativePath = fixture.CompileCSharp(
                (
                    if enabled {
                        "#define ACTIVE_6033\n"
                    } else {
                        ""
                    }
                ) +
                    CSharpDeclarations +
                    csharpCall +
                    "; Trace += \"O\"; return Trace; } }",
                if enabled {
                    "NativeEnabled6033"
                } else {
                    "NativeDisabled6033"
                }
            )
            let native = EmittedFixture.Load(nativePath)
            let expected = Encoding.UTF8.GetBytes(
                if enabled {
                    enabledOutput
                } else {
                    "O"
                }
            )
            Assert.Equal(expected, Run(native))
            let source = GSharpDeclarations + gsharpCall + "\nTrace += \"O\"\nreturn Trace\n} }"
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){
                IsLibrary = true,
                PreprocessorSymbols = if enabled {
                    ImmutableHashSet.Create("ACTIVE_6033")
                } else {
                    ImmutableHashSet[string].Empty
                }
            }
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let emitted = EmittedFixture.Load(image.ToArray())
            Assert.Equal(expected, Run(emitted))
            AssertMetadata(native)
            AssertMetadata(emitted)
        }
    }

    @Theory
    @InlineData("")
    @InlineData("shared ")
    func NonVoidSourceMembers_ReportExistingConditionalDiagnostic(modifier string) {
        let source = "import System.Diagnostics\n" + modifier + `class Invalid {
    @Conditional("ABSENT_6033")
    func Bad() int32 { return 1 }
}`
        using let image = MemoryStream()
        let result = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}.Emit(image)
        Assert.False(result.Success)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0212")
        Assert.Equal(source.IndexOf("Bad", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(3, diagnostic.Location.Span.Length)
    }

    shared {
        private func Run(assembly Assembly)[]uint8 -> Encoding.UTF8.GetBytes(
            cast[string](
                assembly.GetTypes().Single((t Type) -> t.Name == "Consumer").GetMethod("Run")!!.Invoke(nil, nil)
            )
        )

        private func AssertMetadata(assembly Assembly) {
            let attributes = assembly
                .GetTypes()
                .SelectMany(
                (t Type) -> t.GetMethods(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                    BindingFlags.Static | BindingFlags.DeclaredOnly
                )
            )
                .Select(
                (m MethodInfo) -> m
                    .GetCustomAttributesData()
                    .Where((a CustomAttributeData) -> a.AttributeType == typeof(ConditionalAttribute))
                    .ToArray()
            )
                .Where((a[]CustomAttributeData) -> a.Length > 0)
                .ToArray()
            Assert.Equal(6, attributes.Length)
            for methodAttributes in attributes {
                Assert.Equal(
                    []string{"OTHER_6033", "ACTIVE_6033"},
                    methodAttributes.Select((a CustomAttributeData) -> cast[string](a.ConstructorArguments[0].Value))
                )
            }
        }

        private const GSharpDeclarations string = `import System
import System.Diagnostics
open class Probe {
    @Conditional("OTHER_6033") @Conditional("ACTIVE_6033")
    open func Keep(value int32) { Consumer.Trace += "K" + value.ToString() }
    @Conditional("OTHER_6033") @Conditional("ACTIVE_6033")
    func KeepGeneric[T](value T) { Consumer.Trace += "T" + value.ToString() }
    func Implicit() { Keep(Consumer.Argument()) }
    shared {
        @Conditional("OTHER_6033") @Conditional("ACTIVE_6033")
        func SharedKeep(value int32) { Consumer.Trace += "S" + value.ToString() }
    }
}
class Derived : Probe {
    func FromBase() { base.Keep(Consumer.Argument()) }
}
class Overrider : Probe {
    override func Keep(value int32) { Consumer.Trace += "V" + value.ToString() }
}
shared class Generic[T] {
    @Conditional("OTHER_6033") @Conditional("ACTIVE_6033")
    func Keep(value T) { Consumer.Trace += "G" + value.ToString() }
}
@Conditional("OTHER_6033") @Conditional("ACTIVE_6033")
func (self Probe) KeepExtension(value int32) { Consumer.Trace += "E" + value.ToString() }
shared class Consumer {
    var Trace string = ""
    func Argument() int32 {
        Trace += "A"
        return 7
    }
    func Receiver() Probe {
        Trace += "R"
        return Probe()
    }
    func OptionalReceiver() Probe? {
        Trace += "R"
        return Probe()
    }
    @Conditional("OTHER_6033") @Conditional("ACTIVE_6033")
    private func Keep(value int32) { Trace += "L" + value.ToString() }
    func Run() string {
`

        private const CSharpDeclarations string = `using System.Diagnostics;
public class Probe {
    [Conditional("OTHER_6033"), Conditional("ACTIVE_6033")]
    public virtual void Keep(int value) { Consumer.Trace += "K" + value.ToString(); }
    [Conditional("OTHER_6033"), Conditional("ACTIVE_6033")]
    public void KeepGeneric<T>(T value) { Consumer.Trace += "T" + value!.ToString(); }
    public void Implicit() { Keep(Consumer.Argument()); }
    [Conditional("OTHER_6033"), Conditional("ACTIVE_6033")]
    public static void SharedKeep(int value) { Consumer.Trace += "S" + value.ToString(); }
}
public class Derived : Probe {
    public void FromBase() { base.Keep(Consumer.Argument()); }
}
public class Overrider : Probe {
    public override void Keep(int value) { Consumer.Trace += "V" + value.ToString(); }
}
public static class Generic<T> {
    [Conditional("OTHER_6033"), Conditional("ACTIVE_6033")]
    public static void Keep(T value) { Consumer.Trace += "G" + value!.ToString(); }
}
public static class Extensions {
    [Conditional("OTHER_6033"), Conditional("ACTIVE_6033")]
    public static void KeepExtension(this Probe self, int value) { Consumer.Trace += "E" + value.ToString(); }
}
public static class Consumer {
    public static string Trace = "";
    public static int Argument() { Trace += "A"; return 7; }
    public static Probe Receiver() { Trace += "R"; return new Probe(); }
    public static Probe? OptionalReceiver() { Trace += "R"; return new Probe(); }
    [Conditional("OTHER_6033"), Conditional("ACTIVE_6033")]
    private static void Keep(int value) { Trace += "L" + value.ToString(); }
    public static string Run() {
`
    }
}
