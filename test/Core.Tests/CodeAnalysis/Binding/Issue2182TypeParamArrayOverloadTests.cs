// <copyright file="Issue2182TypeParamArrayOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2182: a slice <c>[]T</c> whose element <c>T</c> is a generic type
/// parameter has a null backing <c>ClrType</c> during binding. #2140 made the
/// element-INDEPENDENT array supertypes (<see cref="System.Array"/>, the
/// non-generic collection interfaces) accepted by
/// <c>Conversion.Classify</c> in assignment / return position, but the
/// OVERLOAD- and CONSTRUCTOR-resolution applicability check surfaced no
/// effective CLR type for such an argument, so it never ran and the
/// constructor-as-call lookup dead-ended with GS0159 'Cannot find function'.
/// The fix surfaces the erased array type (<c>[]T</c> -&gt; <c>object[]</c>,
/// mirroring the ADR-0004 type-parameter-to-<c>object</c> erasure) so
/// <c>[]T</c> becomes applicable to an array-base parameter exactly where a
/// concrete <c>[]int32</c> argument (backing <c>int[]</c>) and a direct
/// <see cref="System.Array"/> argument already are.
/// </summary>
public class Issue2182TypeParamArrayOverloadTests
{
    [Fact]
    public void TypeParamArray_ToSystemArrayParameter_MethodCall_Binds()
    {
        const string source = @"
package P
class C[T] {
    func Take(a System.Array) int32 { return a.Length }
    func Call(a []T) int32 { return Take(a) }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TypeParamArray_ToNonGenericCollectionParameters_MethodCall_Binds()
    {
        const string source = @"
package P
import System.Collections
class C[T] {
    func TakeColl(a ICollection) int32 { return a.Count }
    func TakeList(a IList) int32 { return a.Count }
    func TakeEnum(a IEnumerable) int32 { return 0 }
    func Call(a []T) int32 { return TakeColl(a) + TakeList(a) + TakeEnum(a) }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TypeParamArray_ToConstructorTakingICollection_Binds()
    {
        // Constructor-call path: ArrayList(ICollection). Before the fix this
        // reported GS0159 because no applicable ctor was found for the
        // untyped []T argument.
        const string source = @"
package P
import System.Collections
class C[T] {
    func Make(a []T) ArrayList { return ArrayList(a) }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TypeParamArray_ToNestedImportedConstructor_Binds()
    {
        // The original repro: a nested imported type's constructor
        // (TypeConverter.StandardValuesCollection(ICollection)).
        const string source = @"
package P
import System
import System.ComponentModel
class C[T Enum struct] {
    func WithTypeParamArr(a []T) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TypeParamArray_AndConcreteArray_AndArrayBase_AllBindTogether()
    {
        // The three sibling overloads from the issue: []T, []int32, and
        // System.Array must ALL bind against the same constructor.
        const string source = @"
package P
import System
import System.ComponentModel
class C[T Enum struct] {
    func WithTypeParamArr(a []T) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
    func WithConcreteArr(a []int32) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
    func WithArrayBase(a System.Array) TypeConverter.StandardValuesCollection {
        return TypeConverter.StandardValuesCollection(a)
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ConcreteArray_ToConstructor_StillBinds_Control()
    {
        // Control: the concrete-element path (backing ClrType non-null) must
        // remain unaffected.
        const string source = @"
package P
import System.Collections
class C {
    func Make(a []int32) ArrayList { return ArrayList(a) }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TypeParamArray_ToMismatchedConstructor_StillRejected()
    {
        // Guard against over-broadening: []T must not become applicable to an
        // unrelated non-array parameter. System.Uri has no ctor taking any
        // array-base type, so this must still fail.
        const string source = @"
package P
import System
class C[T] {
    func Bad(a []T) Uri { return Uri(a) }
}
";
        Assert.NotEmpty(GetDiagnostics(source));
    }

    [Fact]
    public void TypeParamArray_ToICollectionParameter_EmitsAndRuns()
    {
        // Runtime/emit assertion: the selected ICollection overload must
        // actually execute against the real []T backing array at runtime.
        const string source = @"package Issue2182Rt
import System
import System.Collections

class Bag[T] {
    func CountColl(a ICollection) int32 { return a.Count }
    func Run(a []T) int32 { return CountColl(a) }
}

let b = Bag[int32]()
let arr = []int32{10, 20, 30}
Console.WriteLine(b.Run(arr))
";
        var output = CompileAndRun(source, "Issue2182Rt");
        Assert.Equal("3", output.Trim());
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

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

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static ImmutableArrayOfDiagnostic GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        var all = parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new ImmutableArrayOfDiagnostic(all);
    }

    /// <summary>
    /// Thin wrapper so the test cases can call <c>Assert.Empty</c> against a
    /// <see cref="ImmutableArray{T}"/> without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var diagnostic in this.diagnostics)
            {
                yield return diagnostic;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
    }
}
