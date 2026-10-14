// <copyright file="Issue2898NestedEnumConstructedOuterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #2898: nested enums retain generic enclosing construction in metadata.
open class Issue2898NestedEnumConstructedOuterEmitTests {
    @Fact
    func NestedEnumConstructedThroughGenericOuter_LoadsWithDistinctClosedSignatures() {
        const source = `package P
import System.Collections.Generic

struct Outer[T] {
    enum Color { Red = 11, Green = 22, Blue = 33 }
    func MakeColor() Color { return Color.Green }
}

func I(c Outer[int32].Color) Outer[int32].Color { return c }
func S(c Outer[string].Color) Outer[string].Color { return c }
func NI(c Outer[int32].Color?) Outer[int32].Color? { return c }
func NS(c Outer[string].Color?) Outer[string].Color? { return c }
func RI() Outer[int32].Color { return Outer[int32].Color.Green }
func RS() Outer[string].Color { return Outer[string].Color.Blue }
func BI() object { return Outer[int32].Color.Red }
func BS() object { return Outer[string].Color.Green }
func Capture[T](c Outer[T].Color) () -> Outer[T].Color -> () -> c
func Remap[A, B](c Outer[B].Color) int32 {
    var outer = List[Outer[B].Color]()
    outer.Add(c)
    var outerRed = Outer[B].Color.Red
    let f (Outer[B].Color) -> int32 = (value Outer[B].Color) -> {
        var inner = List[Outer[B].Color]()
        inner.Add(value)
        var innerRed = Outer[B].Color.Red
        return int32(inner[0]) + int32(innerRed)
    }
    return int32(outerRed) + f(outer[0])
}
func Iterate[A, B](c Outer[B].Color) sequence[int32] {
    var values = List[Outer[B].Color]()
    values.Add(c)
    yield int32(values[0])
}
struct Holder {
    var IntRed Outer[int32].Color
    var StringRed Outer[string].Color
}`
        let assembly = CompileAndLoad(source)
        let allTypes = assembly.GetTypes()
        let program = allTypes.Single((t Type) -> t.Name == "<Program>")
        let intMethod = GetMethod(program, "I")
        let stringMethod = GetMethod(program, "S")
        let intEnum = Assert.Single(intMethod.GetParameters()).ParameterType
        let stringEnum = Assert.Single(stringMethod.GetParameters()).ParameterType
        Assert.Equal(intEnum, intMethod.ReturnType)
        Assert.Equal(stringEnum, stringMethod.ReturnType)
        Assert.NotEqual(intEnum, stringEnum)
        Assert.True(intEnum.IsConstructedGenericType)
        Assert.True(stringEnum.IsConstructedGenericType)
        Assert.Equal(typeof(int32), Assert.Single(intEnum.GenericTypeArguments))
        Assert.Equal(typeof(string), Assert.Single(stringEnum.GenericTypeArguments))
        Assert.Equal(intEnum.GetGenericTypeDefinition(), stringEnum.GetGenericTypeDefinition())
        let nullableIntEnum = Assert.Single(GetMethod(program, "NI").GetParameters()).ParameterType
        let nullableStringEnum = Assert.Single(GetMethod(program, "NS").GetParameters()).ParameterType
        Assert.Equal(intEnum, Nullable.GetUnderlyingType(nullableIntEnum))
        Assert.Equal(stringEnum, Nullable.GetUnderlyingType(nullableStringEnum))
        let enumDefinition = Assert.Single(allTypes, (t Type) -> t.Name == "Color")
        Assert.True(enumDefinition.IsEnum)
        Assert.Equal(enumDefinition, intEnum.GetGenericTypeDefinition())
        let intRed FieldInfo? = intEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static)
        let stringRed FieldInfo? = stringEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(intRed)
        Assert.NotNull(stringRed)
        Assert.Equal(intRed!!.MetadataToken, stringRed!!.MetadataToken)
        Assert.Equal(11, intRed!!.GetRawConstantValue())
        Assert.Equal(11, stringRed!!.GetRawConstantValue())
        Assert.Equal(intEnum, intRed!!.FieldType)
        Assert.Equal(stringEnum, stringRed!!.FieldType)
        let holder = allTypes.Single((t Type) -> t.Name == "Holder")
        Assert.Equal(
            intEnum,
            holder.GetField("IntRed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!!.FieldType
        )
        Assert.Equal(
            stringEnum,
            holder.GetField(
                "StringRed",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )!!.FieldType
        )
        let outerDefinition = allTypes.Single((t Type) -> t.Name == "Outer`1")
        let intOuter = outerDefinition.MakeGenericType(typeof(int32))
        Assert.Equal(intEnum, GetMethod(intOuter, "MakeColor").ReturnType)
        Assert.Equal(
            22,
            Convert.ToInt32(GetMethod(intOuter, "MakeColor").Invoke(Activator.CreateInstance(intOuter), nil))
        )
        let intValue object? = GetMethod(program, "RI").Invoke(nil, nil)
        let stringValue object? = GetMethod(program, "RS").Invoke(nil, nil)
        Assert.Equal(intEnum, intValue!!.GetType())
        Assert.Equal(stringEnum, stringValue!!.GetType())
        Assert.Equal(22, Convert.ToInt32(intValue))
        Assert.Equal(33, Convert.ToInt32(stringValue))
        Assert.Equal(intEnum, GetMethod(program, "BI").Invoke(nil, nil)!!.GetType())
        Assert.Equal(stringEnum, GetMethod(program, "BS").Invoke(nil, nil)!!.GetType())
        let captureInt = GetMethod(program, "Capture").MakeGenericMethod(typeof(int32))
        Assert.Equal(intEnum, Assert.Single(captureInt.GetParameters()).ParameterType)
        let captured = Assert.IsAssignableFrom[Delegate](captureInt.Invoke(nil, []object{intValue}))
        Assert.Equal(intEnum, captured.DynamicInvoke()!!.GetType())
        let remap = GetMethod(program, "Remap").MakeGenericMethod(typeof(int32), typeof(string))
        Assert.Equal(stringEnum, Assert.Single(remap.GetParameters()).ParameterType)
        Assert.Equal(55, remap.Invoke(nil, []object{stringValue}))
        let iterate = GetMethod(program, "Iterate").MakeGenericMethod(typeof(int32), typeof(string))
        Assert.Equal(stringEnum, Assert.Single(iterate.GetParameters()).ParameterType)
        let sequence_ = Assert.IsAssignableFrom[IEnumerable](iterate.Invoke(nil, []object{stringValue}))
        Assert.Equal([]int32{33}, sequence_.Cast[object]().Select(Convert.ToInt32))
    }

    @Fact
    func DeepNestedEnum_LoadsAcrossGenericInterfaceAndDictionarySignatures() {
        const source = `package P
import System.Collections.Generic

struct Deep[A] {
    struct Mid[B] {
        enum Tone { Red = 5, Green, Blue = 9 }
    }
}

interface IToneSource[A, B] {
    func Get() Deep[A].Mid[B].Tone;
}

class ToneSource[A, B] : IToneSource[A, B] {
    func Get() Deep[A].Mid[B].Tone { return Deep[A].Mid[B].Tone.Green }
}

func Echo[A, B](tone Deep[A].Mid[B].Tone) Deep[A].Mid[B].Tone { return tone }
func Blue() Deep[int32].Mid[string].Tone { return Deep[int32].Mid[string].Tone.Blue }
func Source() Deep[int32].Mid[string].Tone { return ToneSource[int32, string]().Get() }
func MakeMap() Dictionary[Deep[int32].Mid[string].Tone, string] {
    let values = Dictionary[Deep[int32].Mid[string].Tone, string]()
    values.Add(Deep[int32].Mid[string].Tone.Red, "red")
    return values
}`
        let assembly = CompileAndLoad(source)
        let allTypes = assembly.GetTypes()
        let program = allTypes.Single((t Type) -> t.Name == "<Program>")
        let deepEnum = GetMethod(program, "Blue").ReturnType
        let enumDefinition = deepEnum.GetGenericTypeDefinition()
        Assert.Equal("Tone", enumDefinition.Name)
        Assert.Equal([]Type{typeof(int32), typeof(string)}, deepEnum.GenericTypeArguments)
        Assert.Equal(5, deepEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static)!!.GetRawConstantValue())
        Assert.Equal(6, deepEnum.GetField("Green", BindingFlags.Public | BindingFlags.Static)!!.GetRawConstantValue())
        Assert.Equal(9, deepEnum.GetField("Blue", BindingFlags.Public | BindingFlags.Static)!!.GetRawConstantValue())
        let echo = GetMethod(program, "Echo").MakeGenericMethod(typeof(int32), typeof(string))
        Assert.Equal(deepEnum, Assert.Single(echo.GetParameters()).ParameterType)
        Assert.Equal(deepEnum, echo.ReturnType)
        let blue object? = GetMethod(program, "Blue").Invoke(nil, nil)
        Assert.Equal(9, Convert.ToInt32(echo.Invoke(nil, []object{blue})))
        Assert.Equal(6, Convert.ToInt32(GetMethod(program, "Source").Invoke(nil, nil)))
        let sourceInterface = allTypes.Single((t Type) -> t.Name == "IToneSource`2").MakeGenericType(
            typeof(int32),
            typeof(string)
        )
        let sourceClass = allTypes.Single((t Type) -> t.Name == "ToneSource`2").MakeGenericType(
            typeof(int32),
            typeof(string)
        )
        Assert.Equal(deepEnum, GetMethod(sourceInterface, "Get").ReturnType)
        Assert.Equal(deepEnum, GetMethod(sourceClass, "Get").ReturnType)
        let mapMethod = GetMethod(program, "MakeMap")
        Assert.Equal(deepEnum, mapMethod.ReturnType.GenericTypeArguments[0])
        let map_ = Assert.IsAssignableFrom[IDictionary](mapMethod.Invoke(nil, nil))
        Assert.Equal("red", map_[deepEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!])
    }

    @Fact
    func ImportedNestedEnum_LoadsWithConcreteDistinctEnclosingArguments() {
        const librarySource = `package glib

public struct Outer[T] {
    public enum Color { Red = 4, Green = 5, Blue = 6 }
}`
        const consumerSource = `package useglib
import glib

var c = Outer[int32].Color.Green
var d = Outer[string].Color.Blue
func I() int32 { return int32(c) }
func S() int32 { return int32(d) }
func BI() object { return c }
func BS() object { return d }
func EI(value Outer[int32].Color) Outer[int32].Color { return value }
func ES(value Outer[string].Color) Outer[string].Color { return value }`
        let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2898ImportedEmit", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
        try {
            let libraryPath = Compile(tempDir, "glib", librarySource)
            let consumerPath = Compile(tempDir, "useglib", consumerSource, "/target:exe", "/r:" + libraryPath)
            IlVerifier.Verify(libraryPath)
            IlVerifier.Verify(consumerPath, []string{libraryPath})
            let intSignature = GetFieldSignature(consumerPath, "c")
            let stringSignature = GetFieldSignature(consumerPath, "d")
            Assert.NotEqual(intSignature, stringSignature)
            Assert.EndsWith("08", intSignature)
            Assert.EndsWith("0E", stringSignature)
            Assert.DoesNotContain("1300", intSignature)
            Assert.DoesNotContain("1300", stringSignature)
            // One context for both: the assertions compare the consumer's
            // constructed enum types against the library's definitions,
            // and loading them together is also what resolves the
            // consumer's reference to the library (the AppDomain-wide
            // AssemblyResolve hook this replaced only ever fired for the
            // default load context).
            let loaded2898 = EmittedFixture.LoadTogether(libraryPath, consumerPath)
            let library = loaded2898[0]
            let libraryTypes = library.GetTypes()
            {
                let consumer = loaded2898[1]
                let consumerTypes = consumer.GetTypes()
                let program = consumerTypes.Single((t Type) -> t.Name == "<Program>")
                let intEnum = program.GetField(
                    "c",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )!!.FieldType
                let stringEnum = program.GetField(
                    "d",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )!!.FieldType
                Assert.NotEqual(intEnum, stringEnum)
                Assert.Equal(typeof(int32), Assert.Single(intEnum.GenericTypeArguments))
                Assert.Equal(typeof(string), Assert.Single(stringEnum.GenericTypeArguments))
                Assert.Equal(intEnum.GetGenericTypeDefinition(), stringEnum.GetGenericTypeDefinition())
                Assert.Equal(libraryTypes.Single((t Type) -> t.Name == "Color"), intEnum.GetGenericTypeDefinition())
                Assert.Equal(intEnum, Assert.Single(GetMethod(program, "EI").GetParameters()).ParameterType)
                Assert.Equal(intEnum, GetMethod(program, "EI").ReturnType)
                Assert.Equal(stringEnum, Assert.Single(GetMethod(program, "ES").GetParameters()).ParameterType)
                Assert.Equal(stringEnum, GetMethod(program, "ES").ReturnType)
                GetMethod(program, "<Main>$$").Invoke(nil, []object{Array.Empty[string]()})
                Assert.Equal(5, GetMethod(program, "I").Invoke(nil, nil))
                Assert.Equal(6, GetMethod(program, "S").Invoke(nil, nil))
                Assert.Equal(intEnum, GetMethod(program, "BI").Invoke(nil, nil)!!.GetType())
                Assert.Equal(stringEnum, GetMethod(program, "BS").Invoke(nil, nil)!!.GetType())
            }
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func BareNestedEnumEmptySliceLiteral_ClosesOverCurrentTypeParameters() {
        const source = `package P

struct Outer[T] {
    public enum Color { Red = 1, Green = 2, Blue = 3 }
    public func Values() []Color { return []Color{} }
}`
        let values = InvokeOuterArrayMethod(source, "Values")
        Assert.Empty(values)
        Assert.Equal(typeof(int32), Assert.Single(values.GetType().GetElementType()!!.GenericTypeArguments))
    }

    @Fact
    func BareNestedEnumPopulatedSliceLiteral_ClosesOverCurrentTypeParameters() {
        const source = `package P

struct Outer[T] {
    public enum Color { Red = 1, Green = 2, Blue = 3 }
    public func Values() []Color { return []Color{Color.Red, Color.Blue} }
}`
        let values = InvokeOuterArrayMethod(source, "Values")
        Assert.Equal([]int32{1, 3}, values.Cast[object]().Select(Convert.ToInt32))
        Assert.Equal(typeof(int32), Assert.Single(values.GetType().GetElementType()!!.GenericTypeArguments))
    }

    @Fact
    func AlreadyClosedNestedEnumSliceLiteral_RemainsClosed() {
        const source = `package P

struct Outer[T] {
    public enum Color { Red = 1, Green = 2, Blue = 3 }
    public func R() int32 {
        var colors = []Outer[int32].Color{Outer[int32].Color.Blue}
        return int32(colors[0])
    }
}`
        let assembly = CompileAndLoad(source)
        let outer = assembly.GetTypes().Single((t Type) -> t.Name == "Outer`1").MakeGenericType(typeof(string))
        Assert.Equal(3, GetMethod(outer, "R").Invoke(Activator.CreateInstance(outer), nil))
    }

    @Fact
    func NestedEnumUnderNonGenericMiddle_ClosesOverGenericAncestor() {
        const source = `package P

struct Gen[T] {
    public struct Mid {
        public enum Tone { A = 1, B = 2 }
        public func R() int32 {
            var tone = Tone.B
            return int32(tone)
        }
    }
}`
        let assembly = CompileAndLoad(source)
        let midDefinition = assembly.GetTypes().Single((t Type) -> t.Name == "Mid")
        let mid = if midDefinition.IsGenericTypeDefinition {
            midDefinition.MakeGenericType(typeof(int32))
        } else {
            midDefinition
        }
        Assert.Equal(2, GetMethod(mid, "R").Invoke(Activator.CreateInstance(mid), nil))
    }

    @Fact
    func NestedEnumTwoGenericLevelsDeep_LocalExpressionClosesAllEnclosingParameters() {
        const source = `package P

struct Gen[T] {
    public struct MidG[U] {
        public enum Tone { A = 1, B = 2 }
        public func R() int32 {
            var tone = Tone.B
            return int32(tone)
        }
    }
}`
        Assert.Equal(2, InvokeNestedMidMethod(source))
    }

    @Fact
    func NestedEnumTwoGenericLevelsDeep_SliceLiteralClosesAllEnclosingParameters() {
        const source = `package P

struct Gen[T] {
    public struct MidG[U] {
        public enum Tone { A = 1, B = 2 }
        public func R() int32 {
            var tones = []Tone{Tone.B}
            return int32(tones[0])
        }
    }
}`
        Assert.Equal(2, InvokeNestedMidMethod(source))
    }

    @Fact
    func StaticInterfacePropertyNestedEnum_PropagatesReferenceNullabilityErasure() {
        const source = `package P

struct Outer[T] {
    public enum Color { Red = 1 }
}

sealed interface IGet[T] {
    shared { prop Value Outer[T?].Color { get; } }
}

class TextImplicit : IGet[string] {
    shared { prop Value Outer[string].Color -> Outer[string].Color.Red }
}

func Read[T IGet[string]](witness T) Outer[string].Color {
    return T.Value
}

func Run() int32 { return int32(Read(TextImplicit{})) }`
        let assembly = CompileAndLoad(source, IlVerifier.KnownIssues.StaticVirtualInterface)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(1, GetMethod(program, "Run").Invoke(nil, nil))
    }

    shared {
        private func GetMethod(type Type, name string) MethodInfo -> type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Missing method ${type.FullName}.$name")

        private func InvokeOuterArrayMethod(source string, methodName string) Array {
            let assembly = CompileAndLoad(source)
            let outer = assembly.GetTypes().Single((t Type) -> t.Name == "Outer`1").MakeGenericType(typeof(int32))
            return Assert.IsAssignableFrom[Array](
                GetMethod(outer, methodName).Invoke(Activator.CreateInstance(outer), nil)
            )
        }

        private func InvokeNestedMidMethod(source string) int32 {
            let assembly = CompileAndLoad(source)
            let mid = assembly
                .GetTypes()
                .Single((t Type) -> t.Name == "MidG`1")
                .MakeGenericType(typeof(int32), typeof(string))
            return Assert.IsType[int32](GetMethod(mid, "R").Invoke(Activator.CreateInstance(mid), nil))
        }

        private func CompileAndLoad(source string, ignoredErrorCodes[]?string = nil) Assembly {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2898Emit", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            try {
                let outputPath = Compile(tempDir, "test", source)
                IlVerifier.Verify(outputPath, ignoredErrorCodes: ignoredErrorCodes)
                let assembly = EmittedFixture.Load(outputPath)
                let _ = assembly.GetTypes()
                return assembly
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func Compile(directory string, name string, source string, extraArguments ...string) string {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let outputPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                let targetArgument = if extraArguments.Any(
                    (a string) -> a.StartsWith("/target:", StringComparison.OrdinalIgnoreCase)
                ) {
                    Array.Empty[string]()
                } else {
                    []string{"/target:library"}
                }
                exitCode = Program.Main(
                    extraArguments
                        .Concat(targetArgument)
                        .Concat([]string{"/out:" + outputPath, "/targetframework:net10.0", sourcePath})
                        .ToArray()
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return outputPath
        }

        private func GetFieldSignature(assemblyPath string, fieldName string) string {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            let field = metadata
                .FieldDefinitions
                .Select(metadata.GetFieldDefinition)
                .Single((f FieldDefinition) -> metadata.GetString(f.Name) == fieldName)
            return Convert.ToHexString(metadata.GetBlobBytes(field.Signature))
        }
    }
}
