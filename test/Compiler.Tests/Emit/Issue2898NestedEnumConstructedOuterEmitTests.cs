// <copyright file="Issue2898NestedEnumConstructedOuterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2898: nested enums retain generic enclosing construction in metadata.</summary>
public class Issue2898NestedEnumConstructedOuterEmitTests
{
    [Fact]
    public void NestedEnumConstructedThroughGenericOuter_LoadsWithDistinctClosedSignatures()
    {
        const string source = """
            package P
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
            }
            """;

        var assembly = CompileAndLoad(source);
        var allTypes = assembly.GetTypes();
        var program = allTypes.Single(t => t.Name == "<Program>");
        var intMethod = GetMethod(program, "I");
        var stringMethod = GetMethod(program, "S");
        var intEnum = Assert.Single(intMethod.GetParameters()).ParameterType;
        var stringEnum = Assert.Single(stringMethod.GetParameters()).ParameterType;

        Assert.Equal(intEnum, intMethod.ReturnType);
        Assert.Equal(stringEnum, stringMethod.ReturnType);
        Assert.NotEqual(intEnum, stringEnum);
        Assert.True(intEnum.IsConstructedGenericType);
        Assert.True(stringEnum.IsConstructedGenericType);
        Assert.Equal(typeof(int), Assert.Single(intEnum.GenericTypeArguments));
        Assert.Equal(typeof(string), Assert.Single(stringEnum.GenericTypeArguments));
        Assert.Equal(intEnum.GetGenericTypeDefinition(), stringEnum.GetGenericTypeDefinition());

        var nullableIntEnum = Assert.Single(GetMethod(program, "NI").GetParameters()).ParameterType;
        var nullableStringEnum = Assert.Single(GetMethod(program, "NS").GetParameters()).ParameterType;
        Assert.Equal(intEnum, Nullable.GetUnderlyingType(nullableIntEnum));
        Assert.Equal(stringEnum, Nullable.GetUnderlyingType(nullableStringEnum));

        var enumDefinition = Assert.Single(allTypes, t => t.Name == "Color");
        Assert.True(enumDefinition.IsEnum);
        Assert.Equal(enumDefinition, intEnum.GetGenericTypeDefinition());

        var intRed = intEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static);
        var stringRed = stringEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(intRed);
        Assert.NotNull(stringRed);
        Assert.Equal(intRed.MetadataToken, stringRed.MetadataToken);
        Assert.Equal(11, intRed.GetRawConstantValue());
        Assert.Equal(11, stringRed.GetRawConstantValue());
        Assert.Equal(intEnum, intRed.FieldType);
        Assert.Equal(stringEnum, stringRed.FieldType);

        var holder = allTypes.Single(t => t.Name == "Holder");
        Assert.Equal(intEnum, holder.GetField("IntRed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).FieldType);
        Assert.Equal(stringEnum, holder.GetField("StringRed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).FieldType);

        var outerDefinition = allTypes.Single(t => t.Name == "Outer`1");
        var intOuter = outerDefinition.MakeGenericType(typeof(int));
        Assert.Equal(intEnum, GetMethod(intOuter, "MakeColor").ReturnType);
        Assert.Equal(22, Convert.ToInt32(GetMethod(intOuter, "MakeColor").Invoke(Activator.CreateInstance(intOuter), null)));

        var intValue = GetMethod(program, "RI").Invoke(null, null);
        var stringValue = GetMethod(program, "RS").Invoke(null, null);
        Assert.Equal(intEnum, intValue.GetType());
        Assert.Equal(stringEnum, stringValue.GetType());
        Assert.Equal(22, Convert.ToInt32(intValue));
        Assert.Equal(33, Convert.ToInt32(stringValue));
        Assert.Equal(intEnum, GetMethod(program, "BI").Invoke(null, null).GetType());
        Assert.Equal(stringEnum, GetMethod(program, "BS").Invoke(null, null).GetType());

        var captureInt = GetMethod(program, "Capture").MakeGenericMethod(typeof(int));
        Assert.Equal(intEnum, Assert.Single(captureInt.GetParameters()).ParameterType);
        var captured = Assert.IsAssignableFrom<Delegate>(captureInt.Invoke(null, new[] { intValue }));
        Assert.Equal(intEnum, captured.DynamicInvoke().GetType());

        var remap = GetMethod(program, "Remap").MakeGenericMethod(typeof(int), typeof(string));
        Assert.Equal(stringEnum, Assert.Single(remap.GetParameters()).ParameterType);
        Assert.Equal(55, remap.Invoke(null, new[] { stringValue }));

        var iterate = GetMethod(program, "Iterate").MakeGenericMethod(typeof(int), typeof(string));
        Assert.Equal(stringEnum, Assert.Single(iterate.GetParameters()).ParameterType);
        var sequence = Assert.IsAssignableFrom<IEnumerable>(iterate.Invoke(null, new[] { stringValue }));
        Assert.Equal(new[] { 33 }, sequence.Cast<object>().Select(Convert.ToInt32));
    }

    [Fact]
    public void DeepNestedEnum_LoadsAcrossGenericInterfaceAndDictionarySignatures()
    {
        const string source = """
            package P
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
            }
            """;

        var assembly = CompileAndLoad(source);
        var allTypes = assembly.GetTypes();
        var program = allTypes.Single(t => t.Name == "<Program>");
        var deepEnum = GetMethod(program, "Blue").ReturnType;
        var enumDefinition = deepEnum.GetGenericTypeDefinition();

        Assert.Equal("Tone", enumDefinition.Name);
        Assert.Equal(new[] { typeof(int), typeof(string) }, deepEnum.GenericTypeArguments);
        Assert.Equal(5, deepEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static).GetRawConstantValue());
        Assert.Equal(6, deepEnum.GetField("Green", BindingFlags.Public | BindingFlags.Static).GetRawConstantValue());
        Assert.Equal(9, deepEnum.GetField("Blue", BindingFlags.Public | BindingFlags.Static).GetRawConstantValue());

        var echo = GetMethod(program, "Echo").MakeGenericMethod(typeof(int), typeof(string));
        Assert.Equal(deepEnum, Assert.Single(echo.GetParameters()).ParameterType);
        Assert.Equal(deepEnum, echo.ReturnType);

        var blue = GetMethod(program, "Blue").Invoke(null, null);
        Assert.Equal(9, Convert.ToInt32(echo.Invoke(null, new[] { blue })));
        Assert.Equal(6, Convert.ToInt32(GetMethod(program, "Source").Invoke(null, null)));

        var sourceInterface = allTypes.Single(t => t.Name == "IToneSource`2")
            .MakeGenericType(typeof(int), typeof(string));
        var sourceClass = allTypes.Single(t => t.Name == "ToneSource`2")
            .MakeGenericType(typeof(int), typeof(string));
        Assert.Equal(deepEnum, GetMethod(sourceInterface, "Get").ReturnType);
        Assert.Equal(deepEnum, GetMethod(sourceClass, "Get").ReturnType);

        var mapMethod = GetMethod(program, "MakeMap");
        Assert.Equal(deepEnum, mapMethod.ReturnType.GenericTypeArguments[0]);
        var map = Assert.IsAssignableFrom<IDictionary>(mapMethod.Invoke(null, null));
        Assert.Equal("red", map[deepEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static).GetValue(null)]);
    }

    [Fact]
    public void ImportedNestedEnum_LoadsWithConcreteDistinctEnclosingArguments()
    {
        const string librarySource = """
            package glib

            public struct Outer[T] {
                public enum Color { Red = 4, Green = 5, Blue = 6 }
            }
            """;
        const string consumerSource = """
            package useglib
            import glib

            var c = Outer[int32].Color.Green
            var d = Outer[string].Color.Blue
            func I() int32 { return int32(c) }
            func S() int32 { return int32(d) }
            func BI() object { return c }
            func BS() object { return d }
            func EI(value Outer[int32].Color) Outer[int32].Color { return value }
            func ES(value Outer[string].Color) Outer[string].Color { return value }
            """;

        var tempDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2898ImportedEmit",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var libraryPath = Compile(tempDir, "glib", librarySource);
            var consumerPath = Compile(tempDir, "useglib", consumerSource, "/target:exe", "/r:" + libraryPath);

            IlVerifier.Verify(libraryPath);
            IlVerifier.Verify(consumerPath, new[] { libraryPath });

            var intSignature = GetFieldSignature(consumerPath, "c");
            var stringSignature = GetFieldSignature(consumerPath, "d");
            Assert.NotEqual(intSignature, stringSignature);
            Assert.EndsWith("08", intSignature);
            Assert.EndsWith("0E", stringSignature);
            Assert.DoesNotContain("1300", intSignature);
            Assert.DoesNotContain("1300", stringSignature);

            // One context for both: the assertions compare the consumer's
            // constructed enum types against the library's definitions,
            // and loading them together is also what resolves the
            // consumer's reference to the library (the AppDomain-wide
            // AssemblyResolve hook this replaced only ever fired for the
            // default load context).
            var loaded2898 = EmittedFixture.LoadTogether(libraryPath, consumerPath);
            var library = loaded2898[0];
            var libraryTypes = library.GetTypes();
            {
                var consumer = loaded2898[1];
                var consumerTypes = consumer.GetTypes();
                var program = consumerTypes.Single(t => t.Name == "<Program>");
                var intEnum = program.GetField("c", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).FieldType;
                var stringEnum = program.GetField("d", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).FieldType;

                Assert.NotEqual(intEnum, stringEnum);
                Assert.Equal(typeof(int), Assert.Single(intEnum.GenericTypeArguments));
                Assert.Equal(typeof(string), Assert.Single(stringEnum.GenericTypeArguments));
                Assert.Equal(intEnum.GetGenericTypeDefinition(), stringEnum.GetGenericTypeDefinition());
                Assert.Equal(libraryTypes.Single(t => t.Name == "Color"), intEnum.GetGenericTypeDefinition());
                Assert.Equal(intEnum, Assert.Single(GetMethod(program, "EI").GetParameters()).ParameterType);
                Assert.Equal(intEnum, GetMethod(program, "EI").ReturnType);
                Assert.Equal(stringEnum, Assert.Single(GetMethod(program, "ES").GetParameters()).ParameterType);
                Assert.Equal(stringEnum, GetMethod(program, "ES").ReturnType);
                GetMethod(program, "<Main>$").Invoke(null, new object[] { Array.Empty<string>() });
                Assert.Equal(5, GetMethod(program, "I").Invoke(null, null));
                Assert.Equal(6, GetMethod(program, "S").Invoke(null, null));
                Assert.Equal(intEnum, GetMethod(program, "BI").Invoke(null, null).GetType());
                Assert.Equal(stringEnum, GetMethod(program, "BS").Invoke(null, null).GetType());
            }
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void BareNestedEnumEmptySliceLiteral_ClosesOverCurrentTypeParameters()
    {
        const string source = """
            package P

            struct Outer[T] {
                public enum Color { Red = 1, Green = 2, Blue = 3 }
                public func Values() []Color { return []Color{} }
            }
            """;

        var values = InvokeOuterArrayMethod(source, "Values");
        Assert.Empty(values);
        Assert.Equal(typeof(int), Assert.Single(values.GetType().GetElementType()!.GenericTypeArguments));
    }

    [Fact]
    public void BareNestedEnumPopulatedSliceLiteral_ClosesOverCurrentTypeParameters()
    {
        const string source = """
            package P

            struct Outer[T] {
                public enum Color { Red = 1, Green = 2, Blue = 3 }
                public func Values() []Color { return []Color{Color.Red, Color.Blue} }
            }
            """;

        var values = InvokeOuterArrayMethod(source, "Values");
        Assert.Equal(new[] { 1, 3 }, values.Cast<object>().Select(Convert.ToInt32));
        Assert.Equal(typeof(int), Assert.Single(values.GetType().GetElementType()!.GenericTypeArguments));
    }

    [Fact]
    public void AlreadyClosedNestedEnumSliceLiteral_RemainsClosed()
    {
        const string source = """
            package P

            struct Outer[T] {
                public enum Color { Red = 1, Green = 2, Blue = 3 }
                public func R() int32 {
                    var colors = []Outer[int32].Color{Outer[int32].Color.Blue}
                    return int32(colors[0])
                }
            }
            """;

        var assembly = CompileAndLoad(source);
        var outer = assembly.GetTypes().Single(t => t.Name == "Outer`1").MakeGenericType(typeof(string));
        Assert.Equal(3, GetMethod(outer, "R").Invoke(Activator.CreateInstance(outer), null));
    }

    [Fact]
    public void NestedEnumUnderNonGenericMiddle_ClosesOverGenericAncestor()
    {
        const string source = """
            package P

            struct Gen[T] {
                public struct Mid {
                    public enum Tone { A = 1, B = 2 }
                    public func R() int32 {
                        var tone = Tone.B
                        return int32(tone)
                    }
                }
            }
            """;

        var assembly = CompileAndLoad(source);
        var midDefinition = assembly.GetTypes().Single(t => t.Name == "Mid");
        var mid = midDefinition.IsGenericTypeDefinition
            ? midDefinition.MakeGenericType(typeof(int))
            : midDefinition;
        Assert.Equal(2, GetMethod(mid, "R").Invoke(Activator.CreateInstance(mid), null));
    }

    [Fact]
    public void NestedEnumTwoGenericLevelsDeep_LocalExpressionClosesAllEnclosingParameters()
    {
        const string source = """
            package P

            struct Gen[T] {
                public struct MidG[U] {
                    public enum Tone { A = 1, B = 2 }
                    public func R() int32 {
                        var tone = Tone.B
                        return int32(tone)
                    }
                }
            }
            """;

        Assert.Equal(2, InvokeNestedMidMethod(source));
    }

    [Fact]
    public void NestedEnumTwoGenericLevelsDeep_SliceLiteralClosesAllEnclosingParameters()
    {
        const string source = """
            package P

            struct Gen[T] {
                public struct MidG[U] {
                    public enum Tone { A = 1, B = 2 }
                    public func R() int32 {
                        var tones = []Tone{Tone.B}
                        return int32(tones[0])
                    }
                }
            }
            """;

        Assert.Equal(2, InvokeNestedMidMethod(source));
    }

    [Fact]
    public void StaticInterfacePropertyNestedEnum_PropagatesReferenceNullabilityErasure()
    {
        const string source = """
            package P

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

            func Run() int32 { return int32(Read(TextImplicit{})) }
            """;

        var assembly = CompileAndLoad(source, IlVerifier.KnownIssues.StaticVirtualInterface);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");

        Assert.Equal(1, GetMethod(program, "Run").Invoke(null, null));
    }

    private static MethodInfo GetMethod(Type type, string name)
        => type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Missing method {type.FullName}.{name}");

    private static Array InvokeOuterArrayMethod(string source, string methodName)
    {
        var assembly = CompileAndLoad(source);
        var outer = assembly.GetTypes().Single(t => t.Name == "Outer`1").MakeGenericType(typeof(int));
        return Assert.IsAssignableFrom<Array>(GetMethod(outer, methodName).Invoke(Activator.CreateInstance(outer), null));
    }

    private static int InvokeNestedMidMethod(string source)
    {
        var assembly = CompileAndLoad(source);
        var mid = assembly.GetTypes().Single(t => t.Name == "MidG`1").MakeGenericType(typeof(int), typeof(string));
        return Assert.IsType<int>(GetMethod(mid, "R").Invoke(Activator.CreateInstance(mid), null));
    }

    private static Assembly CompileAndLoad(string source, string[] ignoredErrorCodes = null)
    {
        var tempDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2898Emit",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var outputPath = Compile(tempDir, "test", source);
            IlVerifier.Verify(outputPath, ignoredErrorCodes: ignoredErrorCodes);

            var assembly = EmittedFixture.Load(outputPath);
            _ = assembly.GetTypes();
            return assembly;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string Compile(string directory, string name, string source, params string[] extraArguments)
    {
        var sourcePath = Path.Combine(directory, name + ".gs");
        var outputPath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int exitCode;
        try
        {
            var targetArgument = extraArguments.Any(a => a.StartsWith("/target:", StringComparison.OrdinalIgnoreCase))
                ? Array.Empty<string>()
                : new[] { "/target:library" };
            exitCode = Program.Main(extraArguments.Concat(targetArgument).Concat(new[]
            {
                "/out:" + outputPath,
                "/targetframework:net10.0",
                sourcePath,
            }).ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        return outputPath;
    }

    private static string GetFieldSignature(string assemblyPath, string fieldName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var metadata = peReader.GetMetadataReader();
        var field = metadata.FieldDefinitions
            .Select(metadata.GetFieldDefinition)
            .Single(f => metadata.GetString(f.Name) == fieldName);
        return Convert.ToHexString(metadata.GetBlobBytes(field.Signature));
    }
}
