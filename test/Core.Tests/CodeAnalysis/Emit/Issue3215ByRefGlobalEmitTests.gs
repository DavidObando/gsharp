// <copyright file="Issue3215ByRefGlobalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3215: taking the address of a top-level variable (`var p = &x`)
/// used to crash the emitter with an internal signature-encoding exception
/// ("Cannot encode '*int32' as a non-byref signature slot"), because the
/// submission machinery hoisted the byref-typed (`*T`) variable to a static
/// FieldDef — a signature ECMA-335 §II.14.4.2 forbids. The fix keeps
/// byref-typed top-level variables as entry-point local slots (byref LOCALS
/// are legal IL) while every other top-level variable still hoists, and turns
/// the genuinely unrepresentable shapes — referencing such a variable from a
/// declared function or a lambda body, which would require the impossible
/// static field — into the GS9004 byref-escape diagnostic instead of an ICE.
open class Issue3215ByRefGlobalEmitTests {
    @Fact
    func AddressOfTopLevelVariable_EmitsAndRoundTripsThroughDereference() {
        // The issue's exact repro, executed emitted, with the dereferenced
        // value observed so the pointer round-trip is the assertion.
        let result = EmittedOracle.Evaluate(`
var x = 42
var p = &x
var y = *p
y
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func WriteThroughTopLevelPointer_MutatesThePointeeVariable() {
        // The discriminating direction: `*p = 100` must write through the
        // managed pointer into `x`'s storage (the hoisted static field the
        // pointer was taken from), not a detached copy.
        let result = EmittedOracle.Evaluate(`
var x = 42
var p = &x
*p = 100
x
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(100, result.Value)
    }

    @Fact
    func ByRefTypedTopLevelVariable_IsNotHoistedToAStaticField() {
        // The metadata contract behind the fix: `x` still hoists to a static
        // FieldDef on <Program>, while the byref-typed `p` must not appear as
        // a field at all — no legal field signature can carry
        // ELEMENT_TYPE_BYREF.
        let source = `
var x = 42
var p = &x
var y = *p
y
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let emitResult = compilation.Emit(peStream)
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join(
                "; ",
                emitResult.Diagnostics.Select((d Diagnostic) -> d.Message)
            )
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        let md = peReader.GetMetadataReader()
        let fieldNames = md
            .FieldDefinitions
            .Select(md.GetFieldDefinition)
            .Select((f FieldDefinition) -> md.GetString(f.Name))
            .ToList()
        Assert.Contains("x", fieldNames)
        Assert.DoesNotContain("p", fieldNames)
    }

    @Fact
    func FunctionReferencingByRefTopLevelVariable_ReportsGS9004() {
        // A declared function body has no storage through which to reach the
        // entry-point-local pointer (a static byref field cannot exist), so
        // the reference is a compile-time byref-escape error — never an ICE.
        let result = EmittedOracle.Evaluate(`
var x = 42
var p = &x
func f() int32 { return *p }
f()
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func LambdaReferencingByRefTopLevelVariable_ReportsGS9004() {
        // Same contract for a function literal: globals are normally read
        // live from their static fields (never captured), which is exactly
        // what a byref-typed global cannot provide.
        let result = EmittedOracle.Evaluate(`
var x = 42
var p = &x
let f = func() int32 { return *p }
f()
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }
}
