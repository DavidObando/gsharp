// <copyright file="Issue5435ImportedRecordProjectionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.IO
import System.Text
import Xunit

class Issue5435ImportedRecordProjectionEmitTests {
    @Theory
    @InlineData(false, "ScalarBox{...Source{Value: 7}}")
    @InlineData(true, "ScalarBox{...Source{Value: 7}}")
    @InlineData(false, "cast[GenericBox[int32]](Source{Value: 7})")
    @InlineData(true, "cast[GenericBox[int32]](Source{Value: 7})")
    func ImportedRecordProjection_PreservesOptionalDefault(referenceAssembly bool, expression string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ProjectionGap5419.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace ProjectionGap5419;
public record ScalarBox(int Value, int Extra = 9);
public record GenericBox<T>(int Value, int Extra = 9);
`, "ProjectionGap5419", reference)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import ProjectionGap5419
struct Source { public var Value int32 }
let value = EXPRESSION
System.Console.WriteLine(value.Value)
System.Console.WriteLine(value.Extra)
System.Console.WriteLine(ScalarBox(11).Extra)
`.Replace(
                "EXPRESSION",
                expression,
                StringComparison.Ordinal
            ), "OptionalProjection", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal(ConsoleBytes("7\n9\n9\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedRecordProjection_UsesExactPrimaryOwnerAcrossPlannerRoutes(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ProjectionEffects5435.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`#nullable enable
namespace ProjectionEffects5435;
public record Base {
    public int Value;
}
public record Box<T> : Base {
    public Box(string Value, int Extra = 9) =>
        throw new System.InvalidOperationException("not primary");
    public Box(T Value, int Extra = 9) {
        System.Console.WriteLine("constructor");
        this.Value = Value;
        this.Extra = Extra;
    }
    public new T Value { get; init; }
    public int Extra { get; init; }
    private int tail;
    public int Tail {
        get => tail;
        set { System.Console.WriteLine("set-tail"); tail = value; }
    }
}
public sealed class Source<T> {
    private readonly T value;
    public Source(T value) {
        System.Console.WriteLine("source");
        this.value = value;
    }
    public T Value {
        get { System.Console.WriteLine("get-value"); return value; }
    }
    public int Tail {
        get { System.Console.WriteLine("get-tail"); return 2; }
    }
}
public static class Read {
    public static T Primary<T>(Box<T> box) => box.Value;
    public static int Base<T>(Box<T> box) => ((Base)box).Value;
    public static Box<string> Accept(Box<string> box) => box;
}
`, "ProjectionEffects5435", reference)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import ProjectionEffects5435
func Input() Source[string] {
    return Source[string]("payload")
}
func Override() string {
    Console.WriteLine("override")
    return "override"
}
func Tail() int32 {
    Console.WriteLine("tail")
    return 3
}
func Print(value Box[string]) {
    Console.WriteLine(Read.Primary(value))
    Console.WriteLine(Read.Base(value))
    Console.WriteLine(value.GetType() == typeof(Box[string]))
    Console.WriteLine(value.Extra)
    Console.WriteLine(value.Tail)
}
Print(Box[string]{...Input()})
Print(cast[Box[string]](Input()))
let implicit Box[string] = Input()
Print(implicit)
Print(Input())
Print(Read.Accept(cast[Box[string]](Input())))
Print(Box[string]{...Input(), Tail: Tail(), Value: Override()})
`, "ProjectionRoutes", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        let projected = "source\nget-value\nconstructor\nget-tail\nset-tail\npayload\n0\nTrue\n9\n2\n"
        let overridden = "source\noverride\nconstructor\ntail\nset-tail\noverride\n0\nTrue\n9\n3\n"
        Assert.Equal(
            ConsoleBytes(projected + projected + projected + projected + projected + overridden),
            fixture.RunBytes(dll)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedRecordProjection_RejectsMissingRequiredSlotWithoutOutputs(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "RequiredProjection.ref.dll")
        let contract = fixture.CompileCSharpWithReference(
            "namespace RequiredProjection; public record ScalarBox(int Value, int Extra = 9);",
            "RequiredProjection",
            reference
        )
        IlVerifier.Verify(contract)
        let referenceOutput = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(`import RequiredProjection
struct Source { public var Other int32 }
let value = ScalarBox{...Source{Other: 7}}
`, "Rejected", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            }, "/refout:" + referenceOutput, "/debug:portable", "/pdb:" + pdb)
        Assert.Equal(1, code)
        Assert.Contains("Rejected.gs(3,26,3,42): error GS0490:", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(referenceOutput))
        Assert.False(File.Exists(pdb))
    }

    private func ConsoleBytes(value string)[]uint8 {
        return Encoding.UTF8.GetBytes(value.Replace("\n", Environment.NewLine, StringComparison.Ordinal))
    }
}
