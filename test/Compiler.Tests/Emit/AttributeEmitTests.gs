// <copyright file="AttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Text.Json
import System.Text.Json.Serialization
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.ObjectModel

/// Phase 3 emit tests for issue #141 / ADR-0047. Compiles GSharp sources that
/// carry user annotations and asserts that the resulting PE contains the
/// expected `CustomAttribute` rows by inspecting the loaded assembly's
/// reflection metadata.
open class AttributeEmitTests {
    @Fact
    func Emits_Obsolete_With_Message_On_Function() {
        let source = `package P
import System

@Obsolete("use Bar instead")
func Foo() {
}`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let foo MethodInfo? = program.GetMethod(
            "Foo",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(foo)
        let data = foo!!.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("use Bar instead", arg.Value)
    }

    @Fact
    func Emits_Parameterless_Obsolete_On_Function() {
        let source = `package P
import System

@Obsolete
func Helper() {
}`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let helper MethodInfo? = program.GetMethod(
            "Helper",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(helper)
        Assert.Contains(
            helper!!.GetCustomAttributesData(),
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
    }

    @Fact
    func Emits_Attribute_On_Struct_TypeDef() {
        let source = `package P
import System

@Obsolete("legacy")
data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let data = point.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("legacy", arg.Value)
    }

    @Fact
    func AttributeSugar_Emits_Class_With_SystemAttribute_Base() {
        let source = `package P
import System

@Attribute
class Trace {
}`
        let assembly = CompileToAssembly(source)
        let trace = assembly.GetTypes().Single((t Type) -> t.Name == "Trace")
        Assert.Equal("System.Attribute", trace.BaseType?.FullName)
        Assert.True(typeof(Attribute).IsAssignableFrom(trace))
    }

    @Fact
    func Emits_Typeof_Argument_On_Function() {
        // System.Diagnostics.DebuggerTypeProxyAttribute(Type) — exercises the
        // ECMA-335 II.23.3 element-type 0x50 (SerString type-name) encoding.
        let source = `package P
import System
import System.Diagnostics

@DebuggerTypeProxy(typeof(int32))
data struct Box {
    var Value int32
}`
        let assembly = CompileToAssembly(source)
        let box = assembly.GetTypes().Single((t Type) -> t.Name == "Box")
        let data = box.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.Diagnostics.DebuggerTypeProxyAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal(typeof(Type), arg.ArgumentType)
        // The CLR rehydrates the SerString into either a System.Type or its
        // canonical string name depending on whether the type resolves —
        // accept either, but assert it identifies System.Int32.
        let typeName string? = switch arg.Value {
            case t is Type: t.FullName
            case s is string: s
            default: default(string?)
        }
        Assert.StartsWith("System.Int32", typeName ?? string.Empty)
    }

    @Fact
    func Emits_Typeof_SameCompilation_Type() {
        let source = `package P
import System
import System.Diagnostics

class Proxy {
}

@DebuggerTypeProxy(typeof(Proxy))
class Model {
}`
        let assembly = CompileToAssembly(source)
        let model = assembly.GetTypes().Single((t Type) -> t.Name == "Model")
        let data = model.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.Diagnostics.DebuggerTypeProxyAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal(assembly.GetTypes().Single((t Type) -> t.Name == "Proxy"), arg.Value)
    }

    @Fact
    func Emits_Typeof_Named_Argument() {
        // DebuggerDisplayAttribute exposes a settable `Target` property of
        // type System.Type — verifies named-arg encoding of the 0x50 tag.
        let source = `package P
import System
import System.Diagnostics

@DebuggerDisplay("{Value}", Target: typeof(string))
data struct Holder {
    var Value int32
}`
        let assembly = CompileToAssembly(source)
        let holder = assembly.GetTypes().Single((t Type) -> t.Name == "Holder")
        let data = holder.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.Diagnostics.DebuggerDisplayAttribute"
        )
        let targetNamed = Assert.Single(
            data.NamedArguments,
            (n CustomAttributeNamedArgument) -> n.MemberName == "Target"
        )
        Assert.Equal(typeof(Type), targetNamed.TypedValue.ArgumentType)
        let typeName string? = switch targetNamed.TypedValue.Value {
            case t is Type: t.FullName
            case s is string: s
            default: default(string?)
        }
        Assert.StartsWith("System.String", typeName ?? string.Empty)
    }

    @Fact
    func Emits_Object_Argument_Carrying_Boxed_Int() {
        // DefaultValueAttribute(object) is the canonical boxed-object ctor —
        // the emitter must precede the FixedArg with the runtime type tag
        // (ECMA-335 II.23.3 element-type 0x51).
        let source = `package P
import System
import System.ComponentModel

@DefaultValue(42)
data struct Counter {
    var Value int32
}`
        let assembly = CompileToAssembly(source)
        let counter = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let data = counter.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DefaultValueAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        // CustomAttributeData unboxes a 0x51-wrapped value to its runtime element type.
        Assert.Equal(typeof(int32), arg.ArgumentType)
        Assert.Equal(42, arg.Value)
    }

    @Fact
    func Emits_Object_Argument_Carrying_String() {
        let source = `package P
import System
import System.ComponentModel

@DefaultValue("hello")
data struct Greeter {
    var Value int32
}`
        let assembly = CompileToAssembly(source)
        let greeter = assembly.GetTypes().Single((t Type) -> t.Name == "Greeter")
        let data = greeter.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DefaultValueAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal(typeof(string), arg.ArgumentType)
        Assert.Equal("hello", arg.Value)
    }

    @Fact
    func Emits_Array_Argument() {
        // TupleElementNamesAttribute(string[]) — exercises the ECMA-335
        // II.23.3 SZARRAY (0x1D) encoding for a string-array positional arg.
        let source = `package P
import System
import System.Runtime.CompilerServices

@TupleElementNames([]string{"first", "second"})
data struct Pair {
    var A int32
    var B int32
}`
        let assembly = CompileToAssembly(source)
        let pair = assembly.GetTypes().Single((t Type) -> t.Name == "Pair")
        let data = pair.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.TupleElementNamesAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        let values = (cast[ReadOnlyCollection[CustomAttributeTypedArgument]](arg.Value)).Select(
            (v CustomAttributeTypedArgument) -> cast[string](v.Value)
        )
            .ToArray()
        Assert.Equal([]string{"first", "second"}, values)
    }

    @Fact
    func Emits_Object_Argument_Carrying_Type() {
        // DefaultValueAttribute(object) carrying a `typeof(T)` — verifies the
        // recursive 0x51-boxed encoding nests a 0x50 type-name SerString.
        let source = `package P
import System
import System.ComponentModel

@DefaultValue(typeof(int32))
data struct Holder {
    var Value int32
}`
        let assembly = CompileToAssembly(source)
        let holder = assembly.GetTypes().Single((t Type) -> t.Name == "Holder")
        let data = holder.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DefaultValueAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal(typeof(Type), arg.ArgumentType)
        let typeName string? = switch arg.Value {
            case t is Type: t.FullName
            case s is string: s
            default: default(string?)
        }
        Assert.StartsWith("System.Int32", typeName ?? string.Empty)
    }

    @Fact
    func Emits_Attribute_On_Parameter() {
        // Issue #170 / ADR-0047 §3: per-parameter annotations attach to the
        // Parameter metadata row, round-tripping through
        // `MethodInfo.GetParameters()[i].GetCustomAttributesData()`.
        // Uses `[Description]` because its [AttributeUsage(All)] permits the
        // Parameter target (issue #177 enforces ValidOn).
        let source = `package P
import System.ComponentModel

func Foo(@Description("old name") name string) {
}`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let foo MethodInfo? = program.GetMethod(
            "Foo",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(foo)
        let parameters = foo!!.GetParameters()
        let nameParam = Assert.Single(parameters)
        Assert.Equal("name", nameParam.Name)
        let data = nameParam.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DescriptionAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("old name", arg.Value)
        // The MethodDef itself should not carry the parameter-target attribute.
        Assert.DoesNotContain(
            foo!!.GetCustomAttributesData(),
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DescriptionAttribute"
        )
    }

    @Fact
    func Issue3082_PropertyTarget_On_DataPositionalMember_IsRuntimeObservable() {
        let _ = typeof(JsonIgnoreAttribute).Assembly
        let source = `package P
import System.Text.Json.Serialization

data class QuestionResult(
    QuestionId string,
    @property:JsonIgnore Points float64) {
}`
        let assembly = CompileToAssembly(source)
        let resultType = assembly.GetTypes().Single((t Type) -> t.Name == "QuestionResult")
        let pointsProperty PropertyInfo? = resultType.GetProperty("Points")
        Assert.NotNull(pointsProperty)
        Assert.Contains(
            pointsProperty!!.GetCustomAttributesData(),
            (data CustomAttributeData) -> data.AttributeType == typeof(JsonIgnoreAttribute)
        )
        let constructor = resultType.GetConstructors().Single(
            (ctor ConstructorInfo) -> ctor.GetParameters().Any((parameter ParameterInfo) -> parameter.Name == "Points")
        )
        let pointsParameter = constructor.GetParameters().Single(
            (parameter ParameterInfo) -> parameter.Name == "Points"
        )
        Assert.DoesNotContain(
            pointsParameter.GetCustomAttributesData(),
            (data CustomAttributeData) -> data.AttributeType == typeof(JsonIgnoreAttribute)
        )
        let instance object? = Activator.CreateInstance(resultType, "question-1", 2.5)
        let json = JsonSerializer.Serialize(instance, resultType)
        Assert.Contains("\"QuestionId\":\"question-1\"", json)
        Assert.DoesNotContain("\"Points\"", json)
    }

    @Fact
    func Emits_Attribute_On_Return_Parameter() {
        // Issue #172 / ADR-0047 §3: `@return:` annotations attach to the
        // synthesised sequence-0 Parameter row (ECMA-335 II.22.33), surfacing
        // through `MethodInfo.ReturnParameter.GetCustomAttributesData()`.
        // Uses `[Description]` because its [AttributeUsage(All)] permits the
        // ReturnValue target (issue #177 enforces ValidOn).
        let source = `package P
import System.ComponentModel

@return:Description("old return")
func Foo() int32 {
    return 0
}`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let foo MethodInfo? = program.GetMethod(
            "Foo",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(foo)
        let returnParam = foo!!.ReturnParameter
        Assert.NotNull(returnParam)
        let data = returnParam.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DescriptionAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("old return", arg.Value)
        // The MethodDef itself should not carry the return-target attribute.
        Assert.DoesNotContain(
            foo!!.GetCustomAttributesData(),
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ComponentModel.DescriptionAttribute"
        )
    }

    @Fact
    func Emits_Obsolete_On_Struct_Field() {
        // Issue #186: `@Obsolete` on a field declaration round-trips to a
        // CustomAttribute row on the field's FieldDef.
        let source = `package P
import System

data struct Point {
    @Obsolete("use NewX")
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let xField FieldInfo? = point.GetField("X", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(xField)
        let data = xField!!.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("use NewX", arg.Value)
        // Sibling field carries no attribute rows.
        let yField FieldInfo? = point.GetField("Y", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(yField)
        Assert.DoesNotContain(
            yField!!.GetCustomAttributesData(),
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
    }

    @Fact
    func Emits_Obsolete_On_Class_Field() {
        // Issue #186: same round-trip for class-declared fields. Verifies the
        // EmitNestedStructTypeDef-shared field-emit path also writes the row.
        let source = `package P
import System

class Box {
    @Obsolete("retired")
    var Value int32
}`
        let assembly = CompileToAssembly(source)
        let box = assembly.GetTypes().Single((t Type) -> t.Name == "Box")
        let valueField FieldInfo? = box.GetField("Value", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(valueField)
        Assert.Contains(
            valueField!!.GetCustomAttributesData(),
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
    }

    @Fact
    func Emits_ParamsArray_Attribute_Expanding_Trailing_Args() {
        // Issue: attributes whose constructor ends in a params-array (e.g.
        // xUnit's InlineData(params object[])) were silently dropped because the
        // emitter required exact arity. The compiler must now collapse the
        // trailing positional arguments into a synthesized array argument.
        // MemberNotNull(params string[]) is the framework analogue used here.
        let source = `package P
import System.Diagnostics.CodeAnalysis

class Box {
    @MemberNotNull("A", "B")
    func Setup() {
    }
}`
        let assembly = CompileToAssembly(source)
        let box = assembly.GetTypes().Single((t Type) -> t.Name == "Box")
        let setup MethodInfo? = box.GetMethod(
            "Setup",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        )
        Assert.NotNull(setup)
        let data = setup!!.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d
                .AttributeType
                .FullName == "System.Diagnostics.CodeAnalysis.MemberNotNullAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal(typeof([]string), arg.ArgumentType)
        let elements = Assert.IsAssignableFrom[ReadOnlyCollection[CustomAttributeTypedArgument]](arg.Value)
        Assert.Equal([]string{"A", "B"}, elements.Select((e CustomAttributeTypedArgument) -> cast[string](e.Value)))
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_attr_emit_").FullName
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
            // Read all bytes so the file isn't locked, then load via Assembly.Load.
            return EmittedFixture.Load(outPath)
        }
    }
}
