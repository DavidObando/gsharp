// <copyright file="Issue5436ImportedMemberHidingEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.IO
import System.Text
import Xunit

class Issue5436ImportedMemberHidingEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedMembers_SelectNearestDeclarationAcrossKinds(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "MemberGap5436.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace MemberGap5436;
public record Base { public int Value; }
public record Box<T>(T Value) : Base {
    public new T Value { get; init; } = Value;
}
public record Mutable<T> : Base {
    public Mutable(T value) { Value = value; }
    public new T Value { get; set; }
}
public class PlainBase { public int Value; }
public class PlainMiddle<T> : PlainBase {
    public PlainMiddle(T value) { Value = value; }
    public new T Value { get; set; }
}
public class Plain<T> : PlainMiddle<T> {
    public Plain(T value) : base(value) { }
}
public record PropertyBase { public int Value { get; set; } = 31; }
public record FieldMiddle : PropertyBase { public new int Value = 41; }
public record FieldLeaf : FieldMiddle;
public static class Read {
    public static T Primary<T>(Box<T> box) => box.Value;
    public static int Base(Base box) => box.Value;
    public static int PlainBase(PlainBase box) => box.Value;
    public static int PropertyBase(PropertyBase box) => box.Value;
}
`, "MemberGap5436", reference)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import MemberGap5436
func Print(value Box[int32]) { System.Console.WriteLine(value.Value) }
func Generic[T](value Box[T]) T { return value.Value }
let value = Box[int32](7)
System.Console.WriteLine(Read.Primary(value))
System.Console.WriteLine(value.Value)
Print(value)
System.Console.WriteLine(Generic(value))
System.Console.WriteLine(value is { Value: 7 })
let baseValue Base = value
System.Console.WriteLine(baseValue.Value)
let mutable = Mutable[int32](11)
mutable.Value = 13
System.Console.WriteLine(mutable.Value)
System.Console.WriteLine(Read.Base(mutable))
let plain = Plain[int32](17)
plain.Value = 19
System.Console.WriteLine(plain.Value)
System.Console.WriteLine(Read.PlainBase(plain))
let field = FieldLeaf()
field.Value = 43
System.Console.WriteLine(field.Value)
System.Console.WriteLine(Read.PropertyBase(field))
`, "MemberHiding", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal(ConsoleBytes("7\n7\n7\n7\nTrue\n0\n13\n0\n19\n0\n43\n31\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func GetOnlyProperty_HidesBaseFieldForReadsAndWrites(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ReadOnlyGap5436.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace ReadOnlyGap5436;
public record Base { public int Value; }
public record Derived : Base {
    public new int Value {
        get { System.Console.WriteLine("getter"); return 7; }
    }
}
public static class Factory {
    public static Derived Make() {
        System.Console.WriteLine("receiver");
        return new Derived();
    }
}
`, "ReadOnlyGap5436", reference)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import ReadOnlyGap5436
System.Console.WriteLine(Factory.Make().Value)
`, "ReadOnlyMemberRead", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal(ConsoleBytes("receiver\ngetter\n7\n"), fixture.RunBytes(dll))
        let (code, output) = fixture.TryCompile(`import ReadOnlyGap5436
let value = Derived()
value.Value = 9
`, "RejectedMemberWrite", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        Assert.Equal(1, code)
        Assert.Contains("RejectedMemberWrite.gs(3,13,3,14): error GS0127:", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedMemberWrite.dll")))
    }

    private func ConsoleBytes(value string)[]uint8 {
        return Encoding.UTF8.GetBytes(value.Replace("\n", Environment.NewLine, StringComparison.Ordinal))
    }
}
