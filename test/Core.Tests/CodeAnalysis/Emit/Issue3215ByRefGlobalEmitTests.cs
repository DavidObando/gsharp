// <copyright file="Issue3215ByRefGlobalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3215: taking the address of a top-level variable (`var p = &amp;x`)
/// used to crash the emitter with an internal signature-encoding exception
/// ("Cannot encode '*int32' as a non-byref signature slot"), because the
/// submission machinery hoisted the byref-typed (`*T`) variable to a static
/// FieldDef — a signature ECMA-335 §II.14.4.2 forbids. The fix keeps
/// byref-typed top-level variables as entry-point local slots (byref LOCALS
/// are legal IL) while every other top-level variable still hoists, and turns
/// the genuinely unrepresentable shapes — referencing such a variable from a
/// declared function or a lambda body, which would require the impossible
/// static field — into the GS9004 byref-escape diagnostic instead of an ICE.
/// </summary>
public class Issue3215ByRefGlobalEmitTests
{
    [Fact]
    public void AddressOfTopLevelVariable_EmitsAndRoundTripsThroughDereference()
    {
        // The issue's exact repro, executed emitted, with the dereferenced
        // value observed so the pointer round-trip is the assertion.
        var result = EmittedOracle.Evaluate(@"
var x = 42
var p = &x
var y = *p
y
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void WriteThroughTopLevelPointer_MutatesThePointeeVariable()
    {
        // The discriminating direction: `*p = 100` must write through the
        // managed pointer into `x`'s storage (the hoisted static field the
        // pointer was taken from), not a detached copy.
        var result = EmittedOracle.Evaluate(@"
var x = 42
var p = &x
*p = 100
x
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void ByRefTypedTopLevelVariable_IsNotHoistedToAStaticField()
    {
        // The metadata contract behind the fix: `x` still hoists to a static
        // FieldDef on <Program>, while the byref-typed `p` must not appear as
        // a field at all — no legal field signature can carry
        // ELEMENT_TYPE_BYREF.
        var source = @"
var x = 42
var p = &x
var y = *p
y
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join("; ", emitResult.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();
        var fieldNames = md.FieldDefinitions
            .Select(md.GetFieldDefinition)
            .Select(f => md.GetString(f.Name))
            .ToList();

        Assert.Contains("x", fieldNames);
        Assert.DoesNotContain("p", fieldNames);
    }

    [Fact]
    public void FunctionReferencingByRefTopLevelVariable_ReportsGS9004()
    {
        // A declared function body has no storage through which to reach the
        // entry-point-local pointer (a static byref field cannot exist), so
        // the reference is a compile-time byref-escape error — never an ICE.
        var result = EmittedOracle.Evaluate(@"
var x = 42
var p = &x
func f() int32 { return *p }
f()
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9004");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void LambdaReferencingByRefTopLevelVariable_ReportsGS9004()
    {
        // Same contract for a function literal: globals are normally read
        // live from their static fields (never captured), which is exactly
        // what a byref-typed global cannot provide.
        var result = EmittedOracle.Evaluate(@"
var x = 42
var p = &x
let f = func() int32 { return *p }
f()
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9004");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }
}
