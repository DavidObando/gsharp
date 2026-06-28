// <copyright file="Issue1049NullableVoidDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1049: emitting a nullable function (delegate) type whose return type
/// is <c>void</c> — e.g. <c>((Args) -> void)?</c> — crashed the compiler with
/// <c>GS9998: ArgumentException: The type 'System.Void' may not be used as a
/// type argument</c>. Issue #1399 / ADR-0137 makes nullable function types use
/// parenthesized spelling, so <c>(Args) -> void?</c> remains a nullable return
/// and <c>((Args) -> void)?</c> is the nullable delegate. Its underlying return is still
/// <c>void</c>, so it must map to <c>System.Action&lt;...&gt;</c> rather than
/// the illegal <c>System.Func&lt;..., System.Void&gt;</c>.
/// </summary>
public class Issue1049NullableVoidDelegateEmitTests
{
    [Fact]
    public void NullableVoidDelegateField_NoArgs_EmitsAsAction()
    {
        var asm = LoadCompiled("""
            package p
            class C {
                var f (() -> void)?
            }
            """);

        var field = FindField(asm, "p", "C", "f");
        Assert.Equal("System.Action", field.FieldType.FullName);
    }

    [Fact]
    public void NullableVoidDelegateField_OneArg_EmitsAsActionOfArg()
    {
        var asm = LoadCompiled("""
            package p
            class C {
                var g ((int32) -> void)?
            }
            """);

        var field = FindField(asm, "p", "C", "g");
        Assert.True(
            field.FieldType.IsGenericType
            && field.FieldType.GetGenericTypeDefinition().FullName == "System.Action`1",
            $"expected System.Action`1 but was '{field.FieldType.FullName}'");
        Assert.Equal(typeof(int).FullName, field.FieldType.GetGenericArguments()[0].FullName);
    }

    [Fact]
    public void PlainVoidDelegateField_StillEmitsAsAction_RegressionGuard()
    {
        // Control: the non-nullable `() -> void` shape already mapped to
        // System.Action and must keep doing so after the fix.
        var asm = LoadCompiled("""
            package p
            class C {
                var f () -> void
            }
            """);

        var field = FindField(asm, "p", "C", "f");
        Assert.Equal("System.Action", field.FieldType.FullName);
    }

    [Fact]
    public void NullableNonVoidReturnDelegateField_StillEmitsAsFunc_RegressionGuard()
    {
        // Control: a nullable *non-void* return is unaffected — it stays a
        // System.Func<int32, int32> (the `?` annotation on a value-type
        // return shares the underlying CLR representation).
        var asm = LoadCompiled("""
            package p
            class C {
                var h (int32) -> int32?
            }
            """);

        var field = FindField(asm, "p", "C", "h");
        Assert.True(
            field.FieldType.IsGenericType
            && field.FieldType.GetGenericTypeDefinition().FullName == "System.Func`2",
            $"expected System.Func`2 but was '{field.FieldType.FullName}'");
    }

    private static FieldInfo FindField(Assembly asm, string ns, string typeName, string fieldName)
    {
        var full = ns + "." + typeName;
        var type = asm.GetType(full, throwOnError: false)
            ?? asm.GetTypes().FirstOrDefault(t =>
                string.Equals(t.Namespace, ns, StringComparison.Ordinal)
                && string.Equals(t.Name, typeName, StringComparison.Ordinal));
        Assert.NotNull(type);

        var field = type.GetField(
            fieldName,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static);
        Assert.NotNull(field);
        return field;
    }

    private static Assembly LoadCompiled(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1049_").FullName;
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
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
        IlVerifier.Verify(outPath);

        var ctx = new AssemblyLoadContext(name: "gs_issue1049_" + Guid.NewGuid(), isCollectible: true);
        return ctx.LoadFromAssemblyPath(outPath);
    }
}
