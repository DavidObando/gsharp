package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue5951SourceMaybeNullReturnTests {
    @Fact
    func NarrowedStorage_PreservesChangedReturnContracts() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    static int calls;
    [return: MaybeNull]
    static Task<int> Empty() { calls++; return null; }
#nullable disable
    static Task<int> Forward() => Empty();
#nullable enable
    [return: MaybeNull]
    static Task<int> ThroughStorage()
    {
        Task<int>? task = Forward();
        var copy = task;
        return copy;
    }
    public static void Main()
    {
        Console.WriteLine(ThroughStorage() == null);
        Console.WriteLine(calls);
    }
}`, expectedOutput: string.Join(Environment.NewLine, []string{"True", "1"}) + Environment.NewLine)
    }

    @Fact
    func DeclaredDelegateReturns_StayDistinctFromAsyncEnvelopes() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Threading.Tasks;
public delegate string? Reader();
public static class P
{
    static int calls;
    static string? Value(bool missing) { calls++; return missing ? null : "abc"; }
    static async Task<string?> Payload() { calls++; await Task.Yield(); return null; }
#nullable disable
    static int Read(Reader reader) => reader().Length;
    public static void Main()
    {
        Reader missing = () => Value(true);
        Reader present = () => Value(false);
        try { Console.WriteLine(Read(missing)); }
        catch (NullReferenceException) { Console.WriteLine("null"); }
        Console.WriteLine(Read(present));
        Console.WriteLine(Value(false).Length);
        try { Console.WriteLine(Value(true).Length); }
        catch (NullReferenceException) { Console.WriteLine("null"); }
        Console.WriteLine(Payload().GetAwaiter().GetResult() == null);
        Console.WriteLine(calls);
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.DoesNotContain(
                    "Payload()!!",
                    printed
                )
            }, nullableContext: NullableContextOptions.Disable, expectedOutput: string.Join(
                Environment.NewLine,
                []string{"null", "3", "3", "null", "True", "5"}
            ) +
                Environment.NewLine)
    }

    @Fact
    func EnvelopeStorage_DoesNotBecomeAwaitedResultEvidence() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable disable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    static int calls;
    [return: MaybeNull]
    static Task<string> Empty() { calls++; Task<string> task = null; return task; }
    static Task<string> Forward() => Empty();
    static async Task<string> Inner() { calls++; await Task.Yield(); return null; }
    [return: MaybeNull]
    static Task<string> Both() { var task = Inner(); return task; }
    static ValueTask<string?> StructResult() => ValueTask.FromResult<string?>(null);
    public static void Main()
    {
        Console.WriteLine(Forward() == null);
        Console.WriteLine(Both().GetAwaiter().GetResult() == null);
        Console.WriteLine(StructResult().Result == null);
        Console.WriteLine(calls);
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.Contains(
                    "func Empty() Task[string]?",
                    printed
                )
                Assert.DoesNotContain(
                    "func Empty() Task[string?]?",
                    printed
                )
                Assert.Contains(
                    "func Both() Task[string?]?",
                    printed
                )
                Assert.DoesNotContain(
                    "ValueTask[string?]?",
                    printed
                )
            }, nullableContext: NullableContextOptions.Disable, expectedOutput: string.Join(
                Environment.NewLine,
                []string{"True", "True", "True", "2"}
            ) +
                Environment.NewLine)
    }

    @Fact
    func LaterEnvelopeWrites_PromoteStorageAndForwardedReturns() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable disable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    static int calls;
    [return: MaybeNull]
    static Task<int> Empty() { calls++; return null; }
    static Task<int> Forward()
    {
        var task = Task.FromResult(1);
        task = Empty();
        return task;
    }
    static Task<int> NonNull()
    {
        var task = Task.FromResult(1);
        task = Task.FromResult(2);
        return task;
    }
    public static void Main()
    {
        Console.WriteLine(Forward() == null);
        Console.WriteLine(NonNull().Result);
        Console.WriteLine(calls);
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.DoesNotContain(
                    "Empty()!!",
                    printed
                )
                Assert.DoesNotContain(
                    "func NonNull() Task[int32]?",
                    printed
                )
            }, nullableContext: NullableContextOptions.Disable, expectedOutput: string.Join(
                Environment.NewLine,
                []string{"True", "2", "1"}
            ) +
                Environment.NewLine)
    }

    shared {
        private func AssertMetadataBoundary(knownSource bool, inheritedContract bool = false) {
            let librarySource = if inheritedContract {
                `
#nullable enable
using System.Diagnostics.CodeAnalysis;
namespace Library
{
    public interface IValue { [return: MaybeNull] string Read(); }
    public abstract class Base { [return: MaybeNull] public abstract string Read(); }
}`
            } else {
                `
#nullable enable
using System.Diagnostics.CodeAnalysis;
namespace Library
{
    public static class Lib
    {
        public static int Calls;
        [return: MaybeNull]
        public static string Value(bool missing) { Calls++; return missing ? null : "abc"; }
    }
}`
            }
            let libraryTree = CSharpSyntaxTree.ParseText(librarySource, path: "Library.cs")
            let library = CSharpCompilation.Create(
                "Library",
                []SyntaxTree{libraryTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let image = MemoryStream()
            let libraryEmit = library.Emit(image)
            Assert.True(libraryEmit.Success, string.Join(Environment.NewLine, libraryEmit.Diagnostics))
            let consumerSource = if inheritedContract {
                `
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
using Library;
public class Value : Base, IValue
{
    public static int Calls;
    [return: MaybeNull]
    public override string Read() { Calls++; return null; }
}
public static class P
{
    public static void Main()
    {
        IValue value = new Value();
        Base parent = new Value();
        Console.WriteLine(value.Read() == null);
        Console.WriteLine(parent.Read() == null);
        Console.WriteLine(new Value().Read() == null);
        Console.WriteLine(Value.Calls);
    }
}`
            } else {
                `
#nullable disable
using System;
using Library;
public static class P
{
    static string? Read() => Lib.Value(true);
    public static void Main()
    {
        Console.WriteLine(Read() == null);
        Console.WriteLine(Lib.Value(false).Length);
        try { Console.WriteLine(Lib.Value(true).Length); }
        catch (NullReferenceException) { Console.WriteLine("null"); }
        Console.WriteLine(Lib.Calls);
    }
}`
            }
            let consumer = CSharpProjectLoader.LoadInMemory(
                [](string, Source string){("Consumer.cs", consumerSource)},
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Append(MetadataReference.CreateFromImage(image.ToArray()))
                    .ToArray(),
                assemblyName: "Native",
                outputKind: OutputKind.ConsoleApplication
            )
            Assert.True(consumer.BoundWithoutErrors, string.Join(Environment.NewLine, consumer.ErrorDiagnostics))
            let document = Assert.Single(consumer.Documents)
            let compilations = if knownSource {
                []CSharpCompilation{library, consumer.Compilation}
            } else {
                []CSharpCompilation{}
            }
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(
                    document,
                    TranslationContext(
                        consumer.Compilation,
                        document.SemanticModel,
                        document.FilePath,
                        compilations,
                        compilations
                    )
                )
            )
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5951-metadata", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let libraryPath = Path.Combine(directory, "Library.dll")
                File.WriteAllBytes(libraryPath, image.ToArray())
                let nativePath = Path.Combine(directory, "Native.dll")
                {
                    using let native = File.Create(nativePath)
                    let result = consumer.Compilation.Emit(native)
                    Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
                }
                File.WriteAllText(
                    Path.Combine(directory, "Native.runtimeconfig.json"),
                    `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
                )
                let expected = LiteralConstructionRuntimeParity.RunDotnet([]string{nativePath})
                Assert.Equal(
                    Encoding.UTF8.GetBytes(
                        string.Join(
                            Environment.NewLine,
                            if inheritedContract {
                                []string{"True", "True", "True", "3"}
                            } else {
                                []string{"True", "3", "null", "3"}
                            }
                        ) +
                            Environment.NewLine
                    ),
                    expected
                )
                let compiler = LiteralConstructionRuntimeParity.FindCompiler()
                if knownSource {
                    let model = library.GetSemanticModel(libraryTree)
                    let libraryPrinted = GSharpPrinter.Print(
                        CSharpToGSharpTranslator().TranslateDocument(
                            LoadedDocument("Library.cs", libraryTree, model),
                            TranslationContext(library, model, "Library.cs", compilations, compilations)
                        )
                    )
                    let libraryGs = Path.Combine(directory, "Library.gs")
                    File.WriteAllText(libraryGs, libraryPrinted)
                    LiteralConstructionRuntimeParity.RunDotnet(
                        []string{
                            compiler,
                            "/target:library",
                            "/targetframework:net10.0",
                            "/out:" + libraryPath,
                            libraryGs
                        },
                        libraryPrinted
                    )
                }
                let gsPath = Path.Combine(directory, "Translated.gs")
                let translatedPath = Path.Combine(directory, "Translated.dll")
                File.WriteAllText(gsPath, printed)
                LiteralConstructionRuntimeParity.RunDotnet(
                    []string{
                        compiler,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + libraryPath,
                        "/out:" + translatedPath,
                        gsPath
                    },
                    printed
                )
                Assert.Equal(expected, LiteralConstructionRuntimeParity.RunDotnet([]string{translatedPath}, printed))
                if inheritedContract {
                    Assert.Contains("func Read() string?", printed)
                    Assert.DoesNotContain("Read()!!", printed)
                } else if knownSource {
                    Assert.Contains("Lib.Value(false)!!.Length", printed)
                } else {
                    Assert.DoesNotContain("Lib.Value(false)!!", printed)
                }
                Assert.DoesNotContain("Lib.Value(true)!!\n", printed)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }

    @Fact
    func NullableEnvelopes_AreAssertedOnlyAtActualDereferences() {
        let source = `
#nullable disable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    static int calls;
    [return: MaybeNull]
    static Task<int> Value(bool missing) { calls++; return missing ? null : Task.FromResult(7); }
    [return: MaybeNull]
    static ValueTask<int> StructValue() => new ValueTask<int>(9);
    public static void Main()
    {
        Console.WriteLine(Value(false).Result);
        Console.WriteLine(Value(false).GetAwaiter().GetResult());
        try { Console.WriteLine(Value(true).Result); }
        catch (NullReferenceException) { Console.WriteLine("null"); }
        try { Console.WriteLine(Value(true).GetAwaiter().GetResult()); }
        catch (NullReferenceException) { Console.WriteLine("null"); }
        Console.WriteLine(StructValue().Result);
        var saved = Value(false);
        Console.WriteLine(saved.Result);
        Console.WriteLine(calls);
    }
}`
        for mode in[]NullableContextOptions{NullableContextOptions.Disable, NullableContextOptions.Enable} {
            LiteralConstructionRuntimeParity.AssertMatches(
                if mode == NullableContextOptions.Enable {
                    source.Replace("#nullable disable", "#nullable enable")
                } else {
                    source
                },
                nullableContext: mode,
                expectedOutput: string.Join(Environment.NewLine, []string{"7", "7", "null", "null", "9", "7", "5"}) +
                    Environment.NewLine
            )
        }
    }

    @Fact
    func NullableEnvelopes_ForwardWithoutBorrowingAwaitedResultNullability() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable disable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    static int calls;
    [return: MaybeNull]
    static Task<int> Empty() { calls++; return null; }
    static Task<int> Forward() => Empty();
    static Task<int> Again() => Forward();
    static Task<int> Alias() { var task = Empty(); return task; }
    [return: MaybeNull]
    static Task<string> TextEmpty() => null;
    static Task<string> TextForward() => TextEmpty();
    [return: MaybeNull]
    static Task<T> GenericEmpty<T>() { calls++; return null; }
    static Task<T> GenericForward<T>() => GenericEmpty<T>();
    static Task<int> Fallback() => Empty() ?? Task.FromResult(9);
    public static void Main()
    {
        Console.WriteLine(Again() == null);
        Console.WriteLine(TextForward() == null);
        Console.WriteLine(GenericForward<int>() == null);
        Console.WriteLine(GenericForward<string>() == null);
        Console.WriteLine(Alias() == null);
        Console.WriteLine(Fallback().Result);
        Console.WriteLine(calls);
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.Contains(
                    "func Forward() Task[int32]?",
                    printed
                )
                Assert.Contains(
                    "func Again() Task[int32]?",
                    printed
                )
                Assert.Contains(
                    "func TextForward() Task[string]?",
                    printed
                )
                Assert.DoesNotContain(
                    "Task[string?]",
                    printed
                )
                Assert.DoesNotContain(
                    "Empty()!!",
                    printed
                )
                Assert.DoesNotContain(
                    "func Fallback() Task[int32]?",
                    printed
                )
            }, nullableContext: NullableContextOptions.Disable, expectedOutput: string.Join(
                Environment.NewLine,
                []string{"True", "True", "True", "True", "True", "9", "5"}
            ) +
                Environment.NewLine)
    }

    @Fact
    func KnownSiblingInheritedContracts_AreReadFromTheirSourceDeclarations() {
        AssertMetadataBoundary(knownSource: true, inheritedContract: true)
    }

    @Fact
    func DeclaredTaskEnvelopes_DoNotDependOnTheirResultKind() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public interface IValue
{
    [return: MaybeNull] Task<int> Value();
}
public class TaskValue : IValue
{
    [return: MaybeNull] public Task<int> Value() => null;
}
public static class P
{
    static int calls;
    [return: MaybeNull]
    static Task<int> Number() { calls++; return null; }
    [return: MaybeNull]
    static Task<(string, int)> Tuple() => null;
    [return: MaybeNull]
    static Task<T> Generic<T>() => null;
    [return: MaybeNull]
    static T Identity<T>(T value) => value;
    public static void Main()
    {
        IValue value = new TaskValue();
        Console.WriteLine(Number() == null);
        Console.WriteLine(Tuple() == null);
        Console.WriteLine(Generic<string>() == null);
        Console.WriteLine(Generic<int>() == null);
        Console.WriteLine(value.Value() == null);
        Console.WriteLine(Identity(7));
        Console.WriteLine(calls);
    }
}`, expectedOutput: string.Join(Environment.NewLine, []string{"True", "True", "True", "True", "True", "7", "1"}) +
                Environment.NewLine)
    }

    @Fact
    func TaskEnvelopeAndAwaitedResult_PromoteIndependently() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable disable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    static int calls;
    static async Task<string> Inner()
    {
        calls++;
        await Task.Yield();
        return null;
    }
    [return: MaybeNull]
    static Task<string> Outer() { calls++; return Inner(); }
    [return: MaybeNull]
    static Task<string> Empty() => null;
    static Task<string> ResultOnly() => Inner();
    static async Task<string> AsyncForward() => await Inner();
    public static void Main()
    {
        Console.WriteLine(Empty() == null);
        Console.WriteLine(Outer()!.GetAwaiter().GetResult() == null);
        Console.WriteLine(ResultOnly().GetAwaiter().GetResult() == null);
        Console.WriteLine(AsyncForward().GetAwaiter().GetResult() == null);
        Console.WriteLine(calls);
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.Contains(
                    "func Empty() Task[string]?",
                    printed
                )
                Assert.DoesNotContain(
                    "func Empty() Task[string?]?",
                    printed
                )
                Assert.Contains(
                    "func Outer() Task[string?]?",
                    printed
                )
                Assert.Contains(
                    "func ResultOnly() Task[string?]",
                    printed
                )
                Assert.DoesNotContain(
                    "func ResultOnly() Task[string?]?",
                    printed
                )
            }, nullableContext: NullableContextOptions.Disable, expectedOutput: string.Join(
                Environment.NewLine,
                []string{"True", "True", "True", "True", "4"}
            ) +
                Environment.NewLine)
    }

    @Fact
    func KnownSiblingMethods_UseSourceContracts_WhileExternalMetadataStaysFixed() {
        AssertMetadataBoundary(knownSource: true)
        AssertMetadataBoundary(knownSource: false)
    }

    @Fact
    func SourceReturnContract_PreservesNullAtNullableSinks() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
public static class P
{
    [return: MaybeNull]
    static string Value() => null;
    public static string? Read() => Value();
    static string? Forward(string? value) => value;
    public static void Main()
    {
        [return: MaybeNull]
        string Local() => null;
        Func<string?> reader = Value;
        string? local = Value();
        Console.WriteLine(Read() == null);
        Console.WriteLine(Forward(local) == null);
        Console.WriteLine(Forward(Value()) == null);
        Console.WriteLine(Local() == null);
        Console.WriteLine(reader() == null);
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.Contains(
                    "@return:MaybeNull",
                    printed
                )
                Assert.DoesNotContain(
                    "Value()!!",
                    printed
                )
            })
    }

    @Fact
    func SourceReturnContract_ChangesOnlyTheReferenceRoot() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public static class P
{
    [return: MaybeNull]
    static string[] Missing() => null;
    [return: MaybeNull]
    static string?[] Nested() => new string?[] { null };
    [return: MaybeNull]
    static int Number() => 7;
    [return: MaybeNull]
    static T Reference<T>() where T : class => null;
    [return: MaybeNull]
    static T Identity<T>(T value) => value;
    [return: MaybeNull]
    static T StructIdentity<T>(T value) where T : struct => value;
    [return: MaybeNull]
    static Task<string> Envelope() => null;
    static string Plain() => "plain";
    public static void Main()
    {
        Console.WriteLine(Missing() == null);
        Console.WriteLine(Nested()![0] == null);
        Console.WriteLine(Number());
        Console.WriteLine(Reference<string>() == null);
        Console.WriteLine(Identity(8));
        Console.WriteLine(Identity("value"));
        Console.WriteLine(StructIdentity(9));
        Console.WriteLine(Envelope() == null);
        Console.WriteLine(Plain());
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.Contains(
                    "func Missing() []?string",
                    printed
                )
                Assert.Contains(
                    "func Nested() []?string?",
                    printed
                )
                Assert.Contains(
                    "func Number() int32",
                    printed
                )
                Assert.DoesNotContain(
                    "func Number() int32?",
                    printed
                )
                Assert.Contains(
                    "func Reference[T class]() T?",
                    printed
                )
                Assert.Contains(
                    "func Identity[T](value T) T",
                    printed
                )
                Assert.DoesNotContain(
                    "func Identity[T](value T) T?",
                    printed
                )
                Assert.Contains(
                    "func StructIdentity[T struct](value T) T",
                    printed
                )
                Assert.Contains(
                    "func Envelope() Task[string]?",
                    printed
                )
                Assert.DoesNotContain(
                    "Task[string?]",
                    printed
                )
                Assert.Contains(
                    "func Plain() string",
                    printed
                )
                Assert.DoesNotContain(
                    "func Plain() string?",
                    printed
                )
            })
    }

    @Fact
    func SourceReturnContract_StaysAlignedWithInheritedSourceSignatures() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
public interface IValue
{
    [return: MaybeNull]
    string Read();
}
public abstract class Base
{
    [return: MaybeNull]
    public abstract string Read();
}
public class Value : Base, IValue
{
    [return: MaybeNull]
    public override string Read() => null;
}
public class InheritedValue : Base, IValue
{
    public override string Read() => "value";
}
public static class P
{
    public static void Main()
    {
        IValue contract = new Value();
        Base parent = new Value();
        Console.WriteLine(contract.Read() == null);
        Console.WriteLine(parent.Read() == null);
        Console.WriteLine(new Value().Read() == null);
        Console.WriteLine(new InheritedValue().Read());
    }
}`, verifyTranslation: (
                printed string
            ) -> {
                Assert.Contains(
                    "func Read() string?",
                    printed
                )
                Assert.Contains(
                    "func Read() string? -> \"value\"",
                    printed
                )
                Assert.DoesNotContain(
                    "Read()!!",
                    printed
                )
            })
    }

    @Fact
    func SourceReturnContract_DoesNotRepaintImportedOrUnrelatedAttributes() {
        LiteralConstructionRuntimeParity.AssertMatches(`
#nullable enable
namespace Other
{
    public static class Source
    {
        [return: System.Diagnostics.CodeAnalysis.MaybeNull]
        public static string Value() => null;
    }
    public sealed class MaybeNullAttribute : System.Attribute { }
    public static class P
    {
        [return: MaybeNull]
        public static string Value() => "value";
        public static void Main()
        {
            System.Console.WriteLine(Source.Value() == null);
            System.Console.WriteLine(Value());
            Library.IRequired required = new ImportedContract();
            System.Console.WriteLine(required.Read());
            System.Console.WriteLine(new CovariantValue().Covariant());
        }

    }
    public class ImportedContract : Library.IRequired
    {
        [return: System.Diagnostics.CodeAnalysis.MaybeNull]
        public string Read() => "value";
    }
    public class CovariantValue : Library.RequiredBase
    {
        [return: System.Diagnostics.CodeAnalysis.MaybeNull]
        public override string Covariant() => "covariant";
    }
}
`, verifyTranslation: (
                printed string
            ) -> {
                if printed
                    .Contains(
                    "shared class Source"
                ) {
                    Assert.Contains(
                        "func Value() string? -> nil",
                        printed
                    )
                    Assert.Contains(
                        "func Value() string -> \"value\"",
                        printed
                    )
                    Assert.Contains(
                        "func Covariant() string -> \"covariant\"",
                        printed
                    )
                }
                Assert.Contains(
                    "func Read() string",
                    printed
                )
                Assert.DoesNotContain(
                    "func Read() string?",
                    printed
                )
            }, librarySource: `
#nullable enable
namespace Library
{
    public interface IRequired { string Read(); }
    public class RequiredBase { public virtual object Covariant() => new object(); }
}
`)
    }
}
