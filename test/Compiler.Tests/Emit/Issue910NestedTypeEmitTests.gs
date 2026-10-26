// <copyright file="Issue910NestedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Linq
import System.Reflection
import System.Text
import Xunit.Sdk

/// Issue #910 / ADR-0110: nested type declarations (`class` / `struct`
/// / `interface` / `enum`) inside a `class` or `struct` body
/// must be emitted as real CLR nested types with nested accessibility, be
/// usable from the enclosing type's members, pass ilverify, and execute.
open class Issue910NestedTypeEmitTests {
    @Fact
    func NestedTypeReadsEnclosingPrivateSharedFieldThroughDriver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `class Enclosing {
    shared { private let Expected int32 = 1 }

    private class Nested {
        func Read() int32 -> Expected
    }
}`
        let library = fixture.Compile(source, "Exact5262", false)
        IlVerifier.Verify(library)
        let executable = fixture.Compile(
            source.Replace(
                "    private class Nested {",
                "    func Run() int32 -> Nested().Read()\n    private class Nested {"
            ) +
                "\nSystem.Console.Write(Enclosing().Run())",
            "Read5262",
            true
        )
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("1"), fixture.RunBytes(executable))
    }

    @Fact
    func NestedSharedFieldWritesKeepNearestLexicalOwnerAndShadowing() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package Lexical5262
import System
class Outer {
    shared { var Value int32 = 100 }
    class Middle {
        shared { var Value int32 = 10 }
        class Leaf {
            shared {
                func Bump() int32 {
                    Value += 2
                    return Value++
                }
            }
            func Read() int32 -> Value
            func Parameter(Value int32) int32 -> Value
        }
        class Own {
            var Value int32 = 20
            func Read() int32 -> Value
        }
        func Run() {
            Console.Write(Leaf.Bump())
            Console.Write("|")
            Console.Write(Leaf().Read())
            Console.Write("|")
            Console.Write(Value)
            Console.Write("|")
            Console.Write(Leaf().Parameter(30))
            Console.Write("|")
            Console.Write(Own().Read())
        }
    }
    func Run() {
        Middle().Run()
        Console.Write("|")
        Console.Write(Value)
    }
}
Outer().Run()`, "Write5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("12|13|13|30|20|100"), fixture.RunBytes(executable))
    }

    @Fact
    func LexicalInstanceFieldsHideOuterSharedFieldsWithoutAnOuterReceiver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`class Far {
    shared { let Hidden int32 = 1 }
    class Near {
        var Hidden int32 = 2
        class Child {
            func Read() int32 -> Hidden
        }
    }
    class Same {
        var Hidden int32 = 3
        shared { func Read() int32 -> Hidden }
    }
}`, "Rejected5262", false)
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected5262.gs(6,34,6,40): error GS0125", output)
        Assert.Contains("Rejected5262.gs(11,39,11,45): error GS0125", output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected5262.dll")))
    }

    @Fact
    func LexicalEventSubscriptionsCallDeclaringAccessorsInEvaluationOrder() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package Events5262
import System
class Hub {
    shared {
        event Ticked Action?
        func Raise() { Ticked?() }
        func Stamp(handler Action) Action {
            Console.Write("S")
            return handler
        }
    }
    class Subscriber {
        func Adjust(handler Action) {
            Ticked += Hub.Stamp(handler)
            Ticked += Hub.Stamp(handler)
            Hub.Raise()
            Ticked -= Hub.Stamp(handler)
            Hub.Raise()
        }
    }
    func Run() { Subscriber().Adjust(func() { Console.Write("H") }) }
}
Hub().Run()`, "Events5262", true)
        IlVerifier.Verify(executable)
        let assembly = Assembly.Load(File.ReadAllBytes(executable))
        let subscriber = assembly.GetType("Events5262.Hub+Subscriber")!!
        let adjust = subscriber.GetMethod("Adjust")!!
        let accessors = List[string]()
        for instruction in IlInstructionReader.Read(adjust.GetMethodBody()!!.GetILAsByteArray()) {
            if instruction.MetadataToken is {} token {
                let called = adjust.Module.ResolveMethod(token)!!
                if called.Name == "add_Ticked" || called.Name == "remove_Ticked" {
                    accessors.Add(called.DeclaringType!!.FullName + "." + called.Name)
                }
            }
        }
        Assert.Equal(
            []string{"Events5262.Hub.add_Ticked", "Events5262.Hub.add_Ticked", "Events5262.Hub.remove_Ticked"},
            accessors.ToArray()
        )
        Assert.Equal(Encoding.UTF8.GetBytes("SSHHSH"), fixture.RunBytes(executable))
    }

    @Fact
    func InheritedClrMembersHideLexicalStateWithoutChangingItsStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace Foreign5262 {
public class MutableBase {
    public int Value { get; set; } = 5;
    public int Field = 7;
    private int Hidden = 9;
}
}`, "Foreign5262")
        let executable = fixture.Compile(`package Imported5262
import System
class Outer {
    shared {
        var Message string = "outer"
        var Value int32 = 100
        var Field int32 = 200
        var Hidden int32 = 300
    }
    class Error : Exception {
        init() : base("inner") { }
        func Read() string -> Message
    }
    class Mutable : Foreign5262.MutableBase {
        func Update() {
            Value += 2
            Field = Field + 1
            Console.Write(Value)
            Console.Write("|")
            Console.Write(Field)
            Console.Write("|")
            Console.Write(Hidden)
        }
    }
    func Run() {
        Console.Write(Error().Read())
        Console.Write("|")
        Console.Write(Message)
        Console.Write("|")
        Mutable().Update()
        Console.Write("|")
        Console.Write(Value)
        Console.Write("|")
        Console.Write(Field)
    }
}
Outer().Run()`, "Imported5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("inner|outer|7|8|300|100|200"), fixture.RunBytes(executable))
    }

    @Fact
    func NearerInstanceSharedAndInheritedMethodsHideOuterCallbacks() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package Methods5262
import System
open class Base { func Read() int32 -> 4 }
class Outer {
    shared { let Read () -> int32 = func() int32 { return 1 } }
    class Instance {
        func Read() int32 -> 2
        func Pick() int32 {
            let f () -> int32 = Read
            return f()
        }
    }
    class Static {
        shared {
            func Read() int32 -> 3
            func Pick() int32 {
                let f () -> int32 = Read
                return f()
            }
        }
    }
    class Derived : Base {
        func Pick() int32 {
            let f () -> int32 = Read
            return f()
        }
    }
    class Fallback {
        func Pick() int32 {
            let f () -> int32 = Read
            return f()
        }
    }
    func Run() {
        Console.Write(Instance().Pick())
        Console.Write("|")
        Console.Write(Static.Pick())
        Console.Write("|")
        Console.Write(Derived().Pick())
        Console.Write("|")
        Console.Write(Fallback().Pick())
    }
}
Outer().Run()`, "Methods5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("2|3|4|1"), fixture.RunBytes(executable))
    }

    @Fact
    func InheritedStaticsDoNotHideLexicalStateButDeclaredStaticsDo() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ForeignStatics5262;
public class Base {
    public static int Read() => 90;
    public int func() => 80;
}`, "ForeignStatics5262")
        let executable = fixture.Compile(`package StaticVisibility5262
import System
import ForeignStatics5262
open class SourceBase {
    shared {
        let Value int32 = 70
        const Code int32 = 72
    }
}
class Outer {
    shared {
        let Value int32 = 10
        let Code int32 = 12
        let Read () -> int32 = func() int32 { return 11 }
        let func_ () -> int32 = func() int32 { return 81 }
    }
    class FromSource : SourceBase {
        func Pick() int32 -> Value + Code
    }
    class FromClr : Base {
        func Pick() int32 {
            let f () -> int32 = Read
            return f()
        }
        func Call() int32 -> func_()
    }
    class Declared : SourceBase {
        shared {
            let Value int32 = 20
            func Read() int32 -> 21
        }
        func Pick() int32 -> Value
        func Call() int32 {
            let f () -> int32 = Read
            return f()
        }
    }
    func Run() {
        Console.Write(FromSource().Pick())
        Console.Write("|")
        Console.Write(FromClr().Pick())
        Console.Write("|")
        Console.Write(Declared().Pick())
        Console.Write("|")
        Console.Write(Declared().Call())
        Console.Write("|")
        Console.Write(SourceBase.Value)
        Console.Write("|")
        Console.Write(SourceBase.Code)
        Console.Write("|")
        Console.Write(Base.Read())
        Console.Write("|")
        Console.Write(FromClr().Call())
    }
}
Outer().Run()`, "StaticVisibility5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("22|11|20|21|70|72|90|80"), fixture.RunBytes(executable))
    }

    @Fact
    func NestedInterfaceBodiesUseEnclosingSharedStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package InterfaceStorage5262
import System
class Outer {
    shared {
        private let Value int32 = 1
        private var Counter int32 = 0
        prop Total int32 { get; set; }
        private var Changed Action? = func() { Console.Write("C") }
        event Ticked Action?
        func Raise() { Ticked?() }
        func Dump() {
            Console.Write(Counter)
            Console.Write("|")
            Console.Write(Total)
        }
    }
    interface Nested {
        func Read() int32 { return Value }
        func Change(handler Action) {
            Counter += 2
            Total = Counter + Value
            Total += 2
            Changed += handler
            Changed?()
            Changed -= handler
            Ticked += handler
            Outer.Raise()
            Ticked -= handler
            Outer.Raise()
        }
    }
}
class Implementation : Outer.Nested {}
let reader Outer.Nested = Implementation()
Console.Write(reader.Read())
Console.Write("|")
reader.Change(func() { Console.Write("H") })
Console.Write("|")
Outer.Dump()`, "InterfaceStorage5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("1|CHH|2|5"), fixture.RunBytes(executable))
    }

    @Fact
    func NestedInterfacesKeepLocalAndInheritedNamesBeforeEnclosingState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package InterfacePrecedence5262
import System
interface BaseReader { func Read() int32 { return 2 } }
class Outer {
    shared {
        private let Marker int32 = 1
        let Value int32 = 9
        let Read () -> int32 = func() int32 { return 8 }
        let Hidden () -> int32 = func() int32 { return 8 }
        let GetType () -> Type = func() Type { return typeof(string) }
    }
    interface Nested : BaseReader {
        shared { let Value int32 = 3 }
        private func Hidden() int32 { return 5 }
        func Run() {
            Console.Write(Marker)
            Console.Write("|")
            Console.Write(Value)
            Console.Write("|")
            Console.Write(Read())
            Console.Write("|")
            Console.Write(Hidden())
            Console.Write("|")
            Console.Write(GetType().Name)
        }
    }
}
class Implementation : Outer.Nested {}
let reader Outer.Nested = Implementation()
reader.Run()`, "InterfacePrecedence5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("1|3|2|5|Implementation"), fixture.RunBytes(executable))
        let (code, output) = fixture.TryCompile(`class Outer {
    shared { let Read () -> int32 = func() int32 { return 1 } }
    interface Nested {
        func Read(value int32) int32 { return value }
        func Pick() int32 { return Read() }
    }
}`, "InterfaceNameBarrier5262", false)
        Assert.NotEqual(0, code)
        Assert.Contains("InterfaceNameBarrier5262.gs(5,36,5,42): error GS0144:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InterfaceNameBarrier5262.dll")))
    }

    @Fact
    func InheritedClrInterfaceCallsBeatEnclosingCallbacks() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`import System
class Outer {
    shared { let Dispose Action = func() { Console.Write("O") } }
    interface Nested : IDisposable { func Run() { Dispose() } }
}
class Implementation : Outer.Nested { func Dispose() { Console.Write("D") } }
let reader Outer.Nested = Implementation()
reader.Run()
Outer.Dispose()`, "InheritedInterfaceCall5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("DO"), fixture.RunBytes(executable))
    }

    @Fact
    func TransitiveGenericClrInterfaceCallsMatchQualifiedDispatch() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedInterfaces5262;
public interface IReader<T> { T Read(); }
public interface ITransitive<T> : IReader<T> { }`, "ImportedInterfaces5262")
        let executable = fixture.Compile(`import System
import ImportedInterfaces5262
class Outer {
    shared { let Read () -> int32 = func() int32 { return 99 } }
    interface Nested : ITransitive[int32] {
        func Bare() int32 { return Read() }
        func Qualified() int32 { return this.Read() }
    }
}
class Implementation : Outer.Nested { func Read() int32 { return 42 } }
let reader Outer.Nested = Implementation()
Console.Write(reader.Qualified())
Console.Write("|")
Console.Write(reader.Bare())`, "GenericInterfaceCall5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("42|42"), fixture.RunBytes(executable))
    }

    @Fact
    func InheritedClrInterfacePropertiesPrecedeEnclosingSharedFields() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedProperties5262;
public interface IValue { int Value { get; set; } }
public interface IDerived : IValue { }`, "ImportedProperties5262")
        let executable = fixture.Compile(`import System
import ImportedProperties5262
class Outer {
    shared { var Value int32 = 1 }
    interface Nested : IDerived {
        func Bare() int32 { return Value }
        func Qualified() int32 { return this.Value }
        func Chained() string { return Value.ToString() }
    }
    func Read() int32 -> Value
}
class Implementation : Outer.Nested {
    var stored int32 = 2
    prop Value int32 {
        get -> stored
        set { stored = value }
    }
}
let item Outer.Nested = Implementation()
Console.Write(item.Qualified())
Console.Write("|")
Console.Write(item.Bare())
Console.Write("|")
Console.Write(item.Chained())
Console.Write("|")
Console.Write(Outer().Read())`, "ImportedProperty5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("2|2|2|1"), fixture.RunBytes(executable))
    }

    @Fact
    func UnsupportedImportedInterfacePropertyWritesCannotMutateEnclosingFields() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedProperties5262;
public interface IValue { int Value { get; set; } }`, "ImportedProperties5262")
        let (code, output) = fixture.TryCompile(`import ImportedProperties5262
class Outer {
    shared { var Value int32 = 1 }
    interface Nested : IValue {
        func Write() { Value = 4 }
        func Compound() { Value += 4 }
    }
}`, "RejectedImportedProperty5262", false, "/r:" + contract)
        Assert.NotEqual(0, code)
        Assert.Contains("RejectedImportedProperty5262.gs(5,24,5,29): error GS0125", output)
        Assert.Contains("RejectedImportedProperty5262.gs(6,27,6,32): error GS0125", output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedImportedProperty5262.dll")))
    }

    @Fact
    func ImportedInterfaceCallsUseCanonicalEscapedNamesAndCollisionRules() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace EscapedMembers5262;
public interface IKeywords {
    int @return() => 2;
    int return_() => 3;
}
public class Keywords {
    public int @return() => 2;
    public int return_() => 3;
}`, "EscapedMembers5262")
        let executable = fixture.Compile(`import System
import EscapedMembers5262
class Outer {
    shared { let return__ () -> int32 = func() int32 { return 1 } }
    interface Nested : IKeywords {
        func Bare() int32 { return return__() }
        func Collision() int32 { return return_() }
    }
}
class Implementation : Outer.Nested {}
let item Outer.Nested = Implementation()
Console.Write(Keywords().return__())
Console.Write("|")
Console.Write(item.Bare())
Console.Write("|")
Console.Write(item.Collision())`, "EscapedInterfaceCall5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("2|2|3"), fixture.RunBytes(executable))
    }

    @Fact
    func ImplicitImportedInterfaceCallsPreserveExplicitClrTypeArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace GenericInterface5262;
public interface IKind { string Kind<T>(T value) => typeof(T).Name; }
public class Reader { public string Kind<T>(T value) => typeof(T).Name; }`, "GenericInterface5262")
        let executable = fixture.Compile(`import System
import GenericInterface5262
class Outer {
    shared { let Kind (object) -> string = func(value object) string { return "Outer" } }
    interface Nested : IKind {
        func Bare() string { return Kind[object]("x") }
        func Qualified() string { return this.Kind[object]("x") }
        func Inferred() string { return Kind("x") }
    }
}
class Implementation : Outer.Nested {}
class ClassControl : Reader {
    func Bare() string { return Kind[object]("x") }
    func Qualified() string { return this.Kind[object]("x") }
}
let reader Outer.Nested = Implementation()
Console.Write(reader.Qualified())
Console.Write("|")
Console.Write(reader.Bare())
Console.Write("|")
Console.Write(reader.Inferred())
Console.Write("|")
Console.Write(ClassControl().Bare())
Console.Write("|")
Console.Write(ClassControl().Qualified())`, "ClrArguments5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("Object|Object|String|Object|Object"), fixture.RunBytes(executable))
    }

    @Fact
    func ImplicitImportedInterfaceCallsPreserveExplicitSymbolicTypeArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace GenericInterface5262;
public interface IKind { string Kind<T>(T value) => typeof(T).Name; }
public class Reader { public string Kind<T>(T value) => typeof(T).Name; }`, "GenericInterface5262")
        let executable = fixture.Compile(`import System
import GenericInterface5262
open class Marker {}
class Derived : Marker {}
class Outer {
    shared { let Kind (object) -> string = func(value object) string { return "Outer" } }
    interface Nested : IKind {
        func Bare(value Derived) string { return Kind[Marker](value) }
        func Qualified(value Derived) string { return this.Kind[Marker](value) }
    }
}
class Implementation : Outer.Nested {}
class ClassControl : Reader {
    func Bare(value Derived) string { return Kind[Marker](value) }
    func Qualified(value Derived) string { return this.Kind[Marker](value) }
}
let reader Outer.Nested = Implementation()
Console.Write(reader.Qualified(Derived()))
Console.Write("|")
Console.Write(reader.Bare(Derived()))
Console.Write("|")
Console.Write(ClassControl().Bare(Derived()))
Console.Write("|")
Console.Write(ClassControl().Qualified(Derived()))`, "SymbolicArguments5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("Marker|Marker|Marker|Marker"), fixture.RunBytes(executable))
    }

    @Fact
    func InheritedStaticInterfacePropertiesDoNotHideEnclosingFields() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`import System
interface Base { shared { prop Value int32 { get { return 9 } } } }
class Outer {
    shared { let Value int32 = 1 }
    interface Nested : Base { func Read() int32 { return Value } }
}
class Implementation : Outer.Nested {}
let reader Outer.Nested = Implementation()
Console.Write(reader.Read())`, "InheritedInterfaceProperty5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("1"), fixture.RunBytes(executable))
    }

    @Fact
    func DeclaredStaticInterfacePropertyDoesNotBecomeAnInstanceReadOrOuterField() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`class Outer {
    shared { let Value int32 = 1 }
    interface Nested {
        shared { prop Value int32 { get { return 3 } } }
        func Read() int32 { return Value }
    }
}`, "DeclaredInterfaceProperty5262", false)
        Assert.NotEqual(0, code)
        Assert.Contains("DeclaredInterfaceProperty5262.gs(5,36,5,41): error GS0125:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "DeclaredInterfaceProperty5262.dll")))
    }

    @Fact
    func SourceExplicitMethodsDoNotHideOuterCallbacksOrOrdinaryPrivateMethods() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package SourceExplicit5262
import System
interface IReader { func Read() int32; }
interface IValue[T] { func Echo(value T) T; }
open class Base : IReader { func (IReader) Read() int32 -> 2 }
class Outer {
    shared {
        let Read () -> int32 = func() int32 { return 1 }
        let Echo (int32) -> int32 = func(value int32) int32 { return value + 10 }
    }
    class Inner : IReader {
        func (IReader) Read() int32 -> 2
        func Pick() int32 -> Read()
    }
    class Generic : IValue[int32] {
        func (IValue[int32]) Echo(value int32) int32 -> value
        func Pick() int32 -> Echo(3)
    }
    class Ordinary : IReader {
        func (IReader) Read() int32 -> 2
        private func Read() int32 -> 4
        func Pick() int32 -> Read()
    }
    class Derived : Base { func Pick() int32 -> Read() }
    func Run() {
        let inner = Inner()
        let reader IReader = inner
        Console.Write(reader.Read())
        Console.Write("|")
        Console.Write(inner.Pick())
        Console.Write("|")
        let generic = Generic()
        let value IValue[int32] = generic
        Console.Write(value.Echo(3))
        Console.Write("|")
        Console.Write(generic.Pick())
        Console.Write("|")
        Console.Write(Ordinary().Pick())
        Console.Write("|")
        Console.Write(Derived().Pick())
    }
}
Outer().Run()`, "SourceExplicit5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("2|1|3|13|4|1"), fixture.RunBytes(executable))
    }

    @Fact
    func SourceExplicitSharedMethodsDoNotHideOuterCallbacks() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package StaticExplicit5262
import System
interface IFactory { shared { func Choose() int32; } }
class Outer {
    shared { let Choose () -> int32 = func() int32 { return 7 } }
    class Inner : IFactory {
        shared {
            func (IFactory) Choose() int32 -> 6
            func Pick() int32 -> Choose()
        }
    }
    func Run() { Console.Write(Inner.Pick()) }
}
Outer().Run()`, "StaticExplicit5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("7"), fixture.RunBytes(executable))
    }

    @Fact
    func ImportedDefaultMethodsHideOuterCallbacksUsingInheritedCallCandidates() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace DefaultMethods5262;
public interface IReader { int Read() => 2; }
public interface ITransitive : IReader { }
public class Reader : ITransitive { }
public interface IValue<T> { T Echo(T value) => value; }
public class GenericReader<T> : IValue<T> { }
public interface IExplicit { int Read(); }
public class ExplicitReader : IExplicit { int IExplicit.Read() => 6; }`, "DefaultMethods5262")
        let executable = fixture.Compile(`package DefaultLookup5262
import System
import DefaultMethods5262
class Plain : Reader { func Pick() int32 -> Read() }
class Outer {
    shared {
        let Read () -> int32 = func() int32 { return 1 }
        let Echo (int32) -> int32 = func(value int32) int32 { return 99 }
    }
    class Inner : Reader { func Pick() int32 -> Read() }
    class Generic : GenericReader[int32] { func Pick() int32 -> Echo(7) }
    class Declared : Reader {
        func Read() int32 -> 3
        func Pick() int32 -> Read()
    }
    class Explicit : ExplicitReader { func Pick() int32 -> Read() }
    class Parameter : Reader { func Pick(Read () -> int32) int32 -> Read() }
    func Run() {
        Console.Write(Inner().Pick())
        Console.Write("|")
        Console.Write(Generic().Pick())
        Console.Write("|")
        Console.Write(Declared().Pick())
        Console.Write("|")
        Console.Write(Explicit().Pick())
        Console.Write("|")
        Console.Write(Parameter().Pick(func() int32 { return 8 }))
    }
}
Console.Write(Plain().Pick())
Console.Write("|")
Outer().Run()`, "DefaultLookup5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(Encoding.UTF8.GetBytes("2|2|7|3|1|8"), fixture.RunBytes(executable))
    }

    @Fact
    func ImportedDefaultMethodsDoNotAcquireAReceiverInSharedBody() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace SharedDefault5262;
public interface IReader { int Read() => 2; }
public class Reader : IReader { }`, "SharedDefault5262")
        let (code, output) = fixture.TryCompile(`import SharedDefault5262
class Outer {
    shared { let Read () -> int32 = func() int32 { return 1 } }
    class Inner : Reader {
        shared { func Pick() int32 -> Read() }
    }
}`, "SharedDefaultLookup5262", false, "/r:" + contract)
        Assert.NotEqual(0, code)
        Assert.Contains("SharedDefaultLookup5262.gs(5,39,5,43): error GS0130:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "SharedDefaultLookup5262.dll")))
    }

    @Fact
    func ImplicitObjectMethodDoesNotAcquireAReceiverInSharedBody() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package ObjectStatic5262
import System
class Outer {
    shared { let GetType Func[Type] = func() Type { return typeof(string) } }
    class Inner {
        shared { func Read() string -> GetType().Name }
    }
}`, "ObjectStatic5262", false)
        Assert.NotEqual(0, code)
        Assert.Contains("ObjectStatic5262.gs(6,40,6,47): error GS0130:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "ObjectStatic5262.dll")))
    }

    @Fact
    func ImplicitObjectMethodsHideOuterCallbacksWithoutHidingUnrelatedState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package ObjectControls5262
import System
open class Base {}
class Plain {
    func Read() string -> GetType().Name
}
class Outer {
    shared {
        private let GetType Func[Type] = func() Type { return typeof(string) }
        private let ToString Func[string] = func() string { return "outer" }
        private let Unique Func[Type] = func() Type { return typeof(int64) }
    }
    class Implicit {
        func Read() string -> GetType().Name
        func TextMatchesType() bool -> ToString() == GetType().FullName
        func ReadOuter() string -> Unique().Name
    }
    class Source : Base {
        func Read() string -> GetType().Name
    }
    class Imported : Exception {
        func Read() string -> GetType().Name
    }
    class Declared {
        func GetType() Type -> typeof(int32)
        func Read() string -> GetType().Name
    }
    func Run() {
        let value = Implicit()
        Console.Write(value.Read())
        Console.Write("|")
        Console.Write(value.TextMatchesType())
        Console.Write("|")
        Console.Write(Source().Read())
        Console.Write("|")
        Console.Write(Imported().Read())
        Console.Write("|")
        Console.Write(Declared().Read())
        Console.Write("|")
        Console.Write(value.ReadOuter())
    }
}
Console.Write(Plain().Read())
Console.Write("|")
Outer().Run()`, "ObjectControls5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(
            Encoding.UTF8.GetBytes("Plain|Implicit|True|Source|Imported|Int32|Int64"),
            fixture.RunBytes(executable)
        )
    }

    @Fact
    func SelectedLexicalDelegateFieldKeepsCompoundWritesAwayFromInheritedEvents() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package SelectedField5262
import System
open class Base {
    shared {
        event Changed Action?
        func Raise() { Changed?() }
    }
}
class EventOnly : Base {
    shared {
        func Adjust(handler Action) {
            Changed += handler
            Base.Raise()
            Changed -= handler
            Base.Raise()
        }
    }
}
class Outer {
    shared {
        var Changed Action? = func() { Console.Write("X") }
        func Stamp(handler Action) Action {
            Console.Write("S")
            return handler
        }
        event Ticked Action?
        func RaiseTicked() { Ticked?() }
    }
    class Nested : Base {
        shared {
            func Reset(handler Action) { Changed = handler }
            func Fire() { Changed?() }
            func Add(handler Action) { Changed += Outer.Stamp(handler) }
            func Remove(handler Action) { Changed -= Outer.Stamp(handler) }
            func EventControl(handler Action) {
                Ticked += handler
                Outer.RaiseTicked()
                Ticked -= handler
                Outer.RaiseTicked()
            }
        }
    }
    func Run() {
        let handler Action = func() { Console.Write("H") }
        let baseHandler Action = func() { Console.Write("B") }
        Base.Changed += baseHandler
        Nested.Reset(func() { Console.Write("O") })
        Nested.Fire()
        Console.Write("|")
        Base.Raise()
        Console.Write("|")
        Nested.Add(handler)
        Nested.Fire()
        Console.Write("|")
        Base.Raise()
        Console.Write("|")
        Nested.Remove(handler)
        Nested.Fire()
        Console.Write("|")
        Base.Raise()
        Console.Write("|")
        Nested.EventControl(handler)
        Console.Write("|")
        EventOnly.Adjust(handler)
        Base.Changed -= baseHandler
    }
}
Outer().Run()`, "SelectedField5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("O|B|SOH|B|SO|B|H|BHB"), fixture.RunBytes(executable))
    }

    @Fact
    func SelectedLexicalDelegatePropertyKeepsCompoundWritesAndAccessorEvaluation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`using System;
namespace ForeignEvents5262;
public class ClrBase
{
    public static event Action? Changed;
    public static void Raise() => Changed?.Invoke();
}`, "ForeignEvents5262")
        let executable = fixture.Compile(`package SelectedProperty5262
import System
import ForeignEvents5262
open class Base {
    shared {
        event Changed Action?
        func Raise() { Changed?() }
    }
}
class Outer[T] {
    shared {
        private var stored Action? = func() { Console.Write("X") }
        prop Changed Action? {
            get {
                Console.Write("G")
                return stored
            }
            set {
                Console.Write("W")
                stored = value
            }
        }
        func Stamp(handler Action) Action {
            Console.Write("S")
            return handler
        }
    }
    class Nested : Base {
        shared {
            func Reset(handler Action) { Changed = handler }
            func Fire() { Changed?() }
            func Add(handler Action) { Changed += Outer[T].Stamp(handler) }
            func Remove(handler Action) { Changed -= Outer[T].Stamp(handler) }
        }
    }
    class Imported : ClrBase {
        shared {
            func Reset(handler Action) { Changed = handler }
            func Fire() { Changed?() }
            func Add(handler Action) { Changed += Outer[T].Stamp(handler) }
            func Remove(handler Action) { Changed -= Outer[T].Stamp(handler) }
        }
    }
    func Run() {
        let handler Action = func() { Console.Write("H") }
        let baseHandler Action = func() { Console.Write("B") }
        Base.Changed += baseHandler
        Nested.Reset(func() { Console.Write("O") })
        Nested.Fire()
        Console.Write("|")
        Base.Raise()
        Console.Write("|")
        Nested.Add(handler)
        Nested.Fire()
        Console.Write("|")
        Base.Raise()
        Console.Write("|")
        Nested.Remove(handler)
        Nested.Fire()
        Console.Write("|")
        Base.Raise()
        Base.Changed -= baseHandler
        Console.Write("|")
        ClrBase.Changed += baseHandler
        Imported.Reset(func() { Console.Write("O") })
        Imported.Fire()
        Console.Write("|")
        ClrBase.Raise()
        Console.Write("|")
        Imported.Add(handler)
        Imported.Fire()
        Console.Write("|")
        ClrBase.Raise()
        Console.Write("|")
        Imported.Remove(handler)
        Imported.Fire()
        Console.Write("|")
        ClrBase.Raise()
        ClrBase.Changed -= baseHandler
    }
}
Outer[int32]().Run()`, "SelectedProperty5262", true, "/r:" + contract)
        IlVerifier.Verify(executable, []string{contract})
        Assert.Equal(
            Encoding.UTF8.GetBytes("WGO|B|GSWGOH|B|GSWGO|B|WGO|B|GSWGOH|B|GSWGO|B"),
            fixture.RunBytes(executable)
        )
    }

    @Fact
    func IssueExample_NestedClassInClass_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package Oahu.Cli.Tests

import System

class Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }

    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func NestedStructInStruct_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

struct Outer {
    struct Inner {
        var X int32
    }
}

func (o Outer) Make() int32 {
    let i = Inner{X: 41}
    return i.X + 1
}

let o = Outer{}
Console.WriteLine(o.Make())`)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NestedStructInClass_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer {
    struct Point {
        var X int32
        var Y int32
    }

    func Sum() int32 {
        let p = Point{X: 3, Y: 4}
        return p.X + p.Y
    }
}

let o = Outer()
Console.WriteLine(o.Sum())`)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func NestedClassInStruct_ConstructedFromEnclosingMethod_Runs() {
        // Issue #910 / ADR-0110: a class nested in a struct is now emitted as a
        // real CLR nested type (the unified emission-order refactor guarantees
        // the enclosing struct TypeDef row precedes the nested class row per
        // ECMA-335 §II.22.32). Construct it from an enclosing method and run.
        let output = CompileAndRun(`package P

import System

struct Outer {
    class Inner {
        func Hello() string {
            return "from-nested-class"
        }
    }
}

func (o Outer) Make() string {
    let i = Inner()
    return i.Hello()
}

let o = Outer{}
Console.WriteLine(o.Make())`)
        Assert.Equal("from-nested-class${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnumInClass_UsedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer {
    enum Color {
        Red,
        Green,
        Blue,
    }

    func Pick() int32 {
        let c = Color.Green
        if c == Color.Green {
            return 1
        }
        return 0
    }
}

let o = Outer()
Console.WriteLine(o.Pick())`)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnumInStruct_UsedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

struct Outer {
    enum Color {
        Red,
        Green,
        Blue,
    }
}

func (o Outer) Pick() int32 {
    let c = Color.Blue
    if c == Color.Blue {
        return 2
    }
    return 0
}

let o = Outer{}
Console.WriteLine(o.Pick())`)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func NestedInterfaceInClass_ImplementedAndCalledThrough_Runs() {
        // Issue #910 / ADR-0110: a nested interface is now emitted as a real
        // CLR nested type. A sibling nested class implements it; an enclosing
        // method upcasts to the interface and dispatches through it.
        let output = CompileAndRun(`package P

import System

class Outer {
    interface IInner {
        func Hello() string;
    }

    class Impl : IInner {
        func Hello() string {
            return "from-nested-interface"
        }
    }

    func Make() string {
        var i IInner = Impl{}
        return i.Hello()
    }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("from-nested-interface${Environment.NewLine}", output)
    }

    @Fact
    func NestedInterfaceInStruct_ImplementedAndCalledThrough_Runs() {
        // Issue #910 / ADR-0110: a nested interface inside a struct is also a
        // real CLR nested type. A sibling nested class implements it.
        let output = CompileAndRun(`package P

import System

struct Outer {
    interface IInner {
        func Hello() string;
    }

    class Impl : IInner {
        func Hello() string {
            return "iface-in-struct"
        }
    }
}

func (o Outer) Make() string {
    var i IInner = Impl{}
    return i.Hello()
}

let o = Outer{}
Console.WriteLine(o.Make())`)
        Assert.Equal("iface-in-struct${Environment.NewLine}", output)
    }

    @Fact
    func IssueExample_EmitsRealNestedClrType() {
        // ADR-0110: the supported combinations are emitted as real CLR nested
        // TypeDefs. Verify via reflection that Inner is nested inside Outer.
        let assembly = CompileToLibrary(`package Oahu.Cli.Tests

class Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }

    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}`)
        let outer = Enumerable.Single(assembly.GetTypes(), (t Type) -> t.Name == "Outer")
        let inner Type? = outer.GetNestedType("Inner", BindingFlags.Public | BindingFlags.NonPublic)
        Assert.NotNull(inner)
        Assert.True(inner!!.IsNested)
        Assert.Equal(outer, inner!!.DeclaringType)
    }

    @Fact
    func RecursivelyNestedClass_ConstructedFromInnermostMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer {
    class Middle {
        class Inner {
            func N() int32 {
                return 7
            }
        }

        func Make() int32 {
            let i = Inner()
            return i.N()
        }
    }

    func Make() int32 {
        let m = Middle()
        return m.Make()
    }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue910_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`compile failed (` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileToLibrary(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue910_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }
    }
}
