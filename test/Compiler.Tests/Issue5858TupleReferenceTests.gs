package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Reflection
import System.Text
import Xunit

class Issue5858TupleReferenceTests {
    @Fact
    func NarrowedObjectField_TupleReferenceAddressesTheBoxedValue() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package BoxedTuple5858
import System
class Holder {
    let Value object
    init(value object) { Value = value }
}
class Reader { shared {
func Read(h Holder) string {
    if h.Value is ValueTuple[string, int32] {
        let ref readonly alias string = h.Value.Item1
        return alias
    }
    return "wrong"
}
} }
func Main() {
    var row (string, int32) = ("keep", 1)
    Console.WriteLine(Reader.Read(Holder(row)))
}`, "BoxedTuple5858", executable: true)
        let consumer = fixture.CompileCSharp(`public static class Consumer {
    public static string Run() => BoxedTuple5858.Reader.Read(new BoxedTuple5858.Holder(("keep", 1)));
}`, "BoxedTuple5858Consumer", dll)
        // ILVerify rejects unbox followed by ldflda; ECMA-335 III.1.8.1.2.2 permits this projection.
        IlVerifier.Verify(consumer, []string{dll})
        let assemblies = EmittedFixture.LoadTogether(dll, consumer)
        let method = assemblies[0].GetType("BoxedTuple5858.Reader")!!.GetMethod("Read")!!
        let code = method.GetMethodBody()!!.GetILAsByteArray()!!
        Assert.Equal(45, code.Length)
        for offset in[]int32{2, 21} {
            let field = method.Module.ResolveField(BitConverter.ToInt32(code, offset))!!
            Assert.Equal("Value", field.Name)
            Assert.Equal(typeof(object), field.FieldType)
        }
        for offset in[]int32{7, 26} {
            Assert.Equal(
                typeof(ValueTuple[string, int32]),
                method.Module.ResolveType(BitConverter.ToInt32(code, offset))
            )
        }
        let leaf = method.Module.ResolveField(BitConverter.ToInt32(code, 31))!!
        Assert.Equal("Item1", leaf.Name)
        Assert.Equal(typeof(ValueTuple[string, int32]), leaf.DeclaringType)
        Assert.Equal("wrong", method.Module.ResolveString(BitConverter.ToInt32(code, 40)))
        for offset in[]int32{2, 7, 21, 26, 31, 40} {
            Array.Clear(code, offset, 4)
        }
        Assert.Equal(
            []uint8{
                0x02,
                0x7b,
                0,
                0,
                0,
                0,
                0x75,
                0,
                0,
                0,
                0,
                0x14,
                0xfe,
                0x03,
                0x39,
                0x14,
                0,
                0,
                0,
                0x02,
                0x7b,
                0,
                0,
                0,
                0,
                0x79,
                0,
                0,
                0,
                0,
                0x7c,
                0,
                0,
                0,
                0,
                0x0a,
                0x06,
                0x50,
                0x2a,
                0x72,
                0,
                0,
                0,
                0,
                0x2a
            },
            code
        )
        Assert.Equal("keep", assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
        Assert.Equal(Encoding.UTF8.GetBytes("keep\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticReadOnlyTuple_RefReturnDoesNotAddressADefensiveCopy(nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let state = if nested {
            "struct Snapshot { var Row (Text string, Code int32) }\n"
        } else {
            ""
        }
        let field = if nested {
            "let State Snapshot = Snapshot{Row: (\"keep\", 1)}"
        } else {
            "let Row (Text string, Code int32) = (\"keep\", 1)"
        }
        let selected = if nested {
            "State.Row"
        } else {
            "Row"
        }
        let emitted = fixture.Compile("package TupleReadOnly5858\n" + state + `
class Source {
    shared {
        ` + field + `
        func Borrow() ref readonly string { return ref ` + selected + `.Text }
    }
}`, "TupleReadOnly5858", executable: false)
        let consumer = fixture.CompileCSharp(`using System;
public static class Consumer {
    public static string Run() {
        ref readonly string alias = ref TupleReadOnly5858.Source.Borrow();
        GC.Collect();
        return alias;
    }
}`, "TupleReadOnly5858Consumer", emitted)
        // ILVerify rejects ldsflda of initonly fields from C# too; the consumer verifies without a waiver.
        IlVerifier.Verify(consumer, []string{emitted})
        let assemblies = EmittedFixture.LoadTogether(emitted, consumer)
        let method = assemblies[0].GetType("TupleReadOnly5858.Source")!!.GetMethod("Borrow")!!
        let body = method.GetMethodBody()!!
        let code = body.GetILAsByteArray()!!
        let fields = if nested {
            []string{"State", "Row", "Item1"}
        } else {
            []string{"Row", "Item1"}
        }
        Assert.Equal(5 * fields.Length + 1, code.Length)
        for var i = 0; i < fields.Length; i++ {
            Assert.Equal(
                if i == 0 {
                    0x7f
                } else {
                    0x7c
                },
                int32(code[5 * i])
            )
            Assert.Equal(fields[i], method.Module.ResolveField(BitConverter.ToInt32(code, 5 * i + 1))!!.Name)
        }
        Assert.Equal(0x2a, int32(code[code.Length - 1]))
        Assert.Equal("keep", assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func OpenGenericTuple_ParameterReferenceMatchesCSharpIL() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let native = fixture.CompileCSharp(
            "public static class Control { public static ref (T Value, int Code) Borrow<T>(ref (T Value, int Code) value) => ref value; }",
            "Control5862"
        )
        let emitted = fixture.Compile(`package Parameter5862
func Borrow[T any](ref value (Value T, Code int32)) ref (Value T, Code int32) {
    return ref value
}`, "Parameter5862", executable: false)
        let assemblies = EmittedFixture.LoadTogether(native, emitted)
        let control = assemblies[0].GetType("Control")!!.GetMethod("Borrow")!!
        let method = assemblies[1].GetType("Parameter5862.<Program>")!!.GetMethod("Borrow")!!
        Assert.Equal([]uint8{2, 42}, control.GetMethodBody()!!.GetILAsByteArray())
        Assert.Equal(control.GetMethodBody()!!.GetILAsByteArray(), method.GetMethodBody()!!.GetILAsByteArray())
        // ILVerify 10.0.8 rejects this byte-identical Roslyn forwarder too (#5862).

    }

    @Theory
    @InlineData("Text", "(Text string, Code int32)", "(\"x\", 1)")
    @InlineData("Item1", "(Text string, Code int32)", "(\"x\", 1)")
    @InlineData("Inner.Text", "(Inner (Text string, Code int32), Flag bool)", "((\"x\", 1), true)")
    @InlineData("Item8", "(int32, int32, int32, int32, int32, int32, int32, string)", "(1, 2, 3, 4, 5, 6, 7, \"x\")")
    @InlineData(
        "Item15",
        "(int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, string)",
        "(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, \"x\")"
    )
    func TupleElement_RefLocalAndArgumentsMutateOriginalStorage(member string, type string, value string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Tuple5858
import System
func Set(ref text string) { text = "ref" }
func Clear(out text string) { text = "out" }
func Read(in text string) string { return text }
func Main() {
    var row ` + type + ` = ` + value + `
    var ref alias string = row.` + member + `
    alias = "keep"
    Console.WriteLine(row.` + member + `)
    Set(ref row.` + member + `)
    Console.WriteLine(Read(in row.` + member + `))
    Set(&row.` + member + `)
    Clear(out row.` + member + `)
    Console.WriteLine(row.` + member + `)
}`, "Tuple5858", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("keep\nref\nout\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ReadOnlyTuple_ExposesReadOnlyElementReference(parameter bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let declaration = if parameter {
            "func Read(in row (Text string, Code int32)) string {"
        } else {
            "func Read() string {\n    let row (Text string, Code int32) = (\"x\", 1)"
        }
        let call = if parameter {
            "var row (Text string, Code int32) = (\"x\", 1)\nConsole.WriteLine(Read(in row))"
        } else {
            "Console.WriteLine(Read())"
        }
        let dll = fixture.Compile("package TupleReadOnly5858\nimport System\n" + declaration + `
    let ref readonly alias string = row.Text
    return alias
}
func Main() {
` + call + "\n}", "TupleReadOnly5858", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("x\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("parameter")
    @InlineData("heap-field")
    @InlineData("array")
    func TupleElement_RefReturnPreservesCallerStorage(origin string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let declaration = switch origin {
            case "parameter": "func Borrow(ref row (Text string, Code int32)) ref string { return ref row.Text }"
            case "heap-field": "class Holder { var row (Text string, Code int32) }\nfunc Borrow(holder Holder) ref string { return ref holder.row.Text }"
            default: "func Borrow(rows [](Text string, Code int32)) ref string { return ref rows[0].Text }"
        }
        let setup = switch origin {
            case "parameter": "var row (Text string, Code int32) = (\"x\", 1)\nvar ref alias = Borrow(ref row)"
            case "heap-field": "let holder = Holder()\nholder.row = (\"x\", 1)\nvar ref alias = Borrow(holder)"
            default: "var rows = [](Text string, Code int32){(\"x\", 1)}\nvar ref alias = Borrow(rows)"
        }
        let read = switch origin {
            case "parameter": "row.Text"
            case "heap-field": "holder.row.Text"
            default: "rows[0].Text"
        }
        let dll = fixture.Compile(
            "package TupleReturn5858\nimport System\n" +
                declaration +
                "\nfunc Main() {\n" +
                setup +
                "\nalias = \"keep\"\nConsole.WriteLine(" +
                read +
                ")\n}",
            "TupleReturn5858",
            executable: true
        )
        if origin == "parameter" {
            AssertTupleElementForwarder(
                EmittedFixture.Load(dll).GetType("TupleReturn5858.<Program>")!!.GetMethod("Borrow")!!,
                0
            )
        } else {
            IlVerifier.Verify(dll)
        }
        Assert.Equal(Encoding.UTF8.GetBytes("keep\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("function", false)
    @InlineData("function", true)
    @InlineData("class", false)
    @InlineData("class", true)
    @InlineData("struct", false)
    @InlineData("struct", true)
    func OpenGenericTuple_RefParameterAndLocalForwardTheirManagedReference(owner string, alias bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let body = if alias {
            "var ref alias = value\nreturn ref alias"
        } else {
            "return ref value"
        }
        let method = "func Borrow" +
            (
            if owner == "function" {
                "[T any]"
            } else {
                ""
            }
        ) +
            "(ref value (Value T, Code int32)) ref (Value T, Code int32) {\n" +
            body +
            "\n}"
        let declaration = if owner == "function" {
            method
        } else {
            owner + " Owner[T any] {\n" + method + "\n}"
        }
        let call = if owner == "function" {
            "Borrow[string]"
        } else {
            "owner.Borrow"
        }
        let instance = if owner == "function" {
            ""
        } else {
            if owner == "struct" {
                "var owner = Owner[string]{}\n"
            } else {
                "var owner = Owner[string]()\n"
            }
        }
        let dll = fixture.Compile("package Tuple5862\nimport System\n" + declaration + "\nfunc Main() {\n" + instance + `var row (Value string, Code int32) = ("x", 1)
    var ref result = ` + call + `(ref row)
    result = ("keep", 42)
    Console.WriteLine(row.Value)
    Console.WriteLine(row.Code)
}`, "Tuple5862", executable: true)
        let borrowed = EmittedFixture.Load(dll).GetType(
            if owner == "function" {
                "Tuple5862.<Program>"
            } else {
                "Tuple5862.Owner`1"
            }
        )!!.GetMethod("Borrow")!!
        let argument = if owner == "function" {
            uint8(2)
        } else {
            uint8(3)
        }
        Assert.Equal(
            if alias {
                []uint8{argument, 0x0a, 0x06, 0x2a}
            } else {
                []uint8{argument, 0x2a}
            },
            borrowed.GetMethodBody()!!.GetILAsByteArray()
        )
        Assert.Equal(Encoding.UTF8.GetBytes("keep\n42\n"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("Value", "(Value T, Code int32)", "(\"x\", 1)")
    @InlineData("Item8", "(int32, int32, int32, int32, int32, int32, int32, T)", "(1, 2, 3, 4, 5, 6, 7, \"x\")")
    @InlineData(
        "Item15",
        "(int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, T)",
        "(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, \"x\")"
    )
    func OpenGenericTuple_ElementRefReturnMutatesOriginal(member string, type string, value string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(
            "package TupleElement5862\nimport System\nfunc Borrow[T any](ref value " +
                type +
                ") ref T { return ref value." +
                member +
                " }\nfunc Main() {\nvar row " +
                type.Replace("T", "string") +
                " = " +
                value +
                "\nvar ref result = Borrow[string](ref row)\nresult = \"keep\"\nConsole.WriteLine(row." +
                member +
                ")\n}",
            "TupleElement5862",
            executable: true
        )
        let method = EmittedFixture.Load(dll).GetType("TupleElement5862.<Program>")!!.GetMethod(
            "Borrow"
        )!!.MakeGenericMethod(typeof(string))
        AssertTupleElementForwarder(
            method,
            if member == "Item15" {
                2
            } else if member == "Item8" {
                1
            } else {
                0
            }
        )
        Assert.Equal(Encoding.UTF8.GetBytes("keep\n"), fixture.RunBytes(dll))
    }

    @Fact
    func OpenGenericTuple_RefOutInParametersAddressTheirReferents() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TupleArguments5862
import System
func Assign[T any](ref row (Value T, Code int32), next T) {
    var ref alias T = row.Value
    alias = next
}
func Fill[T any](out row (Value T, Code int32), next T) {
    row = (next, 42)
    Assign[T](ref row, next)
}
func Read[T any](in row (Value T, Code int32)) T {
    let ref readonly alias T = row.Value
    return alias
}
func Main() {
    var row (Value string, Code int32) = ("x", 1)
    Assign[string](ref row, "keep")
    Console.WriteLine(Read[string](in row))
    Fill[string](out row, "out")
    Console.WriteLine(row.Value)
    Console.WriteLine(row.Code)
}`, "TupleArguments5862", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("keep\nout\n42\n"), fixture.RunBytes(dll))
    }

    @Fact
    func OpenGenericTuple_HeapFieldElementReturnIsStrictlyVerifiable() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package HeapTuple5862
import System
class Holder[T any] {
    var row (Value T, Code int32)
    func Borrow() ref T { return ref row.Value }
}
func Main() {
    let holder = Holder[string]()
    holder.row = ("x", 1)
    var ref alias = holder.Borrow()
    alias = "keep"
    Console.WriteLine(holder.row.Value)
}`, "HeapTuple5862", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("keep\n"), fixture.RunBytes(dll))
    }

    shared {
        private func AssertTupleElementForwarder(method MethodInfo, restCount int32) {
            // Incoming-byref returns use C#-equivalent IL and runtime witnesses; ILVerify rejects them too (#5862).
            let code = method.GetMethodBody()!!.GetILAsByteArray()!!
            Assert.Equal(7 + 5 * restCount, code.Length)
            Assert.Equal(2, int32(code[0]))
            var receiver = method.GetParameters()[0].ParameterType.GetElementType()
            for var i = 0; i <= restCount; i++ {
                let offset = 1 + 5 * i
                Assert.Equal(0x7c, int32(code[offset]))
                let field = method.Module.ResolveField(
                    BitConverter.ToInt32(code, offset + 1),
                    nil,
                    method.GetGenericArguments()
                )!!
                Assert.Equal(receiver, field.DeclaringType)
                Assert.Equal(
                    if i == restCount {
                        "Item1"
                    } else {
                        "Rest"
                    },
                    field.Name
                )
                receiver = field.FieldType
            }
            Assert.Equal(method.ReturnType.GetElementType(), receiver)
            Assert.Equal(0x2a, int32(code[code.Length - 1]))
        }
    }
}
