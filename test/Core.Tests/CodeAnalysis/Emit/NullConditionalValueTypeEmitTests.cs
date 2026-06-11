// <copyright file="NullConditionalValueTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #421 / P2-7: null-conditional <c>s?.M()</c> over a value-type
/// member result must produce a <c>Nullable&lt;T&gt;</c> stack value on
/// both branches. The nil branch materializes <c>default(Nullable&lt;T&gt;)</c>
/// via <c>ldloca</c>/<c>initobj</c>; the not-null branch wraps the raw
/// <c>T</c> via <c>newobj Nullable&lt;T&gt;::.ctor(!0)</c>. Without this
/// fix, the nil branch pushes a ref-typed <c>ldnull</c> while the not-null
/// branch pushes a raw <c>int32</c>, producing invalid IL.
/// </summary>
public class NullConditionalValueTypeEmitTests
{
    [Fact]
    public void NullConditional_OnNonNullRef_ProducesNullableValueType()
    {
        // Reading the static field via reflection avoids brittleness around
        // overload resolution for Console.WriteLine(Nullable<int>).
        var source = @"
package NullCondValueTypeNonNull
import System

var n int32? = ""hello""?.Length
";
        var n = CompileLoadInvokeReadField(source, nameof(NullConditional_OnNonNullRef_ProducesNullableValueType), "n");
        Assert.Equal(5, (int)(int?)n);
    }

    [Fact]
    public void NullConditional_OnNilRef_ProducesEmptyNullable()
    {
        var source = @"
package NullCondValueTypeNil
import System

var s string? = nil
var n int32? = s?.Length
";
        var n = CompileLoadInvokeReadField(source, nameof(NullConditional_OnNilRef_ProducesEmptyNullable), "n");
        Assert.Null(n);
    }

    [Fact]
    public void NullConditional_OnNonNullRef_NullableField_HasValueAndValue()
    {
        // Verify the emitted Nullable<int> is a real value-type Nullable —
        // its field signature must be Nullable<int> and runtime Value is 2.
        var source = @"
package NullCondValueTypeShape
import System

var s string? = ""hi""
var n int32? = s?.Length
";
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(result.Success);
        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(NullConditional_OnNonNullRef_NullableField_HasValueAndValue), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var field = programType!.GetField("n", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(field);
            Assert.Equal(typeof(int?), field!.FieldType);

            var entry = programType.GetMethod("<Main>$", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

            // GetValue on a Nullable<T> field unboxes to T or returns null.
            var boxed = field.GetValue(null);
            Assert.NotNull(boxed);
            Assert.Equal(2, (int)boxed!);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void NullConditional_OnNilRef_FieldType_IsNullableInt()
    {
        // The static backing field for `var n int32? = ...` must be
        // emitted with signature `Nullable<int32>`, not raw `int32`.
        var source = @"
package NullCondValueTypeFieldType
import System

var s string? = nil
var n int32? = s?.Length
";
        var fieldType = CompileLoadGetFieldType(source, nameof(NullConditional_OnNilRef_FieldType_IsNullableInt), "n");
        Assert.Equal(typeof(int?), fieldType);
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static object CompileLoadInvokeReadField(string source, string contextName, string fieldName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

            var field = programType.GetField(fieldName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(field);
            return field!.GetValue(null);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static Type CompileLoadGetFieldType(string source, string contextName, string fieldName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var field = programType!.GetField(fieldName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(field);
            return field!.FieldType;
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
