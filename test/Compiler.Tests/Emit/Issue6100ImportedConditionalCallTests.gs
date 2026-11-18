package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
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

class Issue6100ImportedConditionalCallTests {
    @Fact
    func Driver_ElidesImportedConditionalCall() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(NativeLibrary, "ConditionalLibrary6100")
        let program = fixture.Compile(`import System
import ConditionalFixture6100
Probe.SharedKeep(7)
Console.WriteLine(Recorder.Trace)`, "ConditionalDriver6100", executable: true, "/r:" + library)
        Assert.Equal(Encoding.UTF8.GetBytes("\n"), fixture.RunBytes(program))
        IlVerifier.Verify(program, []string{library})
    }

    @Theory
    @InlineData("Probe.SharedKeep(channel)", false)
    @InlineData("Probe().Keep(channel)", false)
    @InlineData("Derived().Send(channel)", false)
    @InlineData("Probe.SharedKeep(channel)", true)
    func FrozenGSharpSuspendingCalls_AreElidedBeforeCompletion(call string, asyncCaller bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        // G# owns the suspending ABI; freeze its producer before varying consumer symbols.
        let library = fixture.Compile(`package ConditionalSuspension6100
import System.Diagnostics
open class Probe {
    @Conditional("ACTIVE_6100")
    suspend func Keep(channel chan[int32]) { channel <- 7 }
    shared {
        @Conditional("ACTIVE_6100")
        suspend func SharedKeep(channel chan[int32]) { channel <- 7 }
    }
}`, "ConditionalSuspensionLibrary6100", executable: false)
        let frozenBytes = File.ReadAllBytes(library)
        let referencePaths = ReferenceResolver.ResolveDriverReferencePaths([]string{library})
        let runtimeDirectory = Path.GetDirectoryName(
            referencePaths.Single((path string) -> Path.GetFileName(path) == "Gsharp.Runtime.Channels.dll")
        )
        var source = `import ConditionalSuspension6100
class Derived : Probe {
    func Send(channel chan[int32]) { base.Keep(channel) }
}
shared class Consumer {
    private var result int32 = -1
    func Run() {
        let channel = chan[int32](1)
        ` + call + `
        channel.Reader.TryRead(out var value)
        result = value
    }
    func ReadResult() int32 -> result
}
Consumer.Run()`
        if asyncCaller {
            source = source.Replace("func Run()", "async func Run()").Replace(
                "Consumer.Run()",
                "Consumer.Run().GetAwaiter().GetResult()"
            )
        }
        for enabled in[]bool{false, true} {
            using let references = ReferenceResolver.WithReferences(referencePaths)
            let compilation = Compilation(references, SyntaxTree.Parse(SourceText.From(source))){
                PreprocessorSymbols = if enabled {
                    ImmutableHashSet.Create("ACTIVE_6100")
                } else {
                    ImmutableHashSet[string].Empty
                }
            }
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let assemblies = EmittedFixture.LoadTogether(runtimeDirectory, frozenBytes, image.ToArray())
            let consumer = assemblies[1].GetTypes().Single((t Type) -> t.Name == "Consumer")
            let entry = assemblies[1].EntryPoint!!
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
            let method = assemblies[0].GetType("ConditionalSuspension6100.Probe")!!.GetMethod("SharedKeep")!!
            Assert.Equal(typeof(ValueTask), method.ReturnType)
            Assert.Contains(
                method.GetCustomAttributesData(),
                (a CustomAttributeData) -> a.AttributeType == typeof(ConditionalAttribute)
            )
            Assert.Contains(
                method.GetCustomAttributesData(),
                (a CustomAttributeData) -> a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute"
            )
            Assert.Equal(frozenBytes, File.ReadAllBytes(library))
        }
    }

    @Fact
    func ElidedArguments_DoNotDefinitelyAssignOutParameters() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(NativeLibrary, "ConditionalOutLibrary6100")
        let frozenBytes = File.ReadAllBytes(library)
        let nativeSource = `using ConditionalFixture6100;
public static class Consumer {
    static int Assign(out int value) { value = 7; return value; }
    static void Set(out int value) { Probe.SharedKeep(Assign(out value)); }
    public static string Run() {
        Recorder.Trace = "";
        Set(out var value);
        return value.ToString() + ":" + Recorder.Trace;
    }
}`
        let source = `import ConditionalFixture6100
shared class Consumer {
    func Assign(out value int32) int32 {
        value = 7
        return value
    }
    func Set(out value int32) { Probe.SharedKeep(Assign(out value)) }
    func Run() string {
        Recorder.Trace = ""
        Set(out var value)
        return value.ToString() + ":" + Recorder.Trace
    }
}`
        for enabled in[]bool{false, true} {
            using let references = ReferenceResolver.WithReferences([]string{library})
            let compilation = Compilation(references, SyntaxTree.Parse(SourceText.From(source))){
                IsLibrary = true,
                PreprocessorSymbols = if enabled {
                    ImmutableHashSet.Create("ACTIVE_6100")
                } else {
                    ImmutableHashSet[string].Empty
                }
            }
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            if !enabled {
                let error = Assert.ThrowsAny[Exception](
                    func () {
                        fixture.CompileCSharp(nativeSource, "NativeConditionalOut6100", library)
                    }
                )
                Assert.Contains("CS0177", error.Message)
                Assert.False(result.Success)
                Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
                continue
            }
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let native = fixture.CompileCSharp(
                "#define ACTIVE_6100\n" + nativeSource,
                "NativeConditionalOut6100",
                library
            )
            let expected = Encoding.UTF8.GetBytes("7:S7")
            Assert.Equal(expected, Run(EmittedFixture.Load(native)))
            let assemblies = EmittedFixture.LoadTogether(fixture.Directory, frozenBytes, image.ToArray())
            Assert.Equal(expected, Run(assemblies[1]))
        }
        Assert.Equal(frozenBytes, File.ReadAllBytes(library))
    }

    @Theory
    @InlineData("Probe.SharedKeep(Argument())", "Probe.SharedKeep(Argument())", "AS7O")
    @InlineData("Receiver().Keep(Argument())", "Receiver().Keep(Argument())", "RAK7O")
    @InlineData("OptionalReceiver()?.Keep(Argument())", "OptionalReceiver()?.Keep(Argument())", "RAK7O")
    @InlineData("MissingReceiver()?.Keep(Argument())", "MissingReceiver()?.Keep(Argument())", "RO")
    @InlineData("Receiver().KeepExtension(Argument())", "Receiver().KeepExtension(Argument())", "RAE7O")
    @InlineData("Derived().FromBase()", "new Derived().FromBase()", "AK7O")
    @InlineData("Derived().FromBaseLambda()", "new Derived().FromBaseLambda()", "AK7O")
    @InlineData("NativeOverride().Keep(Argument())", "new NativeOverride().Keep(Argument())", "AV7O")
    @InlineData("SourceOverride().Keep(Argument())", "new SourceOverride().Keep(Argument())", "AW7O")
    @InlineData("Generic[int32].Keep(Argument())", "Generic<int>.Keep(Argument())", "AG7O")
    @InlineData("Receiver().KeepGeneric[int32](Argument())", "Receiver().KeepGeneric<int>(Argument())", "RAT7O")
    @InlineData("ThrowingReceiver().Keep(Argument())", "ThrowingReceiver().Keep(Argument())", "RXO")
    @InlineData("Receiver().Keep(ThrowingArgument())", "Receiver().Keep(ThrowingArgument())", "RAXO")
    @InlineData("Deferred()", "Deferred()", "AS7O")
    @InlineData("Awaited().GetAwaiter().GetResult()", "Awaited().GetAwaiter().GetResult()", "AS7O")
    func ImportedCalls_MatchNativeConsumer_WithoutChangingFrozenMetadata(
        gsharpCall string,
        csharpCall string,
        enabledOutput string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        // Native C# produces the frozen import. Only each consumer's symbols change.
        let library = fixture.CompileCSharp(NativeLibrary, "ConditionalLibrary6100")
        let frozenBytes = File.ReadAllBytes(library)
        for symbol in[]string{"", "ACTIVE_6100", "OTHER_6100"} {
            let nativePath = fixture.CompileCSharp(
                (
                    if symbol.Length == 0 {
                        ""
                    } else {
                        "#define " + symbol + "\n"
                    }
                ) +
                    NativeConsumer +
                    csharpCall +
                    `; } catch (InvalidOperationException) { Recorder.Trace += "X"; }
Recorder.Trace += "O"; Probe.Always(); new NativeHider().Keep(7); return Recorder.Trace; } }`,
                "NativeConsumer6100",
                library
            )
            let expected = Encoding.UTF8.GetBytes(
                (
                    if symbol.Length == 0 {
                        "O"
                    } else {
                        enabledOutput
                    }
                ) +
                    "NH7"
            )
            Assert.Equal(expected, Run(EmittedFixture.Load(nativePath)))
            let source = GSharpConsumer + gsharpCall + `
} catch (InvalidOperationException) { Recorder.Trace += "X" }
Recorder.Trace += "O"
Probe.Always()
NativeHider().Keep(7)
return Recorder.Trace
} }`
            using let references = ReferenceResolver.WithReferences([]string{library})
            let compilation = Compilation(references, SyntaxTree.Parse(SourceText.From(source))){
                IsLibrary = true,
                PreprocessorSymbols = if symbol.Length == 0 {
                    ImmutableHashSet[string].Empty
                } else {
                    ImmutableHashSet.Create(symbol)
                }
            }
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            let assemblies = EmittedFixture.LoadTogether(fixture.Directory, frozenBytes, image.ToArray())
            Assert.Equal(expected, Run(assemblies[1]))
            let attributes = assemblies[0].GetType("ConditionalFixture6100.Probe")!!.GetMethod("Keep")!!
                .GetCustomAttributesData()
                .Where((a CustomAttributeData) -> a.AttributeType == typeof(ConditionalAttribute))
                .ToArray()
            Assert.Equal(
                []string{"OTHER_6100", "ACTIVE_6100"},
                attributes.Select((a CustomAttributeData) -> cast[string](a.ConstructorArguments[0].Value))
            )
            Assert.Equal(frozenBytes, File.ReadAllBytes(library))
        }
    }

    shared {
        private func Run(assembly Assembly)[]uint8 -> Encoding.UTF8.GetBytes(
            cast[string](
                assembly.GetTypes().Single((t Type) -> t.Name == "Consumer").GetMethod("Run")!!.Invoke(nil, nil)
            )
        )

        private const NativeLibrary string = `using System;
using System.Diagnostics;
namespace SimilarName6100 {
    public sealed class ConditionalAttribute : Attribute {
        public ConditionalAttribute(string symbol) { }
    }
}
namespace ConditionalFixture6100 {
    public static class Recorder { public static string Trace = ""; }
    public class Probe {
        [Conditional("OTHER_6100"), Conditional("ACTIVE_6100")]
        public virtual void Keep(int value) { Recorder.Trace += "K" + value; }
        [Conditional("OTHER_6100"), Conditional("ACTIVE_6100")]
        public void KeepGeneric<T>(T value) { Recorder.Trace += "T" + value; }
        [Conditional("OTHER_6100"), Conditional("ACTIVE_6100")]
        public static void SharedKeep(int value) { Recorder.Trace += "S" + value; }
        [SimilarName6100.Conditional("ABSENT")]
        public static void Always() { Recorder.Trace += "N"; }
    }
    public class NativeOverride : Probe {
        public override void Keep(int value) { Recorder.Trace += "V" + value; }
    }
    public class NativeHider : Probe {
        public new virtual void Keep(int value) { Recorder.Trace += "H" + value; }
    }
    public static class Generic<T> {
        [Conditional("OTHER_6100"), Conditional("ACTIVE_6100")]
        public static void Keep(T value) { Recorder.Trace += "G" + value; }
    }
    public static class Extensions {
        [Conditional("OTHER_6100"), Conditional("ACTIVE_6100")]
        public static void KeepExtension(this Probe self, int value) { Recorder.Trace += "E" + value; }
    }
}`

        private const GSharpConsumer string = `import System
import System.Threading.Tasks
import ConditionalFixture6100
class Derived : Probe {
    func FromBase() { base.Keep(Consumer.Argument()) }
    func FromBaseLambda() {
        let call = func() { base.Keep(Consumer.Argument()) }
        call()
    }
}
class SourceOverride : Probe {
    override func Keep(value int32) { Recorder.Trace += "W" + value.ToString() }
}
shared class Consumer {
    func Deferred() { defer Probe.SharedKeep(Argument()) }
    func AsyncArgument() Task[int32] {
        Recorder.Trace += "A"
        return Task.FromResult(7)
    }
    async func Awaited() { Probe.SharedKeep(await AsyncArgument()) }
    func Argument() int32 {
        Recorder.Trace += "A"
        return 7
    }
    func ThrowingArgument() int32 {
        Recorder.Trace += "A"
        throw InvalidOperationException()
    }
    func Receiver() Probe {
        Recorder.Trace += "R"
        return Probe()
    }
    func OptionalReceiver() Probe? {
        Recorder.Trace += "R"
        return Probe()
    }
    func MissingReceiver() Probe? {
        Recorder.Trace += "R"
        return nil
    }
    func ThrowingReceiver() Probe {
        Recorder.Trace += "R"
        throw InvalidOperationException()
    }
    func Run() string {
        Recorder.Trace = ""
        try {
`

        private const NativeConsumer string = `using System;
using System.Threading.Tasks;
using ConditionalFixture6100;
public class Derived : Probe {
    public void FromBase() { base.Keep(Consumer.Argument()); }
    public void FromBaseLambda() {
        Action call = () => base.Keep(Consumer.Argument());
        call();
    }
}
public class SourceOverride : Probe {
    public override void Keep(int value) { Recorder.Trace += "W" + value; }
}
public static class Consumer {
    public static void Deferred() { Probe.SharedKeep(Argument()); }
    public static Task<int> AsyncArgument() { Recorder.Trace += "A"; return Task.FromResult(7); }
    public static async Task Awaited() { Probe.SharedKeep(await AsyncArgument()); }
    public static int Argument() { Recorder.Trace += "A"; return 7; }
    public static int ThrowingArgument() { Recorder.Trace += "A"; throw new InvalidOperationException(); }
    public static Probe Receiver() { Recorder.Trace += "R"; return new Probe(); }
    public static Probe? OptionalReceiver() { Recorder.Trace += "R"; return new Probe(); }
    public static Probe? MissingReceiver() { Recorder.Trace += "R"; return null; }
    public static Probe ThrowingReceiver() { Recorder.Trace += "R"; throw new InvalidOperationException(); }
    public static string Run() {
        Recorder.Trace = "";
        try {
`
    }
}
