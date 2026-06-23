// <copyright file="Issue973ClassValueTypeFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #973 — emit + IL-verify + runtime coverage for a <c>class</c> that
/// declares a field whose type is a user value type (<c>struct</c> or
/// <c>data struct</c>).
///
/// The reported symptom was an internal emit crash
/// (<c>GS9998: InvalidOperationException: Struct 'S' has no emitted TypeDef.</c>)
/// when a <c>class</c> field referenced a user <c>struct</c>: classes are
/// emitted before structs, so when the class field signature was encoded the
/// struct's TypeDef row had not yet been registered. A second, order-sensitive
/// symptom (<c>GS0113: Type 'S' doesn't exist.</c>) appeared when the struct was
/// declared AFTER the class, because struct/class names were declared and their
/// bodies bound in a single source-order pass.
///
/// The fix has two parts:
///   - Emit: pre-reserve every user TypeDefinitionHandle before any member
///     signature is encoded, so a forward-referenced type resolves regardless
///     of relative emission order.
///   - Bind: declare every struct/class type-name shell first, then bind their
///     bodies, so a field type can forward-reference a type declared later.
///
/// These tests cover the shapes the fix unblocks, asserting the program
/// compiles, passes IL verification, emits the struct as a real value-type
/// field of the class, and round-trips a value at runtime — for both
/// declaration orders and for <c>data struct</c> fields.
/// </summary>
public class Issue973ClassValueTypeFieldEmitTests
{
    #region Exact repro — struct declared BEFORE the class

    [Fact]
    public void ClassWithStructField_StructBeforeClass_CompilesVerifiesAndRoundTrips()
    {
        var source = """
            package Probe

            struct S {
                var X int32
            }

            class C {
                var Field S
                init(f S) { Field = f }
            }

            public var value = C(S{ X: 7 }).Field.X
            """;

        var assembly = CompileVerifyAndRun(source);

        Assert.Equal(7, GetField<int>(assembly, "value"));
        AssertFieldIsValueType(assembly, className: "C", fieldName: "Field", fieldTypeName: "S");
    }

    #endregion

    #region Order symptom — struct declared AFTER the class (was GS0113)

    [Fact]
    public void ClassWithStructField_StructAfterClass_CompilesVerifiesAndRoundTrips()
    {
        var source = """
            package Probe

            class C {
                var Field S
                init(f S) { Field = f }
            }

            struct S {
                var X int32
            }

            public var value = C(S{ X: 9 }).Field.X
            """;

        var assembly = CompileVerifyAndRun(source);

        Assert.Equal(9, GetField<int>(assembly, "value"));
        AssertFieldIsValueType(assembly, className: "C", fieldName: "Field", fieldTypeName: "S");
    }

    #endregion

    #region data struct field

    [Fact]
    public void ClassWithDataStructField_CompilesVerifiesAndRoundTrips()
    {
        var source = """
            package Probe

            data struct S {
                var X int32
            }

            class C {
                var Field S
                init(f S) { Field = f }
            }

            public var value = C(S{ X: 42 }).Field.X
            """;

        var assembly = CompileVerifyAndRun(source);

        Assert.Equal(42, GetField<int>(assembly, "value"));
        AssertFieldIsValueType(assembly, className: "C", fieldName: "Field", fieldTypeName: "S");
    }

    #endregion

    #region Mutual forward reference between two classes (was GS0113)

    [Fact]
    public void ClassWithForwardReferencedClassField_CompilesAndRoundTrips()
    {
        var source = """
            package Probe

            class A {
                var Inner B
                init(b B) { Inner = b }
            }

            class B {
                var X int32
                init(x int32) { X = x }
            }

            public var value = A(B(5)).Inner.X
            """;

        var assembly = CompileVerifyAndRun(source);

        Assert.Equal(5, GetField<int>(assembly, "value"));
    }

    #endregion

    #region Helpers

    private static Assembly CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_973_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static T GetField<T>(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var resultField = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (T)resultField!.GetValue(null)!;
    }

    private static void AssertFieldIsValueType(Assembly assembly, string className, string fieldName, string fieldTypeName)
    {
        var classType = assembly.GetTypes().Single(t => t.Name == className);
        Assert.True(classType.IsClass, $"'{className}' should be emitted as a reference type.");

        var field = classType.GetField(fieldName, BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(field);
        Assert.Equal(fieldTypeName, field!.FieldType.Name);
        Assert.True(field.FieldType.IsValueType, $"field '{fieldName}' should be a value type ('{fieldTypeName}').");
    }

    #endregion
}
