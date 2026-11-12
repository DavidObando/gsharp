package Cs2Gs.Tests

import Xunit

class Issue5951SourceMaybeNullReturnTests {
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
