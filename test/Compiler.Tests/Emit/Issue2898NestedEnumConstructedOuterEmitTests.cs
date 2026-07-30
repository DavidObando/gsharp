// <copyright file="Issue2898NestedEnumConstructedOuterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
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

            struct Outer[T] {
                enum Color { Red }
                func MakeColor() Color { return Color.Red }
            }

            func I(c Outer[int32].Color) Outer[int32].Color { return c }
            func S(c Outer[string].Color) Outer[string].Color { return c }
            func NI(c Outer[int32].Color?) Outer[int32].Color? { return c }
            func NS(c Outer[string].Color?) Outer[string].Color? { return c }
            func RI() Outer[int32].Color { return Outer[int32].Color.Red }
            func RS() Outer[string].Color { return Outer[string].Color.Red }
            func BI() object { return Outer[int32].Color.Red }
            func BS() object { return Outer[string].Color.Red }
            func Capture[T](c Outer[T].Color) () -> Outer[T].Color -> () -> c
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

        var enumDefinition = Assert.Single(allTypes, t => t.Name == "Color`1");
        Assert.True(enumDefinition.IsEnum);
        Assert.Equal(enumDefinition, intEnum.GetGenericTypeDefinition());

        var intRed = intEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static);
        var stringRed = stringEnum.GetField("Red", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(intRed);
        Assert.NotNull(stringRed);
        Assert.Equal(intRed.MetadataToken, stringRed.MetadataToken);
        Assert.Equal(0, intRed.GetRawConstantValue());
        Assert.Equal(0, stringRed.GetRawConstantValue());
        Assert.Equal(intEnum, intRed.FieldType);
        Assert.Equal(stringEnum, stringRed.FieldType);

        var holder = allTypes.Single(t => t.Name == "Holder");
        Assert.Equal(intEnum, holder.GetField("IntRed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).FieldType);
        Assert.Equal(stringEnum, holder.GetField("StringRed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).FieldType);

        var outerDefinition = allTypes.Single(t => t.Name == "Outer`1");
        var intOuter = outerDefinition.MakeGenericType(typeof(int));
        Assert.Equal(intEnum, GetMethod(intOuter, "MakeColor").ReturnType);

        var intValue = GetMethod(program, "RI").Invoke(null, null);
        var stringValue = GetMethod(program, "RS").Invoke(null, null);
        Assert.Equal(intEnum, intValue.GetType());
        Assert.Equal(stringEnum, stringValue.GetType());
        Assert.Equal(0, Convert.ToInt32(intValue));
        Assert.Equal(0, Convert.ToInt32(stringValue));
        Assert.Equal(intEnum, GetMethod(program, "BI").Invoke(null, null).GetType());
        Assert.Equal(stringEnum, GetMethod(program, "BS").Invoke(null, null).GetType());

        var captureInt = GetMethod(program, "Capture").MakeGenericMethod(typeof(int));
        Assert.Equal(intEnum, Assert.Single(captureInt.GetParameters()).ParameterType);
        var captured = Assert.IsAssignableFrom<Delegate>(captureInt.Invoke(null, new[] { intValue }));
        Assert.Equal(intEnum, captured.DynamicInvoke().GetType());
    }

    private static MethodInfo GetMethod(Type type, string name)
        => type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Missing method {type.FullName}.{name}");

    private static Assembly CompileAndLoad(string source)
    {
        var tempDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2898Emit",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var sourcePath = Path.Combine(tempDir, "test.gs");
            var outputPath = Path.Combine(tempDir, "test.dll");
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
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var bytes = File.ReadAllBytes(outputPath);
            var assembly = Assembly.Load(bytes);
            _ = assembly.GetTypes();
            return assembly;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
