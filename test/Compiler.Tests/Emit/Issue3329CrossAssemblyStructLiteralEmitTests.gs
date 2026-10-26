// <copyright file="Issue3329CrossAssemblyStructLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3329 — a struct literal (`S{}`) for a struct type declared in
/// ANOTHER (already-compiled) assembly lost its ADR-0159 "sound zero value"
/// instance-field initializer for a magic-collection-typed field (map/slice/
/// fixed array/sequence), leaving the field at its raw CLR default (a null
/// reference for a reference-backed collection) and NREing at runtime the
/// first time the field is used. The REPL hits this identically on a
/// cross-cell struct, since each submission is a distinct assembly (ADR-0156)
/// — these tests exercise the SAME code paths (`ImportedTypeSymbol.
/// BuildSemanticAggregate` for a `data struct`/primary-ctor struct,
/// `ExpressionBinder.BindImportedTypeObjectInitializer` for a plain
/// struct) through ordinary cross-assembly `gsc` compilation plus ILVerify,
/// which is more convenient to drive from a test than a REPL session and
/// confirms the fix is not REPL-specific.
open class Issue3329CrossAssemblyStructLiteralEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_EmptyPrimaryParity(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package constructor5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Next() int32 {
            Trace = Trace + "I"
            return 1
        }
    }
}
public data struct S() {
    public var X int32 = Effects.Next()
}`, "constructor5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import constructor5296
import System
data struct Local() {
    public var X int32 = Effects.Next()
}
let local = Local{}
Console.WriteLine(local.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let imported = S{}
Console.WriteLine(imported.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let localOverride = Local{X: 9}
Console.WriteLine(localOverride.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let importedOverride = S{X: 9}
Console.WriteLine(importedOverride.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let ordinary = S()
Console.WriteLine(ordinary.X.ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("1:I\n1:I\n9:I\n9:I\n1:I\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_DefaultOverrideAndExpressionTree(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package phases5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Value(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S {
    public var X int32 = Effects.Value("D", 7)
}
public data struct Plain {
    public var X int32 = 7
}
public data struct Primary(A int32, B int32 = 5) {
    public var X int32 = Effects.Value("D", 7)
}`, "phases5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import phases5296
import System
import System.Linq.Expressions
data struct Local {
    public var X int32 = Effects.Value("D", 7)
}
let local = Local{X: Effects.Value("E", 9)}
Console.WriteLine(Effects.Trace + ":" + local.X.ToString())
Effects.Trace = ""
let imported = S{X: Effects.Value("E", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.X.ToString())
Effects.Trace = ""
let tree Expression[Func[S]] = () -> S{}
Console.WriteLine("tree:" + Effects.Trace)
let compiled = tree.Compile()
let fromTree = compiled()
Console.WriteLine(Effects.Trace + ":" + fromTree.X.ToString())
let literalTree Expression[Func[Plain]] = () -> Plain{}
let literalFactory = literalTree.Compile()
Console.WriteLine(literalFactory().X)
Effects.Trace = ""
let overrideTree Expression[Func[S]] = () -> S{X: Effects.Value("E", 9)}
Console.WriteLine("tree:" + Effects.Trace)
Console.WriteLine(overrideTree.Compile()().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let primaryTree Expression[Func[Primary]] = () -> Primary{B: Effects.Value("Q", 2), A: Effects.Value("A", 3), X: Effects.Value("E", 9)}
Console.WriteLine("tree:" + Effects.Trace)
let primary = primaryTree.Compile()()
Console.WriteLine(Effects.Trace + ":" + primary.A.ToString() + "/" + primary.B.ToString() + "/" + primary.X.ToString())
Effects.Trace = ""
let rawTree Expression[Func[S]] = () -> default(S)
Console.WriteLine(rawTree.Compile()().X.ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("DE:9\nDE:9\ntree:\nD:7\n7\ntree:\n9:DE\ntree:\nQADE:3/2/9\n0:\n"),
            fixture.RunBytes(consumer)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_ReadonlyDefaultsAndConstructorUseAnchors(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package readonly5296
public data struct R {
    public let X int32 = 7
}`, "readonly5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import readonly5296
class Holder {
    public var Value R = R{}
}
let first = Holder{}
let second = Holder{}
System.Console.WriteLine(first.Value.X)
System.Console.WriteLine(second.Value.X)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("7\n7\n"), fixture.RunBytes(consumer))
        let (code, output) = fixture.TryCompile(`import readonly5296
let x = R{X: 9}`, "rejected", executable: true, "/r:" + selected)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,11,2,12): error GS0127:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        let rejectedReference = Path.Combine(fixture.Directory, "anchored.ref.dll")
        let (anchorCode, anchorOutput) = fixture.TryCompile(`import readonly5296
class Holder {
    public var Value R = R{X: 9}
}
let first = Holder{}
let second = Holder{}`, "anchored", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(anchorCode != 0, anchorOutput)
        for location in[]string{"(3,28,3,29)", "(5,13,5,19)", "(6,14,6,20)"} {
            Assert.True(
                anchorOutput.Contains("anchored.gs" + location + ": error GS0127:", StringComparison.Ordinal),
                anchorOutput
            )
        }
        Assert.Equal(3, anchorOutput.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "anchored.dll")))
        Assert.False(File.Exists(rejectedReference))
        AssertOrdinaryConstructorMetadata(producer, "R")
        AssertOrdinaryConstructorMetadata(reference, "R")
        AssertConstructorStores(consumer, "readonly5296", "R", "X")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_PrimaryAuthoredAndGenericPhases(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package policy5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Primary(A int32, B int32 = 5) {
    public var X int32 = Effects.Mark("D", 7)
}
public data struct Authored {
    public var X int32 = Effects.Mark("D", 7)
    public init() {
        Effects.Trace = Effects.Trace + "B"
        X = 8
    }
    public convenience init(value int32) {
        init()
        X = value
    }
}
public data struct Overloaded {
    public var X int32 = Effects.Mark("D", 7)
    public init(unused int32) {
        Effects.Trace = Effects.Trace + "P"
        X = 99
    }
}
public data struct EmptyPrimary() {
    public var X int32 = Effects.Mark("D", 7)
    public init(unused int32) {
        Effects.Trace = Effects.Trace + "P"
        X = 99
    }
}
public data struct Private[T] {
    private var Hidden int32 = Effects.Mark("H", 3)
    public var X int32 = Effects.Mark("D", 7)
    public func ReadHidden() int32 -> Hidden
}
public data struct Generic[T](Value T) {
    public var X int32 = Effects.Mark("D", 7)
}`, "policy5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import policy5296
import System
let first = Primary{A: Effects.Mark("A", 3), X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + first.A.ToString() + "/" + first.B.ToString() + "/" + first.X.ToString())
Effects.Trace = ""
let reversed = Primary{B: Effects.Mark("Q", 2), A: Effects.Mark("A", 1), X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + reversed.A.ToString() + "/" + reversed.B.ToString() + "/" + reversed.X.ToString())
Effects.Trace = ""
let ordinary = Primary(3)
Console.WriteLine(Effects.Trace + ":" + ordinary.A.ToString() + "/" + ordinary.B.ToString() + "/" + ordinary.X.ToString())
Effects.Trace = ""
let authored = Authored{X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + authored.X.ToString())
Effects.Trace = ""
Console.WriteLine(Authored().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Authored(5).X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Overloaded{}.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Overloaded().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Overloaded(1).X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary{}.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let hidden = Private[int32]{X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + hidden.ReadHidden().ToString() + "/" + hidden.X.ToString())
Effects.Trace = ""
func Make[T](value T) int32 {
    let item = Generic[T]{Value: value, X: Effects.Mark("E", 9)}
    return item.X
}
Console.WriteLine(Make[int32](42).ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System
                .Text
                .Encoding
                .UTF8
                .GetBytes(
                "ADE:3/0/9\nQADE:1/2/9\nD:3/5/7\nDBE:9\n8:DB\n5:DB\n7:D\n7:D\n99:DP\n7:D\n7:D\nHDE:3/9\n9:DE\n"
            ),
            fixture.RunBytes(consumer)
        )
        AssertOrdinaryConstructorMetadata(producer, "Overloaded")
        AssertOrdinaryConstructorMetadata(reference, "Overloaded")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_ThrowingDefaultsAndStaticInitialization(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package throws5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
        public func Fail() int32 {
            Trace = Trace + "D"
            throw System.InvalidOperationException("default")
        }
    }
}
public data struct Throwing {
    public var X int32 = Effects.Fail()
}
public data struct Static {
    public var X int32 = Effects.Mark("D", 7)
    shared { init { Effects.Trace = Effects.Trace + "S" } }
}
public data struct StaticPrimary(A int32) {
    public var X int32 = Effects.Mark("D", 7)
    shared { init { Effects.Trace = Effects.Trace + "S" } }
}`, "throws5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import throws5296
import System
try {
    let value = Throwing{X: Effects.Mark("E", 9)}
    Console.WriteLine(value.X)
} catch (error InvalidOperationException) {
    Console.WriteLine(Effects.Trace + ":" + error.Message)
}
Effects.Trace = ""
let first = Static{X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + first.X.ToString())
Effects.Trace = ""
let second = StaticPrimary{A: Effects.Mark("A", 1), X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + second.X.ToString())`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("D:default\nSDE:9\nASDE:9\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_CSharpConsumerAndDeterministicMetadata(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        const source = `package native5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S {
    public var X int32 = Effects.Mark("D", 7)
    private var Hidden int32 = 3
    public func ReadHidden() int32 -> Hidden
}
public data struct Empty {}
public data struct Readonly {
    public let X int32 = 7
}
public data struct Generic[T](Value T, Other int32 = 5) {
    public var X int32 = Effects.Mark("D", 7)
}`
        let producer = fixture.Compile(source, "native5296", executable: false, "/refout:" + reference)
        let firstImplementation = File.ReadAllBytes(producer)
        let firstReference = File.ReadAllBytes(reference)
        fixture.Compile(source, "native5296", executable: false, "/refout:" + reference)
        Assert.Equal(firstImplementation, File.ReadAllBytes(producer))
        Assert.Equal(firstReference, File.ReadAllBytes(reference))
        IlVerifier.Verify(producer)
        AssertOrdinaryConstructorMetadata(producer, "S")
        AssertOrdinaryConstructorMetadata(reference, "S")
        AssertOrdinaryConstructorMetadata(producer, "Empty")
        AssertOrdinaryConstructorMetadata(reference, "Empty")
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let native = fixture.CompileCSharp(`using native5296;
namespace Native5296Consumer;
public static class NativeConsumer {
    public static string Run() {
        Effects.Trace = "";
        var first = new S { X = Effects.Mark("E", 9) };
        var trace = Effects.Trace + ":" + first.X + "/" + first.ReadHidden();
        Effects.Trace = "";
        var second = new Generic<int>(3) { X = Effects.Mark("E", 9) };
        trace += "\n" + Effects.Trace + ":" + second.Value + "/" + second.Other + "/" + second.X;
        Effects.Trace = "";
        var raw = default(S);
        var array = new S[1];
        return trace + "\n" + raw.X + "/" + array[0].X + ":" + Effects.Trace + "\n" + new Readonly().X;
    }
}`, "NativeConsumer", selected)
        IlVerifier.Verify(native, []string{producer})
        let consumer = fixture.Compile(`import Native5296Consumer
System.Console.WriteLine(NativeConsumer.Run())`, "consumer", executable: true, "/r:" + selected, "/r:" + native)
        IlVerifier.Verify(consumer, []string{producer, native})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("DE:9/3\nDE:3/5/9\n0/0:\n7\n"), fixture.RunBytes(consumer))
        let rejected = CSharpCompilation.Create(
            "rejected",
            []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(`using native5296;
public static class Bad {
    public static Readonly Run() => new Readonly { X = 9 };
}`, path: "rejected.cs")},
            cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
                .Split(Path.PathSeparator)
                .Append(selected)
                .Select((path string) -> MetadataReference.CreateFromFile(path)),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let image = MemoryStream()
        let rejection = rejected.Emit(image)
        Assert.False(rejection.Success)
        let error = Assert.Single(
            rejection.Diagnostics.Where(
                (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
        )
        Assert.Equal("CS0191", error.Id)
        let location = error.Location.GetLineSpan()
        Assert.Equal("rejected.cs", location.Path)
        Assert.Equal(2, location.StartLinePosition.Line)
        Assert.Equal(51, location.StartLinePosition.Character)
        Assert.Equal(52, location.EndLinePosition.Character)
        Assert.Equal(0, image.Length)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_AuthoredAccessibilityAndFriendMetadata(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package access5296
@assembly:InternalsVisibleTo("consumer")
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Secret {
    public var X int32 = Effects.Mark("D", 7)
    private init() {
        Effects.Trace = Effects.Trace + "B"
        X = 8
    }
    shared { public func Create() Secret -> Secret{} }
}
public data struct Friend {
    public var X int32 = Effects.Mark("D", 7)
    internal func init() {
        Effects.Trace = Effects.Trace + "B"
        X = 8
    }
}`, "access5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import access5296
import System
let own = Secret.Create()
Console.WriteLine(Effects.Trace + ":" + own.X.ToString())
Effects.Trace = ""
let friend = Friend{}
Console.WriteLine(Effects.Trace + ":" + friend.X.ToString())`, "consumer", executable: true, "/assemblyname:consumer", "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("DB:8\nDB:8\n"), fixture.RunBytes(consumer))
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import access5296
let bad = Secret{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,11,2,17): error GS0267:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_LegacyMissingConstructorAndForeignZero(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const declarations = `namespace legacy5296;
public struct Legacy { public int X; }
public record struct Foreign(int X = 17) { public int Y = 3; }
public record struct Authored {
    public int X = 7;
    public Authored() { X = 8; }
}`
        let probe = fixture.CompileCSharp(declarations, "Probe")
        var legacyToken = 0
        {
            using let stream = File.OpenRead(probe)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            legacyToken = MetadataTokens.GetToken(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == "Legacy"
                )
            )
        }
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.CompileCSharpWithReference(
            "[assembly: System.Reflection.AssemblyMetadata(\"GSharp.TypeSemantics\", \"" + legacyToken.ToString(
                System.Globalization.CultureInfo.InvariantCulture
            ) +
                "|struct|1||closed\")]\n" +
                declarations,
            "legacy5296",
            reference
        )
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import legacy5296
let bad = Legacy{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,11,2,17): error GS0267:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let consumer = fixture.Compile(`import legacy5296
import System
let empty = Foreign{}
let supplied = Foreign{X: 9}
let ordinary = Foreign(3)
Console.WriteLine(empty.X.ToString() + "/" + empty.Y.ToString())
Console.WriteLine(supplied.X.ToString() + "/" + supplied.Y.ToString())
Console.WriteLine(ordinary.X.ToString() + "/" + ordinary.Y.ToString())
Console.WriteLine(Authored{}.X)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("0/0\n9/0\n3/3\n8\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_ProjectionCopyAndNestedZeroPhases(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package storage5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Child {
    public var X int32 = Effects.Mark("N", 7)
    public var Items []int32
}
public data struct Target {
    public var A int32
    public var B int32
    public var X int32 = Effects.Mark("D", 7)
    public var Nested Child
}
public data struct Positional(A int32) {
    public var X int32 = Effects.Mark("D", 7)
}`, "storage5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import storage5296
import System
data struct Source {
    public var A int32
    public var B int32
    public var X int32
    public var Nested Child
}
let source = Source{A: 3, X: 7}
let first Target = source
Console.WriteLine(Effects.Trace + ":" + first.A.ToString() + "/" + first.X.ToString() + "/" + first.Nested.X.ToString() + "/" + first.Nested.Items.Length.ToString())
Effects.Trace = ""
let second = Target{...source, X: Effects.Mark("E", 9), B: Effects.Mark("B", 2)}
Console.WriteLine(Effects.Trace + ":" + second.A.ToString() + "/" + second.X.ToString() + "/" + second.B.ToString())
Effects.Trace = ""
let third Positional = source
Console.WriteLine(Effects.Trace + ":" + third.A.ToString() + "/" + third.X.ToString())
Effects.Trace = ""
let copied = first with{X = Effects.Mark("E", 8)}
let copiedAgain = first.copy(X: Effects.Mark("C", 9))
Console.WriteLine(Effects.Trace + ":" + copied.X.ToString() + "/" + copiedAgain.X.ToString() + "/" + first.X.ToString())
Effects.Trace = ""
var bare Target
let raw = default(Target)
let array = [1]Target{}
Console.WriteLine(bare.X.ToString() + "/" + bare.Nested.X.ToString() + "/" + bare.Nested.Items.Length.ToString())
Console.WriteLine(raw.X.ToString() + "/" + array[0].X.ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("D:3/7/0/0\nDEB:3/9/2\nD:3/7\nEC:8/9/7\n0/0/0\n0/0:\n"),
            fixture.RunBytes(consumer)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_PrimaryConstructorsDoNotExportLiteralInitializers(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296primary
public class Effects {
    shared {
        public var Trace string = ""
        public func Next(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct EmptyPrimary() {
    public var X int32 = Effects.Next("I", 1)
}
public data struct Primary(Seed int32 = 0) {
    public var X int32 = Effects.Next("I", 1)
}
public data struct NonPrimary {
    public var X int32 = Effects.Next("I", 1)
}`, "i5296primary", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import System
import i5296primary
data struct LocalPrimary() {
    public var X int32 = Effects.Next("I", 1)
}
data struct LocalNonPrimary {
    public var X int32 = Effects.Next("I", 1)
}
let local = LocalPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + local.X.ToString())
Effects.Trace = ""
let imported = EmptyPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.X.ToString())
Effects.Trace = ""
Console.WriteLine(LocalPrimary{}.X)
Console.WriteLine(Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary().X)
Console.WriteLine(Effects.Trace)
Effects.Trace = ""
let localNonPrimary = LocalNonPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + localNonPrimary.X.ToString())
Effects.Trace = ""
let importedNonPrimary = NonPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + importedNonPrimary.X.ToString())
Effects.Trace = ""
Console.WriteLine(NonPrimary{}.X)
Console.WriteLine(Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("IE:9\nIE:9\n1\nI\n1\nI\nIE:9\nIE:9\n1\nI\n"),
            fixture.RunBytes(consumer)
        )
        let assembly = EmittedFixture.Load(producer)
        for name in[]string{"EmptyPrimary", "Primary"} {
            let type = assembly.GetType("i5296primary." + name, throwOnError: true)
            Assert.Null(type!!.GetNestedType("<>FieldInitializers", BindingFlags.Public))
        }
        let nonPrimary = assembly.GetType("i5296primary.NonPrimary", throwOnError: true)
        Assert.Null(nonPrimary!!.GetNestedType("<>FieldInitializers", BindingFlags.Public))
        AssertOrdinaryConstructorMetadata(producer, "NonPrimary")
        AssertOrdinaryConstructorMetadata(reference, "NonPrimary")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_NestedReadonlyCollectionDiagnosticsRetainConsumerAnchors(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296anchors
public data struct ReadonlyItems {
    public let Items []int32
    private var Marker int32 = 0
    public func Count() int32 -> Marker + Items.Length
}
public data struct Outer {
    public var Child ReadonlyItems
}
public data struct MutableItems {
    public var Items []int32
}
public data struct MutableOuter {
    public var Child MutableItems
}`, "i5296anchors", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import i5296anchors
class Holder {
    public var Value Outer
}
let first = Holder{}
let second = Holder{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        for location in[]string{"(3,5,3,27)", "(5,13,5,19)", "(6,14,6,20)"} {
            Assert.True(output.Contains("rejected.gs" + location + ": error GS0127:", StringComparison.Ordinal), output)
        }
        Assert.Equal(3, output.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let consumer = fixture.Compile(`import i5296anchors
System.Console.WriteLine(Outer{}.Child.Count())
class Holder {
    public var Value MutableOuter = MutableOuter{}
}
let omitted = Holder{}
System.Console.WriteLine(omitted.Value.Child.Items.Length)
let supplied = Holder{Value: MutableOuter{Child: MutableItems{Items: []int32{1, 2}}}}
System.Console.WriteLine(supplied.Value.Child.Items.Length)`, "control", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("0\n0\n2\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ReadonlyProjectionUsesOwningConstructor(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296projection
public data struct Target {
    public var A int32
    public let X int32 = 7
}
public data struct Mutable {
    public var A int32
    public var X int32 = 7
}`, "i5296projection", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let projected = fixture.Compile(`import i5296projection
data struct Source { public var A int32 }
let source = Source{A: 3}
let target Target = source
System.Console.WriteLine(target.A)
System.Console.WriteLine(target.X)`, "projected", executable: true, "/r:" + selected)
        IlVerifier.Verify(projected, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("3\n7\n"), fixture.RunBytes(projected))
        AssertConstructorStores(projected, "i5296projection", "Target", "X")
        let consumer = fixture.Compile(`import i5296projection
data struct Source {
    public var A int32
    public var X int32
}
let source = Source{A: 3, X: 9}
let target Mutable = source
System.Console.WriteLine(target.A)
System.Console.WriteLine(target.X)
System.Console.WriteLine(default(Target).X)`, "control", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("3\n9\n0\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_FriendMixedInitializerSeedsInternalCollection(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296friend
@assembly:InternalsVisibleTo("FriendConsumer")
public class Effects {
    shared {
        public var Trace string = ""
        public func ExplicitItems() []int32 {
            Trace = Trace + "E"
            return []int32{8, 9, 10}
        }
    }
}
public data struct Basket {
    public var Tag int32
    internal var Items []int32
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}`, "i5296friend", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let imported = EmittedFixture.Load(File.ReadAllBytes(producer), fixture.Directory).GetType("i5296friend.Basket")
        let field = imported!!.GetField("Items", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        Assert.True(field!!.IsAssembly)
        Assert.Null(imported!!.GetField("Items", BindingFlags.Instance | BindingFlags.Public))
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import System
import i5296friend
data struct LocalBasket {
    public var Tag int32
    internal var Items []int32
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}
let local = LocalBasket{Tag: 0, 1, Items: Effects.ExplicitItems()}
Console.WriteLine(Effects.Trace + ":" + local.Tag.ToString() + "," + local.Items.Length.ToString())
Effects.Trace = ""
let imported = Basket{Tag: 0, 1, Items: Effects.ExplicitItems()}
Console.WriteLine(Effects.Trace + ":" + imported.Tag.ToString() + "," + imported.Items.Length.ToString())`, "FriendConsumer", executable: true, "/assemblyname:FriendConsumer", "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("AE:1,3\nAE:1,3\n"),
            System.Text.Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
        let (code, output) = fixture.TryCompile(`import i5296friend
let value = Basket{Items: []int32{}}`, "NonFriend", executable: true, "/assemblyname:NonFriend", "/r:" + selected)
        Assert.True(code != 0, output)
        Assert.Contains("NonFriend.gs(2,20,2,25): error GS0158:", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "NonFriend.dll")))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ReadonlyInitializerRejectsExternalWrites(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296readonly
public data struct Readonly {
    public let X int32 = 7
}`, "i5296readonly", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import i5296readonly
System.Console.WriteLine(Readonly{}.X)
System.Console.WriteLine(default(Readonly).X)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("7\n0\n"), fixture.RunBytes(consumer))
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import i5296readonly
let value = Readonly{X: 9}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,22,2,23): error GS0127:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Fact
    func ImportedDataStruct_MixedInitializersUseConstructorDefaultsBeforeOrderedPopulation() {
        const expression = "Basket{Tag: 0, 1, Items: Effects.ExplicitItems()}"
        const library = `package i5296mixed
public class Effects {
    shared {
        public var Trace string = ""
        public func DefaultItems() []int32 {
            Trace = Trace + "D"
            return []int32{10, 11}
        }
        public func ExplicitItems() []int32 {
            Trace = Trace + "E"
            return []int32{8, 9, 10}
        }
    }
}
public data struct Basket {
    public var Tag int32
    public var Items []int32 = Effects.DefaultItems()
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}`
        let source = `import System
import i5296mixed
data struct LocalBasket {
    public var Tag int32
    public var Items []int32 = Effects.DefaultItems()
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}
let local = ` + expression.Replace("Basket", "LocalBasket", StringComparison.Ordinal) + `
Console.WriteLine(Effects.Trace + ":" + local.Tag.ToString() + "," + local.Items.Length.ToString())
Effects.Trace = ""
let imported = ` + expression + `
Console.WriteLine(Effects.Trace + ":" + imported.Tag.ToString() + "," + imported.Items.Length.ToString())`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("DAE:3,3\nDAE:3,3\n"),
            CompileAndRunExact(source, library, "i5296mixed")
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ConstantInitializerUsesOrdinaryStaticConstructor(throws bool) {
        let initialization = if throws {
            `System.Console.Write("S")
        throw System.InvalidOperationException("expected static initialization")`
        } else {
            `System.Console.Write("S")`
        }
        let members = `public var Value int32 = 1
    shared { init { ` + initialization + ` } }`
        let library = "package i5296static\npublic data struct Imported {\n" + members + "\n}"
        let source = "import i5296static\ndata struct Local {\n" + members + `
}
try {
    System.Console.WriteLine(Local{}.Value)
} catch (error System.TypeInitializationException) {
    System.Console.WriteLine(error.InnerException?.Message)
}
try {
    System.Console.WriteLine(Imported{}.Value)
} catch (error System.TypeInitializationException) {
    System.Console.WriteLine(error.InnerException?.Message)
}`
        Assert.Equal(
            System
                .Text
                .Encoding
                .UTF8
                .GetBytes(
                (
                    if throws {
                        "Sexpected static initialization\nSexpected static initialization\n"
                    } else {
                        "S1\nS1\n"
                    }
                )
            ),
            CompileAndRunExact(source, library, "i5296static")
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_OmittedInlineInitializersMatchLocalLiterals(useReferenceAssembly bool) {
        const library = `package i5296defaults
public enum Layout { Stacked, Compact }
public data struct PropertyGrid {
    public var Layout Layout
    public var LabelWidth float64 = 160
}
public data struct SettingsLayoutInput {
    public var SidebarWidth float64 = 180
}`
        const source = `import System
import i5296defaults
data struct LocalGrid {
    public var LabelWidth float64 = 160
}
Console.WriteLine(LocalGrid{}.LabelWidth)
Console.WriteLine(PropertyGrid{Layout: Layout.Compact}.LabelWidth)
Console.WriteLine(SettingsLayoutInput{}.SidebarWidth)
Console.WriteLine(PropertyGrid{Layout: Layout.Compact, LabelWidth: 160}.LabelWidth)`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("160\n160\n180\n160\n"),
            CompileAndRunExact(source, library, "i5296defaults", useReferenceAssembly)
        )
    }

    @Fact
    func ImportedDataStruct_InlineInitializersPreserveOverridesAndEvaluationOrder() {
        const library = `package i5296order
public class Effects {
    shared {
        public var Trace string = ""
        public func Next(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Imported {
    public var A int32 = Effects.Next("A", 1)
    public var B int32 = Effects.Next("B", 2)
    public var C int32 = Effects.Next("C", 3)
}`
        const source = `import System
import i5296order
data struct Local {
    public var A int32 = Effects.Next("A", 1)
    public var B int32 = Effects.Next("B", 2)
    public var C int32 = Effects.Next("C", 3)
}
let local = Local{C: Effects.Next("X", 9)}
Console.WriteLine(Effects.Trace + ":" + local.A.ToString() + "," + local.B.ToString() + "," + local.C.ToString())
Effects.Trace = ""
let imported = Imported{C: Effects.Next("X", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.A.ToString() + "," + imported.B.ToString() + "," + imported.C.ToString())
Effects.Trace = ""
let empty = Imported{}
Console.WriteLine(Effects.Trace + ":" + empty.A.ToString() + "," + empty.B.ToString() + "," + empty.C.ToString())
Effects.Trace = ""
let explicit = Imported{C: Effects.Next("X", 9), B: Effects.Next("Y", 8), A: Effects.Next("Z", 7)}
Console.WriteLine(Effects.Trace + ":" + explicit.A.ToString() + "," + explicit.B.ToString() + "," + explicit.C.ToString())
Effects.Trace = ""
Console.WriteLine(default(Imported).A)
let array = [1]Imported{}
Console.WriteLine(array[0].A)
Console.WriteLine(Effects.Trace.Length)`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("ABCX:1,2,9\nABCX:1,2,9\nABC:1,2,3\nABCXYZ:7,8,9\n0\n0\n0\n"),
            CompileAndRunExact(source, library, "i5296order")
        )
    }

    @Fact
    func ImportedDataStruct_InlineInitializersRetainPrivateCallsAndCollectionValues() {
        const library = `package i5296expressions
public data struct Input {
    public var Values []int32 = []int32{Seed()}
    public var Text string = "seed:${Seed()}"
    shared {
        private func Seed() int32 -> 4
    }
}`
        const source = `import System
import i5296expressions
let input = Input{}
Console.WriteLine(input.Values.Length)
if input.Values.Length != 0 {
    Console.WriteLine(input.Values[0])
}
Console.WriteLine(input.Text)`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("1\n4\nseed:4\n".ReplaceLineEndings(Environment.NewLine)),
            System.Text.Encoding.UTF8.GetBytes(CompileAndRun(source, library, "i5296expressions"))
        )
    }

    @Fact
    func PlainStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib1

struct S {
    public var Items []int32
}`
        const source = `package i3329a
import i3329lib1

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib1"))
    }

    @Fact
    func DataStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib2

data struct S {
    public var Items []int32
}`
        const source = `package i3329b
import i3329lib2

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib2"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_MapField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib3

struct S {
    public var M map[string, int32]
}`
        const source = `package i3329c
import i3329lib3

func Main() {
    let s = S{}
    System.Console.WriteLine(s.M.Count)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib3"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_SequenceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib4

struct S {
    public var Seq sequence[int32]
}`
        const source = `package i3329d
import i3329lib4

func Main() {
    let s = S{}
    var n = 0
    for x in s.Seq {
        n = n + 1
    }
    System.Console.WriteLine(n)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib4"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_FixedArrayField_ZeroInitializesToDeclaredLength() {
        const library = `package i3329lib5

struct S {
    public var Buf [4]int32
}`
        const source = `package i3329e
import i3329lib5

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Buf.Length)
}`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source, library, "i3329lib5"))
    }

    @Fact
    func PlainStruct_LiteralWithExplicitFieldInitializer_MagicCollectionFieldStillZeroInits() {
        // The literal explicitly sets ONE field; the OTHER (magic-collection)
        // field is left unset and must still get its sound zero value.
        const library = `package i3329lib6

struct S {
    public var X int32
    public var Items []int32
}`
        const source = `package i3329f
import i3329lib6

func Main() {
    let s = S{X: 7}
    System.Console.WriteLine(s.X.ToString() + "," + s.Items.Length.ToString())
}`
        Assert.Equal("7,0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib6"))
    }

    @Fact
    func NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralWithExplicitInnerWorks() {
        // Issue #3329 scope note: recursing an OUTER struct literal's own
        // zero-value synthesis INTO an inner struct-typed field that itself
        // needs a magic-collection zero value is issue #3319 (same-assembly
        // recursion — reproduces identically with no library reference at
        // all, confirmed unrelated to #3329's cross-assembly token gap and
        // deliberately left out of this issue's scope). This test instead
        // pins the shape #3329 IS responsible for: an outer struct literal
        // for a type whose nested-struct field is ALSO declared in another
        // assembly, explicitly initialized (not recursively zero-valued).
        const library = `package i3329lib7

struct Inner {
    public var X int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329g
import i3329lib7

func Main() {
    let o = Outer{I: Inner{X: 5}}
    System.Console.WriteLine(o.I.X)
}`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source, library, "i3329lib7"))
    }

    @Fact
    func NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField() {
        // Issue #3329 x #3330 composition: PR #3330 (issue #3319) added
        // SAME-ASSEMBLY recursion so an outer struct literal's own
        // zero-value synthesis walks INTO an inner struct-typed field that
        // itself needs a magic-collection zero value. #3330 postdates this
        // PR's original design (which explicitly scoped that case OUT, see
        // the test above), so this pins the case the two fixes need to get
        // right TOGETHER: `Outer{}` constructed from ANOTHER (consumer)
        // assembly, where `Outer.I Inner` is left unset and `Inner` itself
        // has an unset magic-collection field — the composed zero value must
        // reach all the way through the cross-assembly reconstruction AND
        // the nested-struct recursion.
        const library = `package i3329lib8

struct Inner {
    public var Items []int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329i
import i3329lib8

func Main() {
    let o = Outer{}
    System.Console.WriteLine(o.I.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib8"))
    }

    @Fact
    func DataStructNestedInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField() {
        // Same composed shape as above, but the INNER struct is a `data
        // struct` (routes through ImportedTypeSymbol.BuildSemanticAggregate
        // on reconstruction, rather than ExpressionBinder.
        // BindImportedTypeObjectInitializer's plain-struct fallback) —
        // confirms the composition holds on both cross-assembly
        // reconstruction paths, not just the plain-struct one.
        const library = `package i3329lib9

data struct Inner {
    public var Items []int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329j
import i3329lib9

func Main() {
    let o = Outer{}
    System.Console.WriteLine(o.I.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib9"))
    }

    @Fact
    func SameAssembly_StructLiteral_SliceField_RegressionPin() {
        // Control: a same-compilation struct literal must keep working
        // exactly as before (no library reference at all).
        const source = `package i3329h

struct S {
    public var Items []int32
}

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainStruct_MixedCompositeInitializerAddTouchesOmittedField_ZeroInitBeforeOrderedAdd() {
        // ADR-0180 reviewer finding: the ordered content-element/spread Add(...)
        // calls a mixed composite initializer lowers to (Basket{ Touches: 0, 1, 2,
        // ...extra }) must not run before this struct's own #3329/ADR-0159
        // magic-collection zero-value reconstruction — otherwise Add's own body,
        // which reads the omitted `Items` slice field, observes the raw (unsound)
        // CLR null instead of a zero-initialized empty slice and NREs on the very
        // first Add.
        const library = `package i3785lib1

struct Basket {
    public var Items []int32
    public var Touches int32
    func Add(item int32) {
        Touches = Touches + Items.Length + item
    }
}`
        const source = `package i3785a
import System.Collections.Generic
import i3785lib1

func Main() {
    let extra = List[int32]{ 3, 4 }
    let b = Basket{ Touches: 0, 1, 2, ...extra }
    System.Console.WriteLine(b.Touches)
    System.Console.WriteLine(b.Items.Length)
}`
        Assert.Equal("10${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source, library, "i3785lib1"))
    }

    @Theory
    @InlineData("", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("data ", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("", "Basket(){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("data ", "Basket(){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"last\": 3 } }")
    func MixedInitializer_LaterExplicitMagicFieldsAreSoundBeforeAdd(modifier string, initializer string) {
        let library = (`package i3785later
` + "$modifier" + `struct Basket {
    public var Items []int32
    public var Counts map[string, int32]
    public var Touches int32
    func Add(item int32) {
        Touches = Touches + Items.Length + Counts.Count + item
    }
}`)
        let source = (`import i3785later
let value = ` + "$initializer" + `
System.Console.WriteLine(value.Touches)
System.Console.WriteLine(value.Items.Length)
System.Console.WriteLine(value.Counts.Count)`)
        Assert.Equal(
            "1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(source, library, "i3785later")
        )
    }

    shared {
        private func CompileAndRunExact(
            source string,
            library string,
            libraryName string,
            useReferenceAssembly bool = false
        )[]uint8 {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
            let producer = fixture.Compile(library, libraryName, executable: false, "/refout:" + reference)
            IlVerifier.Verify(producer)
            let consumer = fixture.Compile(
                source,
                "consumer",
                executable: true,
                "/r:" +
                    (
                    if useReferenceAssembly {
                        reference
                    } else {
                        producer
                    }
                )
            )
            IlVerifier.Verify(consumer, []string{producer})
            return fixture.RunBytes(consumer)
        }

        private func AssertOrdinaryConstructorMetadata(path string, typeName string) {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            Assert.NotEmpty(reader.TypeDefinitions)
            for handle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(handle)
                Assert.NotEqual("<>FieldInitializers", reader.GetString(type.Name))
                for methodHandle in type.GetMethods() {
                    Assert.False(
                        reader.GetString(reader.GetMethodDefinition(methodHandle).Name).StartsWith(
                            "<>fieldInitializer$",
                            StringComparison.Ordinal
                        )
                    )
                }
            }
            let target = reader.GetTypeDefinition(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == typeName
                )
            )
            let constructors = target
                .GetMethods()
                .Select((handle MethodDefinitionHandle) -> reader.GetMethodDefinition(handle))
                .Where(
                (method MethodDefinition) -> reader.GetString(method.Name) == ".ctor" &&
                    (method.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public
            )
                .Where(
                (method MethodDefinition) -> {
                    var signature = reader.GetBlobReader(method.Signature)
                    signature.ReadSignatureHeader()
                    return signature.ReadCompressedInteger() == 0
                }
            )
                .ToArray()
            Assert.Single(constructors)
        }

        private func AssertConstructorStores(path string, ns string, typeName string, readonlyField string) {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            var constructorCalls = 0
            for handle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(handle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let bytes = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()!!
                for instruction in IlInstructionReader.Read(bytes) {
                    if instruction.OpCode != OpCodes.Newobj && instruction.OpCode != OpCodes.Stfld {
                        continue
                    }
                    let token = BitConverter.ToInt32(bytes, instruction.Offset + instruction.OpCode.Size)
                    let target = MetadataTokens.EntityHandle(token)
                    if target.Kind != HandleKind.MemberReference {
                        continue
                    }
                    let member = reader.GetMemberReference(cast[MemberReferenceHandle](target))
                    if member.Parent.Kind != HandleKind.TypeReference {
                        continue
                    }
                    let owner = reader.GetTypeReference(cast[TypeReferenceHandle](member.Parent))
                    if reader.GetString(owner.Namespace) != ns || reader.GetString(owner.Name) != typeName {
                        continue
                    }
                    if instruction.OpCode == OpCodes.Newobj {
                        Assert.Equal(".ctor", reader.GetString(member.Name))
                        var signature = reader.GetBlobReader(member.Signature)
                        signature.ReadSignatureHeader()
                        Assert.Equal(0, signature.ReadCompressedInteger())
                        constructorCalls++
                    } else {
                        Assert.NotEqual(readonlyField, reader.GetString(member.Name))
                    }
                }
            }
            Assert.Equal(1, constructorCalls)
        }

        private func CompileAndRun(
            source string,
            library string? = nil,
            libraryAssemblyName string? = nil,
            useReferenceAssembly bool = false
        ) string {
            let tempDir = Directory.CreateDirectory(
                Path.Combine(AppContext.BaseDirectory, "gs_3329_" + Guid.NewGuid().ToString("N"))
            )
                .FullName
            try {
                let dllPath = BuildExecutable(
                    tempDir,
                    source,
                    library,
                    libraryAssemblyName,
                    out var libDll,
                    useReferenceAssembly
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }

        private func BuildExecutable(
            tempDir string,
            source string,
            library string?,
            libraryAssemblyName string?,
            out libDll string?,
            useReferenceAssembly bool
        ) string {
            libDll = nil
            var libReference string? = nil
            if library != nil {
                // ilverify resolves `-r` references by FILE NAME, so the library
                // must be written out under its assembly identity.
                let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                File.WriteAllText(libSrc, library)
                let libraryArgs = List[string]{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc}
                if useReferenceAssembly {
                    libReference = Path.Combine(
                        Directory.CreateDirectory(Path.Combine(tempDir, "ref")).FullName,
                        libraryAssemblyName + ".dll"
                    )
                    libraryArgs.Add("/refout:" + libReference)
                }
                Compile(libraryArgs.ToArray())
                IlVerifier.Verify(libDll!!)
            }
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
            if libDll != nil {
                args.Add("/r:" + (libReference ?? libDll))
            }
            args.Add(srcPath)
            Compile(args.ToArray())
            return dllPath
        }

        private func Compile(args[]string) {
            let result = TryCompile(args)
            Assert.True(result.Code == 0, result.Output)
        }

        private func TryCompile(args[]string)(Code int32, Output string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
